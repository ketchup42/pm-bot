import {
    ConnectionStatus,
    Message,
    RealTimeDataClient,
    RealTimeDataClientArgs,
} from "@polymarket/real-time-data-client";

const RTDS_PRICE_NODATA = undefined;

/** Interface for a single crypto price update received from RTDS */
interface RtdsSymbolPriceData {
    symbol: string;                  // e.g., 'btcusdt' or btc/usdt
    value: number | undefined;       // latest price or undefined if not received yet
    timestamp: number | undefined;   // milliseconds since epoch or undefined if not received yet
}

import { Coin, coin_precis } from "../coins.js";
import { CoinPriceWatcher, isPriceStreamStale, PriceConnectionEvent, PriceConnectionListener } from "./CoinPriceWatcher.js";
import { getPriceSourceConfig, PriceSource, PS_BINANCE, PS_CHAINLINK } from "./price_source.js";
import { TIMER_FAST, TIMER_NORM } from "../../timer.js";
import { EventFrame, getCurrentFrameStart, getFrameDurationMs, getSupportedFrames, waitFrameStartMsUntil } from "../frame.js";
import { delay, positiveFiniteNumberOrUndefined, roundTo } from "../../utils.js";
import { logger } from "../../log.js";

interface CoinPriceData {
    coin: Coin;          // e.g., 'btc'
    data: RtdsSymbolPriceData
}

interface FramePriceData {
    price: number | undefined;
    timestamp: number | undefined;
}

type CoinTopic = { source: PriceSource, name: "crypto_prices" | "crypto_prices_chainlink"};

interface RtdsClient {
    connect(): RtdsClient;
    disconnect(): void;
    subscribe(message: unknown): void;
}

type RtdsClientFactory = (args: RealTimeDataClientArgs) => RtdsClient;

const createRtdsClient: RtdsClientFactory = args => new RealTimeDataClient(args);

/**
 * Watches real‑time symbol prices using Polymarket's RTDS WebSocket.
 * Uses the official @polymarket/real-time-data-client SDK.
 */
export class CoinPriceWatcherRTDS implements CoinPriceWatcher {
    private _rtdcClient: RtdsClient | undefined;
    private _priceTopic: CoinTopic;
    private _priceCoinData: CoinPriceData;

    /** Cached start‑of‑frame prices. */
    private _framePrices: Map<EventFrame, FramePriceData> = new Map();

    /** Flags used to stop the background capture loops. */
    private _frameStopFlags: Map<EventFrame, boolean> = new Map();

