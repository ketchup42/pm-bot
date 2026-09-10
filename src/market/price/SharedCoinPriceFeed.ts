import { createPublicClient } from '@polymarket/client';
import { ConnectionStatus, Message, RealTimeDataClient, RealTimeDataClientArgs } from '@polymarket/real-time-data-client';
import { Coin } from '../coins.js';
import { TIMER_FAST } from '../../timer.js';
import { delay, error_str, safeToNum } from '../../utils.js';
import { logger } from '../../log.js';
import { isPriceStreamStale, PriceConnectionListener, PriceConnectionState } from './CoinPriceWatcher.js';
import { getPriceSourceConfig, getPriceSourceReconnectDelayMs, getPriceSourceSymbol, isTwapPriceSource, PriceSource, PS_BINANCE, PS_CHAINLINK_TWAP_30 } from './price_source.js';

interface PriceState { value: number | undefined; timestamp: number | undefined; receivedAt: number | undefined; }
interface TwapPayload { symbol: string; timestamp: number; value: string; }
interface TwapHandle extends AsyncIterable<{ payload: TwapPayload }> { close(): Promise<void>; }
interface TwapClient { subscribe(requests: readonly { topic: 'prices.crypto.chainlink.twap'; windowSeconds: 30 | 60; symbols: string[] }[]): Promise<TwapHandle>; }
interface RtdsClient { connect(): RtdsClient; disconnect(): void; subscribe(message: unknown): void; }
type RtdsClientFactory = (args: RealTimeDataClientArgs) => RtdsClient;
type FeedClient = TwapClient | RtdsClientFactory | undefined;

export interface SharedCoinPriceFeed {
    getSource(): PriceSource;
    getPrice(coin: Coin): number | undefined;
    getTimestamp(coin: Coin): number | undefined;
    retain(coin: Coin): void;
    release(coin: Coin): void;
    subscribe(coin: Coin, listener: PriceConnectionListener): () => void;
}

const TWAP_TOPIC = 'prices.crypto.chainlink.twap' as const;
/** One source transport distributing timestamped prices to all active coin views. */
export class SharedCoinPriceFeed {
    private readonly states: ReadonlyMap<Coin, PriceState>;
    private readonly listeners = new Map<Coin, Set<PriceConnectionListener>>();
    private readonly activeCounts = new Map<Coin, number>();
    private disposed = false;
    private connectedAt = 0;
    private watchdog: ReturnType<typeof setInterval> | undefined;
    private twapHandle: TwapHandle | undefined;
    private rtdsClient: RtdsClient | undefined;
    private rtdsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private rtdsFailedAttempts = 0;
    private hasConnected = false;

    public constructor(private readonly source: PriceSource, private readonly coins: readonly Coin[], private readonly client: FeedClient = undefined) {
        this.states = new Map(coins.map(coin => [coin, { value: undefined, timestamp: undefined, receivedAt: undefined }]));
        coins.forEach(coin => this.listeners.set(coin, new Set()));
        if (isTwapPriceSource(source)) void this.startTwap();
        else this.startRtds();
    }

    public getSource(): PriceSource { return this.source; }
    public getPrice(coin: Coin): number | undefined { return this.states.get(coin)?.value; }
    public getTimestamp(coin: Coin): number | undefined { return this.states.get(coin)?.timestamp; }
    public retain(coin: Coin): void {
        if (!this.states.has(coin)) throw new Error(`Unsupported shared feed coin: ${coin}`);
        this.activeCounts.set(coin, (this.activeCounts.get(coin) ?? 0) + 1);
    }

    public release(coin: Coin): void {
        const count = this.activeCounts.get(coin) ?? 0;
        if (count > 1) this.activeCounts.set(coin, count - 1);
        else this.activeCounts.delete(coin);
        if (this.activeCounts.size !== 0) return;
        this.disposed = true;
        this.stopWatchdog();
        if (this.rtdsReconnectTimer !== undefined) clearTimeout(this.rtdsReconnectTimer);
        this.rtdsReconnectTimer = undefined;
        this.twapHandle?.close().catch(() => {});
        this.rtdsClient?.disconnect();
    }

