import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchEventBySlug, fetchMarketById } from '../dist/rest/scan.js';

function makeMarket(overrides = {}) {
    return {
        id: '4142716',
        conditionId: 'condition-id',
        clobTokenIds: '["up-token", "down-token"]',
        outcomes: '["Up", "Down"]',
        outcomePrices: '[0.5, "invalid"]',
        ...overrides,
    };
}

function makeEvent(slug, market = makeMarket()) {
    return { id: 'event-id', slug, markets: [market] };
}

function makeResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(body),
    };
}

async function withMockFetch(mock, action) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock;
    try {
        return await action();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test('event accepts unavailable outcome fields without retrying', async () => {
    const slug = 'btc-updown-5m-1788448800';
    let requests = 0;
    const event = await withMockFetch(async () => {
        requests++;
        return makeResponse(makeEvent(slug, makeMarket({ outcomes: null, outcomePrices: 'undefined' })));
    }, () => fetchEventBySlug(slug));

    assert.equal(requests, 1);
    assert.deepEqual(event.markets[0]?.outcomes, []);
    assert.deepEqual(event.markets[0]?.outcomePrices, []);
});

test('market accepts missing outcome fields without retrying', async () => {
    let requests = 0;
    const market = await withMockFetch(async () => {
        requests++;
        return makeResponse([makeMarket({ outcomes: undefined, outcomePrices: undefined })]);
    }, () => fetchMarketById('4142716'));

    assert.equal(requests, 1);
    assert.deepEqual(market.outcomes, []);
    assert.deepEqual(market.outcomePrices, []);
});

test('market normalizes valid outcome fields', async () => {
    const market = await withMockFetch(
        async () => makeResponse([makeMarket({ outcomes: ['Up', 'Down'], outcomePrices: [1, 'invalid'] })]),
        () => fetchMarketById('4142716'),
    );

    assert.deepEqual(market.outcomes, ['Up', 'Down']);
    assert.deepEqual(market.outcomePrices, [1, 0]);
});

test('event rejects a missing required identifier', async () => {
    const slug = 'btc-updown-5m-1788448800';
    await withMockFetch(
        async () => makeResponse(makeEvent(slug, makeMarket({ conditionId: null }))),
        async () => assert.rejects(() => fetchEventBySlug(slug), /market 4142716\.conditionId/),
    );
});

test('event rejects a missing id, non-matching slug, and non-array markets', async () => {
    const slug = 'btc-updown-5m-1788448800';
    const cases = [
        [makeEvent(slug, makeMarket({})), /event\.id/, event => ({ ...event, id: undefined })],
        [makeEvent(slug), /does not match requested/, event => ({ ...event, slug: 'other-slug' })],
        [makeEvent(slug), /markets is not an array/, event => ({ ...event, markets: null })],
    ];

    for (const [event, error, transform] of cases) {
        await withMockFetch(
            async () => makeResponse(transform(event)),
            async () => assert.rejects(() => fetchEventBySlug(slug), error),
        );
    }
});
