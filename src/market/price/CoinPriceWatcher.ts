import { Coin } from "../coins.js";
import { EventFrame } from "../frame.js";
import { PriceWatcher } from "./PriceWatcher.js";
import { PriceSource } from "./price_source.js";

export type PriceConnectionState = 'open' | 'close' | 'error' | 'stale' | 'reconnect';

export interface PriceConnectionEvent {
    timestamp: number;
    state: PriceConnectionState;
    reason: string | undefined;
}

export type PriceConnectionListener = (event: PriceConnectionEvent) => void;

/** Whether a price stream has been silent for longer than its configured limit. */
export function isPriceStreamStale(
    lastReceivedAt: number | undefined,
    connectedAt: number,
    now: number,
    staleReconnectMs: number,
): boolean {
    return now - (lastReceivedAt ?? connectedAt) > staleReconnectMs;
}

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

    /** Subscribes to source lifecycle events. */
    subscribeConnectionEvents(listener: PriceConnectionListener): () => void;
}
