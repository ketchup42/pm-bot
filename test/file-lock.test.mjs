import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { FileLock } from '../dist/file_lock.js';
import { DogeBaselineRefreshLock } from '../dist/app/core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';

test('file lock atomically publishes complete owner data and excludes another owner', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-file-lock-'));
    const filePath = path.join(directory, 'resource.lock');
    try {
        const first = await FileLock.tryAcquire(filePath);
        assert.ok(first);
        const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
        assert.equal(data.pid, process.pid);
        assert.equal(typeof data.createdAt, 'number');
        assert.equal(typeof data.owner, 'string');
        assert.equal(typeof data.processIdentity, 'string');
        assert.equal(await FileLock.tryAcquire(filePath), undefined);
        await first.release();
        await assert.rejects(() => fs.access(filePath), /ENOENT/);
        assert.deepEqual(await fs.readdir(directory), []);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('file lock replaces dead and reused process owners', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-stale-lock-'));
    const filePath = path.join(directory, 'resource.lock');
    try {
        const staleOwners = [
            { pid: 2_147_483_647, createdAt: 1, owner: 'dead', processIdentity: 'dead' },
            { pid: process.pid, createdAt: 1, owner: 'reused', processIdentity: 'different-process' },
        ];
        for (const staleOwner of staleOwners) {
            await fs.writeFile(filePath, JSON.stringify(staleOwner));
            const replacement = await FileLock.tryAcquire(filePath);
            assert.ok(replacement);
            await replacement.release();
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('file lock preserves invalid lock data', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-invalid-lock-'));
    const filePath = path.join(directory, 'resource.lock');
    try {
        await fs.writeFile(filePath, '{}');
        await assert.rejects(() => FileLock.tryAcquire(filePath), /invalid_file_lock/);
        assert.equal(await fs.readFile(filePath, 'utf8'), '{}');
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('DOGE baseline refresh uses the shared file lock', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bot-doge-lock-'));
    const previousDirectory = process.env.STRATEGY_MODELS_DIR;
    process.env.STRATEGY_MODELS_DIR = directory;
    try {
        const first = await DogeBaselineRefreshLock.acquire();
        await assert.rejects(() => DogeBaselineRefreshLock.acquire(), /doge_baseline_refresh_already_running/);
        await first.release();
    } finally {
        if (previousDirectory === undefined) delete process.env.STRATEGY_MODELS_DIR;
        else process.env.STRATEGY_MODELS_DIR = previousDirectory;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
