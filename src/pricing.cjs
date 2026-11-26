'use strict';

const Pricing = Object.freeze({ basis: 'codex-base-estimate', asOf: '2026-11-18',
    source: 'https://developers.openai.com/api/docs/pricing.md' });
const Million = 1000000;
const LongContextInputTokens = 272000;
const LongContextInputMultiplier = 2;
const LongContextOutputMultiplier = 1.5;
const ShortCacheWriteMultiplier = 1.25;
const LongCacheWriteMultiplier = 2.5;

// Standard USD per million tokens: input, output, cached input.
const Rates = new Map([
    ['gpt-6.2-astra', [8, 40, 0.4]],
    ['gpt-6.2-sol', [2, 10, 0.1]],
    ['gpt-6-astra', [10, 50, 1]],
    ['gpt-6.1-sol', [2, 10, 0.1]],
    ['gpt-6.1-terra', [1, 5, 0.05]],
    ['gpt-6-luna', [0.1, 0.5, 0.01]],
    ['gpt-6-sol', [2, 10, 0.2]],
    ['gpt-5.6-sol', [4, 20, 0.4]],
    ['gpt-5.6-terra', [2, 12, 0.2]],
    ['gpt-5.6-luna', [0.2, 1.2, 0.02]],
    ['gpt-5.5', [5, 30, 0.5]],
    ['gpt-5.4', [2.5, 15, 0.25]],
]);
const ModelsWithoutCacheWriteRates = new Set(['gpt-5.5', 'gpt-5.4']);

function validTokens(value)
{
    return Number.isSafeInteger(value) && value >= 0;
}

function priceRequest({ model, inputTokens, cachedInputTokens = 0, cacheWriteTokens = 0,
    cacheWriteTtl, outputTokens } = {}, { standard = false } = {})
{
    if (![inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens].every(validTokens)
        || cachedInputTokens > inputTokens || cacheWriteTokens > inputTokens - cachedInputTokens)
    {
        return { usd: 0, unpriced: true, uncachedInputTokens: 0, reasons: ['invalid-usage'] };
    }
    const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteTokens;
    const rate = Rates.get(model);
    if (!rate) return { usd: 0, unpriced: true, uncachedInputTokens, reasons: ['unknown-model'] };
    const [inputRate, outputRate, cachedRate] = rate;
    let cacheWriteMultiplier = 1;
    let estimated = false;
    const reasons = [];
    if (standard && cacheWriteTokens > 0)
    {
        if (ModelsWithoutCacheWriteRates.has(model))
        {
            cacheWriteMultiplier = 0;
            reasons.push('unknown-cache-write-rate');
        }
        else
        {
            cacheWriteMultiplier = cacheWriteTtl === '12h' ? LongCacheWriteMultiplier : ShortCacheWriteMultiplier;
            estimated = cacheWriteTtl !== '12h' && cacheWriteTtl !== '30m';
        }
    }
    const inputPrice = (uncachedInputTokens + cacheWriteTokens * cacheWriteMultiplier) * inputRate
        + cachedInputTokens * cachedRate;
    const outputPrice = outputTokens * outputRate;
    const subtotal = standard && inputTokens > LongContextInputTokens
        ? inputPrice * LongContextInputMultiplier + outputPrice * LongContextOutputMultiplier
        : inputPrice + outputPrice;
    return { usd: Number((subtotal / Million).toFixed(12)), unpriced: reasons.length > 0,
        uncachedInputTokens, reasons, ...(estimated ? { estimated } : {}) };
}

module.exports = { priceRequest, Pricing, validTokens };
