import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { ClobClient } from "@polymarket/clob-client";
import { logger } from "../../../../log.js";

/**
 * A simple strategy that logs check/execute calls without performing any actions.
 * Useful for debugging or testing the strategy pipeline.
 */
export class LogCoinStrategy implements EventStrategy<CoinFrameEventMarketData> {

    /**
     * Logs that the check phase was called and always returns `false`.
     * @param watchers - Array of event watchers (ignored)
     * @returns Always `false`
     */
    public async check(watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        logger.info("INFO: LogCoinStrategy check..");
        return false;
    }

    /**
     * Logs that the execute phase was called and always returns `false`.
     * @param client - Polymarket CLOB client (ignored)
     * @param watchers - Array of event watchers (ignored)
     * @returns Always `false`
     */
    public async execute(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        logger.info("INFO: LogCoinStrategy execute..");
        return false;
    }

    /**
     * Logs that the cancel phase was called and always returns `true`.
     * @param client - Polymarket CLOB client (ignored)
     * @param watchers - Array of event watchers (ignored)
     * @returns Always `true`
     */
    public async cancel(client: ClobClient, watchers: readonly EventWatcher<CoinFrameEventMarketData>[]): Promise<boolean> {
        logger.info("INFO: LogCoinStrategy cancel..");
        return true;
    }
}