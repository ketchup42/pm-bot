import { ClobClient } from "@polymarket/clob-client";
import { EventWatcher } from "./events/EventWatcher.js";
import { EventStrategy } from "./events/strategy/EventStrategy.js";
import { ExecTarget } from "./exec_targets.js"
import { logger } from "../../log.js";
import { delay, error_str, getISOTimestamp } from "../../utils.js";

/*
 * Manages the execution loop of watchers and strategies.
 * Coordinates event checking and order execution.
 */
export class ExecManager {
    private _client: ClobClient;
    private _watchers: EventWatcher<ExecTarget>[];
    private _strategies: EventStrategy<ExecTarget>[];

    private _isStopped = false;
    private _disposed = false;

    constructor(client: ClobClient, watchers: EventWatcher<ExecTarget>[], strategies: EventStrategy<ExecTarget>[])
    {
        this._client = client;
        this._watchers = watchers;
        this._strategies = strategies;
    }

    /**
     * Starts the main execution loop.
     * Runs until all watchers are finished or shutdown is called.
     * @param tick - Delay (in milliseconds) between loop iterations of strategies executions. Minimum 1 ms.
     */
    public async start(tick: number): Promise<void> {
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
                            const checkResult = await strategy.check(this._watchers);
                            if (checkResult) {
                                const execResult = !this._isStopped && await strategy.execute(this._client, this._watchers);
                                if (execResult) logger.info(`[${getISOTimestamp()}] EXEC MANAGER INFO: STRATEGY EXECUTE SUCCESS!`);
                            }
                        } catch (error) {
                            logger.error(`STRATEGY ERROR: ${error_str(error)}`);
                        }
                    })
                );  
                // Global tick delay
                if (!this._isStopped) await delay(tick);
            }
            await this.die();
        } catch (error) {
            logger.error(`SYSTEM ERROR: ${error_str(error)}`);
            try {
                await this.die();
            } catch (dieError) {
                logger.error(`RED ALERT! SYSTEM IN INCONSISTENT STATE! ERROR DURING DIE: ${error_str(dieError)}`);
            }
        } finally {
            logger.info(`[${getISOTimestamp()}] EXEC MANAGER INFO: STOP`);
        }
    }

   /**
     * Gracefully shuts down the manager.
     * Signals the main loop to stop and triggers cleanup of strategies and watchers.
     * Designed to be called from SIGINT/SIGTERM handlers.
     */
    public shutdown(): void {
        this._isStopped = true;
        logger.warn(`EXEC MANAGER WARN: SHUTDOWN SIGNAL!`);
    }

    /**
     * Performs internal cleanup: cancels all strategies and disposes all watchers.
     * Safe to call multiple times (idempotent).
     * @private
     */
    private async die(): Promise<void> {
        if (this._disposed) return;
        this._disposed = true;

        await Promise.all(this._strategies.map(strategy => strategy.cancel(this._client, this._watchers)));
        await Promise.all(this._watchers.map(async watcher => watcher.dispose()));
    }
}