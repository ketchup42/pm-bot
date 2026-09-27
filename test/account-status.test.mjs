import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatAccountStatusText, getAccountStatus } from '../dist/app/account-status.js';

function sources(overrides = {}) {
    return {
        getIdentity: () => ({ funderAddress: '0x1234567890abcdef1234567890abcdef12345678', signatureType: 2 }),
        getPolygonPusd: async () => 123.456,
        getPortfolioValue: async () => 17.25,
        getOpenPositions: async () => ({
            positions: [{ market: 'DOGE Up or Down', outcome: 'Up', size: 12.5, averagePrice: 0.4, currentValue: 6.25, cashPnl: 1.25 }],
            truncated: false,
        }),
        getOpenOrders: async () => [{
            side: 'BUY', outcome: 'Up', original_size: '10', size_matched: '2.5', price: '0.42',
        }],
        now: () => 1_700_000_000_000,
        ...overrides,
    };
}

test('account status shows Polygon balance, public positions and read-only orders without exposing the address', async () => {
    const status = await getAccountStatus(sources());
    assert.deepEqual(status.account, { available: true, value: { address: '0x1234…5678', signatureType: 2 } });
    assert.deepEqual(status.polygonPusd, { available: true, value: 123.456 });
    assert.equal(status.portfolioValue.value, 17.25);
    assert.equal(status.positions.value.positions[0].market, 'DOGE Up or Down');
    assert.deepEqual(status.openOrders.value, [{ side: 'BUY', outcome: 'Up', remainingSize: 7.5, price: 0.42 }]);
    const text = formatAccountStatusText(status);
    assert.match(text, /POLYGON pUSD\s+\$123\.46/);
    assert.match(text, /POSITION Up: DOGE Up or Down/);
    assert.match(text, /ORDER BUY Up: 7\.5 @ \$0\.42/);
    assert.doesNotMatch(text, /0x1234567890abcdef1234567890abcdef12345678/);
});

test('account status keeps Polygon balance when portfolio and CLOB requests fail', async () => {
    const status = await getAccountStatus(sources({
        getPortfolioValue: async () => { throw new Error('network'); },
        getOpenPositions: async () => { throw new Error('network'); },
        getOpenOrders: async () => { throw new Error('network'); },
    }));
    assert.deepEqual(status.polygonPusd, { available: true, value: 123.456 });
    assert.equal(status.portfolioValue.available, false);
    assert.equal(status.positions.available, false);
    assert.equal(status.openOrders.available, false);
    assert.equal(status.portfolioValue.error, 'request unavailable');
});

test('account status treats a non-array CLOB response as unavailable without failing other sources', async () => {
    const status = await getAccountStatus(sources({
        getOpenOrders: async () => ({ error: 'unavailable' }),
    }));
    assert.deepEqual(status.polygonPusd, { available: true, value: 123.456 });
    assert.equal(status.openOrders.available, false);
    assert.equal(status.openOrders.error, 'request unavailable');
});

test('account status does not request remote sources without an account identity', async () => {
    let requested = false;
    const status = await getAccountStatus(sources({
        getIdentity: () => { throw new Error('FUNDER_ADDRESS is not set'); },
        getPolygonPusd: async () => { requested = true; return 1; },
    }));
    assert.equal(requested, false);
    assert.equal(status.account.error, 'FUNDER_ADDRESS is not set');
    assert.equal(status.polygonPusd.available, false);
});
