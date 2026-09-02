import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

import { HistoryFrameWriter } from '../dist/app/core/history/HistoryFrameWriter.js';
import { readHistoryFrame } from '../dist/app/core/history/HistoryFrameReader.js';
import {
    getConfirmedOutcome,
    getConfirmedOutcomeForFrame,
    settleHistoryDirectory,
} from '../dist/app/core/history/HistorySettlementService.js';
import {
    HISTORY_SCHEMA_VERSION,
    buildHistoryGaps,
    buildHistoryQuality,
    deriveHistoryOutcome,
    selectBestLevels,
    validateHistoryFrame,
} from '../dist/app/core/history/history_frame.js';
import { getSupportedCoins } from '../dist/market/coins.js';
import { getSupportedFrames, waitFrameStartMsUntil } from '../dist/market/frame.js';
import { getSupportedPriceSources, PS_CHAINLINK_TWAP_60 } from '../dist/market/price/price_source.js';

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
    const snapshots = Array.from({ length: 10 }, (_, index) => {
        const timestamp = startTime * 1_000 + index * interval;
        return {
            timestamp,
            coin_price: 60_000 + index,
            coin_timestamp: timestamp,
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
        data_gaps: buildHistoryGaps(snapshots, interval, PS_CHAINLINK_TWAP_60),
        snapshots,
        data_quality: buildHistoryQuality(snapshots, startPrice, endPrice, 1_000, interval, stoppedEarly, PS_CHAINLINK_TWAP_60),
    };
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

test('quality marks stopped frames incomplete and validator accepts the structure', () => {
    const complete = makeFrame(1_000);
    const incomplete = makeFrame(1_300, true);
    assert.equal(complete.data_quality.complete, true);
    assert.equal(incomplete.data_quality.complete, false);
    assert.ok(incomplete.data_quality.warnings.includes('collection_stopped_early'));
    assert.deepEqual(validateHistoryFrame(complete), []);
    assert.deepEqual(validateHistoryFrame(incomplete), []);
});

test('quality accepts one-sided and unchanged books while CLOB is connected', () => {
    const frame = makeFrame(1_600);
    for (const snapshot of frame.snapshots) {
        snapshot.up.asks = [];
        snapshot.down.bids = [];
    }
    const quality = buildHistoryQuality(frame.snapshots, 60_000, 60_010, 1_000, 100, false, PS_CHAINLINK_TWAP_60);

    assert.equal(quality.disconnected_book_snapshots, 0);
    assert.equal(quality.complete, true);
    assert.ok(!frame.data_gaps.some(gap => gap.source === 'clob'));
});

test('gaps distinguish coin data and actual CLOB disconnects', () => {
    const frame = makeFrame(1_700);
    frame.snapshots[2].coin_timestamp = frame.snapshots[2].timestamp - 6_000;
    frame.snapshots[3].coin_timestamp = frame.snapshots[3].timestamp - 6_000;
    frame.snapshots[3].book_watching = false;
    const gaps = buildHistoryGaps(frame.snapshots, 100, PS_CHAINLINK_TWAP_60);
    assert.ok(gaps.some(gap => gap.source === 'coin_price'));
    assert.ok(gaps.some(gap => gap.source === 'clob'));
    const quality = buildHistoryQuality(frame.snapshots, 60_000, 60_010, 1_000, 100, false, PS_CHAINLINK_TWAP_60);
    assert.equal(quality.complete, false);
    assert.equal(quality.coin_gap_snapshots, 2);
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
    assert.ok(!files.some(name => name.startsWith('1000-')));
    assert.ok(files.every(name => !name.includes('.partial.')));
    assert.ok(files.every(name => !name.endsWith('.tmp')));

    const decoded = JSON.parse((await unzip(await fs.readFile(latest.path))).toString('utf8'));
    assert.equal(decoded.start_time, 1_600);
    assert.equal(decoded.data_quality.complete, true);
    assert.equal(decoded.schema_version, 2);
    assert.equal((await readHistoryFrame(latest.path)).start_time, 1_600);
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

test('settlement enrichment atomically confirms a V2 gzip frame', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-settlement-'));
    temporaryDirectories.push(directory);
    const writer = new HistoryFrameWriter({ directory, gzip: true, maxFrames: 0 });
    const written = await writer.write(makeFrame(2_500));
    const result = await settleHistoryDirectory({ directory }, async () => 'down', () => 123_456);
    const settled = await readHistoryFrame(written.path);
    assert.deepEqual(result, { checked: 1, updated: 1, unresolved: 0, failed: 0, failures: [] });
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
