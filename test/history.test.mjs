import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

import { HistoryFrameWriter } from '../dist/app/core/history/HistoryFrameWriter.js';
import { readHistoryFrame, readHistoryFrames } from '../dist/app/core/history/HistoryFrameReader.js';
import { HistoryFrameRollingWindow } from '../dist/app/core/history/history_frame_window.js';
import {
    getHistoryProfileStatusPath,
    readHistoryProfileStatus,
    rebuildHistoryProfileStatus,
    writeHistoryProfileStatus,
} from '../dist/app/core/history/HistoryProfileStatus.js';
import {
    getConfirmedOutcome,
    getConfirmedOutcomeForFrame,
    settleHistoryDirectory,
} from '../dist/app/core/history/HistorySettlementService.js';
import {
    HISTORY_SCHEMA_VERSION,
    HISTORY_MAX_COMPLETE_SNAPSHOT_GAP_MS,
    HISTORY_MAX_COMPLETE_TARGET_PRICE_GAP_MS,
    HISTORY_SNAPSHOT_SCHEDULING_TOLERANCE_MS,
    buildHistoryGaps,
    buildHistoryQuality,
    deriveHistoryOutcome,
    selectBestLevels,
    validateHistoryFrame,
} from '../dist/app/core/history/history_frame.js';
import { getSupportedCoins, isCoin } from '../dist/market/coins.js';
import { getSupportedFrames, waitFrameStartMsUntil } from '../dist/market/frame.js';
import { getPriceSourceConfig, getPriceSourceReconnectDelayMs, getSupportedPriceSources, PS_BINANCE, PS_CHAINLINK_TWAP_60 } from '../dist/market/price/price_source.js';
import { CoinPriceWatcherTWAP } from '../dist/market/price/CoinPriceWatcherTWAP.js';
import { isPriceStreamStale } from '../dist/market/price/CoinPriceWatcher.js';
import { CoinPriceWatcherRTDS } from '../dist/market/price/CoinPriceWatcherRTDS.js';
import { SharedCoinPriceFeed } from '../dist/market/price/SharedCoinPriceFeed.js';
import { SharedCoinPriceWatcher } from '../dist/market/price/SharedCoinPriceWatcher.js';

const unzip = promisify(gunzip);
const temporaryDirectories = [];

