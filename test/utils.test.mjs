import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { killSignalsHook } from '../dist/utils.js';
import { waitFrameStartMsUntil } from '../dist/market/frame.js';
import { ExecScheduler } from '../dist/app/core/ExecScheduler.js';

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

test('interruptible frame wait respects the requested check interval', async () => {
    let stopped = false;
    const startedAt = Date.now();
    setTimeout(() => { stopped = true; }, 10);

    await waitFrameStartMsUntil(60_000, () => stopped, 5);

    assert.ok(Date.now() - startedAt < 100);
});

test('scheduler stops while waiting for its first frame boundary', async () => {
    const scheduler = new ExecScheduler([async () => {
        throw new Error('handler must not run');
    }]);
    const startedAt = Date.now();
    const running = scheduler.start(60_000, 5);
    setTimeout(() => { scheduler.stop(); }, 10);

    await running;

    assert.ok(Date.now() - startedAt < 100);
});

test('scheduler stops after unpausing without waiting for the next full frame', async () => {
    const intervalMs = 1_000;
    const scheduler = new ExecScheduler([async () => {
        throw new Error('handler must not run');
    }]);
    scheduler.pause();

    const startedAt = Date.now();
    const waitForFirstBoundaryMs = intervalMs - (startedAt % intervalMs);
    const running = scheduler.start(intervalMs, 5);
    setTimeout(() => { scheduler.unpause(); }, waitForFirstBoundaryMs + 20);
    setTimeout(() => { scheduler.stop(); }, waitForFirstBoundaryMs + 40);

    await running;

    assert.ok(Date.now() - startedAt < waitForFirstBoundaryMs + 300);
});
