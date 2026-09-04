import { createPublicClient } from "@polymarket/client";
import { Coin, coin_precis } from "../coins.js";
import { CoinPriceWatcher, isPriceStreamStale, PriceConnectionEvent, PriceConnectionListener } from "./CoinPriceWatcher.js";
import { getPriceSourceConfig, PriceSource, PS_CHAINLINK_TWAP_30, PS_CHAINLINK_TWAP_60 } from "./price_source.js";
import { EventFrame, getCurrentFrameStart, getFrameDurationMs, getSupportedFrames, waitFrameStartMsUntil } from "../frame.js";
import { delay, error_str, roundTo, safeToNum } from "../../utils.js";
import { logger } from "../../log.js";
import { TIMER_FAST, TIMER_NORM } from "../../timer.js";

/** Chainlink TWAP subscription topic used by @polymarket/client. */
const PS_CHAINLINK_TWAP_TOPIC = "prices.crypto.chainlink.twap";

/** Delay between subscription retry attempts. */
const TWAP_RECONNECT_DELAY_MS = 1000;

/** Latest TWAP price update state. */
interface TwapSymbolPriceData {
    symbol: string;
    value: number | undefined;
    timestamp: number | undefined; // Chainlink observation time (ms)
}

interface CoinTwapPriceData {
    coin: Coin;
    data: TwapSymbolPriceData;
}

interface FramePriceData {
    price: number | undefined;
    timestamp: number | undefined;
}

interface TwapSubscriptionRequest {
    topic: typeof PS_CHAINLINK_TWAP_TOPIC;
    windowSeconds: 30 | 60;
    symbols: string[];
}

interface TwapSubscriptionHandle extends AsyncIterable<{ payload: TwapPayload }> {
    close(): Promise<void>;
}

interface TwapClient {
    subscribe(requests: readonly TwapSubscriptionRequest[]): Promise<TwapSubscriptionHandle>;
}

/** Payload of a Chainlink TWAP update (as delivered by @polymarket/client). */
interface TwapPayload {
    symbol: string;          // e.g. 'btc/usd'
    timestamp: number;       // Chainlink observation time (epoch ms)
    value: string;           // exact decimal string (e.g. '65000.5')
    windowSeconds: 30 | 60;
}

/**
 * Watches Chainlink TWAP prices (30s or 60s lookback window) via Polymarket's
 * unified `@polymarket/client` SDK. Implements the same {@link CoinPriceWatcher}
 * contract as {@link CoinPriceWatcherRTDS}, but reads the TWAP stream used by
 * the up/down coin markets for resolution.
 *
 * The frame start price is captured by a background loop at each frame boundary:
 * the first TWAP update whose Chainlink observation timestamp is at/after the
 * boundary is recorded as that frame's start price (mirrors CoinPriceWatcherRTDS).
 */
export class CoinPriceWatcherTWAP implements CoinPriceWatcher {
    private readonly _coin: Coin;
    private readonly _source: PriceSource;
    private readonly _symbol: string;
    private readonly _windowSeconds: 30 | 60;
    private readonly _client: TwapClient;

    private _priceCoinData: CoinTwapPriceData;

    private _framePrices: Map<EventFrame, FramePriceData> = new Map();
    private _frameStopFlags: Map<EventFrame, boolean> = new Map();

    private _handle: TwapSubscriptionHandle | undefined = undefined;
    private _disposed = false;
    private _connectedAt = 0;
    private _lastReceivedAt: number | undefined;
    private _watchdog: ReturnType<typeof setInterval> | undefined;
    private _hasConnected = false;
    private readonly _connectionListeners = new Set<PriceConnectionListener>();

    private readonly _onTwapEvent = (payload: TwapPayload): void => {
        if (payload.symbol.toLowerCase() !== this._symbol) return;
        this._priceCoinData.data.value = safeToNum(payload.value);
        this._priceCoinData.data.timestamp = payload.timestamp;
        this._lastReceivedAt = Date.now();
    };

    constructor(coin: Coin, source: PriceSource, client: TwapClient = createPublicClient()) {
        this._coin = coin;
        this._source = source;
        this._symbol = `${coin}/usd`;
        this._client = client;

        if (source === PS_CHAINLINK_TWAP_30) {
            this._windowSeconds = 30;
        } else if (source === PS_CHAINLINK_TWAP_60) {
            this._windowSeconds = 60;
        } else {
            throw new Error(`[CoinPriceWatcherTWAP] Unsupported price source: ${source}`);
        }

        this._priceCoinData = {
            coin,
            data: { symbol: this._symbol, value: undefined, timestamp: undefined },
        };

        for (const frame of getSupportedFrames()) {
            this._frameStopFlags.set(frame, false);
            this._framePrices.set(frame, { price: undefined, timestamp: 0 });
        }

        this._start();
        this._initAfterFirstPrice();
    }