after(async () => {
    await Promise.all(temporaryDirectories.map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function makeSide(timestamp) {
    return {
        book_timestamp: timestamp,
        midpoint: 0.5,
        spread: 0.02,
        bids: [{ price: 0.49, size: 10 }],
        asks: [{ price: 0.51, size: 10 }],
    };
}

function makeFrame(startTime, stoppedEarly = false) {
    const interval = 100;
    const indicatorPrices = timestamp => Object.fromEntries(getSupportedCoins().map(coin => [coin, { price: 60_000, timestamp }]));
    const snapshots = Array.from({ length: 10 }, (_, index) => {
        const timestamp = startTime * 1_000 + index * interval;
        return {
            timestamp,
            coin_price: 60_000 + index,
            coin_timestamp: timestamp,
            indicator_prices: indicatorPrices(timestamp),
            book_watching: true,
            up: makeSide(timestamp),
            down: makeSide(timestamp),
        };
    });
    const startPrice = 60_000;
    const endPrice = stoppedEarly ? undefined : 60_010;
    return {
        schema_version: HISTORY_SCHEMA_VERSION,
        source: PS_CHAINLINK_TWAP_60,
        indicator_coins: [...getSupportedCoins()],
        coin: 'btc',
        frame: '5m',
        slug: `btc-updown-5m-${startTime}`,
        start_time: startTime,
        end_time: startTime + 300,
        collected_at: startTime * 1_000 + 1_000,
        snapshot_interval_ms: interval,
        book_depth: 10,
        coin_frame_start_price: startPrice,
        coin_frame_end_price: endPrice,
        indicator_frame_start_prices: indicatorPrices(startTime * 1_000),
        indicator_frame_end_prices: indicatorPrices((startTime + 300) * 1_000),
        market_data: {
            eventId: `event-${startTime}`,
            marketId: `market-${startTime}`,
            conditionId: `condition-${startTime}`,
            tick_size: 0.01,
            min_order_size: 5,
            fees_enabled: true,
            maker_base_fee: 0,
            taker_base_fee: 0.07,
            rewards_max_spread: 0,
            rewards_min_size: 0,
            up: { outcome: 'up', tokenId: 'up-token' },
            down: { outcome: 'down', tokenId: 'down-token' },
        },
        settlement: {
            derived_outcome: deriveHistoryOutcome(startPrice, endPrice),
            confirmed_outcome: undefined,
            confirmed_at: undefined,
        },
        connection_events: [],
        data_gaps: buildHistoryGaps(snapshots, interval, 'btc', PS_CHAINLINK_TWAP_60, getSupportedCoins()),
        snapshots,
        data_quality: buildHistoryQuality({
            snapshots,
            startPrice,
            endPrice,
            indicatorStartPrices: indicatorPrices(startTime * 1_000),
            indicatorEndPrices: indicatorPrices((startTime + 300) * 1_000),
            frameStartMs: startTime * 1_000,
            frameDurationMs: 1_000,
            snapshotIntervalMs: interval,
            stoppedEarly,
            source: PS_CHAINLINK_TWAP_60,
            indicatorCoins: getSupportedCoins(),
        }),
    };
}

test('history rolling window retains only its bounded projected values', () => {
    const window = new HistoryFrameRollingWindow(2, frame => frame.slug);
    window.push(makeFrame(1_000));
    window.push(makeFrame(1_300));
    assert.deepEqual(window.values(), ['btc-updown-5m-1000', 'btc-updown-5m-1300']);
    assert.deepEqual(window.shift(), ['btc-updown-5m-1000']);
    window.push(makeFrame(1_600));
    assert.deepEqual(window.values(), ['btc-updown-5m-1300', 'btc-updown-5m-1600']);
    assert.throws(() => window.push(makeFrame(1_900)), /history_frame_window_capacity_exceeded/);
});

function buildTestFrameQuality(frame, frameDurationMs = 1_000) {
    return buildHistoryQuality({
        snapshots: frame.snapshots,
        startPrice: frame.coin_frame_start_price,
        endPrice: frame.coin_frame_end_price,
        indicatorStartPrices: frame.indicator_frame_start_prices,
        indicatorEndPrices: frame.indicator_frame_end_prices,
        frameStartMs: frame.start_time * 1_000,
        frameDurationMs,
        snapshotIntervalMs: frame.snapshot_interval_ms,
        stoppedEarly: false,
        source: frame.source,
        indicatorCoins: frame.indicator_coins,
    });
}

function makeFrameSnapshotSeries(frame, { snapshotCount, intervalMs, gapStart, gapSnapshotCount }) {
    const templates = frame.snapshots;
    return Array.from({ length: snapshotCount }, (_, index) => {
        const template = templates[index % templates.length];
        const timestamp = frame.start_time * 1_000 + index * intervalMs;
        const missingTargetPrice = index >= gapStart && index < gapStart + gapSnapshotCount;
        return {
            ...template,
            timestamp,
            coin_price: missingTargetPrice ? undefined : template.coin_price,
            coin_timestamp: missingTargetPrice ? undefined : timestamp,
            indicator_prices: Object.fromEntries(Object.entries(template.indicator_prices).map(([coin, price]) => [coin, {
                ...price,
                timestamp,
            }])),
        };
    });
}

test('selectBestLevels returns existing book levels in best-price-first order', () => {
    const levels = [
        { price: '0.47', size: '30' },
        { price: '0.48', size: '20' },
        { price: '0.49', size: '10' },
    ];
    assert.deepEqual(selectBestLevels(levels, 2), [
        { price: '0.49', size: '10' },
        { price: '0.48', size: '20' },
    ]);
});

test('canonical coin registry excludes removed HYPE markets', () => {
    assert.ok(!getSupportedCoins().includes('hype'));
    assert.equal(isCoin('hype'), false);
});

test('quality marks stopped frames incomplete and validator accepts the structure', () => {
    const complete = makeFrame(1_000);
    const incomplete = makeFrame(1_300, true);
    assert.equal(complete.data_quality.complete, true);
    assert.equal(incomplete.data_quality.complete, false);
    assert.ok(incomplete.data_quality.blocking_warnings.includes('collection_stopped_early'));
    assert.deepEqual(validateHistoryFrame(complete), []);
    assert.deepEqual(validateHistoryFrame(incomplete), []);
});

test('first snapshot delay is diagnostic and does not change completeness', () => {
    const frame = makeFrame(1_350);
    for (const snapshot of frame.snapshots) {
        snapshot.timestamp += 500;
        snapshot.coin_timestamp += 500;
        Object.values(snapshot.indicator_prices).forEach(price => { price.timestamp += 500; });
    }
    frame.data_quality = buildTestFrameQuality(frame);
    assert.equal(frame.data_quality.first_snapshot_delay_ms, 500);
    assert.equal(frame.data_quality.complete, true);
});

test('an empty frame omits first snapshot delay and remains incomplete', () => {
    const frame = makeFrame(1_375);
    frame.snapshots = [];
    const quality = buildTestFrameQuality(frame);
    assert.equal('first_snapshot_delay_ms' in quality, false);
    assert.equal(quality.complete, false);
    assert.ok(quality.blocking_warnings.includes('no_snapshots'));
});

test('indicator gaps remain diagnostic and do not make a target-complete frame incomplete', () => {
    const frame = makeFrame(1_400);
    delete frame.snapshots[2].indicator_prices.eth;
    delete frame.snapshots[3].indicator_prices.eth;
    frame.data_quality = buildTestFrameQuality(frame);
    assert.equal(frame.data_quality.complete, true);
    assert.ok(frame.data_quality.diagnostic_warnings.includes('excessive_indicator_data_gap'));
});

test('CLOB gaps remain diagnostic and do not make a target-complete frame incomplete', () => {
    const frame = makeFrame(1_425);
    frame.snapshots[2].book_watching = false;
    frame.snapshots[3].book_watching = false;
    frame.data_quality = buildTestFrameQuality(frame);
    assert.equal(frame.data_quality.complete, true);
    assert.ok(frame.data_quality.diagnostic_warnings.includes('excessive_clob_disconnect'));
});

test('history validates source and coin for every connection event', () => {
    const frame = makeFrame(1_450);
    frame.connection_events.push({ timestamp: 1, state: 'open', code: undefined, reason: undefined, source: 'clob', coin: 'btc' });
    assert.deepEqual(validateHistoryFrame(frame), []);
    frame.connection_events[0].source = 'invalid';
    assert.ok(validateHistoryFrame(frame).includes('invalid_connection_event'));
});

test('history rejects quality outside its saved indicator basket', () => {
    const frame = makeFrame(1_475);
    frame.data_quality.indicator_prices.extra = { missing_snapshots: 0, stale_snapshots: 0, max_age_ms: 0 };
    assert.ok(validateHistoryFrame(frame).includes('invalid_indicator_quality'));
});

test('history rejects non-positive target and indicator prices', () => {
    const frame = makeFrame(1_480);
    frame.coin_frame_start_price = 0;
    frame.snapshots[0].coin_price = -1;
    frame.snapshots[1].indicator_prices.doge.price = 0;
    const errors = validateHistoryFrame(frame);
    assert.ok(errors.includes('invalid_frame_price'));
    assert.ok(errors.includes('invalid_coin_snapshot_price'));
    assert.ok(errors.includes('invalid_indicator_snapshot_price'));
});

test('TWAP watchdog identifies silence from either connection or last update time', () => {
    assert.equal(isPriceStreamStale(undefined, 1_000, 15_000, 15_000), false);
    assert.equal(isPriceStreamStale(undefined, 1_000, 16_001, 15_000), true);
    assert.equal(isPriceStreamStale(10_000, 1_000, 24_999, 15_000), false);
    assert.equal(isPriceStreamStale(10_000, 1_000, 25_001, 15_000), true);
});

test('every source keeps live reads fast while history capture has a longer timeout', () => {
    for (const source of getSupportedPriceSources()) {
        const config = getPriceSourceConfig(source);
        assert.equal(config.framePriceReadTimeoutMs, 5_000);
        assert.equal(config.framePriceCaptureTimeoutMs, 20_000);
        assert.equal(config.staleReconnectMs, 10_000);
    }
});

test('source reconnect delay uses capped exponential backoff', () => {
    assert.equal(getPriceSourceReconnectDelayMs(PS_CHAINLINK_TWAP_60, 1), 1_000);
    assert.equal(getPriceSourceReconnectDelayMs(PS_CHAINLINK_TWAP_60, 2), 2_000);
    assert.equal(getPriceSourceReconnectDelayMs(PS_CHAINLINK_TWAP_60, 5), 16_000);
    assert.equal(getPriceSourceReconnectDelayMs(PS_CHAINLINK_TWAP_60, 10), 30_000);
});

test('shared TWAP feed subscribes once for the complete requested basket', async () => {
    let requests;
    const handle = {
        async close() {},
        [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; },
    };
    const feed = new SharedCoinPriceFeed(PS_CHAINLINK_TWAP_60, ['btc', 'eth'], {
        async subscribe(value) { requests = value; return handle; },
    });
    const btc = new SharedCoinPriceWatcher('btc', feed);
    const eth = new SharedCoinPriceWatcher('eth', feed);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].symbols, ['btc/usd', 'eth/usd']);
    btc.disconnect();
    eth.disconnect();
});

test('shared RTDS feed uses one client with one filter per basket symbol', () => {
    let args;
    let subscription;
    const feed = new SharedCoinPriceFeed(PS_BINANCE, ['btc', 'eth'], value => {
        args = value;
        return {
            connect() { return this; },
            disconnect() {},
            subscribe(value) { subscription = value; },
        };
    });
    const btc = new SharedCoinPriceWatcher('btc', feed);
    const eth = new SharedCoinPriceWatcher('eth', feed);
    args.onConnect({ subscribe: value => { subscription = value; } });

    assert.equal(subscription.subscriptions.length, 2);
    assert.deepEqual(subscription.subscriptions.map(value => JSON.parse(value.filters).symbol), ['btcusdt', 'ethusdt']);
    btc.disconnect();
    eth.disconnect();
});


test('TWAP watchdog closes a silent subscription', async () => {
    const handle = {
        closeCalls: 0,
        async close() { handle.closeCalls++; },
        [Symbol.asyncIterator]() {
            return { next: () => new Promise(() => {}) };
        },
    };
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
        const watcher = new CoinPriceWatcherTWAP('btc', PS_CHAINLINK_TWAP_60, {
            subscribe: async () => handle,
        });
        const events = [];
        watcher.subscribeConnectionEvents(event => events.push(event));
        await new Promise(resolve => setImmediate(resolve));
        now = 26_001;
        await new Promise(resolve => setTimeout(resolve, 60));

        assert.equal(handle.closeCalls, 1);
        assert.deepEqual(events.map(event => event.state), ['open', 'stale']);
        watcher.disconnect();
    } finally {
        Date.now = realNow;
    }
});

