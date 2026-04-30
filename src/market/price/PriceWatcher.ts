
/**
 * Defines the public contract for a cryptocurrency price watcher using Polymarket RTDS.
 */
export interface PriceWatcher {

    /**
     * Returns the exchange‑specific symbol string used for subscriptions.
     * For Binance source: 'btcusdt', for Chainlink source: 'btc/usd'.
     */
    getSymbol(): string;

    /**
     * Returns the most recent price received from the WebSocket.
     * @returns The latest price, or undefined if not yet received.
     */
    getCurrentPrice(): number | undefined;

    /**
     * Returns the timestamp (milliseconds since epoch) of the last received price update.
     * @returns Timestamp in milliseconds, or undefined if no update yet.
     */
    getTimeStamp(): number | undefined;

    /**
     * This function guarantees that the watcher will establish the first connection 
     * and receive the first price updates after a delay.
     * @param tick Force delay during warming up.
     * @returns Returns itself to chain-call.
     */
    warmUp(tick: number): Promise<this>;

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    disconnect(): void;
}