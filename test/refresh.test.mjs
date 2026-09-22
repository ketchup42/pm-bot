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

function createPrevious(netPnl, replayFrames = 100, initialBalance = 100, latencyMs = 250) {
    return { replayFrames, initialBalance, latencyMs, netPnl };
}

test('refresh enables trading after a significant selected-PnL rise above the minimum', () => {
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(74), createPrevious(48));
    assert.equal(decision.tradingEnabled, true);
    assert.equal(decision.reason, 'selected_net_pnl_rising');
    assert.equal(decision.minimumNetPnl, 50);
    assert.equal(decision.trendStep, 10);
});

test('refresh pauses trading after a significant selected-PnL fall', () => {
    const decision = getDogeBaselineTradingRegimeDecision(true, createEvaluation(57), createPrevious(74));
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_falling');
});

test('refresh pauses trading below the selected-PnL minimum regardless of trend', () => {
    const decision = getDogeBaselineTradingRegimeDecision(true, createEvaluation(49), createPrevious(30));
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'selected_net_pnl_below_minimum');
});

test('refresh preserves the current state for selected-PnL changes inside the trend band', () => {
    const evaluation = createEvaluation(67);
    assert.equal(getDogeBaselineTradingRegimeDecision(true, evaluation, createPrevious(60)).tradingEnabled, true);
    assert.equal(getDogeBaselineTradingRegimeDecision(false, evaluation, createPrevious(60)).tradingEnabled, false);
});

test('refresh does not use an incompatible previous replay as a trend point', () => {
    const decision = getDogeBaselineTradingRegimeDecision(false, createEvaluation(74), createPrevious(48, 100, 100, 200));
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'no_comparable_previous_evaluation');
    assert.equal(decision.previousNetPnl, undefined);
});

test('refresh pauses trading immediately when all evaluated pairs have non-positive PnL', () => {
    const decision = getDogeBaselineTradingRegimeDecision(true, createEvaluation(-1, [0, -1, -2, -3]), createPrevious(100));
    assert.equal(decision.tradingEnabled, false);
    assert.equal(decision.reason, 'all_combinations_non_positive');
});
