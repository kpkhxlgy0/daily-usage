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
    assert.equal(Pricing.basis, 'codex-base-estimate');
    assert.equal(Pricing.asOf, '2026-11-18');
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

test('weekly Standard pricing applies long-context rates only above 272000 input tokens', () =>
{
    const options = { standard: true };
    assert.equal(priceRequest(request({ inputTokens: 272000, cachedInputTokens: 72000,
        outputTokens: 1000 }), options).usd, 0.4172);
    assert.equal(priceRequest(request({ inputTokens: 272001, cachedInputTokens: 72000,
        outputTokens: 1000 }), options).usd, 0.829404);
    assert.equal(priceRequest(request({ model: 'gpt-6-astra', inputTokens: 300000,
        cachedInputTokens: 280000, cacheWriteTokens: 10000, cacheWriteTtl: '12h', outputTokens: 1000 }), options).usd,
    1.335);
    assert.equal(priceRequest(request({ model: 'unpriced', inputTokens: 300000 }), options).unpriced, true);
});

test('weekly Standard quotes the published write retention by model and preserves known subtotals', () =>
{
    const options = { standard: true };
    const pureWrite = request({ inputTokens: 100000, cachedInputTokens: 0, cacheWriteTokens: 100000,
        cacheWriteTtl: '12h', outputTokens: 0 });
    assert.equal(priceRequest(pureWrite).usd, 0.2);
    assert.equal(priceRequest(pureWrite, options).usd, 0.5);
    assert.equal(priceRequest({ ...pureWrite, cacheWriteTtl: '30m' }, options).usd, 0.25);
    const fallback = priceRequest({ ...pureWrite, cacheWriteTtl: null }, options);
    assert.equal(fallback.usd, 0.25);
    assert.equal(fallback.estimated, true);
    for (const [model, want] of [['gpt-5.5', 0.0066], ['gpt-5.4', 0.0033]])
    {
        const partial = priceRequest(request({ model, cacheWriteTokens: 100, cacheWriteTtl: '12h' }), options);
        assert.equal(partial.usd, want);
        assert.equal(partial.unpriced, true);
    }
});

test('all verified Standard models use their own input, cached and output prices', () =>
{
    const cases = [
        ['gpt-6.2-astra', 0.01048], ['gpt-6.2-sol', 0.00262],
        ['gpt-6-astra', 0.0132], ['gpt-6.1-sol', 0.00262], ['gpt-6.1-terra', 0.00131],
        ['gpt-6-luna', 0.000132], ['gpt-6-sol', 0.00264], ['gpt-5.6-sol', 0.00528],
        ['gpt-5.6-terra', 0.00284], ['gpt-5.6-luna', 0.000284],
        ['gpt-5.5', 0.0071], ['gpt-5.4', 0.00355],
    ];
    for (const [model, want] of cases) assert.equal(priceRequest(request({ model })).usd, want, model);
});

test('cache writes use ordinary input rates once regardless of TTL and retain distinct counters', () =>
{
    for (const cacheWriteTtl of ['30m', '12h', undefined])
    {
        const price = priceRequest(request({ cacheWriteTokens: 100, cacheWriteTtl }));
        assert.equal(price.usd, 0.00262, cacheWriteTtl);
        assert.equal(price.uncachedInputTokens, 700);
        assert.equal(price.unpriced, false);
        assert.deepEqual(price.reasons, []);
    }
});

test('large cache writes keep ordinary base input rates without long-context or TTL premiums', () =>
{
    for (const cacheWriteTtl of ['30m', '12h', undefined])
    {
        const price = priceRequest(request({ inputTokens: 300000, cachedInputTokens: 0,
            cacheWriteTokens: 100000, cacheWriteTtl, outputTokens: 1000 }));
        assert.equal(price.usd, 0.61);
        assert.equal(price.uncachedInputTokens, 200000);
        assert.equal(price.unpriced, false);
    }
});

test('known older models price cache writes as ordinary input while unknown models remain unpriced', () =>
{
    for (const [model, want] of [['gpt-5.5', 0.0071], ['gpt-5.4', 0.00355]])
    {
        const price = priceRequest(request({ model, cacheWriteTokens: 100 }));
        assert.equal(price.usd, want, model);
        assert.equal(price.uncachedInputTokens, 700);
        assert.equal(price.unpriced, false);
    }
    const unknown = priceRequest(request({ model: 'custom-private-model', cacheWriteTokens: 100 }));
    assert.equal(unknown.usd, 0);
    assert.equal(unknown.unpriced, true);
    assert.equal(unknown.uncachedInputTokens, 700);
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
test('conflicting retention fields keep weekly cache-write pricing visibly estimated', () => {
    const { normalizeUsage } = require('../src/log-parser.cjs');
    const usage = normalizeUsage({ input_tokens: 100000, output_tokens: 0, cache_write_input_tokens: 100000,
        cache_write_ttl: '30m', cache_write_ttl_seconds: 43200 });
    assert.equal(usage.cacheWriteTtl, null);
    const price = priceRequest({ ...usage, model: 'gpt-6.1-sol' }, { standard: true });
    assert.equal(price.usd, 0.25);
    assert.equal(price.estimated, true);
});
