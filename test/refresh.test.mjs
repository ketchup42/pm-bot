import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    formatDogeBaselineRefreshSelection,
    getDogeBaselineTradingRegimeDecision,
} from '../dist/app/doge-baseline-refresh.js';

function createSelection(id, promoted) {
    return {
        promoted,
        replayFrames: 100,
        selected: {
            id,
            strategyConfig: {
                entry: {
                    modes: {
                        'early-60': {
                            enabled: true,
                            minimumEdge: 0.04,
                            minimumConfidence: 0.5,
                            minimumAbsoluteDeviationBps: 0,
                        },
                        'late-120': {
                            enabled: true,
                            minimumEdge: 0.06,
                            minimumConfidence: 0.5,
                            minimumAbsoluteDeviationBps: 0,
                        },
                    },
                },
                exit: { enabled: false, windowMs: 60_000, deviationFactor: 0.0005, confirmationMs: 5_000, retryMs: 1_000 },
            },
            replayMetrics: { net_pnl: 48.41625 },
        },
    };
}

test('refresh describes a retained working pair', () => {
    assert.equal(
        formatDogeBaselineRefreshSelection(createSelection('working-current', false)),
        'Working model and config retained: selected=working-current ' +
        'modes=early-60=edge0.04/confidence0.50/deviation0bps,late-120=edge0.06/confidence0.50/deviation0bps ' +
        'exit=natural frames=100 netPnL=48.416250',
    );
});

test('refresh preserves the published pair summary', () => {
    assert.equal(
        formatDogeBaselineRefreshSelection(createSelection('candidate-selected', true)),
        'Published candidate-selected: ' +
        'modes=early-60=edge0.04/confidence0.50/deviation0bps,late-120=edge0.06/confidence0.50/deviation0bps ' +
        'exit=natural frames=100 netPnL=48.416250',
    );
});

function createEvaluation(selectedNetPnl, netPnls = [selectedNetPnl, 1, 2, 3], replayFrames = 100) {
    return {
        replayFrames,
        replayConfig: { initial_balance: 100, latency_ms: 250 },
        selected: { replayMetrics: { net_pnl: selectedNetPnl } },
        combinations: netPnls.map(net_pnl => ({ replayMetrics: { net_pnl } })),
    };
}

const regime = { minimumNetPnlPerReplayFrame: 0.5, trendStepPerReplayFrame: 0.1, minimumConsecutiveRises: 2 };

function createPrevious(netPnl, replayFrames = 100, initialBalance = 100, latencyMs = 250) {
    return { point: { replayFrames, initialBalance, latencyMs, netPnl }, state: { consecutiveRises: 0, regime } };
}

test('refresh enables trading only after two significant selected-PnL rises', () => {
    const first = getDogeBaselineTradingRegimeDecision(false, createEvaluation(60), createPrevious(45), regime);
    assert.equal(first.tradingEnabled, false);
    assert.equal(first.reason, 'selected_net_pnl_recovery_pending');
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(74), {
        point: { replayFrames: 100, initialBalance: 100, latencyMs: 250, netPnl: 60 },
        state: { consecutiveRises: first.consecutiveRises, regime },
    }, regime);
    assert.equal(decision.tradingEnabled, true);
    assert.equal(decision.reason, 'selected_net_pnl_recovery_confirmed');
    assert.equal(decision.minimumNetPnl, 50);
    assert.equal(decision.trendStep, 10);
});

test('refresh pauses trading after a significant selected-PnL fall', () => {
    const decision = getDogeBaselineTradingRegimeDecision(true, createEvaluation(57), createPrevious(74), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_falling');
});

test('refresh pauses trading below the selected-PnL minimum regardless of trend', () => {
    const decision = getDogeBaselineTradingRegimeDecision(true, createEvaluation(49), createPrevious(30), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_below_minimum');
});

test('refresh does not resume paused trading from a stable selected PnL', () => {
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(57), createPrevious(57), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_stable');
});

test('refresh preserves the paused state when the previous stable PnL is below the minimum', () => {
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(55), createPrevious(49), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_stable');
});

test('refresh preserves the paused state while selected PnL is still declining', () => {
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(55), createPrevious(57), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_stable');
});

test('refresh does not resume paused trading during a significant PnL fall', () => {
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(57), createPrevious(74), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_falling');
});

test('refresh preserves enabled trading for selected-PnL changes inside the trend band', () => {
    const decision = getDogeBaselineTradingRegimeDecision(true, createEvaluation(67), createPrevious(60), regime);
    assert.equal(decision.tradingEnabled, true);
    assert.equal(decision.reason, 'selected_net_pnl_stable');
});

test('refresh does not use an incompatible previous replay as a trend point', () => {
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(74), createPrevious(48, 100, 100, 200), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'no_comparable_previous_evaluation');
    assert.equal(decision.previousNetPnl, undefined);
});

test('refresh pauses trading immediately when all evaluated pairs have non-positive PnL', () => {
    const decision = getDogeBaselineTradingRegimeDecision(true, createEvaluation(-1, [0, -1, -2, -3]), createPrevious(100), regime);
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'all_combinations_non_positive');
});
