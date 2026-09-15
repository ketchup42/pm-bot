import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    formatDogeBaselineRefreshSelection,
    getDogeBaselineTradingEnabled,
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

function createEvaluation(promoted, netPnls) {
    return {
        promoted,
        combinations: netPnls.map(net_pnl => ({ replayMetrics: { net_pnl } })),
    };
}

test('refresh pauses trading only when every evaluated combination is non-positive', () => {
    assert.equal(
        getDogeBaselineTradingEnabled(true, createEvaluation(false, [0, -1, -2, -3])),
        false,
    );
    assert.equal(
        getDogeBaselineTradingEnabled(true, createEvaluation(false, [-1, 0.01, -2, -3])),
        true,
    );
    assert.equal(getDogeBaselineTradingEnabled(true, createEvaluation(false, [])), true);
});

test('refresh resumes config-paused trading only after publishing a permitted pair', () => {
    assert.equal(
        getDogeBaselineTradingEnabled(false, createEvaluation(false, [1, -1, -2, -3])),
        false,
    );
    assert.equal(
        getDogeBaselineTradingEnabled(false, createEvaluation(true, [1, -1, -2, -3])),
        true,
    );
});