    public subscribe(coin: Coin, listener: PriceConnectionListener): () => void {
        const listeners = this.listeners.get(coin);
        if (listeners === undefined) throw new Error(`Unsupported shared feed coin: ${coin}`);
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    private update(symbol: string, rawValue: unknown, rawTimestamp: unknown): void {
        const coin = this.coins.find(candidate => getPriceSourceSymbol(candidate, this.source) === symbol.toLowerCase());
        const value = safeToNum(rawValue, Number.NaN);
        const timestamp = safeToNum(rawTimestamp, Number.NaN);
        if (coin === undefined || !Number.isFinite(value) || !Number.isFinite(timestamp)) return;
        const state = this.states.get(coin)!;
        state.value = value;
        state.timestamp = timestamp;
        state.receivedAt = Date.now();
    }

    private emit(coin: Coin, state: PriceConnectionState, reason: string | undefined): void {
        const event = { timestamp: Date.now(), state, reason } as const;
        this.listeners.get(coin)?.forEach(listener => listener(event));
    }

    private emitActive(state: 'open' | 'close' | 'error' | 'reconnect', reason: string | undefined): void {
        this.activeCounts.forEach((_count, coin) => this.emit(coin, state, reason));
    }

    private connect(): void {
        this.connectedAt = Date.now();
        this.emitActive(this.hasConnected ? 'reconnect' : 'open', undefined);
        this.hasConnected = true;
        this.startWatchdog();
    }

    private startWatchdog(): void {
        this.stopWatchdog();
        const staleReconnectMs = getPriceSourceConfig(this.source).staleReconnectMs;
        this.watchdog = setInterval(() => {
            if (this.disposed) return;
            const stale = [...this.activeCounts.keys()].filter(coin =>
                isPriceStreamStale(this.states.get(coin)?.receivedAt, this.connectedAt, Date.now(), staleReconnectMs),
            );
            if (stale.length === 0) return;
            stale.forEach(coin => this.emit(coin, 'stale', `no_price_update_for_${staleReconnectMs}ms`));
            this.stopWatchdog();
            this.clearPrices();
            this.twapHandle?.close().catch(error => stale.forEach(coin => this.emit(coin, 'error', error_str(error))));
            const client = this.rtdsClient;
            if (client !== undefined) {
                this.rtdsClient = undefined;
                client.disconnect();
                this.scheduleRtdsReconnect();
            }
        }, TIMER_FAST);
    }

    private stopWatchdog(): void { if (this.watchdog !== undefined) clearInterval(this.watchdog); this.watchdog = undefined; }
    private clearPrices(): void { this.states.forEach(state => { state.value = undefined; state.timestamp = undefined; state.receivedAt = undefined; }); }

    private scheduleRtdsReconnect(): void {
        if (this.disposed || this.rtdsReconnectTimer !== undefined) return;
        this.rtdsFailedAttempts++;
        const delayMs = getPriceSourceReconnectDelayMs(this.source, this.rtdsFailedAttempts);
        logger.warn(`[SharedCoinPriceFeed] RTDS reconnect attempt=${this.rtdsFailedAttempts} delay=${delayMs}ms`);
        this.rtdsReconnectTimer = setTimeout(() => {
            this.rtdsReconnectTimer = undefined;
            if (!this.disposed && this.rtdsClient === undefined) this.startRtds();
        }, delayMs);
    }

    private async startTwap(): Promise<void> {
        const client = (this.client ?? createPublicClient()) as TwapClient;
        const windowSeconds = this.source === PS_CHAINLINK_TWAP_30 ? 30 : 60;
        let failedAttempts = 0;
        while (!this.disposed) {
            try {
                const handle = await client.subscribe([{ topic: TWAP_TOPIC, windowSeconds, symbols: this.coins.map(coin => getPriceSourceSymbol(coin, this.source)) }]);
                failedAttempts = 0;
                this.twapHandle = handle;
                this.connect();
                for await (const event of handle) this.update(event.payload.symbol.toLowerCase(), event.payload.value, event.payload.timestamp);
                if (this.disposed) return;
                this.stopWatchdog();
                this.clearPrices();
                this.emitActive('close', 'stream_ended');
            } catch (error) {
                if (this.disposed) return;
                this.stopWatchdog(); this.clearPrices(); this.emitActive('error', error_str(error));
                logger.warn(`[SharedCoinPriceFeed] TWAP subscription error: ${error_str(error)}`);
            }
            failedAttempts++;
            const delayMs = getPriceSourceReconnectDelayMs(this.source, failedAttempts);
            logger.warn(`[SharedCoinPriceFeed] TWAP reconnect attempt=${failedAttempts} delay=${delayMs}ms`);
            await delay(delayMs);
        }
    }

    private startRtds(): void {
        const factory = (this.client ?? (args => new RealTimeDataClient(args))) as RtdsClientFactory;
        let client: RtdsClient;
        const onStatusChange = (status: ConnectionStatus): void => {
            if (client !== this.rtdsClient || this.disposed) return;
            if (status === ConnectionStatus.CONNECTED) {
                this.rtdsFailedAttempts = 0;
                this.connect();
            }
            else if (status === ConnectionStatus.DISCONNECTED) {
                this.stopWatchdog(); this.clearPrices(); this.emitActive('close', 'disconnected');
                this.rtdsClient = undefined;
                this.scheduleRtdsReconnect();
            }
        };
        const onMessage = (_client: RealTimeDataClient, message: Message): void => {
            const topic = this.source === PS_BINANCE ? 'crypto_prices' : 'crypto_prices_chainlink';
            if (message.topic !== topic || message.type !== 'update') return;
            const payload = message.payload as { symbol?: unknown; value?: unknown; timestamp?: unknown };
            if (typeof payload.symbol === 'string') this.update(payload.symbol.toLowerCase(), payload.value, payload.timestamp);
        };
        client = factory({ onMessage, onStatusChange, onConnect: connected => {
            connected.subscribe({ subscriptions: this.coins.map(coin => ({ topic: this.source === PS_BINANCE ? 'crypto_prices' : 'crypto_prices_chainlink', type: 'update', filters: JSON.stringify({ symbol: getPriceSourceSymbol(coin, this.source) }) })) });
        } });
        this.rtdsClient = client;
        client.connect();
    }
}
