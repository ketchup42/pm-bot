import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    NoTradeReplayStrategy,
    runReplay,
    simulateTakerFill,
    writeReplayReport,
} from '../dist/app/core/backtest/replay.js';
import { TrendLineReplayStrategy } from '../dist/app/core/backtest/strategy/TrendLineReplayStrategy.js';
import { REPLAY_STRATEGY_PRESETS } from '../dist/app/core/backtest/replay_presets.js';
import { runReplayMatrix, writeReplayMatrixReport } from '../dist/app/core/backtest/replay_matrix.js';
import { HISTORY_SCHEMA_VERSION, buildHistoryGaps, buildHistoryQuality } from '../dist/app/core/history/history_frame.js';
import { PS_CHAINLINK_TWAP_60 } from '../dist/market/price/price_source.js';
import { csvValue } from '../dist/utils.js';
import {
    REPLAY_STRATEGY_TREND_LINE_V2,
    REPLAY_STRATEGY_TREND_LINE_V2_DIRECTED,
    REPLAY_STRATEGY_TREND_LINE_V2_DIRECTED_HOLD,
    REPLAY_STRATEGY_TREND_LINE_V2_FIXED_MAX_ENTRY,
    REPLAY_STRATEGY_TREND_LINE_V2_NO_MIRROR,
} from '../dist/app/defaults.js';

function makeFrame() {
    const start = 1_000;
    const snapshots = [0, 1].map(index => ({
        timestamp: start * 1_000 + index * 100,
        coin_price: 60_000,
        coin_timestamp: start * 1_000 + index * 100,
        book_watching: true,
        up: {
            book_timestamp: start * 1_000 + index * 100,
            midpoint: 0.5,
            spread: 0.02,
            bids: [{ price: '0.49', size: '5' }, { price: '0.48', size: '5' }],
            asks: [{ price: '0.51', size: '5' }, { price: '0.52', size: '5' }],
        },
        down: {
            book_timestamp: start * 1_000 + index * 100,
            midpoint: 0.5,
            spread: 0.02,
            bids: [{ price: '0.49', size: '10' }],
            asks: [{ price: '0.51', size: '10' }],
        },
    }));
    return {
        schema_version: HISTORY_SCHEMA_VERSION,
        source: PS_CHAINLINK_TWAP_60, coin: 'btc', frame: '5m', slug: 'btc-updown-5m-1000',
        start_time: start, end_time: start + 300, collected_at: start * 1_000 + 300_000,
        snapshot_interval_ms: 100, book_depth: 10,
        coin_frame_start_price: 60_000, coin_frame_end_price: 60_010,
        market_data: {
            eventId: 'event', marketId: 'market', conditionId: 'condition', tick_size: 0.01,
            min_order_size: 5, fees_enabled: true, maker_base_fee: 0, taker_base_fee: 700,
            rewards_max_spread: 0, rewards_min_size: 0,
            up: { outcome: 'up', tokenId: 'up' }, down: { outcome: 'down', tokenId: 'down' },
        },
        settlement: { derived_outcome: 'up', confirmed_outcome: undefined, confirmed_at: undefined },
        connection_events: [], data_gaps: buildHistoryGaps(snapshots, 100, PS_CHAINLINK_TWAP_60), snapshots,
        data_quality: buildHistoryQuality(snapshots, 60_000, 60_010, 200, 100, false, PS_CHAINLINK_TWAP_60),
    };
}

const config = { initial_balance: 100, latency_snapshots: 0, minimum_order_value: 1 };

test('CSV values preserve commas, quotes, newlines and undefined fields', () => {
    assert.equal(csvValue(undefined), '');
    assert.equal(csvValue('plain'), 'plain');
    assert.equal(csvValue('entry,normal'), '"entry,normal"');
    assert.equal(csvValue('say "yes"'), '"say ""yes"""');
    assert.equal(csvValue('first\nsecond'), '"first\nsecond"');
});

test('taker execution walks depth, calculates VWAP and fees', () => {
    const frame = makeFrame();
    const fill = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 8, limit_price: 0.52,
    }, 100, 0, config);
    assert.equal(fill.status, 'filled');
    assert.equal(fill.filled_quantity, 8);
    assert.equal(fill.average_price, (5 * 0.51 + 3 * 0.52) / 8);
    assert.equal(Number(fill.fee.toFixed(5)), 0.13989);
});

test('taker execution reports partial depth and rejects invalid minimum', () => {
    const frame = makeFrame();
    const partial = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 15, limit_price: 0.60,
    }, 100, 0, config);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.filled_quantity, 10);
    const rejected = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 4, limit_price: 0.52,
    }, 100, 0, config);
    assert.equal(rejected.reason_code, 'below_minimum_size');
});

test('buy limit is rounded down to the market tick', () => {
    const frame = makeFrame();
    const fill = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 8, limit_price: 0.519,
    }, 100, 0, config);
    assert.equal(fill.status, 'partial');
    assert.equal(fill.filled_quantity, 5);
    assert.equal(fill.average_price, 0.51);
});

