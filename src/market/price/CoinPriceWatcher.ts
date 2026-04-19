import { Coin } from "../coins.js";
import { PriceWatcher } from "./PriceWatcher.js";

/**
 * Defines the public contract for a cryptocurrency coin price watcher.
 */
export interface CoinPriceWatcher extends PriceWatcher {
    /**
     * Returns the generic coin identifier (e.g., 'btc', 'eth') that uses by watcher.
     * This represents the cryptocurrency type regardless of the price source.
     * @returns The coin enum value (e.g., Coin.BTC, Coin.ETH)
     */
    getCoin(): Coin;
}