import { isCoin, type Coin } from '../../../market/coins.js';
import { isEventFrame, type EventFrame } from '../../../market/frame.js';
import { MarketSide } from '../../../market/side.js';
import { EventMarketData, OrderBookLevel } from '../../../market/orderbook/watcher/MarketOrderBooksWatcher.js';
import { getPriceSourceConfig, isPriceSource, type PriceSource } from '../../../market/price/price_source.js';
import { positiveFiniteNumberOrUndefined } from '../../../utils.js';

export const HISTORY_SCHEMA_VERSION = 3 as const;
/** Extra delay tolerated before recording a scheduling gap. */
export const HISTORY_SNAPSHOT_SCHEDULING_TOLERANCE_MS = 200;
/** A scheduling gap larger than this makes a frame incomplete. */
export const HISTORY_MAX_COMPLETE_SNAPSHOT_GAP_MS = 1_000;
export const HISTORY_MAX_PRICE_GAP_RATIO = 0.05;
export const HISTORY_MAX_COMPLETE_TARGET_PRICE_GAP_MS = 10_000;

export interface HistoryPriceV3 { price: number; timestamp: number; }

export interface HistorySideSnapshotV3 {
    book_timestamp: number | undefined;
    midpoint: number | undefined;
    spread: number | undefined;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
}

export interface HistorySnapshotV3 {
    timestamp: number;
    /** Price used by the target market's resolution source. */
    coin_price: number | undefined;
    coin_timestamp: number | undefined;
    /** Prices from the frame source for every supported coin, omitted when unavailable. */
    indicator_prices: Partial<Record<Coin, HistoryPriceV3>>;
    book_watching: boolean;
    up: HistorySideSnapshotV3;
    down: HistorySideSnapshotV3;
}

export type HistoryOutcomeV3 = MarketSide | 'tie' | 'unknown';
export type HistoryConnectionStateV3 = 'open' | 'close' | 'error' | 'stale' | 'reconnect';
export type HistoryConnectionSourceV3 = 'clob' | PriceSource;
export type HistoryGapSourceV3 = 'snapshots' | 'clob' | PriceSource;
export const HISTORY_QUALITY_WARNINGS = Object.freeze([
    'collection_stopped_early',
    'missing_frame_start_price',
    'missing_frame_end_price',
    'missing_indicator_frame_price',
    'no_snapshots',
    'insufficient_snapshot_coverage',
    /** Legacy flat-warning code retained for existing V3 frames. */
    'excessive_coin_data_gap',
    'excessive_target_price_gap_ratio',
    'target_price_gap_too_long',
    'excessive_indicator_data_gap',
    'excessive_clob_disconnect',
    'large_snapshot_gap',
] as const);
export type HistoryQualityWarning = typeof HISTORY_QUALITY_WARNINGS[number];

export interface HistoryConnectionEventV3 {
    timestamp: number;
    state: HistoryConnectionStateV3;
    code: number | undefined;
    reason: string | undefined;
    source: HistoryConnectionSourceV3;
    coin: Coin | undefined;
}

export interface HistoryDataGapV3 {
    source: HistoryGapSourceV3;
    coin: Coin | undefined;
    start_timestamp: number;
    end_timestamp: number;
    duration_ms: number;
}

export interface HistorySettlementV3 {
    derived_outcome: HistoryOutcomeV3;
    confirmed_outcome: MarketSide | undefined;
    confirmed_at: number | undefined;
}

export interface HistoryPriceQualityV3 {
    missing_snapshots: number;
    stale_snapshots: number;
    max_age_ms: number;
}

export interface HistoryDataQualityV3 {
    complete: boolean;
    expected_snapshots: number;
    snapshot_count: number;
    first_snapshot_timestamp: number | undefined;
    /** Delay before the first snapshot, recorded for collection diagnostics only. */
    first_snapshot_delay_ms?: number;
    last_snapshot_timestamp: number | undefined;
    max_snapshot_gap_ms: number;
    /** Largest continuous missing or stale target-price interval. */
    max_target_price_gap_ms?: number;
    target_price: HistoryPriceQualityV3;
    indicator_prices: Partial<Record<Coin, HistoryPriceQualityV3>>;
    disconnected_book_snapshots: number;
    /** Blocking causes of incomplete collection in newly written frames. */
    blocking_warnings?: HistoryQualityWarning[];
    /** Non-blocking indicator and CLOB diagnostics in newly written frames. */
    diagnostic_warnings?: HistoryQualityWarning[];
    /** Legacy flat warnings retained for reading existing V3 frames. */
    warnings?: HistoryQualityWarning[];
}