test('execution rejects a snapshot with an aged coin observation', () => {
    const frame = makeFrame();
    frame.snapshots[0].coin_timestamp -= 6_000;
    const fill = simulateTakerFill(frame, frame.snapshots[0], {
        action: 'buy', side: 'up', quantity: 5, limit_price: 0.51,
    }, 100, 0, config);
    assert.equal(fill.status, 'rejected');
    assert.equal(fill.reason_code, 'coin_data_gap');
});

test('replay carries cash through settlement and is deterministic', () => {
    const frame = makeFrame();
    let entered = false;
    const strategy = {
        name: 'fixture-buy',
        decide() {
            if (entered) return { action: 'hold', reason_code: 'already_entered', order: undefined };
            entered = true;
            return { action: 'buy', reason_code: 'fixture', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.51 } };
        },
    };
    const first = runReplay([frame], strategy, config);
    entered = false;
    const second = runReplay([frame], strategy, config);
    assert.deepEqual(first, second);
    assert.ok(first.metrics.net_pnl > 0);
    assert.equal(first.metrics.derived_settlements, 1);
    assert.equal(Number((first.metrics.gross_pnl - first.metrics.net_pnl).toFixed(8)), Number(first.metrics.fees.toFixed(8)));
    assert.equal(
        Number((first.metrics.pre_execution_cost_pnl - first.metrics.gross_pnl).toFixed(8)),
        Number((first.metrics.spread_cost + first.metrics.slippage_cost).toFixed(8)),
    );
    assert.equal(first.metrics.position_frames, 1);
});

test('replay rejects a malformed external order decision', () => {
    const strategy = {
        name: 'invalid-order-decision',
        decide() {
            return {
                action: 'buy',
                reason_code: 'fixture',
                order: { action: 'sell', side: 'up', quantity: 5, limit_price: 0.51 },
            };
        },
    };
    assert.throws(() => runReplay([makeFrame()], strategy, config), /invalid_order_decision/);
});

test('strategy context does not expose future snapshots or settlement', () => {
    const frame = makeFrame();
    const strategy = {
        name: 'look-ahead-check',
        decide(context) {
            assert.equal(context.frame.snapshots, undefined);
            assert.equal(context.frame.settlement, undefined);
            assert.equal(context.frame.coin_frame_end_price, undefined);
            assert.equal(context.frame.coin_frame_start_price, 60_000);
            return { action: 'hold', reason_code: 'checked', order: undefined };
        },
    };
    runReplay([frame], strategy, config);
});

test('one-snapshot latency executes against the following book', () => {
    const frame = makeFrame();
    frame.snapshots[1].up.asks = [{ price: '0.60', size: '10' }];
    let entered = false;
    const strategy = {
        name: 'latency-check',
        decide() {
            if (entered) return { action: 'hold', reason_code: 'done', order: undefined };
            entered = true;
            return { action: 'buy', reason_code: 'fixture', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.60 } };
        },
    };
    const result = runReplay([frame], strategy, { ...config, latency_snapshots: 1 });
    assert.equal(result.fills[0].average_price, 0.60);
});

test('no-trade baseline leaves equity unchanged', () => {
    const result = runReplay([makeFrame()], new NoTradeReplayStrategy(), config);
    assert.equal(result.metrics.final_balance, 100);
    assert.equal(result.metrics.trade_count, 0);
});

test('batched decisions reserve cash for each successive fill', () => {
    let entered = false;
    const strategy = {
        name: 'batched-cash-check',
        decide() {
            return { action: 'hold', reason_code: 'unused', order: undefined };
        },
        decideAll() {
            if (entered) return [{ action: 'hold', reason_code: 'done', order: undefined }];
            entered = true;
            return [
                { action: 'buy', reason_code: 'buy_up', order: { action: 'buy', side: 'up', quantity: 5, limit_price: 0.51 } },
                { action: 'buy', reason_code: 'buy_down', order: { action: 'buy', side: 'down', quantity: 5, limit_price: 0.51 } },
            ];
        },
    };

    const result = runReplay([makeFrame()], strategy, { ...config, initial_balance: 5 });

    assert.deepEqual(result.fills.map(fill => fill.status), ['filled', 'rejected']);
    assert.equal(result.fills[1]?.reason_code, 'insufficient_balance');
    assert.equal(result.metrics.filled_orders, 1);
    assert.equal(result.metrics.rejected_orders, 1);
    assert.ok(result.metrics.final_balance >= 0);
});

function makeTrendFrame(progress = 0.02) {
    const frame = makeFrame();
    for (const [index, snapshot] of frame.snapshots.entries()) {
        snapshot.timestamp = frame.start_time * 1_000 + (progress + index * 0.01) * 300_000;
        snapshot.coin_price = 60_006;
        snapshot.coin_timestamp = snapshot.timestamp;
        snapshot.up.asks = [{ price: '0.56', size: '10' }];
        snapshot.down.asks = [{ price: '0.56', size: '10' }];
        snapshot.up.bids = [{ price: '0.55', size: '10' }];
        snapshot.down.bids = [{ price: '0.55', size: '10' }];
    }
    return frame;
}