test('RTDS records connection lifecycle and clears a disconnected price', () => {
    const clients = [];
    let clientArgs;
    const clientFactory = args => {
        clientArgs = args;
        const client = {
            connect() { return client; },
            disconnect() {},
            subscribe() {},
        };
        clients.push(client);
        return client;
    };
    const watcher = new CoinPriceWatcherRTDS('btc', 'binance', clientFactory);
    const events = [];
    const unsubscribe = watcher.subscribeConnectionEvents(event => events.push(event));

    clientArgs.onStatusChange('CONNECTED');
    clientArgs.onMessage(clients[0], {
        topic: 'crypto_prices', type: 'update',
        payload: { symbol: 'btcusdt', value: 60_000, timestamp: 1_000 },
    });
    assert.equal(watcher.getCurrentPrice(), 60_000);
    clientArgs.onMessage(clients[0], {
        topic: 'crypto_prices', type: 'update',
        payload: { symbol: 'btcusdt', value: 0, timestamp: 1_001 },
    });
    assert.equal(watcher.getCurrentPrice(), 60_000);
    assert.equal(watcher.getTimeStamp(), 1_000);
    clientArgs.onStatusChange('DISCONNECTED');

    assert.deepEqual(events.map(event => event.state), ['open', 'close']);
    assert.equal(watcher.getCurrentPrice(), undefined);
    unsubscribe();
    watcher.disconnect();
});

