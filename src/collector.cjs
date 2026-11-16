'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRolloutReader } = require('./vendor/rollout-reader.cjs');
const { createLogParser } = require('./log-parser.cjs');
const { priceRequest, Pricing, validTokens } = require('./pricing.cjs');

const DayMs = 24 * 60 * 60 * 1000;
const BeijingOffsetMs = 8 * 60 * 60 * 1000;
const RetentionDays = 30;
const CacheVersion = 2;
const OffsetPairWindowMs = 5 * 60 * 1000;

function beijingDate(timestamp)
{
    return new Date(timestamp + BeijingOffsetMs).toISOString().slice(0, 10);
}

function fingerprint(stat)
{
    return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].map(key => stat[key]).join(':');
}

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function usageKey(value)
{
    return [value.inputTokens, value.cachedInputTokens, value.cacheWriteTokens, value.outputTokens].join(':');
}

function difference(current, previous)
{
    const result = { cacheWriteTtl: current.cacheWriteTtl };
    for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'])
    {
        if (current[key] < previous[key]) return null;
        result[key] = current[key] - previous[key];
    }
    if (result.cachedInputTokens + result.cacheWriteTokens > result.inputTokens) return null;
    return result;
}

function validCachedData(value)
{
    function usage(entry)
    {
        return entry && ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens']
            .every(key => validTokens(entry[key]))
            && entry.cachedInputTokens + entry.cacheWriteTokens <= entry.inputTokens
            && [null, '30m', '12h'].includes(entry.cacheWriteTtl);
    }
    function event(entry)
    {
        return entry && Number.isFinite(entry.timestamp) && Math.abs(entry.timestamp) < 8.64e15 - BeijingOffsetMs
            && typeof entry.model === 'string' && entry.model.length <= 128;
    }
    return value && typeof value.sourceId === 'string' && validTokens(value.skippedRecords)
        && validTokens(value.oversizedRecords) && Array.isArray(value.modernThreads)
        && value.modernThreads.every(thread => typeof thread === 'string')
        && Array.isArray(value.modern) && value.modern.every(entry => event(entry) && usage(entry)
            && typeof entry.id === 'string' && typeof entry.thread === 'string'
            && (entry.threadUsageKey === null || typeof entry.threadUsageKey === 'string'))
        && Array.isArray(value.legacy) && value.legacy.every(entry => event(entry) && usage(entry.total)
            && (entry.last === null || usage(entry.last)));
}

