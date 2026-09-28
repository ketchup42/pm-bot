import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getConnectionStatus } from '../dist/app/connection-status.js';

function sources(overrides = {}) {
    return {
        getExternalIpv4: async () => '203.0.113.10',
        checkApiDns: async () => {},
        now: () => 1_700_000_000_000,
        ...overrides,
    };
}

test('connection status reports public IPv4 and API DNS independently', async () => {
    const status = await getConnectionStatus(sources());
    assert.deepEqual(status.ipv4, { available: true, value: '203.0.113.10' });
    assert.deepEqual(status.dns, { available: true });
    assert.equal(status.refreshedAt, 1_700_000_000_000);
});

test('connection status keeps DNS when external IPv4 lookup fails', async () => {
    const status = await getConnectionStatus(sources({
        getExternalIpv4: async () => { throw new Error('timeout'); },
    }));
    assert.deepEqual(status.ipv4, { available: false, reason: 'timeout' });
    assert.deepEqual(status.dns, { available: true });
});

test('connection status keeps external IPv4 when DNS fails', async () => {
    const status = await getConnectionStatus(sources({
        checkApiDns: async () => { throw new Error('dns'); },
    }));
    assert.deepEqual(status.ipv4, { available: true, value: '203.0.113.10' });
    assert.deepEqual(status.dns, { available: false });
});

test('connection status reports safe HTTP and invalid-response reasons', async () => {
    const httpStatus = await getConnectionStatus(sources({
        getExternalIpv4: async () => { throw new Error('external_ip_http_503'); },
    }));
    assert.deepEqual(httpStatus.ipv4, { available: false, reason: 'http' });

    const invalidStatus = await getConnectionStatus(sources({
        getExternalIpv4: async () => { throw new Error('external_ip_invalid_response'); },
    }));
    assert.deepEqual(invalidStatus.ipv4, { available: false, reason: 'invalid_response' });
});

test('connection status times out DNS without hiding external IPv4', async () => {
    const status = await getConnectionStatus(sources({
        checkApiDns: () => new Promise(() => {}),
    }), 1);
    assert.deepEqual(status.ipv4, { available: true, value: '203.0.113.10' });
    assert.deepEqual(status.dns, { available: false });
});
