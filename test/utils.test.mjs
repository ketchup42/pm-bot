import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { killSignalsHook } from '../dist/utils.js';

test('kill signal hook invokes its callback once and unsubscribes cleanly', async () => {
    const signals = new EventEmitter();
    let calls = 0;
    const unsubscribe = killSignalsHook(async () => {
        calls++;
    }, { signalEmitter: signals });

    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(calls, 1);

    unsubscribe();
    signals.emit('SIGINT');
    assert.equal(calls, 1);
});

test('kill signal hook invokes a repeated-signal callback', async () => {
    const signals = new EventEmitter();
    let gracefulCalls = 0;
    let forcedCalls = 0;
    const unsubscribe = killSignalsHook(
        () => { gracefulCalls++; },
        { signalEmitter: signals, onRepeatedSignal: () => { forcedCalls++; } },
    );

    signals.emit('SIGINT');
    signals.emit('SIGINT');
    assert.equal(gracefulCalls, 1);
    assert.equal(forcedCalls, 1);
    unsubscribe();
});