/** Complete multi-coin research record. V2 files are deliberately unsupported. */
export interface HistoryFrameV3 {
    schema_version: typeof HISTORY_SCHEMA_VERSION;
    /** Source used by the target Polymarket market. */
    source: PriceSource;
    /** Exact registry snapshot used while collecting this frame. */
    indicator_coins: Coin[];
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
    indicator_frame_start_prices: Partial<Record<Coin, HistoryPriceV3>>;
    indicator_frame_end_prices: Partial<Record<Coin, HistoryPriceV3>>;
    market_data: EventMarketData;
    settlement: HistorySettlementV3;
    connection_events: HistoryConnectionEventV3[];
    data_gaps: HistoryDataGapV3[];
    snapshots: HistorySnapshotV3[];
    data_quality: HistoryDataQualityV3;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) ? value : undefined;
}

export function makeHistoryPrice(price: number | undefined, timestamp: number | undefined): HistoryPriceV3 | undefined {
    const validPrice = positiveFiniteNumberOrUndefined(price);
    const validTimestamp = finiteOrUndefined(timestamp);
    return validPrice === undefined || validTimestamp === undefined ? undefined : { price: validPrice, timestamp: validTimestamp };
}

/** Converts cache order into best-price-first levels using the existing book type. */
export function selectBestLevels(levels: readonly OrderBookLevel[], depth: number): OrderBookLevel[] {
    return levels.slice(-depth).reverse().map(level => ({ ...level }));
}

export function deriveHistoryOutcome(startPrice: number | undefined, endPrice: number | undefined): HistoryOutcomeV3 {
    if (startPrice === undefined || endPrice === undefined) return 'unknown';
    if (endPrice > startPrice) return 'up';
    if (endPrice < startPrice) return 'down';
    return 'tie';
}

function appendBooleanGaps(
    gaps: HistoryDataGapV3[], snapshots: readonly HistorySnapshotV3[], intervalMs: number,
    source: HistoryGapSourceV3, coin: Coin | undefined, isGap: (snapshot: HistorySnapshotV3) => boolean,
): void {
    let start: number | undefined;
    for (const snapshot of snapshots) {
        if (isGap(snapshot)) start ??= snapshot.timestamp;
        else if (start !== undefined) {
            gaps.push({ source, coin, start_timestamp: start, end_timestamp: snapshot.timestamp, duration_ms: snapshot.timestamp - start });
            start = undefined;
        }
    }
    if (start !== undefined) {
        const end = (snapshots[snapshots.length - 1]?.timestamp ?? start) + intervalMs;
        gaps.push({ source, coin, start_timestamp: start, end_timestamp: end, duration_ms: end - start });
    }
}

function getPriceQuality(
    snapshots: readonly HistorySnapshotV3[], source: PriceSource, read: (snapshot: HistorySnapshotV3) => HistoryPriceV3 | undefined,
): HistoryPriceQualityV3 {
    let missing = 0;
    let stale = 0;
    let maxAge = 0;
    for (const snapshot of snapshots) {
        const point = read(snapshot);
        if (point === undefined) {
            missing++;
            continue;
        }
        const age = Math.max(0, snapshot.timestamp - point.timestamp);
        maxAge = Math.max(maxAge, age);
        if (age > getPriceSourceConfig(source).maxAgeMs) stale++;
    }
    return { missing_snapshots: missing, stale_snapshots: stale, max_age_ms: maxAge };
}

function isPriceQualityAcceptable(quality: Readonly<HistoryPriceQualityV3>, snapshotCount: number): boolean {
    return quality.missing_snapshots + quality.stale_snapshots <= Math.ceil(Math.max(1, snapshotCount) * HISTORY_MAX_PRICE_GAP_RATIO);
}

function isHistoryQualityWarning(value: unknown): value is HistoryQualityWarning {
    return typeof value === 'string' && HISTORY_QUALITY_WARNINGS.includes(value as HistoryQualityWarning);
}

function isHistoryQualityWarnings(value: unknown): value is HistoryQualityWarning[] {
    return Array.isArray(value) && value.every(isHistoryQualityWarning);
}

function isPriceMissingOrStale(
    snapshot: HistorySnapshotV3, source: PriceSource,
    read: (snapshot: HistorySnapshotV3) => HistoryPriceV3 | undefined,
): boolean {
    const point = read(snapshot);
    return point === undefined || snapshot.timestamp - point.timestamp > getPriceSourceConfig(source).maxAgeMs;
}