    private async _start(): Promise<void> {
        while (!this._disposed) {
            try {
                const handle = await this._client.subscribe([{
                    topic: PS_CHAINLINK_TWAP_TOPIC,
                    windowSeconds: this._windowSeconds,
                    symbols: [this._symbol],
                }]);
                this._handle = handle;
                this._connectedAt = Date.now();
                this._lastReceivedAt = undefined;
                this.emitConnectionEvent(this._hasConnected ? 'reconnect' : 'open', undefined);
                this._hasConnected = true;
                this.startWatchdog(handle);

                for await (const event of handle) {
                    if (this._disposed) break;
                    this._onTwapEvent(event.payload);
                }

                if (this._disposed) return;

                // stream ended unexpectedly — close it and retry
                this.stopWatchdog();
                handle.close().catch(() => {});
                this._handle = undefined;
                this.emitConnectionEvent('close', 'stream_ended');
                logger.warn(`[CoinPriceWatcherTWAP] TWAP stream ended unexpectedly, retrying...`);
            } catch (error) {
                this.stopWatchdog();
                this._priceCoinData.data.value = undefined;
                this._priceCoinData.data.timestamp = undefined;
                if (this._disposed) return;
                this._handle = undefined;
                this.emitConnectionEvent('error', error_str(error));
                logger.warn(`[CoinPriceWatcherTWAP] Subscription error: ${error_str(error)}, retrying...`);
            }
            await delay(TWAP_RECONNECT_DELAY_MS);
        }
    }

    public getSymbol(): string {
        return this._symbol;
    }

    public getSource(): PriceSource {
        return this._source;
    }

    public getCurrentPrice(): number | undefined {
        return this._priceCoinData.data.value;
    }

    public getTimeStamp(): number | undefined {
        return this._priceCoinData.data.timestamp;
    }

    public getCoin(): Coin {
        return this._coin;
    }

    public getCoinPrice(): number | undefined {
        return roundTo(this._priceCoinData.data.value, coin_precis(this._coin));
    }

    public async warmUp(tick: number = TIMER_NORM): Promise<this> {
        while (!this.getCurrentPrice()) await delay(tick);
        return this;
    }

    public async getPriceByFrame(
        frame: EventFrame,
        timeoutMs: number = getPriceSourceConfig(this._source).framePriceReadTimeoutMs,
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

    public disconnect(): void {
        this._disposed = true;
        this.stopWatchdog();
        if (this._handle) {
            this._handle.close().catch(() => {});
        }
        for (const frame of getSupportedFrames()) {
            this._frameStopFlags.set(frame, true);
        }
        this._framePrices.clear();
    }

    public subscribeConnectionEvents(listener: PriceConnectionListener): () => void {
        this._connectionListeners.add(listener);
        return () => this._connectionListeners.delete(listener);
    }

    private emitConnectionEvent(state: PriceConnectionEvent['state'], reason: string | undefined): void {
        const event: PriceConnectionEvent = { timestamp: Date.now(), state, reason };
        this._connectionListeners.forEach(listener => listener(event));
    }

    private startWatchdog(handle: TwapSubscriptionHandle): void {
        this.stopWatchdog();
        const staleReconnectMs = getPriceSourceConfig(this._source).staleReconnectMs;
        this._watchdog = setInterval(() => {
            if (this._disposed || this._handle !== handle ||
                !isPriceStreamStale(this._lastReceivedAt, this._connectedAt, Date.now(), staleReconnectMs)) return;
            this._priceCoinData.data.value = undefined;
            this._priceCoinData.data.timestamp = undefined;
            this._lastReceivedAt = undefined;
            this._handle = undefined;
            this.emitConnectionEvent('stale', `no_price_update_for_${staleReconnectMs}ms`);
            logger.warn(`[CoinPriceWatcherTWAP] No price update for ${staleReconnectMs}ms, reconnecting...`);
            this.stopWatchdog();
            handle.close().catch(error => this.emitConnectionEvent('error', error_str(error)));
        }, TIMER_FAST);
    }

    // ---------------------------- FRAME CAPTURE ----------------------------
    private async _initAfterFirstPrice(): Promise<void> {
        while (this.getCurrentPrice() === undefined && !this._disposed) {
            await delay(TIMER_FAST);
        }
        for (const frame of getSupportedFrames()) {
            this._startFrameCapture(frame);
        }
    }

    private _startFrameCapture(frame: EventFrame): void {
        (async () => {
            while (true) {
                await waitFrameStartMsUntil(getFrameDurationMs(frame), () => this._frameStopFlags.get(frame) === true);
                if (this._frameStopFlags.get(frame)) break;

                const timestamp = getCurrentFrameStart(frame) * 1000;
                const price = await this._captureFramePrice(timestamp);
                this._framePrices.set(frame, { price, timestamp });
            }
        })();
    }

    /** Waits for the first TWAP update whose observation timestamp is at/after the frame start. */
    private async _captureFramePrice(frameStartMs: number): Promise<number | undefined> {
        const start = Date.now();
        const timeoutMs = getPriceSourceConfig(this._source).framePriceCaptureTimeoutMs;
        while (Date.now() - start < timeoutMs) {
            const { value, timestamp } = this._priceCoinData.data;
            if (value !== undefined && timestamp !== undefined && timestamp >= frameStartMs) {
                return roundTo(value, coin_precis(this._coin));
            }
            await delay(TIMER_FAST);
        }
        return undefined;
    }

    private stopWatchdog(): void {
        if (this._watchdog !== undefined) clearInterval(this._watchdog);
        this._watchdog = undefined;
    }
}
