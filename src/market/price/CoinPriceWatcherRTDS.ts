import { Message, RealTimeDataClient } from "@polymarket/real-time-data-client";

const RTDS_PRICE_NODATA = undefined;

/** Interface for a single crypto price update received from RTDS */
interface RtdsSymbolPriceData {
    symbol: string;                  // e.g., 'btcusdt' or btc/usdt
    value: number | undefined;       // latest price or undefined if not received yet
    timestamp: number | undefined;   // milliseconds since epoch or undefined if not received yet
}

import { Coin, coin_precis } from "../coins.js";
import { CoinPriceWatcher, FRAME_PRICE_TIMEOUT_MS } from "./CoinPriceWatcher.js";
import { PriceSource, PS_BINANCE, PS_CHAINLINK } from "./price_source.js";
import { TIMER_FAST, TIMER_NORM } from "../../timer.js";
import { EventFrame, getCurrentFrameStart, getSupportedFrames, waitFrameStart } from "../frame.js";
import { delay, roundTo, safeToNum } from "../../utils.js";

interface CoinPriceData {
    coin: Coin;          // e.g., 'btc'
    data: RtdsSymbolPriceData
}
type CoinTopic = { source: PriceSource, name: "crypto_prices" | "crypto_prices_chainlink"};

interface FramePriceData {
    price: number | undefined;
    timestamp: number | undefined;
}

/**
 * Watches real‑time symbol prices using Polymarket's RTDS WebSocket.
 * Uses the official @polymarket/real-time-data-client SDK.
 */
export class CoinPriceWatcherRTDS implements CoinPriceWatcher {
    private _rtdcClient: RealTimeDataClient;
    private _priceTopic: CoinTopic;
    private _priceCoinData: CoinPriceData;

   /** Cached start‑of‑frame prices. */
    private _framePrices: Map<EventFrame, FramePriceData> = new Map();

    /** Flags used to stop the background capture loops. */
    private _frameStopFlags: Map<EventFrame, boolean> = new Map();

