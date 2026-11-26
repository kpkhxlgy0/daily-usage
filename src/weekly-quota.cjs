'use strict';

const WeekMinutes = 7 * 24 * 60;
const WeekMs = WeekMinutes * 60 * 1000;
const ResetJitterMs = 5 * 1000;
const ResetObservationGraceMs = 60 * 1000;

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
    return validTimestamp(timestamp) && timestamp >= resetAt - WeekMs - ResetJitterMs && timestamp <= resetAt;
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
                if (sampleAt > sample.sampleAt || (sampleAt === sample.sampleAt && usedPercent > sample.usedPercent))
                {
                    sample.sampleAt = sampleAt;
                    sample.usedPercent = usedPercent;
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

function validWeeklyData({ weeklySamples, nextWeeklyAt }, generatedAt)
{
    return (nextWeeklyAt === null || (validTimestamp(nextWeeklyAt) && nextWeeklyAt > generatedAt))
        && Array.isArray(weeklySamples) && weeklySamples.every(sample => sample
            && validTimestamp(sample.resetAt) && sample.resetAt % 1000 === 0
            && inCycle(sample.firstAt, sample.resetAt) && sample.firstAt <= sample.sampleAt
            && inCycle(sample.sampleAt, sample.resetAt) && sample.sampleAt <= generatedAt
            && validPercent(sample.usedPercent)
            && (sample.zeroAt === null ? sample.usedPercent !== 0
                : inCycle(sample.zeroAt, sample.resetAt) && sample.zeroAt >= sample.firstAt
                    && sample.zeroAt <= sample.sampleAt)
            && (sample.fullAt === null ? sample.usedPercent !== 100
                : inCycle(sample.fullAt, sample.resetAt) && sample.fullAt >= sample.firstAt
                    && sample.fullAt <= sample.sampleAt));
}

function weeklyWindow(sources, generatedAt)
{
    const samples = sources.flatMap(source => source.weeklySamples);
    let latest;
    for (const sample of samples)
    {
        if (!latest || sample.sampleAt > latest.sampleAt
            || (sample.sampleAt === latest.sampleAt && sample.resetAt > latest.resetAt)) latest = sample;
    }
    if (!latest) return null;

    // 同一个周窗口的重置秒数可能随日志略有抖动。
    let firstAt = Infinity;
    let zeroAt = Infinity;
    let fullAt = Infinity;
    let earliestResetAt = latest.resetAt;
    let latestResetAt = latest.resetAt;
    for (const sample of samples)
    {
        if (Math.abs(sample.resetAt - latest.resetAt) > ResetJitterMs) continue;
        earliestResetAt = Math.min(earliestResetAt, sample.resetAt);
        latestResetAt = Math.max(latestResetAt, sample.resetAt);
        firstAt = Math.min(firstAt, sample.firstAt);
        if (sample.zeroAt !== null) zeroAt = Math.min(zeroAt, sample.zeroAt);
        if (sample.fullAt !== null) fullAt = Math.min(fullAt, sample.fullAt);
    }
    if (latestResetAt <= generatedAt) return null;
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
    return { startAt, startKind,
        fullAt: Number.isFinite(fullAt) ? fullAt : null,
        usedPercent: Number.isFinite(fullAt) ? 100 : latest.usedPercent, sampleAt: latest.sampleAt };
}

module.exports = { createWeeklyObservations, validWeeklyData, weeklyWindow };
