import { getSupportedCoins, Coin } from '../../../market/coins.js';
import {
    EventFrame,
    getCoinSlug,
    getCurrentFrameStart,
    getFrameDurationMs,
    waitFrameStartMsUntil,
} from '../../../market/frame.js';
import { CoinPriceWatcher } from '../../../market/price/CoinPriceWatcher.js';
import { getPriceSourceConfig } from '../../../market/price/price_source.js';
import { CoinMarketOrderBooksWatcher } from '../../../market/orderbook/watcher/CoinMarketOrderBooksWatcher.js';
import { MarketOrderBooksWatcher } from '../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { MarketSide } from '../../../market/side.js';
import { delay, error_str } from '../../../utils.js';
import { logger } from '../../../log.js';
import { HistoryFrameWriter } from './HistoryFrameWriter.js';
import {
    HISTORY_SCHEMA_VERSION,
    HistoryConnectionEventV3,
    HistoryFrameV3,
    HistoryPriceV3,
    HistorySideSnapshotV3,
    HistorySnapshotV3,
    buildHistoryGaps,
    buildHistoryQuality,
    deriveHistoryOutcome,
    historyNumberOrUndefined,
    makeHistoryPrice,
    selectBestLevels,
} from './history_frame.js';

export interface HistoryCollectorOptions {
    coin: Coin;
    frame: EventFrame;
    snapshotIntervalMs: number;
    bookDepth: number;
    frameCount: number;
}

interface HistoryFrameFinalizationInput {
    startTime: number;
    endTime: number;
    durationMs: number;
    slug: string;
    snapshots: HistorySnapshotV3[];
    market: ReturnType<MarketOrderBooksWatcher['getMarketData']>;
    connectionEvents: HistoryConnectionEventV3[];
    stoppedEarly: boolean;
    startPricePromise: Promise<number | undefined>;
    endPricePromise: Promise<number | undefined> | undefined;
    indicatorStartPricesPromise: Promise<Partial<Record<Coin, HistoryPriceV3>>>;
    indicatorEndPricesPromise: Promise<Partial<Record<Coin, HistoryPriceV3>>> | undefined;
}

export class HistoryCollector {
    private readonly options: HistoryCollectorOptions;
    private readonly coinWatcher: CoinPriceWatcher;
    private readonly writer: HistoryFrameWriter;
    private readonly indicatorWatchers: ReadonlyMap<Coin, CoinPriceWatcher>;
    private stopped = false;
    private activeBookWatcher: MarketOrderBooksWatcher | undefined;
    private readonly pendingFinalizations = new Set<Promise<void>>();

    public constructor(
        options: HistoryCollectorOptions,
        coinWatcher: CoinPriceWatcher,
        indicatorWatchers: ReadonlyMap<Coin, CoinPriceWatcher>,
        writer: HistoryFrameWriter,
    ) {
        if (!Number.isInteger(options.snapshotIntervalMs) || options.snapshotIntervalMs < 25) {
            throw new Error(`snapshotIntervalMs must be an integer >= 25, got ${options.snapshotIntervalMs}`);
        }
        if (!Number.isInteger(options.bookDepth) || options.bookDepth < 1 || options.bookDepth > 100) {
            throw new Error(`bookDepth must be an integer in [1, 100], got ${options.bookDepth}`);
        }
        if (!Number.isInteger(options.frameCount) || options.frameCount < 0) {
            throw new Error(`frameCount must be an integer >= 0, got ${options.frameCount}`);
        }
        if (coinWatcher.getCoin() !== options.coin) {
            throw new Error(`Coin watcher target ${coinWatcher.getCoin()} does not match ${options.coin}`);
        }
        for (const coin of getSupportedCoins()) {
            const watcher = indicatorWatchers.get(coin);
            if (watcher === undefined || watcher.getCoin() !== coin || watcher.getSource() !== coinWatcher.getSource()) {
                throw new Error(`Invalid indicator watcher for ${coin}`);
            }
        }
        this.options = options;
        this.coinWatcher = coinWatcher;
        this.indicatorWatchers = indicatorWatchers;
        this.writer = writer;
    }

    public stop(): void {
        this.stopped = true;
    }

    public async run(): Promise<void> {
        logger.info(`[HistoryCollector] Waiting for the next ${this.options.frame} frame boundary`);
        await this.waitNextFrameBoundary();
        let collectedFrames = 0;
        while (!this.stopped) {
            try {
                const { finalization } = await this.collectCurrentFrame();
                this.trackFinalization(finalization);
                collectedFrames++;
                if (this.options.frameCount > 0 && collectedFrames >= this.options.frameCount) this.stopped = true;
            } catch (error) {
                logger.error(`[HistoryCollector] Frame collection failed: ${error_str(error)}`);
                this.activeBookWatcher?.disconnect();
                this.activeBookWatcher = undefined;
                await this.waitNextFrameBoundary();
            }
        }
        this.activeBookWatcher?.disconnect();
        this.activeBookWatcher = undefined;
        await this.waitForPendingFinalizations();
        logger.info('[HistoryCollector] Stopped');
    }

