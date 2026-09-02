import { Coin } from "../coins.js";
import { EventFrame } from "../frame.js";
import { PriceWatcher } from "./PriceWatcher.js";
import { PriceSource } from "./price_source.js";

export const FRAME_PRICE_TIMEOUT_MS = 3000;

/**
 * Defines the public contract for a cryptocurrency coin price watcher.
 */
export interface CoinPriceWatcher extends PriceWatcher {
    /** Returns the configured external price source. */
    getSource(): PriceSource;

    /**
     * Returns the generic coin identifier (e.g., 'btc', 'eth') that uses by watcher.
     * This represents the cryptocurrency type regardless of the price source.
     * @returns The coin enum value (e.g., Coin.BTC, Coin.ETH)
     */
    getCoin(): Coin;

    /**
     * Polymarket uses rounded prices in coin events not raw rtds data.
     */
    getCoinPrice(): number | undefined;

    /**
     * Returns the coin price of the last received price update at the given frame start.
     * @returns Coin price.
     */
    getPriceByFrame(frame: EventFrame, timeoutMs?: number): Promise<number | undefined>;
}