function getMaximumPriceGapMs(
    snapshots: readonly HistorySnapshotV3[], snapshotIntervalMs: number, source: PriceSource,
    read: (snapshot: HistorySnapshotV3) => HistoryPriceV3 | undefined,
): number {
    let gapStart: number | undefined;
    let maximumGapMs = 0;
    for (const snapshot of snapshots) {
        if (isPriceMissingOrStale(snapshot, source, read)) {
            gapStart ??= snapshot.timestamp;
            continue;
        }
        if (gapStart !== undefined) {
            maximumGapMs = Math.max(maximumGapMs, snapshot.timestamp - gapStart);
            gapStart = undefined;
        }
    }
    if (gapStart !== undefined) {
        const end = (snapshots[snapshots.length - 1]?.timestamp ?? gapStart) + snapshotIntervalMs;
        maximumGapMs = Math.max(maximumGapMs, end - gapStart);
    }
    return maximumGapMs;
}

export function buildHistoryGaps(
    snapshots: readonly HistorySnapshotV3[], snapshotIntervalMs: number, coin: Coin,
    source: PriceSource, indicatorCoins: readonly Coin[],
): HistoryDataGapV3[] {
    const gaps: HistoryDataGapV3[] = [];
    const maximumSnapshotGapMs = snapshotIntervalMs * 3 + HISTORY_SNAPSHOT_SCHEDULING_TOLERANCE_MS;
    for (let index = 1; index < snapshots.length; index++) {
        const previous = snapshots[index - 1]!;
        const current = snapshots[index]!;
        if (current.timestamp - previous.timestamp > maximumSnapshotGapMs) {
            const start = previous.timestamp + snapshotIntervalMs;
            gaps.push({ source: 'snapshots', coin: undefined, start_timestamp: start, end_timestamp: current.timestamp, duration_ms: current.timestamp - start });
        }
    }
    appendBooleanGaps(gaps, snapshots, snapshotIntervalMs, source, coin,
        snapshot => isPriceMissingOrStale(snapshot, source, value => makeHistoryPrice(value.coin_price, value.coin_timestamp)));
    for (const indicatorCoin of indicatorCoins) {
        appendBooleanGaps(gaps, snapshots, snapshotIntervalMs, source, indicatorCoin,
            snapshot => isPriceMissingOrStale(snapshot, source, value => value.indicator_prices[indicatorCoin]));
    }
    appendBooleanGaps(gaps, snapshots, snapshotIntervalMs, 'clob', coin, snapshot => !snapshot.book_watching);
    return gaps.sort((left, right) => left.start_timestamp - right.start_timestamp || left.source.localeCompare(right.source));
}

export interface HistoryQualityBuildInput {
    readonly snapshots: readonly HistorySnapshotV3[];
    readonly startPrice: number | undefined;
    readonly endPrice: number | undefined;
    readonly indicatorStartPrices: Readonly<Partial<Record<Coin, HistoryPriceV3>>>;
    readonly indicatorEndPrices: Readonly<Partial<Record<Coin, HistoryPriceV3>>>;
    readonly frameStartMs: number;
    readonly frameDurationMs: number;
    readonly snapshotIntervalMs: number;
    readonly stoppedEarly: boolean;
    readonly source: PriceSource;
    readonly indicatorCoins: readonly Coin[];
}

