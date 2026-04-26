import { UnsubscribeHook, delay, error_str, killSignalsHook } from "../../utils.js";
import { ExecManager } from "./ExecManager";
import { logger, logger_shutdown } from "../../log.js";
import { waitFrameStartMs } from "../../market/frame.js";

/**
 * Type of functions that create ExecManager instances for each cycle.
 */
export type SchedulerTickInitType = () => Promise<ExecManager>;

/**
 * When scheduler receives kill signal it needs to delay some time to stops correctly.
 */
const EXEC_SCHEDULER_SHUTDOWN_SIGNAL_DELAY = 3500;

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
    private _shutdownHandler: Promise<void> | undefined = undefined;
    private _runningManagers: Promise<void>[] = [];

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
            process.stdout.write(`Die...\n`);

            await logger_shutdown();
            await delay(EXEC_SCHEDULER_SHUTDOWN_SIGNAL_DELAY);
            process.exit(0);
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
                    this._runningManagers = this._currentManagers.map(manager => manager.start(execTickMs));
                    await Promise.all(this._runningManagers);
                    this._runningManagers = [];
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
        if (this._shutdownHandler) 
            return this._shutdownHandler;

        this._shutdownHandler = (async () => {
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
                    results.forEach(value => {
                        if (value.status === 'rejected') {
                            logger.error(`SCHEDULER ERROR: Manager shutdown failed: ${error_str(value.reason)}`);
                        }});

                    if (this._runningManagers.length > 0) {
                        await Promise.allSettled(this._runningManagers);
                        this._runningManagers = [];
                    }
                }
                this._currentManagers = [];
                logger.info(`SCHEDULER INFO: SHUTTING DOWN MANAGERS FINISHED!`);
            }
            catch(error) {
                logger.error(`SCHEDULER SHUTDOWN ERROR: ${error_str(error)}`);
            } 
            finally {
                this._isShuttingDown = false;
            }
        })();

        try {
            await this._shutdownHandler;
        } finally {
            this._shutdownHandler = undefined;
        }
    }
}