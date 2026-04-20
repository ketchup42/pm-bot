import { UnsubscribeHook, error_str, killSignalsHook } from "../../utils.js";
import { ExecManager } from "./ExecManager";
import { logger } from "../../log.js";
import { waitFrameStartMs } from "../../market/frame.js";

/**
 * Type of functions that create ExecManager instances for each cycle.
 */
export type SchedulerTickInitType = () => Promise<ExecManager>;

export class ExecScheduler {

    /**
     * Flag indicating whether the scheduler loop is stopped.
     * After start() exits (normally or with an error), it is reset to false,
     * which allows restarting the scheduler by calling start() again.
     * On restart, a new killSignalsHook will be registered.
     */
    private _isStopped = false;
    private _isStarted = false;
    private _isShuttingDown = false;

    private _currentManagers: ExecManager[] = [];
    private _cycleStartHandlers: SchedulerTickInitType[];
    private _unsubscribeHook: UnsubscribeHook = () => {};

    constructor(handlers: SchedulerTickInitType[]) {
        this._cycleStartHandlers = handlers;
    }

    /**
     * Starts the scheduler loop.
     * @param alignMs - Alignment interval in milliseconds (e.g., 300_000 for 5 minutes)
     * @param execTickMs - Tick delay (ms) passed to each ExecManager's start() method
     */
    public async start(alignMs: number, execTickMs: number): Promise<void> {
        if (this._isStarted) return;
        if (this._isStopped) return;

        if (this._cycleStartHandlers.length === 0) {
            logger.warn('SCHEDULER: No handlers provided, exiting..');
            return;
        }
        this._isStarted =  true;
        // Align to the next time frame boundary
        await waitFrameStartMs(alignMs);
        
        // Single global shutdown hook
        this._unsubscribeHook = killSignalsHook(async () => {
            await this.shutdown();
        });

        try {
            while (!this._isStopped) {

                const results = await Promise.allSettled(
                    this._cycleStartHandlers.map(handler => handler())
                );

                {
                    const errors: unknown[] = [];
                    this._currentManagers = [];
                    results.forEach((result => {
                        if (result.status === 'fulfilled') {
                            this._currentManagers.push(result.value);
                        } else {
                            errors.push(result.reason);
                        }
                    }))
                    if (errors.length > 0) { await this.shutdown();  break; }
                }

                // Run all managers concurrently
                if (!this._isStopped) {
                    logger.info(`EXECUTE MANAGERS IN SCHEDULER: ${this._currentManagers.length}`);
                    await Promise.all(this._currentManagers.map(manager => manager.start(execTickMs)))
                    logger.info(`FINISHED EXECUTING MANAGERS IN SCHEDULER: ${this._currentManagers.length}`);
                }
            }
        } catch (error) {
            logger.error(`SCHEDULER ERROR: ${error_str(error)}`);
        } finally {
            // Ensure cleanup even on error or normal exit
            try {
                await this.shutdown();
            } catch (err) {
                logger.error(`SCHEDULER SHUTDOWN ERROR: ${error_str(err)}`);
            }

            this._unsubscribeHook();
 
            this._isStopped = false;
            this._isStarted = false;
        }
    }

    /**
     * Stops the scheduler loop.
     */
    public stop(): void {
        this._isStopped = true;
    }

    /**
     * Gracefully shuts down the scheduler and all currently running managers.
     */
    private async shutdown(): Promise<void> {
        if (this._isShuttingDown) return;
        this._isShuttingDown = true;

        try {
            if (this._isStopped && this._currentManagers.length === 0) return;
            this._isStopped = true;
            
            logger.info(`SCHEDULER INFO: SHUTTING DOWN MANAGERS...`);
            {
                const results = await Promise.allSettled(
                    this._currentManagers.map(manager => manager.shutdown())
                );
                results.forEach((value => {
                    if (value.status === 'rejected') {
                        logger.error(`SCHEDULER ERROR: Manager shutdown failed: ${error_str(value.reason)}`);
                }}))
            }
            this._currentManagers = [];
            logger.info(`SCHEDULER INFO: SHUTTING DOWN MANAGERS FINISHED!`);
        } finally {
            this._isShuttingDown = false;
        }
    }
}