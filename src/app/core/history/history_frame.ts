import { isEventFrame, type EventFrame } from '../../../market/frame.js';
import { isCoin, type Coin } from '../../../market/coins.js';
import { MarketSide } from '../../../market/side.js';
import { EventMarketData, OrderBookLevel } from '../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { getPriceSourceConfig, isPriceSource, type PriceSource } from '../../../market/price/price_source.js';

export const HISTORY_SCHEMA_VERSION = 2 as const;

export interface HistorySideSnapshotV2 {
    book_timestamp: number | undefined;
    midpoint: number | undefined;
    spread: number | undefined;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
}

export interface HistorySnapshotV2 {
    timestamp: number;
    coin_price: number | undefined;
    coin_timestamp: number | undefined;
    book_watching: boolean;
    up: HistorySideSnapshotV2;
    down: HistorySideSnapshotV2;
}

export type HistoryOutcomeV2 = MarketSide | 'tie' | 'unknown';
export type HistoryConnectionStateV2 = 'open' | 'close' | 'error' | 'stale' | 'reconnect';
export type HistoryConnectionSourceV2 = 'clob' | 'coin_price';
export type HistoryGapSourceV2 = 'snapshots' | 'coin_price' | 'clob';
export type HistoryQualityWarning =
    | 'collection_stopped_early'
    | 'missing_frame_start_price'
    | 'missing_frame_end_price'
    | 'no_snapshots'
    | 'insufficient_snapshot_coverage'
    | 'excessive_coin_data_gap'
    | 'excessive_clob_disconnect'
    | 'large_snapshot_gap';

export interface HistoryConnectionEventV2 {
    timestamp: number;
    state: HistoryConnectionStateV2;
    code: number | undefined;
    reason: string | undefined;
    /** Undefined in existing V2 files means CLOB. */
    source: HistoryConnectionSourceV2 | undefined;
}

export interface HistoryDataGapV2 {
    source: HistoryGapSourceV2;
    start_timestamp: number;
    end_timestamp: number;
    duration_ms: number;
}

export interface HistorySettlementV2 {
    derived_outcome: HistoryOutcomeV2;
    confirmed_outcome: MarketSide | undefined;
    confirmed_at: number | undefined;
}

export interface HistoryDataQualityV2 {
    complete: boolean;
    expected_snapshots: number;
    snapshot_count: number;
    first_snapshot_timestamp: number | undefined;
    last_snapshot_timestamp: number | undefined;
    max_snapshot_gap_ms: number;
    missing_coin_price_snapshots: number;
    coin_gap_snapshots: number;
    disconnected_book_snapshots: number;
    warnings: HistoryQualityWarning[];
}