test('V2 baseline can enter both sides from the same snapshot', () => {
    const result = runReplay([makeTrendFrame()], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2), config);
    assert.equal(result.metrics.trade_count, 2);
    assert.deepEqual(result.fills.map(fill => fill.side).sort(), ['down', 'up']);
});

test('directed V2 blocks the side opposite to signed BTC movement', () => {
    const result = runReplay([makeTrendFrame()], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2_DIRECTED), config);
    assert.equal(result.metrics.trade_count, 1);
    assert.equal(result.fills[0].side, 'up');
});

test('V2 no-mirror does not use the lower mirror entry line', () => {
    const frame = makeTrendFrame();
    for (const snapshot of frame.snapshots) {
        snapshot.up.asks = [{ price: '0.54', size: '10' }];
        snapshot.down.asks = [{ price: '0.54', size: '10' }];
        snapshot.up.bids = [{ price: '0.40', size: '10' }];
        snapshot.down.bids = [{ price: '0.40', size: '10' }];
    }
    const baseline = runReplay([frame], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2), config);
    const noMirror = runReplay([frame], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2_NO_MIRROR), config);
    assert.equal(baseline.metrics.trade_count, 2);
    assert.equal(noMirror.metrics.trade_count, 0);
});

test('fixed max-entry preset closes the V2 late-entry cap loophole', () => {
    const frame = makeTrendFrame(0.8);
    for (const snapshot of frame.snapshots) {
        snapshot.up.asks = [{ price: '0.93', size: '10' }];
        snapshot.down.asks = [{ price: '0.93', size: '10' }];
        snapshot.up.bids = [{ price: '0.92', size: '10' }];
        snapshot.down.bids = [{ price: '0.92', size: '10' }];
    }
    const baseline = runReplay([frame], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2), config);
    const fixed = runReplay([frame], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2_FIXED_MAX_ENTRY), config);
    assert.equal(baseline.metrics.trade_count, 2);
    assert.equal(fixed.metrics.trade_count, 0);
});

test('directed hold preset keeps its position until settlement without A/B/C exits', () => {
    const frame = makeTrendFrame();
    frame.snapshots[1].up.bids = [{ price: '0.10', size: '10' }];
    const result = runReplay([frame], new TrendLineReplayStrategy(REPLAY_STRATEGY_TREND_LINE_V2_DIRECTED_HOLD), config);
    assert.equal(result.fills.filter(fill => fill.action === 'buy').length, 1);
    assert.equal(result.fills.filter(fill => fill.action === 'sell').length, 0);
});

test('matrix uses every registered preset and excludes incomplete or unconfirmed frames', async () => {
    const confirmed = makeFrame();
    confirmed.settlement.confirmed_outcome = 'up';
    confirmed.settlement.confirmed_at = confirmed.end_time * 1_000;
    const incomplete = makeFrame();
    incomplete.slug = 'btc-updown-5m-incomplete';
    incomplete.data_quality.complete = false;
    const unconfirmed = makeFrame();
    unconfirmed.slug = 'btc-updown-5m-unconfirmed';
    const result = runReplayMatrix([confirmed, incomplete, unconfirmed], REPLAY_STRATEGY_PRESETS, config);
    assert.equal(result.frames.length, 1);
    assert.deepEqual(result.excluded_frames.map(frame => frame.reason).sort(), ['incomplete', 'unconfirmed_settlement']);
    assert.deepEqual(Object.keys(result.results), REPLAY_STRATEGY_PRESETS.map(preset => preset.id));

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-matrix-'));
    try {
        await writeReplayMatrixReport(result, directory);
        const files = await fs.readdir(directory);
        assert.ok(files.includes('manifest.json'));
        assert.ok(files.includes('summary.csv'));
        assert.ok(files.includes('summary.md'));
        assert.ok(files.includes(REPLAY_STRATEGY_TREND_LINE_V2_DIRECTED_HOLD));
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('replay rejects overlapping frames instead of reusing future capital', () => {
    const first = makeFrame();
    const second = makeFrame();
    second.slug = 'btc-updown-5m-1100';
    second.start_time = 1_100;
    second.end_time = 1_400;
    assert.throws(() => runReplay([first, second], new NoTradeReplayStrategy(), config), /overlapping_frames_not_supported/);
});

test('report writer creates the complete deterministic artifact set', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-report-'));
    try {
        const result = runReplay([makeFrame()], new NoTradeReplayStrategy(), config);
        await writeReplayReport(result, directory);
        assert.deepEqual((await fs.readdir(directory)).sort(), [
            'config.json', 'equity.svg', 'metrics.json', 'report.md', 'trades.csv',
        ]);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