test('price watchers retain the latest valid price when an invalid update arrives', async () => {
    const twapHandle = {
        async close() {},
        [Symbol.asyncIterator]() {
            let index = 0;
            const events = [
                { payload: { symbol: 'btc/usd', value: '60000', timestamp: 1_000 } },
                { payload: { symbol: 'btc/usd', value: '0', timestamp: 1_001 } },
                { payload: { symbol: 'btc/usd', value: true, timestamp: 1_002 } },
            ];
            return {
                next: () => index < events.length
                    ? Promise.resolve({ value: events[index++], done: false })
                    : new Promise(() => {}),
            };
        },
    };
    const twap = new CoinPriceWatcherTWAP('btc', PS_CHAINLINK_TWAP_60, { subscribe: async () => twapHandle });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(twap.getCurrentPrice(), 60_000);
    assert.equal(twap.getTimeStamp(), 1_000);
    twap.disconnect();

    let args;
    const feed = new SharedCoinPriceFeed(PS_BINANCE, ['btc'], value => {
        args = value;
        return { connect() { return this; }, disconnect() {}, subscribe() {} };
    });
    const shared = new SharedCoinPriceWatcher('btc', feed);
    args.onStatusChange('CONNECTED');
    args.onMessage(undefined, {
        topic: 'crypto_prices', type: 'update', payload: { symbol: 'btcusdt', value: '60000', timestamp: 1_000 },
    });
    args.onMessage(undefined, {
        topic: 'crypto_prices', type: 'update', payload: { symbol: 'btcusdt', value: 0, timestamp: 1_001 },
    });
    args.onMessage(undefined, {
        topic: 'crypto_prices', type: 'update', payload: { symbol: 'btcusdt', value: true, timestamp: 1_002 },
    });
    assert.equal(shared.getCurrentPrice(), 60_000);
    assert.equal(shared.getTimeStamp(), 1_000);
    shared.disconnect();
});

test('RTDS watchdog closes a silent stream and creates a replacement client', async () => {
    const clients = [];
    let clientArgs;
    const clientFactory = args => {
        clientArgs = args;
        const client = {
            disconnectCalls: 0,
            connect() { return client; },
            disconnect() { client.disconnectCalls++; },
            subscribe() {},
        };
        clients.push(client);
        return client;
    };
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
        const watcher = new CoinPriceWatcherRTDS('btc', 'binance', clientFactory);
        const events = [];
        watcher.subscribeConnectionEvents(event => events.push(event));
        clientArgs.onStatusChange('CONNECTED');
        now = 26_001;
        await new Promise(resolve => setTimeout(resolve, 60));

        assert.equal(clients[0].disconnectCalls, 1);
        assert.equal(clients.length, 2);
        assert.deepEqual(events.map(event => event.state), ['open', 'stale']);
        watcher.disconnect();
    } finally {
        Date.now = realNow;
    }
});

test('quality accepts one-sided and unchanged books while CLOB is connected', () => {
    const frame = makeFrame(1_600);
    for (const snapshot of frame.snapshots) {
        snapshot.up.asks = [];
        snapshot.down.bids = [];
    }
    const quality = buildTestFrameQuality(frame);

    assert.equal(quality.disconnected_book_snapshots, 0);
    assert.equal(quality.complete, true);
    assert.ok(!frame.data_gaps.some(gap => gap.source === 'clob'));
});