    public getSource(): PriceSource {
        return this._priceTopic.source;
    }

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
     * @param source - Price source: PS_BINANCE or PS_CHAINLINK.
     */
    constructor(coin: Coin, source: PriceSource) {
        // Map coin to symbol string based on source
        const getSymbol = (coin: Coin, source: PriceSource): string => {
            if (source === PS_BINANCE) {
                return `${coin}usdt`;      // 'btcusdt', 'ethusdt', etc.
            } else {
                return `${coin}/usd`;      // 'btc/usd', 'eth/usd', etc.
            }
        };
        const symbol = getSymbol(coin, source);

        this._priceTopic = {
            source: source,
            name: (source === PS_BINANCE) ? "crypto_prices" : "crypto_prices_chainlink"
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

        // Initialise frame stop flags and start background capture loops
        for (const frame of getSupportedFrames()) {
            this._frameStopFlags.set(frame, false);
            this._framePrices.set(frame, { price: undefined, timestamp: 0 });
        }

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

        this._initAfterFirstPrice();
    }

    /**
     * Returns current price data.
     * @returns Readonly copy of RtdsSymbolPriceData
     */
    public getTimeStamp(): number | undefined {
        return this._priceCoinData.data.timestamp;
    }

    /**
     * Returns the most recent price received from the WebSocket.
     * @returns The latest price, or undefined if not yet received or disconnected.
     */
    public getCurrentPrice(): number | undefined {
        return this._priceCoinData.data.value;
    }

    /**
     * Returns the coin price of the last received price update at the given frame start.
     * @returns Coin price.
     */
    public async getPriceByFrame(frame: EventFrame, timeoutMs: number = FRAME_PRICE_TIMEOUT_MS): Promise<number | undefined> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const data = this._framePrices.get(frame);
            if (data?.price !== undefined) {
                const timestamp = getCurrentFrameStart(frame) * 1000;
                if (data.timestamp === timestamp) {
                    return data.price;
                }
            }
            await delay(TIMER_FAST);
        }
        return undefined;
    }

    /**
     * Polymarket uses rounded prices in coin events not raw rtds data.
     */
    public getCoinPrice(): number | undefined {
        return roundTo(this.getCurrentPrice(), coin_precis(this.getCoin()));
    }

    /**
     * This function guarantees that the watcher will establish the first connection 
     * and receive the first price updates after a delay.
     * @param tick Force delay during warming up.
     * @returns Returns itself to chain-call.
     */
    public async warmUp(tick: number = TIMER_NORM): Promise<this> {
        while(!this.getCurrentPrice()) await delay(tick);
        return this;
    }

    /**
     * Returns the price source (Binance or Chainlink) based on the subscribed topic.
     * @returns PS_BINANCE for crypto_prices, PS_CHAINLINK for crypto_prices_chainlink.
     */
    public getPriceSource(): PriceSource {
        return (this._priceTopic.name === "crypto_prices") ? PS_BINANCE : PS_CHAINLINK;
    }

    /**
     * Returns the exchange-specific symbol string used for subscriptions.
     * For Binance source, this is in lowercase concatenated format (e.g., 'btcusdt').
     * For Chainlink source, this is in slash-separated format (e.g., 'btc/usd').
     * @returns The normalized symbol string (e.g., 'btcusdt' or 'btc/usd')
     */
    public getSymbol(): string {
        return this._priceCoinData.data.symbol;
    }

    /**
     * Returns the generic coin identifier (e.g., 'btc', 'eth') that was passed to the constructor.
     * This represents the cryptocurrency type regardless of the price source.
     * @returns The coin enum value (e.g., Coin.BTC, Coin.ETH)
     */
    public getCoin(): Coin {
        return this._priceCoinData.coin;
    }

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    public disconnect(): void {
        if (this._rtdcClient) {
            this._rtdcClient.disconnect();
        }
        // Stop background frame capture loops
        for (const frame of getSupportedFrames()) {
            this._frameStopFlags.set(frame, true);
        }
        this._framePrices.clear();
    }

    private async _initAfterFirstPrice(): Promise<void> {
        while (this.getCurrentPrice() === undefined) {
            await delay(TIMER_FAST);
        }

        for (const frame of getSupportedFrames()) {
            this._startFrameCapture(frame);
        }
    }

    private _waitForStopFlag(frame: EventFrame): Promise<void> {
        return new Promise(resolve => {
            const check = () => {
                if (this._frameStopFlags.get(frame)) {
                    resolve();
                } else {
                    setTimeout(check, TIMER_FAST);
                }
            };
            check();
        });
    }

    /**
     * Starts a non‑blocking loop that waits for the start of the given frame,
     * captures the current coin price, and repeats for the next frame.
     * The loop can be interrupted immediately via stop flags.
     */
    private _startFrameCapture(frame: EventFrame): void {
        (async () => {
            while (true) {
                await Promise.race([
                    waitFrameStart(frame),
                    this._waitForStopFlag(frame),
                ]);

                if (this._frameStopFlags.get(frame)) break;

                const timestamp = getCurrentFrameStart(frame) * 1000;
                const price = await this._captureFramePrice(frame);
                this._framePrices.set(frame, { price, timestamp });
            }
        })();
    }

    private async _captureFramePrice(frame: EventFrame): Promise<number | undefined> {
        const frameStartMs = getCurrentFrameStart(frame) * 1000;
        const prices: number[] = [];
        const startTime = Date.now();
        const MAX_WAIT_MS = FRAME_PRICE_TIMEOUT_MS;

        while (Date.now() - startTime < MAX_WAIT_MS) {
            const { value: price, timestamp } = this._priceCoinData.data;

            if (price !== undefined) {
                prices.push(price);
            }

            if (timestamp !== undefined && timestamp >= frameStartMs) {
                const delayMs = timestamp - frameStartMs;

                if (delayMs <= TIMER_FAST * 3 && price !== undefined) {
                    return roundTo(price, coin_precis(this.getCoin()));
                } else if (prices.length > 0) {
                    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
                    return roundTo(avg, coin_precis(this.getCoin()));
                } else {
                    return undefined;
                }

            }
            await delay(TIMER_FAST);
        }

        if (prices.length === 0) return undefined;
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        return roundTo(avg, coin_precis(this.getCoin()));
    }
}
