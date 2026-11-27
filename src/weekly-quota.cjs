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

function createWeeklyObservations(minTimestamp, maxTimestamp)
{
    const byReset = new Map();
    let nextWeeklyAt = null;
    return {
        observe(limits, sampleAt)
        {
            if (!limits || (limits.limit_id != null && limits.limit_id !== 'codex') || sampleAt < minTimestamp) return;
            for (const window of [limits.primary, limits.secondary])
            {
                if (window?.window_minutes !== WeekMinutes || !Number.isSafeInteger(window.resets_at)
                    || !validPercent(window.used_percent)) continue;
                const resetAt = window.resets_at * 1000;
                if (!validTimestamp(resetAt) || !inCycle(sampleAt, resetAt)) continue;
                if (sampleAt > maxTimestamp)
                {
                    if (nextWeeklyAt === null || sampleAt < nextWeeklyAt) nextWeeklyAt = sampleAt;
                    continue;
                }
                const usedPercent = window.used_percent;
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

function summarizeWindow(samples, latest = latestObservation(samples))
{
    let firstAt = Infinity;
    let zeroAt = Infinity;
    let fullAt = Infinity;
    let earliestResetAt = latest.resetAt;
    for (const sample of samples)
    {
        earliestResetAt = Math.min(earliestResetAt, sample.resetAt);
        firstAt = Math.min(firstAt, sample.firstAt);
        if (sample.zeroAt !== null) zeroAt = Math.min(zeroAt, sample.zeroAt);
        if (sample.fullAt !== null) fullAt = Math.min(fullAt, sample.fullAt);
    }
    let startAt = earliestResetAt - WeekMs;
    let startKind = 'inferred';
    // 重置后短时间内的归零可确认边界，较迟的首条归零仍使用重置时间推算。
    if (zeroAt === firstAt && zeroAt <= startAt + ResetObservationGraceMs)
    {
        startAt = zeroAt;
        startKind = 'reset';
    }
    else if (firstAt < startAt)
    {
        startAt = firstAt;
        startKind = 'observed';
    }
    const window = { startAt, startKind, fullAt: Number.isFinite(fullAt) ? fullAt : null,
        usedPercent: Number.isFinite(fullAt) ? 100 : latest.usedPercent, sampleAt: latest.sampleAt };
    return { window, firstAt, initialStartAt: startAt, earliestResetAt };
}

function observationBeforeReset(sample, resetAt, cutoff)
{
    if (sample.sampleAt < resetAt) return sample;
    // 同轮重置时间有抖动时，只保留能确认在最早边界之前的读数。
    const fullAt = sample.fullAt !== null && sample.fullAt < resetAt ? sample.fullAt : null;
    const zeroAt = sample.zeroAt !== null && sample.zeroAt < resetAt ? sample.zeroAt : null;
    const sampleAt = Math.max(fullAt ?? 0, zeroAt ?? 0, sample.beforeJitter?.sampleAt ?? 0);
    if (!sampleAt || sampleAt < cutoff) return null;
    const usedPercent = sampleAt === fullAt ? 100 : sampleAt === zeroAt ? 0 : sample.beforeJitter.usedPercent;
    return { ...sample, sampleAt, fullAt, zeroAt, usedPercent };
}

function fullWeeksBetween(newerResetAt, olderResetAt)
{
    return Math.floor((newerResetAt - olderResetAt + ResetObservationGraceMs) / WeekMs);
}

function historicalWindows(samples, current, generatedAt, cutoff)
{
    const groups = [];
    for (const sample of samples.sort((a, b) => b.resetAt - a.resetAt))
    {
        let group = groups.at(-1);
        if (!group || group[0].resetAt - sample.resetAt > ResetObservationGraceMs)
        {
            group = [];
            groups.push(group);
        }
        group.push(sample);
    }

    const candidates = [];
    for (const group of groups)
    {
        if (group[0].resetAt > generatedAt) continue;
        const earliestResetAt = group.at(-1).resetAt;
        const observed = group.map(sample => observationBeforeReset(sample, earliestResetAt, cutoff)).filter(Boolean);
        if (observed.length) candidates.push({ ...summarizeWindow(observed), earliestResetAt });
    }
    candidates.sort((a, b) => b.window.sampleAt - a.window.sampleAt || b.earliestResetAt - a.earliestResetAt);
    const history = [];
    const disputedResets = [];
    let newer = current;
    for (const candidate of candidates)
    {
        const { window, earliestResetAt } = candidate;
        if (newer && earliestResetAt >= newer.earliestResetAt - ResetObservationGraceMs) continue;

        const nextStart = newer?.initialStartAt ?? generatedAt + 1;
        const overlap = earliestResetAt - nextStart > ResetObservationGraceMs;
        if (overlap)
        {
            if (newer !== current) newer.window.partial = true;
            if (newer.window.startKind === 'inferred')
            {
                newer.window.startAt = window.sampleAt < newer.firstAt ? newer.firstAt
                    : newer.window.fullAt ?? newer.window.sampleAt;
                newer.window.startKind = 'observed';
            }
        }

        // 两个周期的采样无法放进互斥窗口时，较早的窗口没有可信结束时间。
        if (window.sampleAt >= nextStart)
        {
            if (overlap) disputedResets.push(earliestResetAt);
            continue;
        }
        if (history.length === HistoryLimit) break;
        let endAt = Math.min(earliestResetAt, nextStart) - 1;
        if (overlap && newer?.window.startKind !== 'reset') endAt = window.sampleAt;

        let missing = newer
            ? Math.max(0, fullWeeksBetween(newer.earliestResetAt, earliestResetAt) - 1)
            : Math.floor((generatedAt - earliestResetAt) / WeekMs);
        // 若争议重置与更早的可信重置相隔至少一轮，保留其位置。接近的备选重置不占额外列。
        for (const resetAt of disputedResets)
        {
            const distance = fullWeeksBetween(resetAt, earliestResetAt);
            if (distance <= 0) continue;
            const preceding = Math.max(0, fullWeeksBetween(newer.earliestResetAt, resetAt) - 1);
            missing = Math.max(missing, distance + preceding);
        }
        for (let offset = 0; offset < missing && history.length < HistoryLimit; offset++) history.push(null);
        if (history.length === HistoryLimit) break;

        const period = { ...window, endAt, partial: window.startAt < cutoff || overlap };
        history.push(period);
        newer = { ...candidate, window: period };
        disputedResets.length = 0;
    }
    return history;
}

function weeklyWindows(sources, generatedAt, cutoff)
{
    const samples = sources.flatMap(source => source.weeklySamples)
        .filter(sample => sample.sampleAt >= cutoff);
    const latest = latestObservation(samples);
    if (!latest) return { current: null, history: [] };

    // 秒级的重置抖动可以共用起点和用满样本。是否仍为当前周期沿用原来的较窄容差。
    const sameCycle = sample => Math.abs(sample.resetAt - latest.resetAt) <= ResetObservationGraceMs;
    const current = samples.some(sample => sample.resetAt > generatedAt
        && Math.abs(sample.resetAt - latest.resetAt) <= ResetJitterMs)
        ? summarizeWindow(samples.filter(sameCycle), latest) : null;
    const historical = current ? samples.filter(sample => !sameCycle(sample)) : samples;
    return { current: current?.window ?? null, history: historicalWindows(historical, current, generatedAt, cutoff) };
}

module.exports = { createWeeklyObservations, validWeeklyData, weeklyWindows };