test('gaps distinguish coin data and actual CLOB disconnects', () => {
    const frame = makeFrame(1_700);
    frame.snapshots[2].coin_timestamp = frame.snapshots[2].timestamp - 6_000;
    frame.snapshots[3].coin_timestamp = frame.snapshots[3].timestamp - 6_000;
    frame.snapshots[3].book_watching = false;
    const gaps = buildHistoryGaps(frame.snapshots, 100, 'btc', PS_CHAINLINK_TWAP_60, getSupportedCoins());
    assert.ok(gaps.some(gap => gap.source === PS_CHAINLINK_TWAP_60));
    assert.ok(gaps.some(gap => gap.source === 'clob'));
    const quality = buildTestFrameQuality(frame);
    assert.equal(quality.complete, false);
    assert.equal(quality.target_price.stale_snapshots, 2);
});

test('snapshot gaps above 500ms are diagnostic and gaps above one second block completeness', () => {
    const frame = makeFrame(1_650);
    const updateTimestamps = gapMs => {
        const start = frame.start_time * 1_000;
        frame.snapshots.forEach((snapshot, index) => {
            const timestamp = index === 0 ? start : start + gapMs + (index - 1) * 50;
            snapshot.timestamp = timestamp;
            snapshot.coin_timestamp = timestamp;
            Object.values(snapshot.indicator_prices).forEach(price => { price.timestamp = timestamp; });
        });
    };
    updateTimestamps(501);
    const accepted = buildTestFrameQuality(frame);
    assert.equal(HISTORY_SNAPSHOT_SCHEDULING_TOLERANCE_MS, 200);
    assert.equal(accepted.complete, true);
    assert.equal(accepted.blocking_warnings.includes('large_snapshot_gap'), false);
    assert.ok(buildHistoryGaps(frame.snapshots, 100, 'btc', frame.source, frame.indicator_coins)
        .some(gap => gap.source === 'snapshots'));

    updateTimestamps(HISTORY_MAX_COMPLETE_SNAPSHOT_GAP_MS + 1);
    const rejected = buildTestFrameQuality(frame);
    assert.equal(rejected.complete, false);
    assert.ok(rejected.blocking_warnings.includes('large_snapshot_gap'));
    assert.ok(buildHistoryGaps(frame.snapshots, 100, 'btc', frame.source, frame.indicator_coins)
        .some(gap => gap.source === 'snapshots'));
});

test('target price quality allows five percent short gaps and records their maximum duration', () => {
    const frame = makeFrame(1_700);
    const additionalSnapshots = frame.snapshots.map(snapshot => ({
        ...snapshot,
        timestamp: snapshot.timestamp + 1_000,
        coin_timestamp: snapshot.coin_timestamp + 1_000,
        indicator_prices: Object.fromEntries(Object.entries(snapshot.indicator_prices).map(([coin, price]) => [coin, {
            ...price,
            timestamp: price.timestamp + 1_000,
        }])),
    }));
    frame.snapshots.push(...additionalSnapshots);
    frame.snapshots[4].coin_price = undefined;
    frame.snapshots[4].coin_timestamp = undefined;
    const quality = buildTestFrameQuality(frame, 2_000);
    assert.equal(quality.complete, true);
    assert.equal(quality.target_price.missing_snapshots, 1);
    assert.equal(quality.max_target_price_gap_ms, 100);
});

test('a ten-second target gap passes and a longer gap blocks independently of its ratio', () => {
    const frame = makeFrame(1_800);
    frame.snapshots = makeFrameSnapshotSeries(frame, {
        snapshotCount: 2_020,
        intervalMs: 100,
        gapStart: 500,
        gapSnapshotCount: 100,
    });
    const accepted = buildTestFrameQuality(frame, 202_000);
    assert.equal(accepted.max_target_price_gap_ms, HISTORY_MAX_COMPLETE_TARGET_PRICE_GAP_MS);
    assert.equal(accepted.complete, true);

    frame.snapshots[600].coin_price = undefined;
    frame.snapshots[600].coin_timestamp = undefined;
    const rejected = buildTestFrameQuality(frame, 202_000);
    assert.equal(rejected.complete, false);
    assert.ok(rejected.max_target_price_gap_ms > HISTORY_MAX_COMPLETE_TARGET_PRICE_GAP_MS);
    assert.ok(rejected.blocking_warnings.includes('target_price_gap_too_long'));
    assert.equal(rejected.blocking_warnings.includes('excessive_target_price_gap_ratio'), false);
});

test('target price gaps above five percent block completeness independently of their duration', () => {
    const frame = makeFrame(1_850);
    for (const snapshot of [frame.snapshots[1], frame.snapshots[3]]) {
        snapshot.coin_price = undefined;
        snapshot.coin_timestamp = undefined;
    }
    const quality = buildTestFrameQuality(frame);
    assert.equal(quality.complete, false);
    assert.ok(quality.blocking_warnings.includes('excessive_target_price_gap_ratio'));
    assert.equal(quality.blocking_warnings.includes('target_price_gap_too_long'), false);
});

