import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDogeBaselineRefreshSelection } from '../dist/app/doge-baseline-refresh.js';

function createSelection(id, promoted) {
    return {
        promoted,
        replayFrames: 100,
        selected: {
            id,
            strategyConfig: {
                entry: {
                    modes: {
                        'early-60': { enabled: true, minimumEdge: 0.04 },
                        'late-120': { enabled: true, minimumEdge: 0.06 },
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
        'Working model and config retained: selected=working-current modes=early-60=0.04,late-120=0.06 ' +
        'exit=natural frames=100 netPnL=48.416250',
    );
});

test('refresh preserves the published pair summary', () => {
    assert.equal(
        formatDogeBaselineRefreshSelection(createSelection('candidate-selected', true)),
        'Published candidate-selected: modes=early-60=0.04,late-120=0.06 exit=natural frames=100 netPnL=48.416250',
    );
});