    private _disposed = false;
    private _connectedAt = 0;
    private _lastReceivedAt: number | undefined;
    private _watchdog: ReturnType<typeof setInterval> | undefined;
    private _hasConnected = false;
    private readonly _connectionListeners = new Set<PriceConnectionListener>();

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
                const price = positiveFiniteNumberOrUndefined(payload.value);
                const timestamp = positiveFiniteNumberOrUndefined(payload.timestamp);
                if (price === undefined || timestamp === undefined) return;
                this._priceCoinData.data.value = price;
                this._priceCoinData.data.timestamp = timestamp;
                this._lastReceivedAt = Date.now();
            }
        }
    };

    /**
     * Creates a new price watcher and immediately connects to the RTDS WebSocket.
     * @param coin - Crypto coin, e.g., 'btc', 'eth'
     * @param source - Price source: PS_BINANCE or PS_CHAINLINK.
     */
    constructor(coin: Coin, source: PriceSource, private readonly clientFactory: RtdsClientFactory = createRtdsClient) {
        if (source !== PS_BINANCE && source !== PS_CHAINLINK) {
            throw new Error(`[CoinPriceWatcherRTDS] Unsupported price source: ${source}`);
        }
        const symbol = source === PS_BINANCE ? `${coin}usdt` : `${coin}/usd`;

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

        for (const frame of getSupportedFrames()) {
            this._frameStopFlags.set(frame, false);
            this._framePrices.set(frame, { price: undefined, timestamp: 0 });
        }

        /**
         * Callback invoked when the WebSocket connection is established (or re‑established).
         * Subscribes to the topic with a filter for our specific symbol.
         */
        this.startClient();
        this._initAfterFirstPrice();
    }

    private startClient(): void {
        let client: RtdsClient;
        const onConnect = (connectedClient: RealTimeDataClient): void => {
            if (this._rtdcClient !== client) return;
            // IMPORTANT: The `filters` field must be a JSON string containing an object with the key "symbol".
            // Example: '{"symbol":"BTCUSDT"}'
            // https://github.com/Polymarket/real-time-data-client?tab=readme-ov-file#messages-hierarchy
            const filters = JSON.stringify({ symbol: this.getSymbol() });
            connectedClient.subscribe({
                subscriptions: [
                    {
                        topic: this._priceTopic.name,
                        type: "update", // Use "*" to subscribe to all types
                        filters: filters,
                    },
                ],
            });
        };
        const onStatusChange = (status: ConnectionStatus): void => {
            if (this._rtdcClient !== client || this._disposed) return;
            if (status === ConnectionStatus.CONNECTED) {
                this._connectedAt = Date.now();
                this._lastReceivedAt = undefined;
                this.emitConnectionEvent(this._hasConnected ? 'reconnect' : 'open', undefined);
                this._hasConnected = true;
                this.startWatchdog(client);
            } else if (status === ConnectionStatus.DISCONNECTED) {
                this.stopWatchdog();
                this._priceCoinData.data.value = undefined;
                this._priceCoinData.data.timestamp = undefined;
                this.emitConnectionEvent('close', 'disconnected');
            }
        };
        client = this.clientFactory({
            onMessage: this._onMessage,
            onConnect,
            onStatusChange,
        });
        this._rtdcClient = client;
        client.connect();
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
    public async getPriceByFrame(
        frame: EventFrame,
        timeoutMs: number = getPriceSourceConfig(this.getSource()).framePriceReadTimeoutMs,
    ): Promise<number | undefined> {
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
        return this.getSource();
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

    public subscribeConnectionEvents(_listener: PriceConnectionListener): () => void {
        this._connectionListeners.add(_listener);
        return () => this._connectionListeners.delete(_listener);
    }

    /**
     * Gracefully closes the WebSocket connection and cleans up resources.
     */
    public disconnect(): void {
        this._disposed = true;
        this.stopWatchdog();
        this._rtdcClient?.disconnect();
        this._rtdcClient = undefined;
        // Stop background frame capture loops
        for (const frame of getSupportedFrames()) {
            this._frameStopFlags.set(frame, true);
        }
        this._framePrices.clear();
    }

    private emitConnectionEvent(state: PriceConnectionEvent['state'], reason: string | undefined): void {
        const event: PriceConnectionEvent = { timestamp: Date.now(), state, reason };
        this._connectionListeners.forEach(listener => listener(event));
    }

    private startWatchdog(client: RtdsClient): void {
        this.stopWatchdog();
        const staleReconnectMs = getPriceSourceConfig(this.getSource()).staleReconnectMs;
        this._watchdog = setInterval(() => {
            if (this._disposed || this._rtdcClient !== client ||
                !isPriceStreamStale(this._lastReceivedAt, this._connectedAt, Date.now(), staleReconnectMs)) return;
            this._priceCoinData.data.value = undefined;
            this._priceCoinData.data.timestamp = undefined;
            this._lastReceivedAt = undefined;
            this._rtdcClient = undefined;
            this.emitConnectionEvent('stale', `no_price_update_for_${staleReconnectMs}ms`);
            logger.warn(`[CoinPriceWatcherRTDS] No price update for ${staleReconnectMs}ms, reconnecting...`);
            this.stopWatchdog();
            client.disconnect();
            this.startClient();
        }, TIMER_FAST);
    }

    private async _initAfterFirstPrice(): Promise<void> {
        while (this.getCurrentPrice() === undefined && !this._disposed) {
            await delay(TIMER_FAST);
        }

        for (const frame of getSupportedFrames()) {
            this._startFrameCapture(frame);
        }
    }

    private stopWatchdog(): void {
        if (this._watchdog !== undefined) clearInterval(this._watchdog);
        this._watchdog = undefined;
    }

    /**
     * Starts a non‑blocking loop that waits for the start of the given frame,
     * captures the current coin price, and repeats for the next frame.
     * The loop can be interrupted immediately via stop flags.
     */
    private _startFrameCapture(frame: EventFrame): void {
        (async () => {
            while (true) {
                await waitFrameStartMsUntil(getFrameDurationMs(frame), () => this._frameStopFlags.get(frame) === true);
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
        const maxWaitMs = getPriceSourceConfig(this.getSource()).framePriceCaptureTimeoutMs;

        while (Date.now() - startTime < maxWaitMs) {
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