test('target price ratio and duration violations are both preserved', () => {
    const frame = makeFrame(1_875);
    frame.snapshots = makeFrameSnapshotSeries(frame, {
        snapshotCount: 110,
        intervalMs: 100,
        gapStart: 0,
        gapSnapshotCount: 110,
    });
    const quality = buildTestFrameQuality(frame, 11_000);
    assert.ok(quality.blocking_warnings.includes('excessive_target_price_gap_ratio'));
    assert.ok(quality.blocking_warnings.includes('target_price_gap_too_long'));
});

test('new and legacy warning formats both validate', () => {
    const currentFrame = makeFrame(1_900);
    assert.deepEqual(validateHistoryFrame(currentFrame), []);

    const legacyFrame = makeFrame(2_000);
    const { blocking_warnings, diagnostic_warnings, first_snapshot_delay_ms, max_target_price_gap_ms, ...legacyQuality } = legacyFrame.data_quality;
    legacyFrame.data_quality = { ...legacyQuality, complete: false, warnings: ['excessive_coin_data_gap'] };
    assert.deepEqual(validateHistoryFrame(legacyFrame), []);
});

test('history rejects invalid split warning values', () => {
    const negativeGapFrame = makeFrame(2_100);
    negativeGapFrame.data_quality.max_target_price_gap_ms = -1;
    assert.ok(validateHistoryFrame(negativeGapFrame).includes('invalid_quality_warning_format'));

    const unknownWarningFrame = makeFrame(2_200);
    unknownWarningFrame.data_quality.diagnostic_warnings.push('unknown_warning');
    assert.ok(validateHistoryFrame(unknownWarningFrame).includes('invalid_quality_warning_format'));

    const negativeFirstDelayFrame = makeFrame(2_300);
    negativeFirstDelayFrame.data_quality.first_snapshot_delay_ms = -1;
    assert.ok(validateHistoryFrame(negativeFirstDelayFrame).includes('invalid_first_snapshot_delay'));
});

test('history schema accepts every coin and frame from the canonical registries', () => {
    for (const coin of getSupportedCoins()) {
        for (const frameName of getSupportedFrames()) {
            for (const source of getSupportedPriceSources()) {
                const frame = makeFrame(2_000);
                frame.coin = coin;
                frame.frame = frameName;
                frame.source = source;
                assert.deepEqual(validateHistoryFrame(frame), []);
            }
        }
    }
});

test('writer atomically stores gzip with stable names and rotates by frame', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-'));
    temporaryDirectories.push(directory);
    const writer = new HistoryFrameWriter({ directory, gzip: true, maxFrames: 2 });

    await writer.write(makeFrame(1_000));
    await writer.write(makeFrame(1_300, true));
    const latest = await writer.write(makeFrame(1_600));

    const files = (await fs.readdir(directory)).sort();
    assert.equal(files.length, 2);
    assert.ok(files.some(name => name.startsWith('1000-')));
    assert.ok(files.some(name => name.startsWith('1600-')));
    assert.ok(files.every(name => !name.includes('.partial.')));
    assert.ok(files.every(name => !name.endsWith('.tmp')));
    assert.equal((await fs.readdir(path.join(path.dirname(directory), 'diagnostics'))).length, 1);

    const decoded = JSON.parse((await unzip(await fs.readFile(latest.path))).toString('utf8'));
    assert.equal(decoded.start_time, 1_600);
    assert.equal(decoded.data_quality.complete, true);
    assert.equal(decoded.schema_version, 3);
    assert.equal((await readHistoryFrame(latest.path)).start_time, 1_600);
});

test('cyclic writer retains the newest limit per selected coin without deleting other coins', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-cycle-'));
    temporaryDirectories.push(directory);
    const writer = new HistoryFrameWriter({
        directory,
        gzip: true,
        maxFrames: 0,
        maxFramesPerCoin: 2,
        retainedCoins: ['doge'],
    });
    for (const start of [1_000, 1_300, 1_600]) await writer.write(makeFrame(start));
    for (const start of [1_900, 2_200, 2_500]) {
        const frame = makeFrame(start);
        frame.coin = 'doge';
        frame.slug = `doge-updown-5m-${start}`;
        await writer.write(frame);
    }
    const frames = [];
    for (const name of await fs.readdir(directory)) frames.push(await readHistoryFrame(path.join(directory, name)));
    assert.equal(frames.filter(frame => frame.coin === 'btc').length, 3);
    assert.deepEqual(frames.filter(frame => frame.coin === 'doge').map(frame => frame.start_time).sort(), [2_200, 2_500]);
});