    private async waitNextFrameBoundary(): Promise<void> {
        await waitFrameStartMsUntil(getFrameDurationMs(this.options.frame), () => this.stopped);
    }

    private async collectCurrentFrame(): Promise<{ finalization: Promise<void> }> {
        const startTime = getCurrentFrameStart(this.options.frame);
        const durationMs = getFrameDurationMs(this.options.frame);
        const endTime = startTime + durationMs / 1_000;
        const endTimeMs = endTime * 1_000;
        const slug = getCoinSlug(this.options.coin, this.options.frame);
        logger.info(`[HistoryCollector] Starting ${slug}`);

        const connectionEvents: HistoryConnectionEventV3[] = [];
        const unsubscribeIndicatorEvents = getSupportedCoins().map(coin => {
            const watcher = this.indicatorWatchers.get(coin)!;
            return watcher.subscribeConnectionEvents(event => {
                connectionEvents.push({
                    timestamp: event.timestamp, state: event.state, code: undefined, reason: event.reason,
                    source: watcher.getSource(), coin,
                });
            });
        });

        const framePriceTimeoutMs = getPriceSourceConfig(this.coinWatcher.getSource()).framePriceCaptureTimeoutMs;
        const startPricePromise = this.coinWatcher.getPriceByFrame(this.options.frame, framePriceTimeoutMs);
        const indicatorStartPricesPromise = this.captureIndicatorFramePrices(startTime * 1_000);
        const bookWatcher = await CoinMarketOrderBooksWatcher.create(slug, {
            onWSOpen: async () => {
                connectionEvents.push({ timestamp: Date.now(), state: 'open', code: undefined, reason: undefined, source: 'clob', coin: this.options.coin });
            },
            onWSClose: async (_managerId, code, reason) => {
                connectionEvents.push({ timestamp: Date.now(), state: 'close', code, reason: reason || undefined, source: 'clob', coin: this.options.coin });
            },
            onError: async error => {
                const reason = error instanceof Error ? error.message : error_str(error);
                connectionEvents.push({ timestamp: Date.now(), state: 'error', code: undefined, reason, source: 'clob', coin: this.options.coin });
            },
        }).catch(error => {
            unsubscribeIndicatorEvents.forEach(unsubscribe => unsubscribe());
            throw error;
        });
        this.activeBookWatcher = bookWatcher;
        const market = bookWatcher.getMarketData();
        const snapshots: HistorySnapshotV3[] = [];
        let nextSnapshotAt = Date.now();

        try {
            while (!this.stopped && Date.now() < endTimeMs) {
                const now = Date.now();
                snapshots.push(this.makeSnapshot(bookWatcher, now));
                nextSnapshotAt += this.options.snapshotIntervalMs;
                if (nextSnapshotAt <= now) nextSnapshotAt = now + this.options.snapshotIntervalMs;
                await delay(Math.max(1, Math.min(nextSnapshotAt - Date.now(), endTimeMs - Date.now())));
            }

            const stoppedEarly = this.stopped || Date.now() < endTimeMs;
            const endPricePromise = stoppedEarly
                ? undefined
                : this.coinWatcher.getPriceByFrame(this.options.frame, framePriceTimeoutMs);
            const indicatorEndPricesPromise = stoppedEarly ? undefined : this.captureIndicatorFramePrices(endTime * 1_000);
            return {
                finalization: this.finalizeFrame({
                    startTime,
                    endTime,
                    durationMs,
                    slug,
                    snapshots,
                    market,
                    connectionEvents,
                    stoppedEarly,
                    startPricePromise,
                    endPricePromise,
                    indicatorStartPricesPromise,
                    indicatorEndPricesPromise,
                }),
            };
        } finally {
            unsubscribeIndicatorEvents.forEach(unsubscribe => unsubscribe());
            bookWatcher.disconnect();
            this.activeBookWatcher = undefined;
        }
    }

