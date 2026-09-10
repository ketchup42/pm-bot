import { Coin, coin_precis } from '../coins.js';
import { EventFrame, getCurrentFrameStart, getFrameDurationMs, getSupportedFrames, waitFrameStartMsUntil } from '../frame.js';
import { TIMER_FAST, TIMER_NORM } from '../../timer.js';
import { delay, roundTo } from '../../utils.js';
import { CoinPriceWatcher, PriceConnectionListener } from './CoinPriceWatcher.js';
import { getPriceSourceConfig, getPriceSourceSymbol, PriceSource } from './price_source.js';
import type { SharedCoinPriceFeed } from './SharedCoinPriceFeed.js';

interface FramePriceData {
    price: number | undefined;
    timestamp: number | undefined;
}

/** Per-coin view of a source-level shared price transport. */
export class SharedCoinPriceWatcher implements CoinPriceWatcher {
    private readonly framePrices = new Map<EventFrame, FramePriceData>();
    private readonly frameStopFlags = new Map<EventFrame, boolean>();
    private disposed = false;

    public constructor(private readonly coin: Coin, private readonly feed: SharedCoinPriceFeed) {
        feed.retain(coin);
        for (const frame of getSupportedFrames()) {
            this.framePrices.set(frame, { price: undefined, timestamp: 0 });
            this.frameStopFlags.set(frame, false);
        }
        this.initializeFrameCapture();
    }

    public getSymbol(): string {
        return getPriceSourceSymbol(this.coin, this.feed.getSource());
    }

    public getSource(): PriceSource { return this.feed.getSource(); }
    public getCoin(): Coin { return this.coin; }
    public getCurrentPrice(): number | undefined { return this.feed.getPrice(this.coin); }
    public getTimeStamp(): number | undefined { return this.feed.getTimestamp(this.coin); }
    public getCoinPrice(): number | undefined { return roundTo(this.getCurrentPrice(), coin_precis(this.coin)); }

    public async warmUp(tick: number = TIMER_NORM): Promise<this> {
        while (this.getCurrentPrice() === undefined && !this.disposed) await delay(tick);
        return this;
    }

    public async getPriceByFrame(
        frame: EventFrame,
        timeoutMs: number = getPriceSourceConfig(this.getSource()).framePriceReadTimeoutMs,
    ): Promise<number | undefined> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const data = this.framePrices.get(frame);
            if (data?.price !== undefined && data.timestamp === getCurrentFrameStart(frame) * 1_000) return data.price;
            await delay(TIMER_FAST);
        }
        return undefined;
    }

    public subscribeConnectionEvents(listener: PriceConnectionListener): () => void {
        return this.feed.subscribe(this.coin, listener);
    }

    public disconnect(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const frame of getSupportedFrames()) this.frameStopFlags.set(frame, true);
        this.framePrices.clear();
        this.feed.release(this.coin);
    }

    private initializeFrameCapture(): void {
        for (const frame of getSupportedFrames()) this.captureFramePrices(frame);
    }

    private captureFramePrices(frame: EventFrame): void {
        void (async () => {
            while (!this.disposed) {
                await waitFrameStartMsUntil(getFrameDurationMs(frame), () => this.disposed || this.frameStopFlags.get(frame) === true);
                if (this.disposed || this.frameStopFlags.get(frame)) return;
                const timestamp = getCurrentFrameStart(frame) * 1_000;
                const price = await this.captureFramePrice(timestamp);
                this.framePrices.set(frame, { price, timestamp });
            }
        })();
    }

    private async captureFramePrice(frameStartMs: number): Promise<number | undefined> {
        const start = Date.now();
        const timeoutMs = getPriceSourceConfig(this.getSource()).framePriceCaptureTimeoutMs;
        while (Date.now() - start < timeoutMs) {
            const price = this.getCurrentPrice();
            const timestamp = this.getTimeStamp();
            if (price !== undefined && timestamp !== undefined && timestamp >= frameStartMs) return this.getCoinPrice();
            await delay(TIMER_FAST);
        }
        return undefined;
    }
}
