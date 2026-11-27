"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSnapshot, snapshotForPeer } = require("../src/protocol.cjs");

const now = Date.UTC(2026, 10, 27, 8);
const day = 86400000;
const nearEnd = now - day;
const money = (requests, usd) => ({ requests, usd });
const row = (requests, usd) => ({ model: "test-model", requests, usd, unpricedRequests: 0, estimatedRequests: 0 });

function fixture() {
    const current = { startAt: now - 5 * day, resetAt: now + 2 * day, endAt: now, startKind: "inferred",
        fullAt: now - day, sampleAt: now - 5000, usedPercent: 100, partial: false,
        afterFull: money(1, 1.03), rows: [row(2, 3.04)] };
    const older = { startAt: nearEnd - 7 * day, resetAt: nearEnd, endAt: nearEnd - 1, startKind: "inferred",
        sampleAt: null, fullAt: null, usedPercent: null, partial: true, afterFull: money(0, 0), rows: [row(1, 1.01)] };
    return { schemaVersion: 4, source: "com.kpk.daily-usage", machineId: "11111111-1111-4111-8111-111111111111",
        publisherId: "22222222-2222-4222-8222-222222222222", revision: 1, generatedAt: now, timezone: "Asia/Shanghai",
        from: "2026-10-29", to: "2026-11-27", pricing: { ...require("../src/pricing.cjs").Pricing, basis: "codex-standard-estimate" },
        rows: [{ ...row(6, 7.06), date: "2026-11-25", inputTokens: 50, cachedInputTokens: 10,
            uncachedInputTokens: 40, cacheWriteTokens: 0, outputTokens: 10 }],
        coverage: { files: 1, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        weekly: current, weeklyHistory: [older], weeklyRemainder: { earlier: money(2, 2), unassigned: money(1, 1.01) } };
}

test("whole-cycle v4 preserves overlapping quota identities and conserves requests and Standard dollars", () => {
    const report = fixture();
    assert.deepEqual(validateSnapshot(report, { now }), { ok: true });
    assert.equal(snapshotForPeer(report, 4), report);
    assert.equal(snapshotForPeer(report, 3), null);
    for (const mutate of [
        r => r.weeklyRemainder.unassigned.requests++,
        r => { r.weeklyRemainder.earlier.usd += 0.1; },
        r => { r.weekly.afterFull = money(3, 3); },
        r => { r.weeklyHistory[0].afterFull = money(1, 1); },
        r => { r.weeklyHistory[0].sampleAt = now; },
        r => { r.weekly.endAt = r.weekly.fullAt; },
        r => { r.weeklyHistory.push(r.weeklyHistory[0]); },
        r => { r.weekly.rows[0].baseUsd = 1; },
        r => { r.weeklyRemainder.unassigned.account = "untrusted"; },
    ]) {
        const invalid = fixture();
        mutate(invalid);
        assert.equal(validateSnapshot(invalid, { now }).ok, false);
    }
});