    private async finalizeFrame({
        startTime,
        endTime,
        durationMs,
        slug,
        snapshots,
        market,
        connectionEvents,
        stoppedEarly,
        startPricePromise,
        endPricePromise,
        indicatorStartPricesPromise,
        indicatorEndPricesPromise,
    }: HistoryFrameFinalizationInput): Promise<void> {
        const startPrice = historyNumberOrUndefined(await startPricePromise);
        const endPrice = historyNumberOrUndefined(await endPricePromise);
        const indicatorStartPrices = await indicatorStartPricesPromise;
        const indicatorEndPrices = indicatorEndPricesPromise === undefined ? {} : await indicatorEndPricesPromise;
        const quality = buildHistoryQuality({
            snapshots,
            startPrice,
            endPrice,
            indicatorStartPrices,
            indicatorEndPrices,
            frameStartMs: startTime * 1_000,
            frameDurationMs: durationMs,
            snapshotIntervalMs: this.options.snapshotIntervalMs,
            stoppedEarly,
            source: this.coinWatcher.getSource(),
            indicatorCoins: getSupportedCoins(),
        });
        const frame: HistoryFrameV3 = {
            schema_version: HISTORY_SCHEMA_VERSION,
            source: this.coinWatcher.getSource(),
            indicator_coins: [...getSupportedCoins()],
            coin: this.options.coin,
            frame: this.options.frame,
            slug,
            start_time: startTime,
            end_time: endTime,
            collected_at: Date.now(),
            snapshot_interval_ms: this.options.snapshotIntervalMs,
            book_depth: this.options.bookDepth,
            coin_frame_start_price: startPrice,
            coin_frame_end_price: endPrice,
            indicator_frame_start_prices: indicatorStartPrices,
            indicator_frame_end_prices: indicatorEndPrices,
            market_data: market,
            settlement: {
                derived_outcome: deriveHistoryOutcome(startPrice, endPrice),
                confirmed_outcome: undefined,
                confirmed_at: undefined,
            },
            connection_events: connectionEvents,
            data_gaps: buildHistoryGaps(
                snapshots, this.options.snapshotIntervalMs, this.options.coin, this.coinWatcher.getSource(),
                getSupportedCoins(),
            ),
            snapshots,
            data_quality: quality,
        };
        const result = await this.writer.write(frame);
        const qualityDetails = ` blockingWarnings=${quality.blocking_warnings!.join(',') || 'none'} ` +
            `diagnosticWarnings=${quality.diagnostic_warnings!.join(',') || 'none'} ` +
            `targetGaps=${quality.target_price.missing_snapshots + quality.target_price.stale_snapshots} ` +
            `maxTargetGap=${quality.max_target_price_gap_ms}ms ` +
            `firstSnapshotDelay=${quality.first_snapshot_delay_ms === undefined ? 'none' : `${quality.first_snapshot_delay_ms}ms`} ` +
            `clobDisconnects=${quality.disconnected_book_snapshots}`;
        logger.info(
            `[HistoryCollector] Saved ${result.path} (${result.bytes} bytes, ` +
            `${quality.snapshot_count}/${quality.expected_snapshots} snapshots, complete=${quality.complete}${qualityDetails})`,
        );
    }

    private trackFinalization(finalization: Promise<void>): void {
        const pending = finalization.catch(error => {
            logger.error(`[HistoryCollector] Frame finalization failed: ${error_str(error)}`);
        }).finally(() => {
            this.pendingFinalizations.delete(pending);
        });
        this.pendingFinalizations.add(pending);
    }

    private async waitForPendingFinalizations(): Promise<void> {
        if (this.pendingFinalizations.size === 0) return;
        logger.info(`[HistoryCollector] Waiting for ${this.pendingFinalizations.size} frame finalization(s)`);
        await Promise.all(this.pendingFinalizations);
    }

    private makeSnapshot(book: MarketOrderBooksWatcher, timestamp: number): HistorySnapshotV3 {
        const indicatorPrices: Partial<Record<Coin, HistoryPriceV3>> = {};
        for (const coin of getSupportedCoins()) {
            const watcher = this.indicatorWatchers.get(coin)!;
            const price = makeHistoryPrice(watcher.getCoinPrice(), watcher.getTimeStamp());
            if (price !== undefined) indicatorPrices[coin] = price;
        }
        return {
            timestamp,
            coin_price: historyNumberOrUndefined(this.coinWatcher.getCoinPrice()),
            coin_timestamp: historyNumberOrUndefined(this.coinWatcher.getTimeStamp()),
            indicator_prices: indicatorPrices,
            book_watching: book.isWatching(),
            up: this.makeSideSnapshot(book, 'up'),
            down: this.makeSideSnapshot(book, 'down'),
        };
    }

    private async captureIndicatorFramePrices(frameTimestamp: number): Promise<Partial<Record<Coin, HistoryPriceV3>>> {
        const timeoutMs = getPriceSourceConfig(this.coinWatcher.getSource()).framePriceCaptureTimeoutMs;
        const prices = await Promise.all(getSupportedCoins().map(async coin => {
            const watcher = this.indicatorWatchers.get(coin)!;
            const price = historyNumberOrUndefined(await watcher.getPriceByFrame(this.options.frame, timeoutMs));
            return [coin, makeHistoryPrice(price, frameTimestamp)] as const;
        }));
        const result: Partial<Record<Coin, HistoryPriceV3>> = {};
        for (const [coin, price] of prices) if (price !== undefined) result[coin] = price;
        return result;
    }

    private makeSideSnapshot(book: MarketOrderBooksWatcher, side: MarketSide): HistorySideSnapshotV3 {
        const bids = side === 'up' ? book.getBidsUp() : book.getBidsDown();
        const asks = side === 'up' ? book.getAsksUp() : book.getAsksDown();
        return {
            book_timestamp: historyNumberOrUndefined(book.getTimeStamp(side)),
            midpoint: historyNumberOrUndefined(side === 'up' ? book.getUpMidpoint() : book.getDownMidpoint()),
            spread: historyNumberOrUndefined(side === 'up' ? book.getUpSpread() : book.getDownSpread()),
            bids: selectBestLevels(bids, this.options.bookDepth),
            asks: selectBestLevels(asks, this.options.bookDepth),
        };
    }
}
