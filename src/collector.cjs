'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRolloutReader } = require('./vendor/rollout-reader.cjs');
const { scanPlainRollout } = require('./plain-rollout-reader.cjs');
const { createLogParser } = require('./log-parser.cjs');
const { priceRequest, Pricing, validTokens } = require('./pricing.cjs');
const { validWeeklyData, weeklyWindows } = require('./weekly-quota.cjs');

const DayMs = 24 * 60 * 60 * 1000;
const BeijingOffsetMs = 8 * 60 * 60 * 1000;
const RetentionDays = 30;
const CacheVersion = 4;

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
            && typeof entry.model === 'string' && entry.model.length <= 128
            && Array.isArray(entry.weeklyResets) && entry.weeklyResets.every(resetAt =>
                Number.isSafeInteger(resetAt) && resetAt > 0 && resetAt < 8.64e15 && resetAt % 1000 === 0);
    }
    return value && typeof value.sourceId === 'string' && validTokens(value.skippedRecords)
        && validTokens(value.oversizedRecords) && Array.isArray(value.modernThreads)
        && value.modernThreads.every(thread => typeof thread === 'string')
        && Array.isArray(value.modern) && value.modern.every(entry => event(entry) && usage(entry)
            && typeof entry.id === 'string' && typeof entry.thread === 'string' && typeof entry.weeklyConflict === 'boolean'
            && (entry.threadUsageKey === null || typeof entry.threadUsageKey === 'string'))
        && Array.isArray(value.legacy) && value.legacy.every(entry => event(entry) && usage(entry.total)
            && (entry.last === null || usage(entry.last)) && typeof entry.paired === 'boolean');
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

    async function sourceData(source, cutoff, generatedAt, coverage)
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
            && Number.isFinite(cached.cutoff) && cached.cutoff <= cutoff && validCachedData(cached.data)
            && validWeeklyData(cached.data, generatedAt))
        {
            memory.set(key, cached);
            coverage.cachedFiles++;
            return cached.data;
        }
        const parser = createLogParser({ sourceId: 'file-' + key, minTimestamp: cutoff, maxWeeklyTimestamp: generatedAt });
        const result = /\.zst$/i.test(source.filename)
            ? await reader.scan(source.filename, { onChunk: parser.onChunk })
            : await scanPlainRollout(source.filename, parser.onChunk, checkActive);
        checkActive();
        const data = parser.finish({ discardTail: result.prefix });
        coverage.parsedFiles++;
        if (result.prefix)
        {
            coverage.prefixFiles++;
            return data;
        }
        cached = { schemaVersion: CacheVersion, version: fingerprint(result.stat), cutoff, data };
        memory.set(key, cached);
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
            parsedFiles: 0, prefixFiles: 0, cachedFiles: 0, duplicateRequests: 0, conflictingRequests: 0,
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
                const parsed = await sourceData(source, cutoff, generatedAt, coverage);
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
        const { current, history, older, windows, byReset } = weeklyWindows(data, generatedAt, cutoff);
        const weeklyUsage = new Map();
        function summary()
        {
            return { requests: 0, usd: 0 };
        }
        for (const window of [current, ...history])
        {
            if (window) weeklyUsage.set(window, { rows: new Map(), afterFull: summary() });
        }
        const weeklyRemainder = { earlier: summary(), unassigned: summary() };
        function addRequest(row, price, estimated = false)
        {
            row.requests++;
            row.usd += price.usd;
            if ('unpricedRequests' in row && price.unpriced) row.unpricedRequests++;
            if ('estimatedRequests' in row && estimated) row.estimatedRequests++;
        }
        function includeWeekly(event, price, estimated)
        {
            const candidates = windows.filter(window => event.timestamp >= window.startAt && event.timestamp <= window.endAt);
            const evidence = new Set(event.weeklyResets.map(reset => byReset.get(reset)).filter(Boolean));
            const matched = evidence.size === 1 ? [...evidence][0] : null;
            const window = event.usageConflict ? null : matched && candidates.includes(matched) ? matched
                : !evidence.size && !event.weeklyConflict && candidates.length === 1 ? candidates[0] : null;
            const period = weeklyUsage.get(window);
            if (!period)
            {
                const remainder = older.has(window) ? weeklyRemainder.earlier : weeklyRemainder.unassigned;
                addRequest(remainder, price);
                if (!window)
                {
                    for (const candidate of candidates) candidate.partial = true;
                }
                return;
            }
            let row = period.rows.get(event.model);
            if (!row)
            {
                row = { model: event.model, requests: 0, usd: 0, estimatedRequests: 0, unpricedRequests: 0 };
                period.rows.set(event.model, row);
            }
            addRequest(row, price, estimated);
            if (window.fullAt !== null && event.timestamp > window.fullAt) addRequest(period.afterFull, price);
        }
        const rows = new Map();
        let unpricedRequests = 0;
        function include(event, legacy = false)
        {
            if (event.timestamp < cutoff || event.timestamp > generatedAt) return;
            const date = beijingDate(event.timestamp);
            const price = priceRequest(event);
            const estimated = legacy || price.estimated;
            const key = date + ':' + event.model;
            let row = rows.get(key);
            if (!row)
            {
                row = { date, model: event.model, requests: 0, inputTokens: 0, uncachedInputTokens: 0,
                    cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, usd: 0,
                    unpricedRequests: 0, estimatedRequests: 0 };
                rows.set(key, row);
            }
            addRequest(row, price, estimated);
            for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'])
            {
                row[field] += event[field];
            }
            row.uncachedInputTokens += price.uncachedInputTokens;
            if (price.unpriced) unpricedRequests++;
            if (legacy) coverage.legacyRequests++;
            includeWeekly(event, price, estimated);
        }
        const modernThreads = new Set(data.flatMap(source => source.modernThreads));
        const modernTotals = new Map();
        const responses = new Map();
        for (const source of data)
        {
            for (const event of source.modern)
            {
                if (event.timestamp > generatedAt) continue;
                if (event.threadUsageKey)
                {
                    const totals = modernTotals.get(event.thread) || new Set();
                    totals.add(event.threadUsageKey);
                    modernTotals.set(event.thread, totals);
                }
                if (responses.has(event.id))
                {
                    const previous = responses.get(event.id);
                    if (event.timestamp >= cutoff) coverage.duplicateRequests++;
                    // 分叉副本不能把已经发生的请求带入较新的自然日或周窗口。
                    previous.timestamp = Math.min(previous.timestamp, event.timestamp);
                    if (usageKey(previous) !== usageKey(event) || previous.model !== event.model
                        || previous.cacheWriteTokens > 0 && previous.cacheWriteTtl !== event.cacheWriteTtl)
                    {
                        previous.usageConflict = true;
                        if (event.timestamp >= cutoff) coverage.conflictingRequests++;
                        continue;
                    }
                    previous.weeklyResets.push(...event.weeklyResets);
                    previous.weeklyConflict ||= event.weeklyConflict;
                }
                else responses.set(event.id, { ...event, weeklyResets: [...event.weeklyResets] });
            }
        }
        for (const event of responses.values()) include(event);
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
                for (const event of source.legacy)
                {
                    if (event.timestamp < cutoff || event.timestamp > generatedAt) continue;
                    if (event.paired || totals.has(usageKey(event.total)))
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
                if (event.timestamp > generatedAt) break;
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
                const weeklyResets = event.last && usageKey(event.last) === usageKey(usage) ? event.weeklyResets : [];
                const candidate = { timestamp: event.timestamp, model: event.model, ...usage, weeklyResets };
                const existing = legacyCandidates.get(key);
                if (existing)
                {
                    coverage.duplicateRequests++;
                    // 分叉可能只复制累计流的尾部；保留已观察到的完整增量，禁止再叠加 last。
                    if (usage.inputTokens >= existing.inputTokens && usage.outputTokens >= existing.outputTokens)
                    {
                        if (usageKey(usage) === usageKey(existing)) candidate.weeklyResets = [...existing.weeklyResets, ...weeklyResets];
                        legacyCandidates.set(key, candidate);
                    }
                    continue;
                }
                legacyCandidates.set(key, candidate);
            }
        }
        for (const event of legacyCandidates.values()) include(event, true);
        if (coverage.failedFiles) coverage.warnings.push(`有 ${coverage.failedFiles} 个用量文件读取失败。`);
        if (coverage.prefixFiles) coverage.warnings.push(`有 ${coverage.prefixFiles} 个用量文件在扫描期间继续写入，已统计读取时完整的记录。`);
        if (coverage.discoveryErrors) coverage.warnings.push(`有 ${coverage.discoveryErrors} 处历史目录无法读取。`);
        if (coverage.skippedRecords) coverage.warnings.push(`跳过 ${coverage.skippedRecords} 条不完整记录，统计覆盖不全。`);
        if (coverage.oversizedRecords) coverage.warnings.push(`${coverage.oversizedRecords} 条记录超过 1 MiB 上限。`);
        if (coverage.conflictingRequests) coverage.warnings.push('重复响应的用量、缓存期限或模型不一致，金额采用首条记录。');
        if (coverage.legacySkippedRecords) coverage.warnings.push('旧版累计记录缺少对应逐请求记录，已保守排除。');
        if (coverage.legacyRequests) coverage.warnings.push(`${coverage.legacyRequests} 条旧版累计增量为估算，请求数、日期和金额可能不完整。`);
        if (legacyBaselineGaps) coverage.warnings.push('旧版累计前缀缺少单次用量，仅用作基线。');
        if (legacyReplayGaps) coverage.warnings.push('旧版累计值回退，已排除重放或重置记录。');
        if (unpricedRequests) coverage.warnings.push(`${unpricedRequests} 次请求有未定价部分；美元仅含可定价用量。`);
        if (coverage.cacheErrors) coverage.warnings.push('用量缓存写入失败，仍显示已读取的统计。');
        const result = [...rows.values()].sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model));
        for (const row of result) row.usd = Number(row.usd.toFixed(12));
        function weeklyReport(window)
        {
            if (!window) return null;
            const period = weeklyUsage.get(window);
            const rows = [...period.rows.values()].sort((a, b) => a.model.localeCompare(b.model));
            for (const row of rows) row.usd = Number(row.usd.toFixed(12));
            period.afterFull.usd = Number(period.afterFull.usd.toFixed(12));
            return { ...window, afterFull: period.afterFull, rows };
        }
        for (const row of Object.values(weeklyRemainder)) row.usd = Number(row.usd.toFixed(12));
        progress('complete', coverage, processedFiles);
        return { generatedAt, timezone: 'Asia/Shanghai', from, to, rows: result, weekly: weeklyReport(current),
            weeklyHistory: history.map(weeklyReport), weeklyRemainder, coverage, pricing: { ...Pricing } };
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