export interface HistoryFrameV2 {
    schema_version: typeof HISTORY_SCHEMA_VERSION;
    source: PriceSource;
    coin: Coin;
    frame: EventFrame;
    slug: string;
    start_time: number;
    end_time: number;
    collected_at: number;
    snapshot_interval_ms: number;
    book_depth: number;
    coin_frame_start_price: number | undefined;
    coin_frame_end_price: number | undefined;
    market_data: EventMarketData;
    settlement: HistorySettlementV2;
    connection_events: HistoryConnectionEventV2[];
    data_gaps: HistoryDataGapV2[];
    snapshots: HistorySnapshotV2[];
    data_quality: HistoryDataQualityV2;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** Converts cache order into best-price-first levels using the existing book type. */
export function selectBestLevels(levels: readonly OrderBookLevel[], depth: number): OrderBookLevel[] {
    return levels.slice(-depth).reverse().map(level => ({ ...level }));
}

export function deriveHistoryOutcome(startPrice: number | undefined, endPrice: number | undefined): HistoryOutcomeV2 {
    if (startPrice === undefined || endPrice === undefined) return 'unknown';
    if (endPrice > startPrice) return 'up';
    if (endPrice < startPrice) return 'down';
    return 'tie';
}

function appendBooleanGaps(
    gaps: HistoryDataGapV2[],
    snapshots: readonly HistorySnapshotV2[],
    intervalMs: number,
    source: HistoryGapSourceV2,
    isGap: (snapshot: HistorySnapshotV2) => boolean,
): void {
    let start: number | undefined;
    for (const snapshot of snapshots) {
        if (isGap(snapshot)) {
            start ??= snapshot.timestamp;
        } else if (start !== undefined) {
            gaps.push({ source, start_timestamp: start, end_timestamp: snapshot.timestamp, duration_ms: snapshot.timestamp - start });
            start = undefined;
        }
    }
    if (start !== undefined) {
        const end = (snapshots[snapshots.length - 1]?.timestamp ?? start) + intervalMs;
        gaps.push({ source, start_timestamp: start, end_timestamp: end, duration_ms: end - start });
    }
}

export function buildHistoryGaps(
    snapshots: readonly HistorySnapshotV2[],
    snapshotIntervalMs: number,
    source: PriceSource,
): HistoryDataGapV2[] {
    const gaps: HistoryDataGapV2[] = [];
    for (let index = 1; index < snapshots.length; index++) {
        const previous = snapshots[index - 1]!;
        const current = snapshots[index]!;
        if (current.timestamp - previous.timestamp > snapshotIntervalMs * 3) {
            const start = previous.timestamp + snapshotIntervalMs;
            gaps.push({ source: 'snapshots', start_timestamp: start, end_timestamp: current.timestamp, duration_ms: current.timestamp - start });
        }
    }
    appendBooleanGaps(gaps, snapshots, snapshotIntervalMs, 'coin_price', snapshot =>
        snapshot.coin_price === undefined || snapshot.coin_timestamp === undefined ||
        snapshot.timestamp - snapshot.coin_timestamp > getPriceSourceConfig(source).maxAgeMs,
    );
    appendBooleanGaps(gaps, snapshots, snapshotIntervalMs, 'clob', snapshot => !snapshot.book_watching);
    return gaps.sort((left, right) => left.start_timestamp - right.start_timestamp || left.source.localeCompare(right.source));
}

export function buildHistoryQuality(
    snapshots: readonly HistorySnapshotV2[],
    startPrice: number | undefined,
    endPrice: number | undefined,
    frameDurationMs: number,
    snapshotIntervalMs: number,
    stoppedEarly: boolean,
    source: PriceSource,
): HistoryDataQualityV2 {
    let maxSnapshotGapMs = 0;
    let missingCoinPriceSnapshots = 0;
    let coinGapSnapshots = 0;
    let disconnectedBookSnapshots = 0;
    snapshots.forEach((snapshot, index) => {
        const previous = snapshots[index - 1];
        if (previous) maxSnapshotGapMs = Math.max(maxSnapshotGapMs, snapshot.timestamp - previous.timestamp);
        if (snapshot.coin_price === undefined || snapshot.coin_timestamp === undefined) missingCoinPriceSnapshots++;
        if (snapshot.coin_price === undefined || snapshot.coin_timestamp === undefined ||
            snapshot.timestamp - snapshot.coin_timestamp > getPriceSourceConfig(source).maxAgeMs) coinGapSnapshots++;
        if (!snapshot.book_watching) disconnectedBookSnapshots++;
    });

    const expectedSnapshots = Math.floor(frameDurationMs / snapshotIntervalMs);
    const enoughSnapshots = snapshots.length >= Math.floor(expectedSnapshots * 0.95);
    const acceptableCoinData = coinGapSnapshots <= Math.ceil(Math.max(1, snapshots.length) * 0.02);
    const acceptableDisconnectedBooks = disconnectedBookSnapshots <= Math.ceil(Math.max(1, snapshots.length) * 0.02);
    const acceptableGap = maxSnapshotGapMs <= snapshotIntervalMs * 3;
    const warnings: HistoryQualityWarning[] = [];
    if (stoppedEarly) warnings.push('collection_stopped_early');
    if (startPrice === undefined) warnings.push('missing_frame_start_price');
    if (endPrice === undefined) warnings.push('missing_frame_end_price');
    if (snapshots.length === 0) warnings.push('no_snapshots');
    if (!enoughSnapshots) warnings.push('insufficient_snapshot_coverage');
    if (!acceptableCoinData) warnings.push('excessive_coin_data_gap');
    if (!acceptableDisconnectedBooks) warnings.push('excessive_clob_disconnect');
    if (!acceptableGap) warnings.push('large_snapshot_gap');

    return {
        complete: !stoppedEarly && startPrice !== undefined && endPrice !== undefined && enoughSnapshots &&
            acceptableCoinData && acceptableDisconnectedBooks && acceptableGap,
        expected_snapshots: expectedSnapshots,
        snapshot_count: snapshots.length,
        first_snapshot_timestamp: snapshots[0]?.timestamp,
        last_snapshot_timestamp: snapshots[snapshots.length - 1]?.timestamp,
        max_snapshot_gap_ms: maxSnapshotGapMs,
        missing_coin_price_snapshots: missingCoinPriceSnapshots,
        coin_gap_snapshots: coinGapSnapshots,
        disconnected_book_snapshots: disconnectedBookSnapshots,
        warnings,
    };
}

export function validateHistoryFrame(frame: HistoryFrameV2): string[] {
    const errors: string[] = [];
    if (frame.schema_version !== HISTORY_SCHEMA_VERSION) errors.push('unsupported_schema_version');
    if (!isCoin(frame.coin)) errors.push('unsupported_coin');
    if (!isEventFrame(frame.frame)) errors.push('unsupported_frame');
    if (!isPriceSource(frame.source)) errors.push('unsupported_price_source');
    if (frame.start_time >= frame.end_time) errors.push('invalid_frame_time');
    if (frame.snapshot_interval_ms <= 0) errors.push('invalid_snapshot_interval');
    if (frame.book_depth <= 0) errors.push('invalid_book_depth');
    if (!frame.market_data.eventId || !frame.market_data.marketId || !frame.market_data.conditionId) errors.push('missing_market_ids');
    if (!Number.isFinite(frame.market_data.tick_size) || frame.market_data.tick_size <= 0) errors.push('invalid_tick_size');
    if (!Number.isFinite(frame.market_data.min_order_size) || frame.market_data.min_order_size <= 0) errors.push('invalid_min_order_size');
    if (!Number.isFinite(frame.market_data.taker_base_fee) || frame.market_data.taker_base_fee < 0) errors.push('invalid_taker_fee');
    if (frame.data_quality.snapshot_count !== frame.snapshots.length) errors.push('snapshot_count_mismatch');
    if (frame.data_quality.complete && frame.data_quality.warnings.includes('collection_stopped_early')) errors.push('complete_but_stopped_early');
    if ((frame.settlement.confirmed_outcome === undefined) !== (frame.settlement.confirmed_at === undefined)) {
        errors.push('incomplete_confirmed_settlement');
    }
    for (let index = 1; index < frame.snapshots.length; index++) {
        if (frame.snapshots[index]!.timestamp < frame.snapshots[index - 1]!.timestamp) {
            errors.push('snapshots_not_chronological');
            break;
        }
    }
    if (frame.data_gaps.some(gap => gap.start_timestamp > gap.end_timestamp || gap.duration_ms !== gap.end_timestamp - gap.start_timestamp)) {
        errors.push('invalid_data_gap');
    }
    if (frame.connection_events.some(event => event.source !== undefined && event.source !== 'clob' && event.source !== 'coin_price')) {
        errors.push('invalid_connection_event_source');
    }
    return errors;
}

export const historyNumberOrUndefined = finiteOrUndefined;