export function buildHistoryQuality({
    snapshots,
    startPrice,
    endPrice,
    indicatorStartPrices,
    indicatorEndPrices,
    frameStartMs,
    frameDurationMs,
    snapshotIntervalMs,
    stoppedEarly,
    source,
    indicatorCoins,
}: Readonly<HistoryQualityBuildInput>): HistoryDataQualityV3 {
    let maxSnapshotGapMs = 0;
    let disconnectedBookSnapshots = 0;
    snapshots.forEach((snapshot, index) => {
        const previous = snapshots[index - 1];
        if (previous) maxSnapshotGapMs = Math.max(maxSnapshotGapMs, snapshot.timestamp - previous.timestamp);
        if (!snapshot.book_watching) disconnectedBookSnapshots++;
    });
    const expectedSnapshots = Math.floor(frameDurationMs / snapshotIntervalMs);
    const firstSnapshotTimestamp = snapshots[0]?.timestamp;
    const firstSnapshotDelayMs = firstSnapshotTimestamp === undefined
        ? undefined
        : Math.max(0, firstSnapshotTimestamp - frameStartMs);
    const targetPrice = getPriceQuality(snapshots, source, snapshot => makeHistoryPrice(snapshot.coin_price, snapshot.coin_timestamp));
    const maxTargetPriceGapMs = getMaximumPriceGapMs(
        snapshots, snapshotIntervalMs, source, snapshot => makeHistoryPrice(snapshot.coin_price, snapshot.coin_timestamp),
    );
    const indicatorPrices: Partial<Record<Coin, HistoryPriceQualityV3>> = Object.fromEntries(indicatorCoins.map(indicatorCoin => [indicatorCoin,
        getPriceQuality(snapshots, source, snapshot => snapshot.indicator_prices[indicatorCoin]),
    ]));
    const enoughSnapshots = snapshots.length >= Math.floor(expectedSnapshots * 0.95);
    const acceptableBook = disconnectedBookSnapshots <= Math.ceil(Math.max(1, snapshots.length) * 0.02);
    const acceptableGap = maxSnapshotGapMs <= HISTORY_MAX_COMPLETE_SNAPSHOT_GAP_MS;
    const hasIndicatorFramePrices = indicatorCoins.every(indicatorCoin =>
        indicatorStartPrices[indicatorCoin] !== undefined && indicatorEndPrices[indicatorCoin] !== undefined,
    );
    const acceptableIndicators = indicatorCoins.every(indicatorCoin =>
        isPriceQualityAcceptable(indicatorPrices[indicatorCoin]!, snapshots.length),
    );
    const blockingWarnings: HistoryQualityWarning[] = [];
    const diagnosticWarnings: HistoryQualityWarning[] = [];
    if (stoppedEarly) blockingWarnings.push('collection_stopped_early');
    if (startPrice === undefined) blockingWarnings.push('missing_frame_start_price');
    if (endPrice === undefined) blockingWarnings.push('missing_frame_end_price');
    if (snapshots.length === 0) blockingWarnings.push('no_snapshots');
    if (!enoughSnapshots) blockingWarnings.push('insufficient_snapshot_coverage');
    if (!isPriceQualityAcceptable(targetPrice, snapshots.length)) {
        blockingWarnings.push('excessive_target_price_gap_ratio');
    }
    if (maxTargetPriceGapMs > HISTORY_MAX_COMPLETE_TARGET_PRICE_GAP_MS) {
        blockingWarnings.push('target_price_gap_too_long');
    }
    if (!acceptableGap) blockingWarnings.push('large_snapshot_gap');
    if (!hasIndicatorFramePrices) diagnosticWarnings.push('missing_indicator_frame_price');
    if (!acceptableIndicators) diagnosticWarnings.push('excessive_indicator_data_gap');
    if (!acceptableBook) diagnosticWarnings.push('excessive_clob_disconnect');
    const firstSnapshotDelay = firstSnapshotDelayMs === undefined ? {} : { first_snapshot_delay_ms: firstSnapshotDelayMs };
    return {
        complete: blockingWarnings.length === 0,
        expected_snapshots: expectedSnapshots, snapshot_count: snapshots.length,
        first_snapshot_timestamp: firstSnapshotTimestamp,
        ...firstSnapshotDelay,
        last_snapshot_timestamp: snapshots[snapshots.length - 1]?.timestamp,
        max_snapshot_gap_ms: maxSnapshotGapMs, max_target_price_gap_ms: maxTargetPriceGapMs,
        target_price: targetPrice, indicator_prices: indicatorPrices,
        disconnected_book_snapshots: disconnectedBookSnapshots,
        blocking_warnings: blockingWarnings, diagnostic_warnings: diagnosticWarnings,
    };
}

function isValidPrice(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const price = value as Partial<HistoryPriceV3>;
    return positiveFiniteNumberOrUndefined(price.price) !== undefined && Number.isFinite(price.timestamp);
}

