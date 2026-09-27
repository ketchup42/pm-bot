import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatAccountStatusText, getAccountStatus } from '../dist/app/account-status.js';

function sources(overrides = {}) {
    return {
        getIdentity: () => ({ funderAddress: '0x1234567890abcdef1234567890abcdef12345678', signatureType: 2 }),
        getAvailableCollateral: async () => 123.456,
        getPortfolioValue: async () => 0,
        getOpenOrders: async () => [{
            side: 'BUY', outcome: 'Up', original_size: '10', size_matched: '2.5', price: '0.42',
        }, {
            side: 'SELL', outcome: 'Down', original_size: '5', size_matched: '0', price: '0.58',
        }],
        now: () => 1_700_000_000_000,
        ...overrides,
    };
}

test('account status reports the full supplied open-order count without exposing the address', async () => {
    const status = await getAccountStatus(sources());
    assert.deepEqual(status.account, { available: true, value: { address: '0x1234…5678' } });
    assert.deepEqual(status.availableCollateral, { available: true, value: 123.456 });
    assert.deepEqual(status.portfolioValue, { available: true, value: 0 });
    assert.equal(status.openOrders.value, 2);
    const text = formatAccountStatusText(status);
    assert.match(text, /AVAILABLE BALANCE\s+\$123\.46/);
    assert.match(text, /POSITIONS VALUE\s+\$0\.00/);
    assert.doesNotMatch(text, /SIGNATURE TYPE|POLYGON pUSD|POSITION |ORDER BUY/);
    assert.doesNotMatch(text, /0x1234567890abcdef1234567890abcdef12345678/);
});

test('account status keeps collateral balance when open-order requests fail', async () => {
    const status = await getAccountStatus(sources({
        getOpenOrders: async () => { throw new Error('network'); },
    }));
    assert.deepEqual(status.availableCollateral, { available: true, value: 123.456 });
    assert.equal(status.openOrders.available, false);
    assert.equal(status.openOrders.error, 'request unavailable');
});

test('account status keeps collateral and orders when portfolio value is unavailable', async () => {
    const status = await getAccountStatus(sources({
        getPortfolioValue: async () => { throw new Error('network'); },
    }));
    assert.deepEqual(status.availableCollateral, { available: true, value: 123.456 });
    assert.equal(status.portfolioValue.available, false);
    assert.equal(status.openOrders.value, 2);
});

test('account status treats a non-array CLOB order response as unavailable without failing collateral', async () => {
    const status = await getAccountStatus(sources({
        getOpenOrders: async () => ({ error: 'unavailable' }),
    }));
    assert.deepEqual(status.availableCollateral, { available: true, value: 123.456 });
    assert.equal(status.openOrders.available, false);
    assert.equal(status.openOrders.error, 'request unavailable');
});

test('account status does not request remote sources without an account identity', async () => {
    let requested = false;
    const status = await getAccountStatus(sources({
        getIdentity: () => { throw new Error('FUNDER_ADDRESS is not set'); },
        getAvailableCollateral: async () => { requested = true; return 1; },
    }));
    assert.equal(requested, false);
    assert.equal(status.account.error, 'FUNDER_ADDRESS is not set');
    assert.equal(status.availableCollateral.available, false);
});
