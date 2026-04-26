import { ClobClient } from "@polymarket/clob-client";
import { EventWatcher } from "./events/EventWatcher.js";
import { EventStrategy } from "./events/strategy/EventStrategy.js";
import { ExecTarget } from "./exec_targets.js"
import { logger } from "../../log.js";
import { delay, error_str} from "../../utils.js";
import { TIMER_FAST, TIMER_NORM, TIMER_SLOW } from "../../timer.js";
import { dumper } from "../../dump.js";

export const EXEC_STRAT_SLOW = TIMER_SLOW;
export const EXEC_STRAT_NORM = TIMER_NORM;
export const EXEC_STRAT_FAST = TIMER_FAST;

/*
 * Manages the execution loop of watchers and strategies.
 * Coordinates event checking and order execution.
 */
export class ExecManager {
    private _client: ClobClient;
    private _watchers: EventWatcher<ExecTarget>[];
    private _strategies: EventStrategy<ExecTarget>[];
    private _diePromise: Promise<void> | undefined = undefined;

    private _inDebugMode = false;
    private _isStopped = false;
    private _disposed = false;

    constructor(client: ClobClient, watchers: EventWatcher<ExecTarget>[], strategies: EventStrategy<ExecTarget>[], debug?: boolean)
    {
        this._client = client;
        this._watchers = watchers;
        this._strategies = strategies;
        this._inDebugMode = debug ?? false;
    }

    /**
     * Starts the main execution loop.
     * Runs until all watchers are finished or shutdown is called.
     * @param tick - Delay (in milliseconds) between loop iterations of strategies executions. Minimum 1 ms.
     */
    public async start(tick: number = EXEC_STRAT_NORM): Promise<void> {
        try {
            if (this._disposed) return;

            tick = Math.max(1, tick);
            if (this._watchers.length === 0) {
                logger.warn(`EXEC MANAGER WARN: NO WATCHERS PROVIDED!`);
                return;
            }
            this._isStopped = false;
            while (!this._isStopped && this._watchers.every(watcher => !watcher.isFinished())) {

                await Promise.allSettled(
                    this._strategies.map(async strategy => {
                        try {
                            const execResult = !this._isStopped && await strategy.execute(this._client, this._watchers);
                            if (execResult) logger.info(`EXEC MANAGER INFO: STRATEGY EXECUTED!`);
                        } catch (error) {
                            logger.error(`STRATEGY ERROR: ${error_str(error)}`);
                        }
                    })
                );  
                // Global tick delay
                if (!this._isStopped) await delay(tick);
            }
            if (!this._disposed)
                await this.die();

        } catch (error) {
            logger.error(`SYSTEM ERROR: ${error_str(error)}`);
            try {
                await this.die();
            } catch (dieError) {
                logger.error(`RED ALERT! SYSTEM IN INCONSISTENT STATE! ERROR DURING DIE: ${error_str(dieError)}`);
            }
        } finally {
            logger.info(`EXEC MANAGER INFO: STOPED`);
        }
    }

   /**
     * Gracefully shuts down the manager.
     * Signals the main loop to stop and triggers cleanup of strategies and watchers.
     * Designed to be called from SIGINT/SIGTERM handlers.
     */
    public async shutdown(): Promise<void> {
        this._isStopped = true; // For master manager loop exit
        logger.info(`EXEC MANAGER INFO: SHUTDOWN SIGNAL!`);
        await this.die();
    }

    /**
     * Performs internal cleanup: cancels all strategies and disposes all watchers.
     * Safe to call multiple times (idempotent).
     * @private
     */
    private async die(): Promise<void> {
        if (this._diePromise) return this._diePromise;
        this._diePromise = (async () => {
            if (this._disposed) return;
            this._disposed = true;
            await Promise.all(this._strategies.map(s => s.cancel(this._client, this._watchers)));

            const dumpPromises: Promise<void>[] = [];
            if (this._inDebugMode) {
                this._watchers.forEach(w => {
                    dumpPromises.push(dumper.dump(w.getWatcherHistoryUp(), w.getEventId()));
                    dumpPromises.push(dumper.dump(w.getWatcherHistoryDown(), w.getEventId()));
                });
                logger.info(`EXEC MANAGER INFO: HISTORY DUMPS CREATED`);
            }
            await Promise.all([...dumpPromises, ...this._watchers.map(w => w.dispose())]);
            logger.info(`EXEC MANAGER INFO: CLEANUP FINISHED`);
        })();
        return this._diePromise;
    }
}