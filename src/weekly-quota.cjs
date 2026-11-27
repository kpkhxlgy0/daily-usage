'use strict';

const WeekMinutes = 7 * 24 * 60;
const WeekMs = WeekMinutes * 60 * 1000;
const ResetJitterMs = 5 * 1000;
const ResetObservationGraceMs = 60 * 1000;
const HistoryLimit = 3;

function validTimestamp(value)
{
    return Number.isSafeInteger(value) && value > 0 && value < 8.64e15;
}

function validPercent(value)
{
    return Number.isFinite(value) && value >= 0 && value <= 100;
}

function inCycle(timestamp, resetAt)
{
    return validTimestamp(timestamp) && timestamp >= resetAt - WeekMs - ResetJitterMs && timestamp < resetAt;
}

function laterReading(sampleAt, usedPercent, reading)
{
    return !reading || sampleAt > reading.sampleAt || sampleAt === reading.sampleAt && usedPercent > reading.usedPercent;
}

function weeklyReadings(limits, sampleAt)
{
    if (!limits || (limits.limit_id != null && limits.limit_id !== 'codex')) return [];
    const readings = [];
    for (const window of [limits.primary, limits.secondary])
    {
        if (window?.window_minutes !== WeekMinutes || !Number.isSafeInteger(window.resets_at)
            || !validPercent(window.used_percent)) continue;
        const resetAt = window.resets_at * 1000;
        if (validTimestamp(resetAt) && inCycle(sampleAt, resetAt))
            readings.push({ resetAt, usedPercent: window.used_percent });
    }
    return readings;
}

function sameCycle(first, second)
{
    return Math.abs(first - second) <= ResetObservationGraceMs;
}

function createWeeklyObservations(minTimestamp, maxTimestamp)
{
    const byReset = new Map();
    let nextWeeklyAt = null;
    return {
        observe(readings, sampleAt)
        {
            for (const { resetAt, usedPercent } of readings)
            {
                if (resetAt <= minTimestamp) continue;
                if (sampleAt > maxTimestamp)
                {
                    if (nextWeeklyAt === null || sampleAt < nextWeeklyAt) nextWeeklyAt = sampleAt;
                    continue;
                }
                let sample = byReset.get(resetAt);
                if (!sample)
                {
                    sample = { resetAt, firstAt: sampleAt, sampleAt, usedPercent, zeroAt: null, fullAt: null };
                    byReset.set(resetAt, sample);
                }
                sample.firstAt = Math.min(sample.firstAt, sampleAt);
                if (laterReading(sampleAt, usedPercent, sample))
                {
                    sample.sampleAt = sampleAt;
                    sample.usedPercent = usedPercent;
                }
                if (sampleAt < resetAt - ResetObservationGraceMs && laterReading(sampleAt, usedPercent, sample.beforeJitter))
                {
                    sample.beforeJitter = { sampleAt, usedPercent };
                }
                if (usedPercent === 0 && (sample.zeroAt === null || sampleAt < sample.zeroAt)) sample.zeroAt = sampleAt;
                if (usedPercent === 100 && (sample.fullAt === null || sampleAt < sample.fullAt)) sample.fullAt = sampleAt;
            }
        },
        finish()
        {
            return { weeklySamples: [...byReset.values()], nextWeeklyAt };
        },
    };
}

function validBeforeJitter(sample)
{
    const boundary = sample.resetAt - ResetObservationGraceMs;
    const reading = sample.beforeJitter;
    // 只有可能丢失较早读数的旧缓存需要重读。
    if (reading === undefined) return sample.sampleAt < boundary || sample.firstAt >= boundary;
    return reading && inCycle(reading.sampleAt, sample.resetAt) && reading.sampleAt < boundary
        && reading.sampleAt >= sample.firstAt && reading.sampleAt <= sample.sampleAt && validPercent(reading.usedPercent)
        && (reading.usedPercent !== 0 || sample.zeroAt !== null && sample.zeroAt <= reading.sampleAt)
        && (reading.usedPercent !== 100 || sample.fullAt !== null && sample.fullAt <= reading.sampleAt);
}

function validWeeklyData({ weeklySamples, nextWeeklyAt }, generatedAt)
{
    return (nextWeeklyAt === null || (validTimestamp(nextWeeklyAt) && nextWeeklyAt > generatedAt))
        && Array.isArray(weeklySamples) && weeklySamples.every(sample => sample
            && validTimestamp(sample.resetAt) && sample.resetAt % 1000 === 0
            && inCycle(sample.firstAt, sample.resetAt) && sample.firstAt <= sample.sampleAt
            && inCycle(sample.sampleAt, sample.resetAt) && sample.sampleAt <= generatedAt
            && validPercent(sample.usedPercent) && validBeforeJitter(sample)
            && (sample.zeroAt === null ? sample.usedPercent !== 0
                : inCycle(sample.zeroAt, sample.resetAt) && sample.zeroAt >= sample.firstAt
                    && sample.zeroAt <= sample.sampleAt)
            && (sample.fullAt === null ? sample.usedPercent !== 100
                : inCycle(sample.fullAt, sample.resetAt) && sample.fullAt >= sample.firstAt
                    && sample.fullAt <= sample.sampleAt));
}

