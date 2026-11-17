'use strict';

const Pricing = Object.freeze({ basis: 'codex-base-estimate', asOf: '2026-11-16',
    source: 'https://developers.openai.com/api/docs/pricing.md' });
const Million = 1000000;

// Standard 基础单价于 2026-11-16 核验；每百万 token 计价，不叠加长上下文或 TTL 倍率。
const Rates = new Map([
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

function validTokens(value)
{
    return Number.isSafeInteger(value) && value >= 0;
}

function priceRequest({ model, inputTokens, cachedInputTokens = 0, cacheWriteTokens = 0,
    outputTokens } = {})
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
    const subtotal = (uncachedInputTokens + cacheWriteTokens) * inputRate
        + cachedInputTokens * cachedRate + outputTokens * outputRate;
    return { usd: Number((subtotal / Million).toFixed(12)), unpriced: false,
        uncachedInputTokens, reasons: [] };
}

module.exports = { priceRequest, Pricing, validTokens };
