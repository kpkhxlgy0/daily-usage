"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Pricing } = require("../src/pricing.cjs");
const { demandPaths, makeMarker, validateMarker, validateCapabilities, validateResult,
    MaxDemandBytes, MaxResultBytes, MaxDemandMs } = require("../src/demand-protocol.cjs");
const Id = "11111111-1111-4111-8111-111111111111";
const Publisher = "33333333-3333-4333-8333-333333333333";
const Now = 1794787200000;
const base = { schemaVersion: 1, source: "com.kpk.daily-usage", demandVersion: 1 };
const marker = { ...base, requestId: Id, action: "query", sequence: 1, requestedAt: Now, expiresAt: Now + 300000, snapshotVersion: 4 };
const snapshot = { schemaVersion: 4, source: "com.kpk.daily-usage",
    machineId: "22222222-2222-4222-8222-222222222222", publisherId: Publisher, revision: 1,
    generatedAt: Now, timezone: "Asia/Shanghai", from: "2026-10-18", to: "2026-11-16", rows: [],
    coverage: { files: 0, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
    weekly: null, weeklyHistory: [], weeklyRemainder: { earlier: { requests: 0, usd: 0 },
        unassigned: { requests: 0, usd: 0 } }, pricing: { ...Pricing } };

test("markers use a bounded lifetime and cancellation preserves the query identity and timestamps", () => {
    assert.deepEqual(makeMarker(Id, Now), marker);
    assert.deepEqual(makeMarker(Id, Now + 1000, "cancel", marker), { ...marker, action: "cancel", sequence: 2 });
    assert.deepEqual(demandPaths("/home/me/.codex", path.posix), {
        directory: "/home/me/.codex/.daily-usage", requests: "/home/me/.codex/.daily-usage/requests",
        responses: "/home/me/.codex/.daily-usage/responses",
        capabilities: "/home/me/.codex/.daily-usage/capabilities.json",
        capabilitiesV4: "/home/me/.codex/.daily-usage/capabilities-v4.json" });
    assert.equal(demandPaths("C:\\Codex", path.win32).requests, "C:\\Codex\\.daily-usage\\requests");
    assert.equal(validateMarker(marker, { now: Now }).ok, true);
    const weekly = { ...marker, snapshotVersion: 2 };
    assert.equal(validateMarker(weekly, { now: Now }).ok, true);
    assert.equal(validateMarker({ ...weekly, snapshotVersion: 3 }, { now: Now }).ok, true);
    assert.equal(validateMarker({ ...weekly, snapshotVersion: 5 }, { now: Now }).ok, false);
    assert.equal(makeMarker(Id, Now, "cancel", weekly).snapshotVersion, 2);
    assert.equal(validateMarker({ ...marker, action: "cancel", sequence: 2 }, { now: Now }).ok, true);
    assert.equal(MaxDemandBytes, 2048);
    assert.equal(MaxResultBytes, 2 * 1024 * 1024 + 4096);
    assert.equal(MaxDemandMs, 300000);
});

test("untrusted markers cannot extend work, replay expired work, mix actions or carry arbitrary fields", () => {
    for (const value of [{ ...marker, expiresAt: Now + 300001 }, { ...marker, expiresAt: Now },
        { ...marker, requestedAt: Now + 5001, expiresAt: Now + 6000 }, { ...marker, sequence: 2 },
        { ...marker, requestId: "../summary" }, { ...marker, content: "x".repeat(2048) },
        { ...marker, requestedAt: -1 }, { ...marker, action: "cancel" }]) {
        assert.equal(validateMarker(value, { now: Now }).ok, false);
    }
    assert.throws(() => makeMarker("../bad", Now));
    assert.throws(() => makeMarker(Id, Now, "cancel"));
    assert.equal(validateMarker(marker, { now: marker.expiresAt }).ok, false);
});

test("capabilities and results bind to one endpoint and validate snapshots before accepting success", () => {
    const capabilities = { ...base, publisherId: Publisher };
    const value = { ...base, requestId: Id, publisherId: Publisher, updatedAt: Now, status: "ok", snapshot };
    const options = { requestId: Id, publisherId: Publisher, now: Now };
    assert.equal(validateCapabilities(capabilities).ok, true);
    assert.equal(validateCapabilities({ ...capabilities, demandVersion: 0 }).ok, false);
    assert.equal(validateResult(value, options).ok, true);
    assert.equal(validateResult({ ...value, status: "running", snapshot: undefined }, options).ok, false);
    for (const change of [{ requestId: Publisher }, { publisherId: Id }, { updatedAt: Now + 5001 },
        { status: "unknown" }, { snapshot: { ...snapshot, publisherId: Id } },
        { snapshot: { ...snapshot, generatedAt: Now + 5001 } }, { error: "/private/path" }]) {
        assert.equal(validateResult({ ...value, ...change }, options).ok, false);
    }
    assert.equal(validateResult({ ...base, requestId: Id, publisherId: Publisher, updatedAt: Now,
        status: "running" }, options).ok, true);
    assert.equal(validateResult({ ...base, requestId: Id, publisherId: Publisher, updatedAt: Now,
        status: "error", error: "scan-failed" }, options).ok, true);
});

for (const basis of ["standard", "standard-base-api", "codex-base-estimate"])
test(`successful demand responses propagate the ${basis} pricing update requirement`, () => {
    const { weekly, weeklyHistory, weeklyRemainder, ...daily } = snapshot;
    const value = { ...base, requestId: Id, publisherId: Publisher, updatedAt: Now, status: "ok",
        snapshot: { ...daily, schemaVersion: 1, pricing: { ...snapshot.pricing, basis, asOf: "2026-11-16" } } };
    assert.deepEqual(validateResult(value, { requestId: Id, publisherId: Publisher, now: Now }),
        { ok: false, reason: "update-required" });
});

test("whole-cycle marker uses the v4 capability and keeps its version on cancellation", () => {
    const latest = makeMarker(Id, Now);
    assert.equal(latest.snapshotVersion, 4);
    assert.equal(validateMarker(latest, { now: Now }).ok, true);
    assert.equal(makeMarker(Id, Now, "cancel", latest).snapshotVersion, 4);
    assert.equal(demandPaths("/home/me/.codex", path.posix).capabilitiesV4,
        "/home/me/.codex/.daily-usage/capabilities-v4.json");
});