test('retention separates diagnostics and rotates only after a complete frame', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-retention-'));
    const directory = path.join(root, 'frames');
    temporaryDirectories.push(root);
    const writer = new HistoryFrameWriter({
        directory,
        gzip: true,
        maxFrames: 0,
        maxFramesPerCoin: 2,
        retainedCoins: ['btc'],
        diagnosticRetentionFrames: 1,
    });
    await writer.write(makeFrame(1_000));
    await writer.write(makeFrame(1_300));
    await writer.write(makeFrame(1_600, true));
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.json.gz')).length, 2);
    assert.equal((await fs.readdir(path.join(root, 'diagnostics'))).filter(name => name.endsWith('.json.gz')).length, 1);

    await writer.write(makeFrame(1_900));
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.json.gz')).length, 2);
    assert.equal((await fs.readdir(path.join(root, 'diagnostics'))).filter(name => name.endsWith('.json.gz')).length, 1);
});

test('writer without cycle retention preserves complete history and separates diagnostics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-diagnostics-'));
    const directory = path.join(root, 'frames');
    temporaryDirectories.push(root);
    const writer = new HistoryFrameWriter({
        directory,
        gzip: true,
        maxFrames: 0,
        diagnosticRetentionFrames: 0,
    });
    await writer.write(makeFrame(1_000));
    await writer.write(makeFrame(1_300, true));
    await writer.write(makeFrame(1_600));

    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.json.gz')).length, 2);
    assert.equal((await fs.readdir(path.join(root, 'diagnostics'))).filter(name => name.endsWith('.json.gz')).length, 1);
});

test('profile status cache removes retained history frames without coupling to a strategy', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-profile-status-'));
    const directory = path.join(root, 'frames');
    temporaryDirectories.push(root);
    const profile = { coin: 'btc', frame: '5m', source: PS_CHAINLINK_TWAP_60 };
    const writer = new HistoryFrameWriter({
        directory,
        gzip: true,
        maxFrames: 0,
        maxFramesPerCoin: 1,
        retainedCoins: ['btc'],
    });
    await writer.write(makeFrame(1_000));
    const first = await rebuildHistoryProfileStatus(directory, profile, () => true);
    assert.equal(first.eligibleFrames, 1);
    assert.equal(first.firstEligibleFrameStart, 1_000);
    assert.equal(first.latestEligibleFrameStart, 1_000);
    assert.match(getHistoryProfileStatusPath(directory, profile), /status\/btc-5m-chainlink-twap-60\.json$/);

    await writer.write(makeFrame(1_300));
    const cached = await readHistoryProfileStatus(directory, profile);
    assert.equal(cached.eligibleFrames, 0);
    assert.equal(cached.firstEligibleFrameStart, undefined);
    assert.deepEqual(Object.keys(cached.frames).map(name => cached.frames[name].startTime), [1_300]);
});

test('profile status cache records the full eligible history span', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-profile-span-'));
    const directory = path.join(root, 'frames');
    temporaryDirectories.push(root);
    const profile = { coin: 'btc', frame: '5m', source: PS_CHAINLINK_TWAP_60 };
    const writer = new HistoryFrameWriter({ directory, gzip: true, maxFrames: 0 });
    await writer.write(makeFrame(1_000));
    await writer.write(makeFrame(1_900));

    const status = await rebuildHistoryProfileStatus(directory, profile, () => true);
    assert.equal(status.eligibleFrames, 2);
    assert.equal(status.firstEligibleFrameStart, 1_000);
    assert.equal(status.latestEligibleFrameStart, 1_900);
});

test('profile status cache rejects inconsistent aggregate fields', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-profile-status-invalid-'));
    const directory = path.join(root, 'frames');
    temporaryDirectories.push(root);
    const profile = { coin: 'btc', frame: '5m', source: PS_CHAINLINK_TWAP_60 };
    await new HistoryFrameWriter({ directory, gzip: true, maxFrames: 0 }).write(makeFrame(1_000));
    const status = await rebuildHistoryProfileStatus(directory, profile, () => true);
    await writeHistoryProfileStatus(directory, { ...status, eligibleFrames: 999 });
    assert.equal(await readHistoryProfileStatus(directory, profile), undefined);
});

test('history frame persistence survives an unavailable profile status directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-profile-status-unavailable-'));
    const directory = path.join(root, 'frames');
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, 'status'), 'not a directory');
    const written = await new HistoryFrameWriter({ directory, gzip: true, maxFrames: 0 }).write(makeFrame(1_000));
    assert.equal((await readHistoryFrame(written.path)).start_time, 1_000);
});

test('history stream tolerates a cyclic file disappearing after directory scan', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-read-cycle-'));
    temporaryDirectories.push(directory);
    const writer = new HistoryFrameWriter({ directory, gzip: true, maxFrames: 0 });
    const first = await writer.write(makeFrame(1_000));
    const second = await writer.write(makeFrame(1_300));
    const frames = readHistoryFrames(directory);

    assert.equal((await frames.next()).value.start_time, 1_000);
    await fs.unlink(second.path);
    assert.equal((await frames.next()).done, true);
    assert.equal((await readHistoryFrame(first.path)).start_time, 1_000);
});