export function validateHistoryFrame(frame: HistoryFrameV3): string[] {
    const errors: string[] = [];
    if (frame.schema_version !== HISTORY_SCHEMA_VERSION) errors.push('unsupported_schema_version');
    if (!isCoin(frame.coin)) errors.push('unsupported_coin');
    if (!isEventFrame(frame.frame)) errors.push('unsupported_frame');
    if (!isPriceSource(frame.source)) errors.push('unsupported_price_source');
    if (frame.indicator_coins.length === 0 || new Set(frame.indicator_coins).size !== frame.indicator_coins.length ||
        frame.indicator_coins.some(coin => !isCoin(coin))) errors.push('invalid_indicator_coins');
    if (frame.start_time >= frame.end_time) errors.push('invalid_frame_time');
    if (frame.snapshot_interval_ms <= 0) errors.push('invalid_snapshot_interval');
    if (frame.book_depth <= 0) errors.push('invalid_book_depth');
    if (!frame.market_data.eventId || !frame.market_data.marketId || !frame.market_data.conditionId) errors.push('missing_market_ids');
    if (!Number.isFinite(frame.market_data.tick_size) || frame.market_data.tick_size <= 0) errors.push('invalid_tick_size');
    if (!Number.isFinite(frame.market_data.min_order_size) || frame.market_data.min_order_size <= 0) errors.push('invalid_min_order_size');
    if (!Number.isFinite(frame.market_data.taker_base_fee) || frame.market_data.taker_base_fee < 0) errors.push('invalid_taker_fee');
    if ((frame.coin_frame_start_price !== undefined && positiveFiniteNumberOrUndefined(frame.coin_frame_start_price) === undefined) ||
        (frame.coin_frame_end_price !== undefined && positiveFiniteNumberOrUndefined(frame.coin_frame_end_price) === undefined)) {
        errors.push('invalid_frame_price');
    }
    if (frame.data_quality.snapshot_count !== frame.snapshots.length) errors.push('snapshot_count_mismatch');
    if (frame.data_quality.first_snapshot_delay_ms !== undefined &&
        (!Number.isFinite(frame.data_quality.first_snapshot_delay_ms) || frame.data_quality.first_snapshot_delay_ms < 0)) {
        errors.push('invalid_first_snapshot_delay');
    }
    if (frame.indicator_coins.some(coin => frame.data_quality.indicator_prices[coin] === undefined)) errors.push('missing_indicator_quality');
    if (Object.keys(frame.data_quality.indicator_prices).some(coin => !frame.indicator_coins.includes(coin as Coin))) {
        errors.push('invalid_indicator_quality');
    }
    const quality = frame.data_quality;
    const usesLegacyWarningFormat = quality.warnings !== undefined;
    const usesSplitWarningFormat = quality.blocking_warnings !== undefined || quality.diagnostic_warnings !== undefined ||
        quality.max_target_price_gap_ms !== undefined;
    if (usesLegacyWarningFormat === usesSplitWarningFormat) {
        errors.push('invalid_quality_warning_format');
    } else if (usesLegacyWarningFormat) {
        if (!isHistoryQualityWarnings(quality.warnings)) errors.push('invalid_quality_warning_format');
        else if (quality.complete && quality.warnings.length > 0) errors.push('complete_with_quality_warning');
    } else if (!isHistoryQualityWarnings(quality.blocking_warnings) || !isHistoryQualityWarnings(quality.diagnostic_warnings) ||
        !Number.isFinite(quality.max_target_price_gap_ms) || quality.max_target_price_gap_ms! < 0) {
        errors.push('invalid_quality_warning_format');
    } else if (quality.complete && quality.blocking_warnings.length > 0) {
        errors.push('complete_with_blocking_quality_warning');
    } else if (!quality.complete && quality.blocking_warnings.length === 0) {
        errors.push('incomplete_without_blocking_quality_warning');
    }
    if ((frame.settlement.confirmed_outcome === undefined) !== (frame.settlement.confirmed_at === undefined)) errors.push('incomplete_confirmed_settlement');
    if (Object.entries(frame.indicator_frame_start_prices).some(([coin, point]) => !frame.indicator_coins.includes(coin as Coin) || !isValidPrice(point)) ||
        Object.entries(frame.indicator_frame_end_prices).some(([coin, point]) => !frame.indicator_coins.includes(coin as Coin) || !isValidPrice(point))) errors.push('invalid_indicator_frame_price');
    for (let index = 0; index < frame.snapshots.length; index++) {
        const snapshot = frame.snapshots[index]!;
        if (index > 0 && snapshot.timestamp < frame.snapshots[index - 1]!.timestamp) errors.push('snapshots_not_chronological');
        if (snapshot.coin_price !== undefined && positiveFiniteNumberOrUndefined(snapshot.coin_price) === undefined) {
            errors.push('invalid_coin_snapshot_price');
        }
        if (Object.entries(snapshot.indicator_prices).some(([coin, point]) => !frame.indicator_coins.includes(coin as Coin) || !isValidPrice(point))) errors.push('invalid_indicator_snapshot_price');
    }
    if (frame.data_gaps.some(gap => gap.start_timestamp > gap.end_timestamp || gap.duration_ms !== gap.end_timestamp - gap.start_timestamp || (gap.coin !== undefined && !isCoin(gap.coin)))) errors.push('invalid_data_gap');
    if (frame.connection_events.some(event => (!isPriceSource(event.source) && event.source !== 'clob') || (event.coin !== undefined && !isCoin(event.coin)))) errors.push('invalid_connection_event');
    return [...new Set(errors)];
}

export const historyNumberOrUndefined = finiteOrUndefined;