function latestObservation(samples)
{
    let latest;
    for (const sample of samples)
    {
        if (!latest || sample.sampleAt > latest.sampleAt
            || (sample.sampleAt === latest.sampleAt && sample.resetAt > latest.resetAt)) latest = sample;
    }
    return latest;
}

function summarizeWindow(samples, resetAt, priorResetAt, generatedAt, cutoff)
{
    const latest = latestObservation(samples);
    let firstAt = Infinity;
    let zeroAt = Infinity;
    let fullAt = Infinity;
    for (const sample of samples)
    {
        firstAt = Math.min(firstAt, sample.firstAt);
        if (sample.zeroAt !== null) zeroAt = Math.min(zeroAt, sample.zeroAt);
        if (sample.fullAt !== null) fullAt = Math.min(fullAt, sample.fullAt);
    }
    let startAt = resetAt - WeekMs;
    let startKind = 'inferred';
    // 归零样本可能迟到，不能覆盖已经推算或观察到的较早起点。
    if (priorResetAt !== undefined)
    {
        startAt = priorResetAt;
        startKind = 'reset';
    }
    if (firstAt < startAt || firstAt === startAt && zeroAt === firstAt)
    {
        startAt = firstAt;
        startKind = zeroAt === firstAt ? 'reset' : 'observed';
    }
    return { startAt, resetAt, endAt: Math.min(resetAt - 1, generatedAt), startKind,
        fullAt: Number.isFinite(fullAt) ? fullAt : null, sampleAt: latest?.sampleAt ?? null,
        usedPercent: latest?.usedPercent ?? null, partial: startAt < cutoff };
}

function observationBeforeReset(sample, resetAt)
{
    if (sample.sampleAt < resetAt) return sample;
    // 同轮重置时间有抖动时，只保留能确认在最早边界之前的读数。
    const fullAt = sample.fullAt !== null && sample.fullAt < resetAt ? sample.fullAt : null;
    const zeroAt = sample.zeroAt !== null && sample.zeroAt < resetAt ? sample.zeroAt : null;
    const sampleAt = Math.max(fullAt ?? 0, zeroAt ?? 0, sample.beforeJitter?.sampleAt ?? 0);
    if (!sampleAt) return null;
    const usedPercent = sampleAt === fullAt ? 100 : sampleAt === zeroAt ? 0 : sample.beforeJitter.usedPercent;
    return { ...sample, sampleAt, fullAt, zeroAt, usedPercent };
}

function weeklyWindows(sources, generatedAt, cutoff)
{
    const rawResets = new Map();
    const sourceOf = new Map();
    for (const source of sources)
    {
        for (const sample of source.weeklySamples)
        {
            if (sample.resetAt <= cutoff) continue;
            const readings = rawResets.get(sample.resetAt) || [];
            readings.push(sample);
            rawResets.set(sample.resetAt, readings);
            sourceOf.set(sample, source);
        }
    }
    const latest = latestObservation(sourceOf.keys());
    const groups = [];
    function continuous(first, second)
    {
        if (sourceOf.get(first) !== sourceOf.get(second)) return false;
        if (first.sampleAt === second.sampleAt) return first.usedPercent === second.usedPercent;
        return first.sampleAt < second.sampleAt ? first.usedPercent <= second.usedPercent : second.usedPercent <= first.usedPercent;
    }
    for (const [resetAt, readings] of [...rawResets].sort(([first], [second]) => second - first))
    {
        let group = groups.at(-1);
        // 五秒以上的差距只在同一日志中存在连续百分比读数时合并。
        if (!group || !sameCycle(group[0].resetAt, resetAt) || (group[0].resetAt - resetAt > ResetJitterMs
            && !readings.some(reading => group.some(sample => continuous(sample, reading)))))
        {
            group = [];
            groups.push(group);
        }
        group.push(...readings);
    }

    const windows = [];
    const byReset = new Map();
    let current = null;
    const distinctResets = groups.map(group => group.at(-1).resetAt);
    for (const group of groups)
    {
        const resetAt = group.at(-1).resetAt;
        const observed = group.map(sample => observationBeforeReset(sample, resetAt)).filter(Boolean);
        const inferredStart = resetAt - WeekMs;
        const priorResetAt = distinctResets.find(reset => inferredStart - ResetJitterMs <= reset && reset <= inferredStart);
        const window = summarizeWindow(observed, resetAt, priorResetAt, generatedAt, cutoff);
        if (!observed.length) window.partial = true;
        windows.push(window);
        for (const sample of group) byReset.set(sample.resetAt, window);
        if (resetAt > generatedAt && group.includes(latest)) current = window;
    }
    // 切换账号后另一轮配额仍可能开放，历史列按独立周期的重置时间保留它。
    const otherWindows = windows.filter(window => window !== current);
    const history = otherWindows.slice(0, HistoryLimit);
    const older = new Set(otherWindows.slice(HistoryLimit).filter(window => window.resetAt <= generatedAt));
    return { current, history, older, windows, byReset };
}

module.exports = { createWeeklyObservations, sameCycle, validWeeklyData, weeklyReadings, weeklyWindows };