test('reader rejects the removed V1 format explicitly', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-history-v1-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, '1000-event.json');
    await fs.writeFile(file, JSON.stringify({ schema_version: 1 }));
    await assert.rejects(() => readHistoryFrame(file), /unsupported_schema_version/);
});

test('confirmed settlement requires a closed market winner', () => {
    const market = { closed: true, outcomes: ['Up', 'Down'], outcomePrices: [1, 0] };
    assert.equal(getConfirmedOutcome(market), 'up');
    assert.equal(getConfirmedOutcome({ ...market, closed: false }), undefined);
});

test('settlement confirms only the matching market in the matching event', () => {
    const frame = makeFrame(2_400);
    const event = {
        id: frame.market_data.eventId,
        slug: frame.slug,
        markets: [{
            ...frame.market_data,
            id: frame.market_data.marketId,
            conditionId: frame.market_data.conditionId,
            closed: true,
            outcomes: ['Up', 'Down'],
            outcomePrices: [0, 1],
        }],
    };
    assert.equal(getConfirmedOutcomeForFrame(frame, event), 'down');
    assert.throws(() => getConfirmedOutcomeForFrame(frame, { ...event, id: 'other-event' }), /event_id_mismatch/);
    assert.throws(() => getConfirmedOutcomeForFrame(frame, { ...event, markets: [] }), /market_not_found_in_event/);
});

test('shared frame boundary helper supports cancellation', async () => {
    await waitFrameStartMsUntil(60_000, () => true);
});

test('shared frame boundary helper does not skip a boundary after a late poll', async () => {
    const realNow = Date.now;
    const realSetTimeout = global.setTimeout;
    let now = 59_900;
    let polls = 0;
    Date.now = () => now;
    global.setTimeout = callback => {
        polls++;
        now = 60_001;
        queueMicrotask(callback);
        return undefined;
    };
    try {
        await waitFrameStartMsUntil(60_000, () => false);
        assert.equal(polls, 1);
    } finally {
        Date.now = realNow;
        global.setTimeout = realSetTimeout;
    }
});

test('settlement enrichment atomically confirms a V3 gzip frame', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-settlement-'));
    temporaryDirectories.push(directory);
    const writer = new HistoryFrameWriter({ directory, gzip: true, maxFrames: 0 });
    const written = await writer.write(makeFrame(2_500));
    const result = await settleHistoryDirectory({ directory }, async () => 'down', () => 123_456);
    const settled = await readHistoryFrame(written.path);
    assert.deepEqual(result, { checked: 1, updated: 1, unresolved: 0, disappeared: 0, failed: 0, failures: [] });
    assert.equal(settled.settlement.confirmed_outcome, 'down');
    assert.equal(settled.settlement.confirmed_at, 123_456);
    assert.ok((await fs.readdir(directory)).every(name => !name.endsWith('.tmp')));
});

test('settlement continues after one resolver failure', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-settlement-errors-'));
    temporaryDirectories.push(directory);
    const writer = new HistoryFrameWriter({ directory, gzip: true, maxFrames: 0 });
    const failed = await writer.write(makeFrame(2_600));
    const settled = await writer.write(makeFrame(2_900));
    const result = await settleHistoryDirectory({ directory }, async frame => {
        if (frame.start_time === 2_600) throw new Error('temporary_api_failure');
        return 'up';
    }, () => 123_456);
    assert.equal(result.checked, 2);
    assert.equal(result.updated, 1);
    assert.equal(result.failed, 1);
    assert.match(result.failures[0].reason, /temporary_api_failure/);
    assert.equal((await readHistoryFrame(failed.path)).settlement.confirmed_outcome, undefined);
    assert.equal((await readHistoryFrame(settled.path)).settlement.confirmed_outcome, 'up');
});

test('cyclic rotation defers a locked frame and catches up after settlement', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-settlement-cycle-'));
    temporaryDirectories.push(directory);
    const writer = new HistoryFrameWriter({
        directory,
        gzip: true,
        maxFrames: 0,
        maxFramesPerCoin: 1,
        retainedCoins: ['doge'],
    });
    const makeDogeFrame = startTime => {
        const frame = makeFrame(startTime);
        frame.coin = 'doge';
        frame.slug = `doge-updown-5m-${startTime}`;
        return frame;
    };
    await writer.write(makeDogeFrame(3_200));

    let continueSettlement;
    let markResolverStarted;
    const resolverStarted = new Promise(resolve => { markResolverStarted = resolve; });
    const settlementMayContinue = new Promise(resolve => { continueSettlement = resolve; });
    const settlement = settleHistoryDirectory({ directory }, async () => {
        markResolverStarted();
        await settlementMayContinue;
        return 'up';
    });

    await resolverStarted;
    await writer.write(makeDogeFrame(3_500));
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.json.gz')).length, 2);

    continueSettlement();
    const result = await settlement;
    assert.equal(result.updated, 1);

    await writer.write(makeDogeFrame(3_800));
    const frames = [];
    for await (const frame of readHistoryFrames(directory)) frames.push(frame);

    assert.deepEqual(frames.map(frame => frame.start_time), [3_800]);
});
