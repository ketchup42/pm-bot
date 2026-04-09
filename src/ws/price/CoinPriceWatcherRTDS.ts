import { Message, RealTimeDataClient } from "@polymarket/real-time-data-client";
import { safeToNum } from "../../utils.js";

export const RTDS_PRICE_NODATA = -1;

export type PriceSource = "binance" | "chainlink";
type CoinTopic = { source: PriceSource, name: "crypto_prices" | "crypto_prices_chainlink"};


/** Interface for a single crypto price update received from RTDS */
interface RtdsSymbolPriceData {
    symbol: string;      // e.g., 'btcusdt' or btc/usdt
    value: number;       // latest price
    timestamp: number;   // milliseconds since epoch
}

import { Coin } from "../coins.js";

interface CoinPriceData {
    coin: Coin;          // e.g., 'btc' or btc
    data: RtdsSymbolPriceData
}

/**
 * Watches real‑time symbol prices using Polymarket's RTDS WebSocket.
 * Uses the official @polymarket/real-time-data-client SDK.
 */
export class CoinPriceWatcherRTDS {
    private _rtdcClient: RealTimeDataClient;

    private _priceTopic: CoinTopic;
    private _priceCoinData: CoinPriceData;

    /**
     * Callback triggered for every incoming WebSocket message.
     */
    private readonly _onMessage = (client: RealTimeDataClient, message: Message): void => {
        // Process only price update messages
        if (message.topic === this._priceTopic.name && message.type === "update") {
            const payload = message.payload as RtdsSymbolPriceData;
            // Compare symbols case‑insensitively
            if (payload && payload.symbol.toLowerCase() === this._priceCoinData.data.symbol) {
                // Store the latest price and timestamp
                    const price = safeToNum(payload.value);
                    
                this._priceCoinData.data.value = price;
                this._priceCoinData.data.timestamp = payload.timestamp;
            }
        }
    };

    /**
     * Creates a new price watcher and immediately connects to the RTDS WebSocket.
     * @param coin - Crypto coin, e.g., 'btc', 'eth'
     * @param source - Price source: 'binance' or 'chainlink' (default 'binance')
     */
    constructor(coin: Coin, source: PriceSource = "binance") {
        // Map coin to symbol string based on source
        const getSymbol = (coin: Coin, source: PriceSource): string => {
            if (source === 'binance') {
                return `${coin}usdt`;      // 'btcusdt', 'ethusdt', etc.
            } else {
                return `${coin}/usd`;      // 'btc/usd', 'eth/usd', etc.
            }
        };
        const symbol = getSymbol(coin, source);

        this._priceTopic = {
            source: source,
            name: (source === "binance") ? "crypto_prices" : "crypto_prices_chainlink"
        };

        // Initialize internal data store (no price yet)
        this._priceCoinData = {
            coin: coin,
            data: {
                symbol: symbol.toLowerCase().trim(),
                value: RTDS_PRICE_NODATA,
                timestamp: RTDS_PRICE_NODATA,
            }
        };
        
        /**
         * Callback invoked when the WebSocket connection is established (or re‑established).
         * Subscribes to the topic with a filter for our specific symbol.
         */
        const onConnect = (client: RealTimeDataClient): void => {
            // IMPORTANT: The `filters` field must be a JSON string containing an object with the key "symbol".
            // Example: '{"symbol":"BTCUSDT"}'
            // https://github.com/Polymarket/real-time-data-client?tab=readme-ov-file#messages-hierarchy
            const filters = JSON.stringify({ symbol: symbol.toLowerCase().trim() });
            client.subscribe({
                subscriptions: [
                    {
                        topic: this._priceTopic.name,
                        type: "update", // Use "*" to subscribe to all types
                        filters: filters,
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
     * Returns current price data.
     * @returns Readonly copy of RtdsSymbolPriceData
     */
    getTimeStamp(): number {
        return this._priceCoinData.data.timestamp;
    }

    /**
     * Returns the most recent price received from the WebSocket.
     * @returns The latest price, or RTDS_PRICE_NODATA (-1) if not yet received or disconnected.
     */
    getCurrentPrice(): number {
        return this._priceCoinData.data.value;
    }
    /**
     * Returns the price source (Binance or Chainlink) based on the subscribed topic.
     * @returns 'binance' for crypto_prices, 'chainlink' for crypto_prices_chainlink
     */
    getPriceSource(): PriceSource {
        return (this._priceTopic.name === "crypto_prices") ? "binance" : "chainlink";
    }

    /**
     * Returns the exchange-specific symbol string used for subscriptions.
     * For Binance source, this is in lowercase concatenated format (e.g., 'btcusdt').
     * For Chainlink source, this is in slash-separated format (e.g., 'btc/usd').
     * @returns The normalized symbol string (e.g., 'btcusdt' or 'btc/usd')
     */
    getSymbol(): string {
        return this._priceCoinData.data.symbol;
    }

    /**
     * Returns the generic coin identifier (e.g., 'btc', 'eth') that was passed to the constructor.
     * This represents the cryptocurrency type regardless of the price source.
     * @returns The coin enum value (e.g., Coin.BTC, Coin.ETH)
     */
    getCoin(): Coin {
        return this._priceCoinData.coin;
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