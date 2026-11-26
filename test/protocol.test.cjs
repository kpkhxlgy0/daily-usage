"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Pricing } = require("../src/pricing.cjs");
const { validateSnapshot, snapshotContext, MaxSnapshotBytes } = require("../src/protocol.cjs");

const ThreadId = "11111111-1111-4111-8111-111111111111";
const Now = Date.parse("2026-11-16T00:00:00Z");

function snapshot(overrides = {}) {
    return { schemaVersion: 1, source: "com.kpk.daily-usage",
        machineId: "22222222-2222-4222-8222-222222222222",
        publisherId: "33333333-3333-4333-8333-333333333333", revision: 1, generatedAt: Now,
        timezone: "Asia/Shanghai", from: "2026-10-18", to: "2026-11-16",
        rows: [{ date: "2026-11-16", model: "gpt-5.1", requests: 2, inputTokens: 100,
            uncachedInputTokens: 70, cachedInputTokens: 20, cacheWriteTokens: 10, outputTokens: 30,
            usd: 0.001, unpricedRequests: 1, estimatedRequests: 0 }],
        coverage: { files: 2, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { ...Pricing, source: "https://openai.com/api/pricing/" },
        ...overrides };
}

test("accepts the shared snapshot contract without mutating it", () => {
    const value = snapshot();
    const before = JSON.stringify(value);
    assert.deepEqual(validateSnapshot(value, { now: Now }), { ok: true });
    assert.equal(JSON.stringify(value), before);
    assert.equal(MaxSnapshotBytes, 2 * 1024 * 1024);
    assert.deepEqual(validateSnapshot(snapshot({ rows: [] }), { now: Now }), { ok: true });
});

test("downgrades only a legacy viewer's wire snapshot and preserves the local weekly report", () => {
    const { snapshotForPeer } = require("../src/protocol.cjs");
    const daily = snapshot();
    const modern = { ...daily, schemaVersion: 2, weekly: null };
    assert.deepEqual(snapshotForPeer(modern), daily);
    assert.equal(snapshotForPeer(modern, 2), modern);
    assert.equal(snapshotForPeer(daily, 2), daily);
    assert.equal(modern.schemaVersion, 2);
    assert.equal(modern.weekly, null);
});

test("weekly snapshots carry only bounded per-model amounts and a consistent observed cutoff", () => {
    const row = { model: "example", requests: 2, baseUsd: 1, usd: 1.5, unpricedRequests: 0, estimatedRequests: 1 };
    const weekly = { startAt: Now - 86400000, startKind: "reset", usedPercent: 45.5,
        sampleAt: Now - 1000, fullAt: null, rows: [row] };
    const check = value => validateSnapshot(snapshot({ schemaVersion: 2, weekly: value }), { now: Now }).ok;
    assert.equal(check(weekly), true);
    assert.equal(check(null), true);
    assert.equal(check({ ...weekly, startKind: "observed", rows: [] }), true);
    const missingPrice = { ...row, baseUsd: 0.2, usd: 0, requests: 1, unpricedRequests: 1 };
    assert.equal(check({ ...weekly, rows: [missingPrice] }), true);
    assert.equal(check({ ...weekly, rows: [{ ...missingPrice, unpricedRequests: 0 }] }), false);
    assert.equal(check({ ...weekly, startKind: "inferred", fullAt: Now - 1500, usedPercent: 100 }), true);
    assert.equal(validateSnapshot(snapshot({ weekly }), { now: Now }).ok, false);
    for (const patch of [{ startKind: "rolling" }, { startAt: Now }, { sampleAt: Now + 1 },
        { usedPercent: 101 }, { usedPercent: 100 }, { fullAt: Now - 2000 }, { rows: [row, row] },
        { usedPercent: 100, fullAt: Now }, { rows: [{ ...row, usd: -1 }] },
        { rows: [{ ...row, unpricedRequests: 3 }] }, { rows: [{ ...row, session: "private" }] },
        { rows: [{ ...row, model: "<img>" }] }, { org: "private" }]) {
        assert.equal(check({ ...weekly, ...patch }), false, JSON.stringify(patch));
    }
});

test("stale snapshots remain valid while untrusted future snapshots are rejected", () => {
    assert.equal(validateSnapshot(snapshot({ generatedAt: Now - 3600000 }), { now: Now }).ok, true);
    assert.equal(validateSnapshot(snapshot({ generatedAt: Now + 5000 }), { now: Now }).ok, true);
    assert.deepEqual(validateSnapshot(snapshot({ generatedAt: Now + 5001 }), { now: Now }),
        { ok: false, reason: "future" });
});

test("known prior pricing snapshots require an update only after structure and size validation", () => {
    for (const basis of ["standard", "standard-base-api", "codex-base-estimate"]) {
        const legacy = snapshot({ pricing: { ...snapshot().pricing, basis, asOf: "2026-11-16" } });
        assert.deepEqual(validateSnapshot(legacy, { now: Now }), { ok: false, reason: "update-required" });
        assert.deepEqual(validateSnapshot(snapshot({ pricing: { ...legacy.pricing, basis: "subscription" } }),
            { now: Now }), { ok: false, reason: "invalid" });
        assert.deepEqual(validateSnapshot(snapshot({ pricing: { ...legacy.pricing, asOf: "2026-11-15" } }),
            { now: Now }), { ok: false, reason: "invalid" });
        assert.deepEqual(validateSnapshot({ ...legacy, rows: [{ ...legacy.rows[0], inputTokens: 101 }] },
            { now: Now }), { ok: false, reason: "invalid" });
        const rows = Array.from({ length: 8000 }, (_, index) => ({ ...legacy.rows[0],
            model: "x".repeat(240) + index }));
        assert.deepEqual(validateSnapshot({ ...legacy, rows }, { now: Now }), { ok: false, reason: "size" });
    }
});

test("rejects unknown schemas, identities, unsafe counters, and payload fields", () => {
    for (const change of [{ schemaVersion: 2 }, { source: "codex-session-stats" }, { machineId: "machine" },
        { publisherId: `${snapshot().publisherId}\n` }, { revision: 0 }, { revision: 1.2 },
        { generatedAt: NaN }, { timezone: "UTC" }, { from: "2026-02-30" }, { from: "2026-11-17" },
        { to: "2026-13-01" }, { rows: null }, { messages: ["private"] },
        { pricing: { ...snapshot().pricing, asOf: "2026-02-30" } },
        { pricing: { ...snapshot().pricing, basis: "standard" } },
        { pricing: { ...snapshot().pricing, basis: "subscription" } }]) {
        assert.equal(validateSnapshot(snapshot(change), { now: Now }).ok, false, JSON.stringify(change));
    }
    for (const value of [null, [], "{}", true]) assert.equal(validateSnapshot(value, { now: Now }).ok, false);
    assert.equal(validateSnapshot(snapshot(), null).ok, false);
    assert.equal(validateSnapshot(snapshot(), { now: "now" }).ok, false);
});

test("row validation rejects inconsistent totals, missing price coverage, duplicates and out-of-range dates", () => {
    for (const change of [{ inputTokens: 101 }, { requests: -1 }, { requests: Number.MAX_SAFE_INTEGER + 1 },
        { outputTokens: 1.5 }, { usd: Infinity }, { usd: -0.01 }, { unpricedRequests: 3 },
        { estimatedRequests: 3 }, { model: "" }, { date: "2026-10-17" }, { rawText: "private" }]) {
        const rows = [{ ...snapshot().rows[0], ...change }];
        assert.equal(validateSnapshot(snapshot({ rows }), { now: Now }).ok, false, JSON.stringify(change));
    }
    assert.equal(validateSnapshot(snapshot({ rows: [snapshot().rows[0], snapshot().rows[0]] }), { now: Now }).ok, false);
    const value = snapshot();
    delete value.rows[0].unpricedRequests;
    assert.equal(validateSnapshot(value, { now: Now }).ok, false);
});

test("coverage permits consistent extra counters while rejecting nonnumeric extensions and huge payloads", () => {
    const value = snapshot();
    value.coverage.duplicateRequests = 8;
    assert.equal(validateSnapshot(value, { now: Now }).ok, true);
    value.coverage.rawPath = "/private/path";
    assert.equal(validateSnapshot(value, { now: Now }).ok, false);
    value.coverage = { ...snapshot().coverage, warnings: ["x".repeat(MaxSnapshotBytes)] };
    assert.equal(validateSnapshot(value, { now: Now }).ok, false);
});

test("derives the fixed aggregate path from POSIX and Windows retained rollouts", () => {
    const posix = snapshotContext(`/home/me/.codex/sessions/2026/11/16/rollout-2026-11-16T00-00-00-${ThreadId}.jsonl`, ThreadId);
    assert.equal(posix.codexHome, "/home/me/.codex");
    assert.equal(posix.directory, "/home/me/.codex/.daily-usage");
    assert.equal(posix.file, "/home/me/.codex/.daily-usage/summary.json");
    const windows = snapshotContext(`D:\\Users\\me\\.codex\\archived_sessions\\rollout-2026-11-16T00-00-00-${ThreadId}.jsonl.zst`, ThreadId);
    assert.equal(windows.file, "D:\\Users\\me\\.codex\\.daily-usage\\summary.json");
    const unc = snapshotContext(`\\\\server\\share\\.codex\\sessions\\rollout-2026-11-16T00-00-00-${ThreadId}.jsonl`, ThreadId);
    assert.equal(unc.file, "\\\\server\\share\\.codex\\.daily-usage\\summary.json");
});

test("path validation rejects traversal, ambiguous roots, wrong threads and unsupported source ancestry", () => {
    const name = `rollout-2026-11-16T00-00-00-${ThreadId}.jsonl`;
    for (const value of [`relative/sessions/${name}`, `/home/me/.codex/sessions/../sessions/${name}`,
        `/home/me/.codex/session/${name}`, `/home/me/.codex/sessions/${name}\n`,
        `/home/me/.codex/sessions\\${name}`, `D:\\me\\.codex\\sessions\\..\\sessions\\${name}`,
        `D:\\me.\\.codex\\sessions\\${name}`, `D:\\me\\.codex\\sessions\\${name}:stream`,
        `/home/me/.codex/sessions/rollout-2026-11-16T00-00-00-22222222-2222-4222-8222-222222222222.jsonl`]) {
        assert.equal(snapshotContext(value, ThreadId), null, value);
    }
    assert.equal(snapshotContext(`/home/me/.codex/sessions/${name}`, "../thread"), null);
});

module.exports = { snapshot, ThreadId, Now };
