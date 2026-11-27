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
    assert.equal(Pricing.basis, 'codex-standard-estimate');
    assert.equal(Pricing.asOf, '2026-11-18');
});

test('Standard long-context rates apply to every request above 272000 input tokens', () =>
{
    assert.equal(priceRequest(request({ inputTokens: 272000, cachedInputTokens: 72000,
        outputTokens: 1000 })).usd, 0.4172);
    assert.equal(priceRequest(request({ inputTokens: 272001, cachedInputTokens: 72000,
        outputTokens: 1000 })).usd, 0.829404);
    assert.equal(priceRequest(request({ model: 'gpt-6-astra', inputTokens: 300000,
        cachedInputTokens: 280000, outputTokens: 1000 })).usd, 1.035);
    assert.equal(priceRequest(request({ model: 'gpt-6-astra', inputTokens: 1000000,
        cachedInputTokens: 900000, outputTokens: 1000 })).usd, 3.875);
});

test('long-context Standard pricing applies the cache write premium with the input multiplier', () =>
{
    assert.equal(priceRequest(request({ model: 'gpt-6-astra', inputTokens: 300000,
        cachedInputTokens: 280000, cacheWriteTokens: 10000, cacheWriteTtl: '12h', outputTokens: 1000 })).usd,
    1.335);
});

test('Standard prices cache writes using retention and marks its fallback rate estimated', () =>
{
    const pureWrite = request({ inputTokens: 100000, cachedInputTokens: 0, cacheWriteTokens: 100000,
        cacheWriteTtl: '12h', outputTokens: 0 });
    assert.equal(priceRequest(pureWrite).usd, 0.5);
    assert.equal(priceRequest({ ...pureWrite, cacheWriteTtl: '30m' }).usd, 0.25);
    const fallback = priceRequest({ ...pureWrite, cacheWriteTtl: null });
    assert.equal(fallback.usd, 0.25);
    assert.equal(fallback.estimated, true);
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

test('Standard calculates uncached, cached and write input separately', () =>
{
    const price = priceRequest(request({ cacheWriteTokens: 100, cacheWriteTtl: '12h' }));
    assert.equal(price.usd, 0.00292);
    assert.equal(price.uncachedInputTokens, 700);
    assert.equal(price.unpriced, false);
    assert.deepEqual(price.reasons, []);
});

test('models without write rates preserve known subtotals and unknown models remain unpriced', () =>
{
    for (const [model, want] of [['gpt-5.5', 0.0066], ['gpt-5.4', 0.0033]])
    {
        const price = priceRequest(request({ model, cacheWriteTokens: 100 }));
        assert.equal(price.usd, want, model);
        assert.equal(price.uncachedInputTokens, 700);
        assert.equal(price.unpriced, true);
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
test('conflicting retention fields keep cache-write pricing visibly estimated', () => {
    const { normalizeUsage } = require('../src/log-parser.cjs');
    const usage = normalizeUsage({ input_tokens: 100000, output_tokens: 0, cache_write_input_tokens: 100000,
        cache_write_ttl: '30m', cache_write_ttl_seconds: 43200 });
    assert.equal(usage.cacheWriteTtl, null);
    const price = priceRequest({ ...usage, model: 'gpt-6.1-sol' });
    assert.equal(price.usd, 0.25);
    assert.equal(price.estimated, true);
});
