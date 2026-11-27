'use strict';

const { validTokens } = require('./pricing.cjs');
const { createWeeklyObservations, sameCycle, weeklyReadings } = require('./weekly-quota.cjs');

const MaxRecordBytes = 1024 * 1024;
const PairWindowMs = 5 * 60 * 1000;
const Counters = ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'];

function usageKey(value)
{
    return Counters.map(key => value[key]).join(':');
}

function hasUsage(value)
{
    return value && (value.inputTokens > 0 || value.outputTokens > 0);
}

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

function corroborates(first, firstCandidate, second, secondCandidate)
{
    return first.thread === second.thread && first.turn === second.turn && first.id !== second.id
        && first.timestamp <= second.timestamp && firstCandidate.offset === secondCandidate.offset
        && (firstCandidate.resetAt === secondCandidate.resetAt
            || firstCandidate.resetAt !== null && secondCandidate.resetAt !== null
                && sameCycle(firstCandidate.resetAt, secondCandidate.resetAt))
        && Counters.every(key => first.cumulative[key] <= second.cumulative[key])
        && Counters.some(key => first.cumulative[key] < second.cumulative[key]);
}

function associateSnapshots(modern)
{
    // 优先用相等的累计计数；稳定偏移必须由这份日志中的相邻请求独立佐证。
    const preferred = modern.map(event =>
    {
        const exact = event.snapshots.filter(candidate => candidate.total === event.threadUsageKey);
        return exact.length ? exact : event.snapshots;
    });
    function hasAdjacentMatch(groups, index, candidate)
    {
        const event = modern[index];
        return groups[index - 1]?.some(other => corroborates(modern[index - 1], other, event, candidate))
            || groups[index + 1]?.some(other => corroborates(event, candidate, modern[index + 1], other));
    }
    const validated = preferred.map((candidates, index) =>
    {
        const stable = candidates.filter(candidate => candidate.total === modern[index].threadUsageKey
            || hasAdjacentMatch(preferred, index, candidate));
        return stable.every(candidate => candidate.total === stable[0].total) ? stable : [];
    });
    for (const [index, event] of modern.entries())
    {
        const resets = new Set();
        for (const candidate of validated[index])
        {
            if (candidate.total !== event.threadUsageKey && !hasAdjacentMatch(validated, index, candidate)) continue;
            for (const [snapshot, resetAt] of candidate.snapshots)
            {
                snapshot.paired = true;
                if (resetAt !== null) resets.add(resetAt);
            }
        }
        event.weeklyResets = [...resets];
        event.weeklyConflict = event.sawWeeklyUsage === true && !resets.size;
    }
    for (const event of modern)
    {
        // 等所有相邻匹配完成后再移除仅解析时使用的字段。
        delete event.snapshots;
        delete event.cumulative;
        delete event.session;
        delete event.sawWeeklyUsage;
    }
}

function createLogParser({ sourceId, minTimestamp = -Infinity, maxWeeklyTimestamp = Infinity })
{
    const contexts = new Map();
    const modern = [];
    const legacy = [];
    const modernThreads = new Set();
    const weekly = createWeeklyObservations(minTimestamp, maxWeeklyTimestamp);
    let activeTurn = null;
    let response = null;
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
            response = null;
            activeTurn = null;
            return;
        }
        if (value.type === 'turn_context')
        {
            currentModel = modelName(payload.model);
            activeTurn = identifier(payload.turn_id);
            if (response?.turn !== activeTurn) response = null;
            if (activeTurn) contexts.set(activeTurn, currentModel);
            return;
        }
        const modernUsage = value.type === 'token_usage_record';
        if (!modernUsage && !(value.type === 'event_msg' && payload.type === 'token_count')) return;
        if (modernUsage) response = null;
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
            const turn = identifier(payload.turn_id);
            const model = payload.model ? modelName(payload.model) : contexts.get(turn);
            const cumulative = normalizeUsage(payload.thread_token_usage);
            const threadUsageKey = cumulative ? usageKey(cumulative) : null;
            const session = identifier(payload.session_id);
            const event = { id, thread, turn, session, timestamp, model, threadUsageKey, cumulative, snapshots: [], ...usage };
            modern.push(event);
            if (thread === sourceId && turn && turn === activeTurn) response = event;
            return;
        }
        const readings = weeklyReadings(payload.rate_limits, timestamp);
        weekly.observe(readings, timestamp);
        const total = normalizeUsage(payload.info && payload.info.total_token_usage);
        const last = normalizeUsage(payload.info && payload.info.last_token_usage);
        const weeklyResets = timestamp <= maxWeeklyTimestamp ? readings.map(reading => reading.resetAt) : [];
        const related = response && response.turn === activeTurn && timestamp >= response.timestamp
            && timestamp - response.timestamp <= PairWindowMs
            && (payload.thread_id == null || payload.thread_id === response.thread)
            && (payload.turn_id == null || payload.turn_id === response.turn)
            && (payload.session_id == null || payload.session_id === response.session);
        if (related && weeklyResets.length && (hasUsage(total) || hasUsage(last))) response.sawWeeklyUsage = true;
        if (!total)
        {
            if (payload.info) skippedRecords++;
            return;
        }
        const event = { timestamp, model: currentModel, total, last, weeklyResets, paired: false };
        if (related && response.cumulative && last && usageKey(last) === usageKey(response))
        {
            const totalKey = usageKey(total);
            const offset = Counters.map(key => response.cumulative[key] - total[key]).join(':');
            for (const resetAt of weeklyResets.length ? weeklyResets : [null])
            {
                let candidate = response.snapshots.find(value => value.total === totalKey && (value.resetAt === resetAt
                    || value.resetAt !== null && resetAt !== null && sameCycle(value.resetAt, resetAt)));
                if (!candidate)
                {
                    candidate = { total: totalKey, offset, resetAt, snapshots: [] };
                    response.snapshots.push(candidate);
                }
                candidate.snapshots.push([event, resetAt]);
            }
        }
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
        finish({ discardTail = false } = {})
        {
            if (!discardTail) segment(Buffer.alloc(0), true);
            if (previousLegacy) legacy.unshift(previousLegacy);
            associateSnapshots(modern);
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
