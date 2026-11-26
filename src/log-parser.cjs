'use strict';

const { validTokens } = require('./pricing.cjs');
const { createWeeklyObservations } = require('./weekly-quota.cjs');

const MaxRecordBytes = 1024 * 1024;

function identifier(value)
{
    return typeof value === 'string' && value.length > 0 && value.length <= 256
        && /^[a-zA-Z0-9_.:+/-]+$/.test(value) ? value : null;
}

function modelName(value)
{
    return typeof value === 'string' && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)
        ? value : 'unknown';
}

function normalizeUsage(value)
{
    if (!value || typeof value !== 'object') return null;
    const inputTokens = value.input_tokens;
    const outputTokens = value.output_tokens;
    const cachedInputTokens = value.cached_input_tokens ?? 0;
    const cacheWriteTokens = value.cache_write_input_tokens ?? 0;
    if (![inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens].every(validTokens)
        || cachedInputTokens > inputTokens || cacheWriteTokens > inputTokens - cachedInputTokens) return null;
    const ttl = value.cache_write_ttl;
    const seconds = value.cache_write_ttl_seconds;
    const namedTtl = ttl === '30m' || ttl === '12h' ? ttl : null;
    const secondsTtl = seconds === 1800 ? '30m' : seconds === 43200 ? '12h' : null;
    let cacheWriteTtl = ttl == null ? secondsTtl : namedTtl;
    if (ttl != null && seconds != null && namedTtl !== secondsTtl) cacheWriteTtl = null;
    return { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, cacheWriteTtl };
}

function createLogParser({ sourceId, minTimestamp = -Infinity, maxWeeklyTimestamp = Infinity })
{
    const contexts = new Map();
    const modern = [];
    const legacy = [];
    const modernThreads = new Set();
    const weekly = createWeeklyObservations(minTimestamp, maxWeeklyTimestamp);
    let currentModel = 'unknown';
    let skippedRecords = 0;
    let oversizedRecords = 0;
    let pieces = [];
    let size = 0;
    let discarding = false;
    let previousLegacy;

    function record(buffer)
    {
        if (!buffer.length || !buffer.toString('utf8').trim()) return;
        let value;
        try
        {
            value = JSON.parse(buffer.toString('utf8'));
        }
        catch
        {
            skippedRecords++;
            return;
        }
        if (!value || typeof value !== 'object') return;
        const payload = value.payload;
        if (!payload || typeof payload !== 'object') return;
        if (value.type === 'session_meta')
        {
            sourceId = identifier(payload.id) || sourceId;
            return;
        }
        if (value.type === 'turn_context')
        {
            currentModel = modelName(payload.model);
            const turn = identifier(payload.turn_id);
            if (turn) contexts.set(turn, currentModel);
            return;
        }
        const modernUsage = value.type === 'token_usage_record';
        if (!modernUsage && !(value.type === 'event_msg' && payload.type === 'token_count')) return;
        const timestamp = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
        if (!Number.isFinite(timestamp))
        {
            skippedRecords++;
            return;
        }
        if (modernUsage)
        {
            const thread = identifier(payload.thread_id);
            modernThreads.add(thread);
            const id = identifier(payload.response_id);
            const usage = normalizeUsage(payload.usage);
            if (!id || !usage)
            {
                skippedRecords++;
                return;
            }
            if (timestamp < minTimestamp) return;
            const turn = identifier(payload.turn_id);
            const model = payload.model ? modelName(payload.model) : contexts.get(turn);
            const cumulative = normalizeUsage(payload.thread_token_usage);
            const threadUsageKey = cumulative ? [cumulative.inputTokens, cumulative.cachedInputTokens,
                cumulative.cacheWriteTokens, cumulative.outputTokens].join(':') : null;
            modern.push({ id, thread, turn, timestamp, model, threadUsageKey, ...usage });
            return;
        }
        weekly.observe(payload.rate_limits, timestamp);
        const total = normalizeUsage(payload.info && payload.info.total_token_usage);
        const last = normalizeUsage(payload.info && payload.info.last_token_usage);
        if (!total)
        {
            if (payload.info) skippedRecords++;
            return;
        }
        const event = { timestamp, model: currentModel, total, last };
        if (timestamp < minTimestamp)
        {
            // 仅保留窗口前最后一个累计基线，避免缓存整个历史。
            previousLegacy = event;
        }
        else legacy.push(event);
    }

    function segment(buffer, terminated)
    {
        if (!discarding)
        {
            if (size + buffer.length > MaxRecordBytes)
            {
                discarding = true;
                pieces = [];
                size = 0;
                skippedRecords++;
                oversizedRecords++;
            }
            else if (buffer.length)
            {
                pieces.push(buffer);
                size += buffer.length;
            }
        }
        if (!terminated) return;
        if (!discarding) record(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size));
        pieces = [];
        size = 0;
        discarding = false;
    }

    return {
        onChunk(chunk)
        {
            let from = 0;
            while (from < chunk.length)
            {
                const end = chunk.indexOf(10, from);
                if (end < 0)
                {
                    segment(chunk.subarray(from), false);
                    break;
                }
                segment(chunk.subarray(from, end), true);
                from = end + 1;
            }
        },
        finish()
        {
            segment(Buffer.alloc(0), true);
            if (previousLegacy) legacy.unshift(previousLegacy);
            for (const event of modern)
            {
                event.thread = event.thread || sourceId;
                event.model = event.model || contexts.get(event.turn) || 'unknown';
                delete event.turn;
            }
            return { sourceId, modern, legacy,
                modernThreads: [...modernThreads].map(thread => thread || sourceId),
                skippedRecords, oversizedRecords, ...weekly.finish() };
        },
    };
}

module.exports = { createLogParser, normalizeUsage };
