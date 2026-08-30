import { UnsubscribeHook, delay, error_str, killSignalsHook } from "../../utils.js";
import { ExecManager } from "./ExecManager.js";
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
    private _paused = false;

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

        // Per-scheduler shutdown hook: on a signal only this scheduler is stopped gracefully.
        this._unsubscribeHook = killSignalsHook(async () => {
            await this.shutdown();
        });

        try {
            while (!this._isStopped) {
                if (this._paused) {
                    logger.info(`SCHEDULER: PAUSED, waiting ${alignMs}ms`);
                    await this.waitPaused(alignMs, execTickMs);
                    continue;
                }

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

    /** Pauses this scheduler: the loop stops creating/running managers and just waits alignMs each iteration. */
    public pause(): void {
        this._paused = true;
    }

    /** Resumes normal operation: managers are created and run again. */
    public unpause(): void {
        this._paused = false;
    }

    /** Whether this scheduler is paused. */
    public isPaused(): boolean {
        return this._paused;
    }

    /** Idles while paused: micro-steps of stepMs until the remaining time to the next frame
     * boundary fits in one step, then waitFrameStartMs finishes the exact alignment.
     * Checks the stop flag so shutdown/stop interrupts promptly. */
    private async waitPaused(alignMs: number, stepMs: number): Promise<void> {
        while (!this._isStopped) {
            const remaining = alignMs - (Date.now() % alignMs);  // ms until the next frame boundary
            if (remaining <= stepMs) break;                      // close enough — let waitFrameStartMs finish
            await delay(stepMs);                                 // micro-step
        }
        if (!this._isStopped) {
            await waitFrameStartMs(alignMs);                     // exact frame-boundary alignment
        }
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