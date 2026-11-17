'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { priceRequest, Pricing } = require('../src/pricing.cjs');

function request(overrides = {})
{
    return { model: 'gpt-6.1-sol', inputTokens: 1000, cachedInputTokens: 200,
        cacheWriteTokens: 0, outputTokens: 100, ...overrides };
}

test('cached input is charged separately and reasoning output is not added twice', () =>
{
    const price = priceRequest(request({ reasoningOutputTokens: 60 }));
    assert.equal(price.uncachedInputTokens, 800);
    assert.equal(price.usd, 0.00262);
    assert.equal(price.unpriced, false);
    assert.equal(Pricing.basis, 'standard-base-api');
    assert.equal(Pricing.asOf, '2026-11-16');
});

test('crossing 272000 input tokens keeps the same base input, cache and output rates', () =>
{
    assert.equal(priceRequest(request({ inputTokens: 272000, cachedInputTokens: 72000,
        outputTokens: 1000 })).usd, 0.4172);
    assert.equal(priceRequest(request({ inputTokens: 272001, cachedInputTokens: 72000,
        outputTokens: 1000 })).usd, 0.417202);
    assert.equal(priceRequest(request({ model: 'gpt-6-astra', inputTokens: 300000,
        cachedInputTokens: 280000, outputTokens: 1000 })).usd, 0.53);
    assert.equal(priceRequest(request({ model: 'gpt-6-astra', inputTokens: 1000000,
        cachedInputTokens: 900000, outputTokens: 1000 })).usd, 1.95);
});

test('all verified Standard models use their own input, cached and output prices', () =>
{
    const cases = [
        ['gpt-6-astra', 0.0132], ['gpt-6.1-sol', 0.00262], ['gpt-6.1-terra', 0.00131],
        ['gpt-6-luna', 0.000132], ['gpt-6-sol', 0.00264], ['gpt-5.6-sol', 0.00528],
        ['gpt-5.6-terra', 0.00284], ['gpt-5.6-luna', 0.000284],
        ['gpt-5.5', 0.0071], ['gpt-5.4', 0.00355],
    ];
    for (const [model, want] of cases) assert.equal(priceRequest(request({ model })).usd, want, model);
});

test('explicit 30 minute and 12 hour cache writes replace ordinary input pricing', () =>
{
    assert.equal(priceRequest(request({ cacheWriteTokens: 100, cacheWriteTtl: '30m' })).usd, 0.00267);
    assert.equal(priceRequest(request({ cacheWriteTokens: 100, cacheWriteTtl: '12h' })).usd, 0.00292);
    assert.equal(priceRequest(request({ inputTokens: 300000, cachedInputTokens: 0,
        cacheWriteTokens: 100000, cacheWriteTtl: '30m', outputTokens: 1000 })).usd, 0.66);
});

test('missing write TTL preserves priced subtotal and marks the request unpriced', () =>
{
    const price = priceRequest(request({ cacheWriteTokens: 100 }));
    assert.equal(price.usd, 0.00242);
    assert.equal(price.unpriced, true);
    assert.ok(price.reasons.includes('cache-write-ttl'));
});

test('unknown models and unsupported cache writes are visible rather than assumed free', () =>
{
    const unknown = priceRequest(request({ model: 'custom-private-model' }));
    assert.equal(unknown.usd, 0);
    assert.equal(unknown.unpriced, true);
    const unsupported = priceRequest(request({ model: 'gpt-5.5', cacheWriteTokens: 100,
        cacheWriteTtl: '30m' }));
    assert.equal(unsupported.usd, 0.0066);
    assert.equal(unsupported.unpriced, true);
});

test('invalid overlapping or noninteger token counts never yield a negative or invented price', () =>
{
    for (const values of [{ cachedInputTokens: 1001 }, { cacheWriteTokens: 801 },
        { inputTokens: -1 }, { outputTokens: 1.5 }, { outputTokens: NaN }])
    {
        const price = priceRequest(request(values));
        assert.equal(price.unpriced, true);
        assert.equal(price.usd, 0);
    }
});
