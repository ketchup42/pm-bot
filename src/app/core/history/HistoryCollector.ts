import { Coin } from '../../../market/coins.js';
import {
    EventFrame,
    getCoinSlug,
    getCurrentFrameStart,
    getFrameDurationMs,
    waitFrameStartMsUntil,
} from '../../../market/frame.js';
import { CoinPriceWatcher } from '../../../market/price/CoinPriceWatcher.js';
import { CoinMarketOrderBooksWatcher } from '../../../market/orderbook/watcher/CoinMarketOrderBooksWatcher.js';
import { MarketOrderBooksWatcher } from '../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { MarketSide } from '../../../market/side.js';
import { delay, error_str } from '../../../utils.js';
import { logger } from '../../../log.js';
import { HistoryFrameWriter } from './HistoryFrameWriter.js';
import {
    HISTORY_SCHEMA_VERSION,
    HistoryConnectionEventV2,
    HistoryFrameV2,
    HistorySideSnapshotV2,
    HistorySnapshotV2,
    buildHistoryGaps,
    buildHistoryQuality,
    deriveHistoryOutcome,
    historyNumberOrUndefined,
    selectBestLevels,
} from './history_frame.js';

export interface HistoryCollectorOptions {
    coin: Coin;
    frame: EventFrame;
    snapshotIntervalMs: number;
    bookDepth: number;
    frameCount: number;
}

export class HistoryCollector {
    private readonly options: HistoryCollectorOptions;
    private readonly coinWatcher: CoinPriceWatcher;
    private readonly writer: HistoryFrameWriter;
    private stopped = false;
    private activeBookWatcher: MarketOrderBooksWatcher | undefined;

    public constructor(
        options: HistoryCollectorOptions,
        coinWatcher: CoinPriceWatcher,
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
        this.options = options;
        this.coinWatcher = coinWatcher;
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
                await this.collectCurrentFrame();
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
        logger.info('[HistoryCollector] Stopped');
    }

    private async waitNextFrameBoundary(): Promise<void> {
        await waitFrameStartMsUntil(getFrameDurationMs(this.options.frame), () => this.stopped);
    }

    private async collectCurrentFrame(): Promise<void> {
        const startTime = getCurrentFrameStart(this.options.frame);
        const durationMs = getFrameDurationMs(this.options.frame);
        const endTime = startTime + durationMs / 1_000;
        const endTimeMs = endTime * 1_000;
        const slug = getCoinSlug(this.options.coin, this.options.frame);
        logger.info(`[HistoryCollector] Starting ${slug}`);

        const connectionEvents: HistoryConnectionEventV2[] = [];

        const [bookWatcher, startPriceValue] = await Promise.all([
            CoinMarketOrderBooksWatcher.create(slug, {
                onWSOpen: async () => {
                    connectionEvents.push({ timestamp: Date.now(), state: 'open', code: undefined, reason: undefined });
                },
                onWSClose: async (_managerId, code, reason) => {
                    connectionEvents.push({ timestamp: Date.now(), state: 'close', code, reason: reason || undefined });
                },
                onError: async error => {
                    const reason = error instanceof Error ? error.message : error_str(error);
                    connectionEvents.push({ timestamp: Date.now(), state: 'error', code: undefined, reason });
                },
            }),
            this.coinWatcher.getPriceByFrame(this.options.frame),
        ]);
        this.activeBookWatcher = bookWatcher;
        const market = bookWatcher.getMarketData();
        const snapshots: HistorySnapshotV2[] = [];
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
            const endPriceValue = stoppedEarly
                ? undefined
                : await this.coinWatcher.getPriceByFrame(this.options.frame);
            const startPrice = historyNumberOrUndefined(startPriceValue);
            const endPrice = historyNumberOrUndefined(endPriceValue);
            const quality = buildHistoryQuality(
                snapshots,
                startPrice,
                endPrice,
                durationMs,
                this.options.snapshotIntervalMs,
                stoppedEarly,
                this.coinWatcher.getSource(),
            );

            const frame: HistoryFrameV2 = {
                schema_version: HISTORY_SCHEMA_VERSION,
                source: this.coinWatcher.getSource(),
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
                market_data: market,
                settlement: {
                    derived_outcome: deriveHistoryOutcome(startPrice, endPrice),
                    confirmed_outcome: undefined,
                    confirmed_at: undefined,
                },
                connection_events: connectionEvents,
                data_gaps: buildHistoryGaps(snapshots, this.options.snapshotIntervalMs, this.coinWatcher.getSource()),
                snapshots,
                data_quality: quality,
            };
            const result = await this.writer.write(frame);
            logger.info(
                `[HistoryCollector] Saved ${result.path} (${result.bytes} bytes, ` +
                `${quality.snapshot_count}/${quality.expected_snapshots} snapshots, complete=${quality.complete})`,
            );
        } finally {
            bookWatcher.disconnect();
            this.activeBookWatcher = undefined;
        }
    }

    private makeSnapshot(book: MarketOrderBooksWatcher, timestamp: number): HistorySnapshotV2 {
        return {
            timestamp,
            coin_price: historyNumberOrUndefined(this.coinWatcher.getCoinPrice()),
            coin_timestamp: historyNumberOrUndefined(this.coinWatcher.getTimeStamp()),
            book_watching: book.isWatching(),
            up: this.makeSideSnapshot(book, 'up'),
            down: this.makeSideSnapshot(book, 'down'),
        };
    }

    private makeSideSnapshot(book: MarketOrderBooksWatcher, side: MarketSide): HistorySideSnapshotV2 {
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
