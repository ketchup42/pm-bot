import { Message, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { safeToNum } from "../utils.js";

export const RTDS_PRICE_NODATA = -1;

/** Interface for a single crypto price update received from RTDS */
export interface RtdsSymbolPriceData {
    symbol: string;      // e.g., 'btcusdt'
    value: number;       // latest price
    timestamp: number;   // milliseconds since epoch
    
    full_accuracy_value?: string; //  WS API Optional field
}

/**
 * Watches real‑time symbol prices using Polymarket's RTDS WebSocket.
 * Uses the official @polymarket/real-time-data-client SDK.
 */
export class PriceWatcherRTDC {
    private _rtdcClient: RealTimeDataClient;
    private _priceSymData: RtdsSymbolPriceData;

    /**
     * Callback triggered for every incoming WebSocket message.
     * Filters only 'crypto_prices' updates and matches the subscribed symbol.
     */
    private readonly _onMessage = (client: RealTimeDataClient, message: Message): void => {
        // Process only price update messages
        if (message.topic === 'crypto_prices' && message.type === 'update') {
            const payload = message.payload as RtdsSymbolPriceData;
            // Compare symbols case‑insensitively
            if (payload && payload.symbol.toLowerCase() === this._priceSymData.symbol) {
                // Store the latest price and timestamp
                    const price = payload.full_accuracy_value !== undefined 
                    ? safeToNum(payload.full_accuracy_value)
                    : payload.value;
                    
                this._priceSymData.value = price;
                this._priceSymData.timestamp = payload.timestamp;
            }
        }
    };

    /**
     * Creates a new price watcher and immediately connects to the RTDS WebSocket.
     * @param symbol - Crypto symbol, e.g., 'btcusdt', 'ethusdt' (case‑insensitive)
     */
    constructor(symbol: string) {
        // Initialize internal data store (no price yet)
        this._priceSymData = {
            symbol: symbol.toLowerCase().trim(),
            value: RTDS_PRICE_NODATA,
            timestamp: RTDS_PRICE_NODATA
        };

        /**
         * Callback invoked when the WebSocket connection is established (or re‑established).
         * Subscribes to the 'crypto_prices' topic with a filter for our specific symbol.
         */
        const onConnect = (client: RealTimeDataClient): void => {
            // IMPORTANT: The `filters` field must be a JSON string containing an object with the key "symbol".
            // Example: '{"symbol":"BTCUSDT"}'
            client.subscribe({
                subscriptions: [
                    {
                        topic: "crypto_prices",
                        type: "update",                         // Use "*" to subscribe to all types
                        filters: JSON.stringify({ symbol: symbol.toUpperCase().trim() }),
                    },
                ],
            });
        };

        // Create the SDK client and initiate the connection
        this._rtdcClient = new RealTimeDataClient({
            onMessage: this._onMessage,
            onConnect,
        }).connect();
    }

    /**
     * Returns a **copy** of the current price data.
     * A copy is returned to prevent external code from mutating the internal state.
     * @returns Readonly copy of RtdsSymbolPriceData
     */
    getData(): Readonly<RtdsSymbolPriceData> {
        return { ...this._priceSymData };
    }

    /**
     * Returns the most recent price received from the WebSocket.
     * @returns The latest price, or RTDS_PRICE_NODATA (-1) if not yet received or disconnected.
     */
    getCurrentPrice(): number {
        return this._priceSymData.value;
    }

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    public disconnect(): void {
        if (this._rtdcClient) {
            this._rtdcClient.disconnect();
        }
    }
}