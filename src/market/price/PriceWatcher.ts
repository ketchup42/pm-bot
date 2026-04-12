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
     * @returns The latest price, or `RTDS_PRICE_NODATA` (-1) if not yet received.
     */
    getCurrentPrice(): number;

    /**
     * Returns the timestamp (milliseconds since epoch) of the last received price update.
     * @returns Timestamp in milliseconds, or `RTDS_PRICE_NODATA` (-1) if no update yet.
     */
    getTimeStamp(): number;

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    disconnect(): void;
}