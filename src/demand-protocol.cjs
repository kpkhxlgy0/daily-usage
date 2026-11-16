"use strict";

const path = require("node:path");
const { normalizeThreadId, validateSnapshot, MaxSnapshotBytes, FutureSkewMs } = require("./protocol.cjs");
const MaxDemandBytes = 2048;
const MaxResultBytes = MaxSnapshotBytes + 4096;
const MaxDemandMs = 300000;
const Source = "com.kpk.daily-usage";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const invalid = reason => ({ ok: false, reason });
const fields = (value, keys) => record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
const version = value => value.schemaVersion === 1 && value.source === Source && value.demandVersion === 1;
const bounded = (value, limit) => {
    try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= limit; }
    catch { return false; }
};

function demandPaths(codexHome, pathApi = path) {
    if (typeof codexHome !== "string" || !pathApi.isAbsolute(codexHome)) throw new TypeError("Invalid CODEX_HOME");
    const directory = pathApi.join(codexHome, ".daily-usage");
    return { directory, requests: pathApi.join(directory, "requests"), responses: pathApi.join(directory, "responses"),
        capabilities: pathApi.join(directory, "capabilities.json") };
}

function makeMarker(requestId, now, action = "query", baseMarker) {
    const id = normalizeThreadId(requestId);
    if (!id || !integer(now) || !["query", "cancel"].includes(action)) throw new TypeError("Invalid demand marker");
    if (action === "cancel") {
        if (!record(baseMarker) || baseMarker.requestId !== id || baseMarker.action !== "query"
            || !validateMarker(baseMarker, { now: baseMarker.requestedAt }).ok) {
            throw new TypeError("Cancellation requires its original query marker");
        }
        return { ...baseMarker, action, sequence: 2 };
    }
    return { schemaVersion: 1, source: Source, demandVersion: 1, requestId: id, action, sequence: 1,
        requestedAt: now, expiresAt: now + MaxDemandMs };
}

function validateMarker(value, { now = Date.now() } = {}) {
    if (!integer(now) || !fields(value, ["schemaVersion", "source", "demandVersion", "requestId", "action",
        "sequence", "requestedAt", "expiresAt"]) || !version(value) || !normalizeThreadId(value.requestId)
        || !(value.action === "query" && value.sequence === 1 || value.action === "cancel" && value.sequence === 2)
        || !integer(value.requestedAt) || !integer(value.expiresAt) || value.expiresAt <= value.requestedAt
        || value.expiresAt - value.requestedAt > MaxDemandMs || value.requestedAt - now > FutureSkewMs
        || value.expiresAt <= now || !bounded(value, MaxDemandBytes)) return invalid("invalid");
    return { ok: true };
}

function validateCapabilities(value) {
    return fields(value, ["schemaVersion", "source", "demandVersion", "publisherId"]) && version(value)
        && normalizeThreadId(value.publisherId) && bounded(value, MaxDemandBytes) ? { ok: true } : invalid("invalid");
}

function validateResult(value, { requestId, publisherId, now = Date.now() } = {}) {
    const keys = ["schemaVersion", "source", "demandVersion", "requestId", "publisherId", "updatedAt", "status"];
    if (value?.status === "ok") keys.push("snapshot");
    if (value?.status === "error") keys.push("error");
    if (!integer(now) || !fields(value, keys) || !version(value) || !normalizeThreadId(requestId)
        || !normalizeThreadId(publisherId) || value.requestId !== requestId || value.publisherId !== publisherId
        || !integer(value.updatedAt) || !["running", "ok", "error", "cancelled"].includes(value.status)
        || !bounded(value, MaxResultBytes)) return invalid("invalid");
    if (value.updatedAt - now > FutureSkewMs) return invalid("future");
    if (value.status === "error" && (typeof value.error !== "string"
        || !/^[a-z][a-z0-9-]{0,63}$/.test(value.error))) return invalid("invalid");
    if (value.status === "ok") {
        const checked = validateSnapshot(value.snapshot, { now });
        if (!checked.ok) return checked;
        if (value.snapshot.publisherId !== publisherId) return invalid("identity");
    }
    return { ok: true };
}

module.exports = { demandPaths, makeMarker, validateMarker, validateCapabilities, validateResult,
    MaxDemandBytes, MaxResultBytes, MaxDemandMs };
