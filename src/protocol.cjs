"use strict";

const path = require("node:path");

const MaxSnapshotBytes = 2 * 1024 * 1024;
const StaleAfterMs = 3 * 60 * 1000;
const FutureSkewMs = 5000;
const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RootKeys = ["schemaVersion", "source", "machineId", "publisherId", "revision", "generatedAt", "timezone",
    "from", "to", "rows", "coverage", "pricing"];
const RowCounts = ["requests", "inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteTokens",
    "outputTokens", "unpricedRequests", "estimatedRequests"];
const RowKeys = ["date", "model", ...RowCounts, "usd"];
const CoverageCounts = ["files", "failedFiles", "skippedRecords", "legacyRequests"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
const concise = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

function normalizeThreadId(value) {
    return typeof value === "string" && value.length === 36 && Uuid.test(value) ? value.toLowerCase() : null;
}

function validHostId(value) {
    return concise(value, 512) && value.toLowerCase() !== "local";
}

function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateSnapshot(value, options = {}) {
    const invalid = reason => ({ ok: false, reason });
    if (!record(options)) return invalid("invalid");
    const { now = Date.now() } = options;
    if (!integer(now) || !exactKeys(value, RootKeys) || value.schemaVersion !== 1
        || value.source !== "com.kpk.daily-usage" || !normalizeThreadId(value.machineId)
        || !normalizeThreadId(value.publisherId) || !integer(value.revision) || value.revision === 0
        || !integer(value.generatedAt) || value.timezone !== "Asia/Shanghai"
        || !validDate(value.from) || !validDate(value.to) || value.from > value.to
        || !Array.isArray(value.rows) || value.rows.length > 10000) return invalid("invalid");
    if (value.generatedAt - now > FutureSkewMs) return invalid("future");
    const identities = new Set();
    for (const row of value.rows) {
        if (!exactKeys(row, RowKeys) || !validDate(row.date) || row.date < value.from || row.date > value.to
            || !concise(row.model, 256) || RowCounts.some(key => !integer(row[key]))
            || typeof row.usd !== "number" || !Number.isFinite(row.usd) || row.usd < 0
            || row.inputTokens !== row.uncachedInputTokens + row.cachedInputTokens + row.cacheWriteTokens
            || row.unpricedRequests > row.requests || row.estimatedRequests > row.requests) return invalid("invalid");
        const key = JSON.stringify([row.date, row.model]);
        if (identities.has(key)) return invalid("invalid");
        identities.add(key);
    }
    const coverage = value.coverage;
    if (!record(coverage) || CoverageCounts.some(key => !integer(coverage[key]))
        || !Array.isArray(coverage.warnings) || coverage.warnings.length > 100
        || coverage.warnings.some(value => !concise(value, 512))
        || Object.keys(coverage).some(key => key !== "warnings"
            && (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) || !integer(coverage[key])))) return invalid("invalid");
    if (!exactKeys(value.pricing, ["basis", "asOf", "source"]) || value.pricing.basis !== "standard"
        || value.pricing.asOf !== "2026-11-16" || !concise(value.pricing.source, 512)) return invalid("invalid");
    try {
        if (Buffer.byteLength(JSON.stringify(value), "utf8") > MaxSnapshotBytes) return invalid("size");
    } catch { return invalid("invalid"); }
    return { ok: true };
}

function safePath(value) {
    if (typeof value !== "string" || !value || value.length > 32768
        || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    const pathApi = /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix;
    const windows = pathApi.sep === "\\";
    if (!pathApi.isAbsolute(value) || !windows && value.includes("\\")) return null;
    let parts = value.split(/[\\/]/).filter(Boolean);
    if (windows) {
        if (value.startsWith("\\\\?\\")) {
            if (value.includes("/") || !/^\\\\\?\\(?:[a-z]:\\|UNC\\[^\\]+\\[^\\]+(?:\\|$))/i.test(value)) return null;
            parts = parts.slice(1);
        } else if (!/^[a-z]:[\\/]/i.test(value) && !/^\\\\[^\\/?]+\\[^\\/?]+(?:\\|$)/.test(value)) return null;
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            if (index === 0 && /^[a-z]:$/i.test(part)) continue;
            if (/[. ]$|[<>:"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return null;
        }
    }
    if (parts.some(part => part === "." || part === "..")) return null;
    return { pathApi, filename: pathApi.normalize(value) };
}

function snapshotContext(rolloutPath, threadId) {
    const id = normalizeThreadId(threadId);
    const context = safePath(rolloutPath);
    if (!id || !context) return null;
    const { pathApi, filename } = context;
    const match = /^rollout-(.+?)-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl(?:\.zst)?$/i
        .exec(pathApi.basename(filename));
    if (!match || normalizeThreadId(match[2]) !== id || match[3] && !normalizeThreadId(match[3])) return null;
    let directory = pathApi.dirname(filename);
    while (directory !== pathApi.dirname(directory)) {
        const name = pathApi.basename(directory);
        if ((pathApi.sep === "\\" ? /^(sessions|archived_sessions)$/i : /^(sessions|archived_sessions)$/).test(name)) {
            const codexHome = pathApi.dirname(directory);
            const destination = pathApi.join(codexHome, ".daily-usage");
            return { codexHome, directory: destination, file: pathApi.join(destination, "summary.json"), pathApi };
        }
        directory = pathApi.dirname(directory);
    }
    return null;
}

module.exports = { validateSnapshot, snapshotContext, normalizeThreadId, validHostId, safePath,
    MaxSnapshotBytes, StaleAfterMs, FutureSkewMs };
