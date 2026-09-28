import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getConnectionStatus } from '../dist/app/connection-status.js';

function sources(overrides = {}) {
    return {
        getExternalIpv4: async () => '203.0.113.10',
        resolvePolymarketHost: async () => '104.18.12.48',
        now: () => 1_700_000_000_000,
        ...overrides,
    };
}

test('connection status reports external IPv4 and Polymarket DNS independently', async () => {
    const status = await getConnectionStatus(sources());
    assert.deepEqual(status.externalIpv4, { available: true, value: '203.0.113.10' });
    assert.deepEqual(status.polymarketDns, { available: true, value: '104.18.12.48' });
    assert.equal(status.refreshedAt, 1_700_000_000_000);
});

test('connection status keeps DNS when external IPv4 lookup fails', async () => {
    const status = await getConnectionStatus(sources({
        getExternalIpv4: async () => { throw new Error('timeout'); },
    }));
    assert.deepEqual(status.externalIpv4, { available: false });
    assert.deepEqual(status.polymarketDns, { available: true, value: '104.18.12.48' });
});

test('connection status keeps external IPv4 when DNS fails', async () => {
    const status = await getConnectionStatus(sources({
        resolvePolymarketHost: async () => { throw new Error('dns'); },
    }));
    assert.deepEqual(status.externalIpv4, { available: true, value: '203.0.113.10' });
    assert.deepEqual(status.polymarketDns, { available: false });
});

test('connection status times out DNS without hiding external IPv4', async () => {
    const status = await getConnectionStatus(sources({
        resolvePolymarketHost: () => new Promise(() => {}),
    }), 1);
    assert.deepEqual(status.externalIpv4, { available: true, value: '203.0.113.10' });
    assert.deepEqual(status.polymarketDns, { available: false });
});