function createCollector({ codexHome, cacheDir, now = Date.now, onProgress } = {})
{
    if (typeof codexHome !== 'string' || !codexHome) throw new TypeError('codexHome is required');
    if (typeof now !== 'function') throw new TypeError('now must be a clock function');
    const usageCacheDir = path.join(cacheDir || path.join(codexHome, '.daily-usage'), 'usage-cache');
    const reader = createRolloutReader();
    const memory = new Map();
    let pending = Promise.resolve();
    let disposed = false;

    function checkActive()
    {
        if (disposed) throw Object.assign(new Error('Daily Usage collector is disposed'),
            { code: 'ERR_DAILY_USAGE_DISPOSED' });
    }

    function progress(phase, coverage, processedFiles = 0)
    {
        if (typeof onProgress === 'function')
        {
            onProgress({ phase, files: coverage.files, processedFiles,
                parsedFiles: coverage.parsedFiles, cachedFiles: coverage.cachedFiles,
                failedFiles: coverage.failedFiles });
        }
    }

    async function discover(cutoff, coverage)
    {
        const selected = new Map();
        async function walk(directory, priority)
        {
            checkActive();
            let entries;
            try
            {
                entries = await fs.readdir(directory, { withFileTypes: true });
            }
            catch (error)
            {
                if (error.code !== 'ENOENT') coverage.discoveryErrors++;
                return;
            }
            for (const entry of entries)
            {
                checkActive();
                const filename = path.join(directory, entry.name);
                if (entry.isDirectory()) await walk(filename, priority);
                else if (entry.isFile() && /\.jsonl(?:\.zst)?$/i.test(entry.name))
                {
                    let stat;
                    try
                    {
                        stat = await fs.stat(filename);
                    }
                    catch
                    {
                        coverage.discoveryErrors++;
                        continue;
                    }
                    // 文件目录日期是会话开始时间；旧目录里仍可能存在最近恢复的会话。
                    const namedDate = entry.name.match(/20\d{2}-\d{2}-\d{2}/);
                    const namedTime = namedDate ? Date.parse(namedDate[0] + 'T00:00:00+08:00') : -Infinity;
                    if (stat.mtimeMs < cutoff && namedTime < cutoff) continue;
                    const logicalName = entry.name.replace(/\.zst$/i, '');
                    const compressed = /\.zst$/i.test(entry.name);
                    const rank = priority * 2 + Number(compressed);
                    const existing = selected.get(logicalName);
                    if (!existing || rank < existing.rank)
                    {
                        selected.set(logicalName, { filename, stat, rank });
                    }
                }
            }
        }
        await walk(path.join(codexHome, 'sessions'), 0);
        await walk(path.join(codexHome, 'archived_sessions'), 1);
        return [...selected.values()].sort((a, b) => a.rank - b.rank || a.filename.localeCompare(b.filename));
    }

    async function sourceData(source, cutoff, coverage)
    {
        const key = digest(path.relative(codexHome, source.filename));
        const cacheFile = path.join(usageCacheDir, key + '.json');
        const version = fingerprint(source.stat);
        let cached = memory.get(key);
        if (!cached)
        {
            try
            {
                cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
            }
            catch
            {
                // 缓存丢失或损坏只影响性能，原始日志仍为唯一数据源。
            }
        }
        if (cached && cached.schemaVersion === CacheVersion && cached.version === version
            && Number.isFinite(cached.cutoff) && cached.cutoff <= cutoff && validCachedData(cached.data))
        {
            memory.set(key, cached);
            coverage.cachedFiles++;
            return cached.data;
        }
        const parser = createLogParser({ sourceId: 'file-' + key, minTimestamp: cutoff });
        const result = await reader.scan(source.filename, { onChunk: parser.onChunk });
        checkActive();
        const data = parser.finish();
        cached = { schemaVersion: CacheVersion, version: fingerprint(result.stat), cutoff, data };
        memory.set(key, cached);
        coverage.parsedFiles++;
        let temporary;
        try
        {
            await fs.mkdir(usageCacheDir, { recursive: true });
            temporary = cacheFile + '.' + randomUUID() + '.tmp';
            await fs.writeFile(temporary, JSON.stringify(cached), { mode: 0o600 });
            checkActive();
            await fs.rename(temporary, cacheFile);
            temporary = null;
        }
        catch (error)
        {
            if (disposed) throw error;
            coverage.cacheErrors++;
        }
        finally
        {
            if (temporary) await fs.unlink(temporary).catch(() => {});
        }
        return data;
    }

    async function scanSources()
    {
        checkActive();
        const generatedAt = now();
        if (!Number.isFinite(generatedAt)) throw new TypeError('Clock returned an invalid timestamp');
        const to = beijingDate(generatedAt);
        const cutoff = Date.parse(to + 'T00:00:00+08:00') - (RetentionDays - 1) * DayMs;
        const from = beijingDate(cutoff);
        const coverage = { files: 0, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [],
            parsedFiles: 0, cachedFiles: 0, duplicateRequests: 0, conflictingRequests: 0,
            discoveryErrors: 0, cacheErrors: 0, oversizedRecords: 0, legacySkippedRecords: 0,
            redundantLegacyRecords: 0 };
        progress('discovering', coverage);
        const sources = await discover(cutoff, coverage);
        coverage.files = sources.length;
        const data = [];
        let processedFiles = 0;
        progress('scanning', coverage);
        for (const source of sources)
        {
            checkActive();
            try
            {
                const parsed = await sourceData(source, cutoff, coverage);
                data.push(parsed);
                coverage.skippedRecords += parsed.skippedRecords;
                coverage.oversizedRecords += parsed.oversizedRecords;
            }
            catch (error)
            {
                checkActive();
                coverage.failedFiles++;
            }
            progress('scanning', coverage, ++processedFiles);
        }
        checkActive();
        const rows = new Map();
        let unpricedRequests = 0;
        function include(event, estimated = false)
        {
            const date = beijingDate(event.timestamp);
            if (date < from || date > to) return;
            const price = priceRequest(event);
            const key = date + ':' + event.model;
            let row = rows.get(key);
            if (!row)
            {
                row = { date, model: event.model, requests: 0, inputTokens: 0, uncachedInputTokens: 0,
                    cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, usd: 0,
                    unpricedRequests: 0, estimatedRequests: 0 };
                rows.set(key, row);
            }
            row.requests++;
            for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'])
            {
                row[field] += event[field];
            }
            row.uncachedInputTokens += price.uncachedInputTokens;
            row.usd += price.usd;
            if (price.unpriced)
            {
                row.unpricedRequests++;
                unpricedRequests++;
            }
            if (estimated)
            {
                row.estimatedRequests++;
                coverage.legacyRequests++;
            }
        }
        const modernThreads = new Set(data.flatMap(source => source.modernThreads));
        const modernTotals = new Map();
        const modernTimeline = new Map();
        const responses = new Map();
        for (const source of data)
        {
            for (const event of source.modern)
            {
                const timeline = modernTimeline.get(event.thread) || [];
                timeline.push(event);
                modernTimeline.set(event.thread, timeline);
                if (event.threadUsageKey)
                {
                    const totals = modernTotals.get(event.thread) || new Set();
                    totals.add(event.threadUsageKey);
                    modernTotals.set(event.thread, totals);
                }
                if (responses.has(event.id))
                {
                    coverage.duplicateRequests++;
                    const previous = responses.get(event.id);
                    if (usageKey(previous) !== usageKey(event) || previous.model !== event.model)
                    {
                        coverage.conflictingRequests++;
                    }
                    continue;
                }
                responses.set(event.id, event);
                include(event);
            }
        }
        for (const timeline of modernTimeline.values()) timeline.sort((a, b) => a.timestamp - b.timestamp);
        const offsetPairs = new Map();
        for (const source of data)
        {
            const timeline = modernTimeline.get(source.sourceId)
                || (source.modernThreads.length === 1 ? modernTimeline.get(source.modernThreads[0]) : null);
            if (!timeline) continue;
            const counters = new Set(source.legacy.filter(event => event.timestamp >= cutoff)
                .map(event => usageKey(event.total)));
            for (const modern of timeline)
            {
                if (counters.has(modern.threadUsageKey))
                {
                    offsetPairs.set(modern.thread + ':' + modern.id, modern.threadUsageKey);
                }
            }
        }
        function pairedOffset(event, timeline)
        {
            if (!event.last || !timeline) return false;
            let low = 0;
            let high = timeline.length;
            while (low < high)
            {
                const middle = Math.floor((low + high) / 2);
                if (timeline[middle].timestamp <= event.timestamp) low = middle + 1;
                else high = middle;
            }
            const modern = timeline[low - 1];
            if (!modern || event.timestamp - modern.timestamp > OffsetPairWindowMs
                || usageKey(modern) !== usageKey(event.last)) return false;
            const response = modern.thread + ':' + modern.id;
            const counter = usageKey(event.total);
            if (offsetPairs.has(response)) return offsetPairs.get(response) === counter;
            offsetPairs.set(response, counter);
            return true;
        }
        const legacyThreads = new Map();
        for (const source of data)
        {
            if (modernThreads.has(source.sourceId) || source.modernThreads.length)
            {
                const totals = new Set(modernTotals.get(source.sourceId));
                for (const thread of source.modernThreads)
                {
                    for (const key of modernTotals.get(thread) || []) totals.add(key);
                }
                const timeline = modernTimeline.get(source.sourceId)
                    || (source.modernThreads.length === 1 ? modernTimeline.get(source.modernThreads[0]) : null);
                for (const event of source.legacy)
                {
                    if (event.timestamp < cutoff) continue;
                    // 历史偏移只能用相邻请求佐证；同一响应不可覆盖多个不同累计值。
                    if (totals.has(usageKey(event.total)) || pairedOffset(event, timeline))
                    {
                        coverage.redundantLegacyRecords++;
                    }
                    else
                    {
                        coverage.legacySkippedRecords++;
                        coverage.skippedRecords++;
                    }
                }
                continue;
            }
            const events = legacyThreads.get(source.sourceId) || [];
            events.push(...source.legacy);
            legacyThreads.set(source.sourceId, events);
        }
        const legacyCandidates = new Map();
        let legacyBaselineGaps = 0;
        let legacyReplayGaps = 0;
        for (const events of legacyThreads.values())
        {
            events.sort((a, b) => a.timestamp - b.timestamp);
            let previous;
            for (const event of events)
            {
                let usage;
                if (!previous)
                {
                    usage = event.last;
                    if (!usage && event.timestamp >= cutoff)
                    {
                        legacyBaselineGaps++;
                        coverage.skippedRecords++;
                    }
                    previous = event.total;
                }
                else
                {
                    usage = difference(event.total, previous);
                    if (!usage)
                    {
                        legacyReplayGaps++;
                        coverage.skippedRecords++;
                        continue;
                    }
                    previous = event.total;
                }
                if (!usage || event.timestamp < cutoff || !usage.inputTokens && !usage.outputTokens) continue;
                const key = digest([event.timestamp, event.model, usageKey(event.total)].join('|'));
                const candidate = { timestamp: event.timestamp, model: event.model, ...usage };
                const existing = legacyCandidates.get(key);
                if (existing)
                {
                    coverage.duplicateRequests++;
                    // 分叉可能只复制累计流的尾部；保留已观察到的完整增量，禁止再叠加 last。
                    if (usage.inputTokens >= existing.inputTokens && usage.outputTokens >= existing.outputTokens)
                    {
                        legacyCandidates.set(key, candidate);
                    }
                    continue;
                }
                legacyCandidates.set(key, candidate);
            }
        }
        for (const event of legacyCandidates.values()) include(event, true);
        if (coverage.failedFiles) coverage.warnings.push(`有 ${coverage.failedFiles} 个用量文件读取失败。`);
        if (coverage.discoveryErrors) coverage.warnings.push(`有 ${coverage.discoveryErrors} 处历史目录无法读取。`);
        if (coverage.skippedRecords) coverage.warnings.push(`跳过 ${coverage.skippedRecords} 条不完整记录，统计覆盖不全。`);
        if (coverage.oversizedRecords) coverage.warnings.push(`${coverage.oversizedRecords} 条记录超过 1 MiB 上限。`);
        if (coverage.conflictingRequests) coverage.warnings.push('重复响应的用量或模型不一致，已保留首条。');
        if (coverage.legacySkippedRecords) coverage.warnings.push('旧版累计记录缺少对应逐请求记录，已保守排除。');
        if (coverage.legacyRequests) coverage.warnings.push(`${coverage.legacyRequests} 条旧版累计增量为估算，请求数、日期和金额可能不完整。`);
        if (legacyBaselineGaps) coverage.warnings.push('旧版累计前缀缺少单次用量，仅用作基线。');
        if (legacyReplayGaps) coverage.warnings.push('旧版累计值回退，已排除重放或重置记录。');
        if (unpricedRequests) coverage.warnings.push(`${unpricedRequests} 次请求有未定价部分；美元仅含可定价用量。`);
        if (coverage.cacheErrors) coverage.warnings.push('用量缓存写入失败，仍显示已读取的统计。');
        const result = [...rows.values()].sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model));
        for (const row of result) row.usd = Number(row.usd.toFixed(12));
        progress('complete', coverage, processedFiles);
        return { generatedAt, timezone: 'Asia/Shanghai', from, to, rows: result, coverage, pricing: { ...Pricing } };
    }

    return {
        scan()
        {
            const operation = pending.then(scanSources);
            pending = operation.catch(() => {});
            return operation;
        },
        async dispose()
        {
            disposed = true;
            await reader.dispose();
            await pending;
            memory.clear();
        },
    };
}

module.exports = { createCollector };
