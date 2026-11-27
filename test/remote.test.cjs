"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { Pricing } = require("../src/pricing.cjs");
const { createRemoteStore } = require("../src/remote-store.cjs");
const { createRemoteTransport } = require("../src/vendor/remote-transport.cjs");
const { bindingScript } = require("../src/vendor/binding.cjs");
const ThreadId = "11111111-1111-4111-8111-111111111111";
const OtherThreadId = "44444444-4444-4444-8444-444444444444";
const PublisherId = "33333333-3333-4333-8333-333333333333";
const NextPublisher = "55555555-5555-4555-8555-555555555555";
const Host = "remote-control:runner";
const Home = "/home/me/.codex";
const Directory = `${Home}/.daily-usage`;
const File = `${Directory}/summary.json`;
const Now = Date.parse("2026-11-16T00:00:00Z");
const rollout = id => `${Home}/sessions/2026/11/16/rollout-2026-11-16T00-00-00-${id}.jsonl`;
const flush = () => new Promise(resolve => setImmediate(resolve));

function sample(overrides = {}) {
    return { schemaVersion: 1, source: "com.kpk.daily-usage", machineId: "22222222-2222-4222-8222-222222222222",
        publisherId: PublisherId, revision: 1, generatedAt: Now, timezone: "Asia/Shanghai",
        from: "2026-10-18", to: "2026-11-16", rows: [],
        coverage: { files: 2, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { ...Pricing }, ...overrides };
}

const Requests = `${Directory}/requests`;
const Responses = `${Directory}/responses`;
const Capabilities = `${Directory}/capabilities.json`;
const CapabilitiesV2 = `${Directory}/capabilities-v2.json`;
const CapabilitiesV3 = `${Directory}/capabilities-v3.json`;
const PriorPricingBases = ["standard", "standard-base-api", "codex-base-estimate"];
const Base = { schemaVersion: 1, source: "com.kpk.daily-usage", demandVersion: 1 };

function fixture(t) {
    const state = { now: Now, value: sample(), calls: [], order: [], offline: false, metadata: null, thread: null,
        payload: null, publisherId: PublisherId, oldPeer: false, wait: false, watches: [], markers: [], results: new Map() };
    state.store = createRemoteStore({ now: () => state.now });
    t.after(() => state.store.dispose());
    state.notify = () => { for (const watch of state.watches) watch.changed(); };
    state.finish = (id = state.markers.at(-1)?.requestId, overrides = {}) => {
        state.results.set(id, { ...Base, requestId: id, publisherId: state.publisherId, updatedAt: state.now,
            status: "ok", snapshot: state.value, ...overrides });
        state.notify();
    };
    state.request = async (method, params, limits) => {
        state.calls.push({ method, params, limits });
        if (state.offline) throw new Error("Offline private host info");
        if (method === "thread/read") return state.thread ?? { thread: { id: params.threadId, path: rollout(params.threadId) } };
        const isResult = params.path?.startsWith(`${Responses}/`);
        const isMarker = params.path?.startsWith(`${Requests}/`);
        const capabilities = [Capabilities, CapabilitiesV2, CapabilitiesV3];
        assert.ok([Home, Directory, Requests, Responses, ...capabilities].includes(params.path) || isResult || isMarker,
            `Unexpected path ${params.path}`);
        if (method === "fs/getMetadata") {
            if (state.oldPeer && params.path === Capabilities || params.path === CapabilitiesV2 && !state.weeklyPublisher
                || params.path === CapabilitiesV3 && !state.historyPublisher
                || isResult && !state.results.has(params.path.split("/").at(-1).slice(0, -5))) {
                throw Object.assign(new Error("ENOENT private path"), { code: "ENOENT" });
            }
            const isFile = capabilities.includes(params.path) || isResult || isMarker;
            const info = { isFile, isDirectory: !isFile, isSymlink: false, createdAtMs: 10, modifiedAtMs: 20, size: 100 };
            return state.metadata ? state.metadata(params.path, info) : info;
        }
        if (method === "fs/writeFile") {
            assert.equal(isMarker, true);
            const marker = JSON.parse(Buffer.from(params.dataBase64, "base64").toString());
            state.markers.push(marker);
            state.order.push(marker.action);
            assert.equal(params.path, `${Requests}/${marker.requestId}.json`);
            if (marker.action === "query" && !state.wait) state.finish(marker.requestId);
            return {};
        }
        assert.equal(method, "fs/readFile");
        if (capabilities.includes(params.path)) return { dataBase64: Buffer.from(JSON.stringify({ ...Base,
            publisherId: [state.publisherId, state.weeklyPublisher, state.historyPublisher][capabilities.indexOf(params.path)] })).toString("base64") };
        assert.equal(isResult, true);
        const id = params.path.split("/").at(-1).slice(0, -5);
        if (!state.results.has(id)) throw Object.assign(new Error("ENOENT private path"), { code: "ENOENT" });
        return { dataBase64: state.payload ?? Buffer.from(JSON.stringify(state.results.get(id))).toString("base64") };
    };
    state.watch = async (path, { signal }) => {
        assert.equal(path, Responses);
        assert.equal(signal instanceof AbortSignal, true);
        state.order.push("watch");
        let queued = false;
        let waiter;
        const watcher = { disposed: false, changed() {
            if (watcher.disposed) return;
            if (waiter) { const done = waiter; waiter = null; done(); } else queued = true;
        }, next() {
            if (queued) { queued = false; return Promise.resolve(); }
            return new Promise(resolve => { waiter = resolve; });
        }, async dispose() { watcher.disposed = true; state.order.push("unwatch"); } };
        state.watches.push(watcher);
        return watcher;
    };
    state.get = (identity = { hostId: Host, threadId: ThreadId }, options = {}) =>
        state.store.get(identity, state.request, { watch: state.watch, ...options });
    return state;
}

test("an unusable optional advertisement falls back to daily without following a symlink", async t => {
    const f = fixture(t);
    f.weeklyPublisher = PublisherId;
    f.metadata = (path, info) => path === CapabilitiesV2 ? { ...info, isSymlink: true } : info;
    assert.equal((await f.get()).status, "ok");
    assert.equal(f.markers.at(-1).snapshotVersion, undefined);
    assert.equal(f.calls.some(call => call.method === "fs/readFile" && call.params.path === CapabilitiesV2), false);
});

test("only opts into weekly snapshots for the active remote publisher that advertises them", async t => {
    const f = fixture(t);
    assert.equal((await f.get()).status, "ok");
    assert.equal(f.markers.at(-1).snapshotVersion, undefined);
    f.weeklyPublisher = NextPublisher;
    assert.equal((await f.get()).status, "ok");
    assert.equal(f.markers.at(-1).snapshotVersion, undefined);
    f.weeklyPublisher = PublisherId;
    f.historyPublisher = NextPublisher;
    f.value = sample({ revision: 2, schemaVersion: 2, weekly: null });
    assert.equal((await f.get()).snapshot.schemaVersion, 2);
    assert.equal(f.markers.at(-1).snapshotVersion, 2);
    f.historyPublisher = PublisherId;
    f.value = sample({ revision: 3, schemaVersion: 3, weekly: null, weeklyHistory: [] });
    assert.deepEqual((await f.get()).snapshot, f.value);
    assert.equal(f.markers.at(-1).snapshotVersion, 3);
});

test("one remote query watches before its marker and reads only capabilities and its matching response", async t => {
    const f = fixture(t);
    const result = await f.get();
    assert.equal(result.status, "ok");
    assert.deepEqual(result.snapshot, sample());
    assert.deepEqual(f.order.slice(0, 2), ["watch", "query"]);
    assert.equal(f.order.at(-1), "unwatch");
    assert.equal(f.markers.length, 1);
    assert.deepEqual(f.calls[0].params, { threadId: ThreadId, includeTurns: false });
    assert.ok(f.calls.filter(x => x.method === "fs/readFile").every(x =>
        x.params.path === Capabilities || x.params.path === `${Responses}/${f.markers[0].requestId}.json`));
    assert.ok(f.calls.every(x => x.limits.timeoutMs > 0 && x.limits.timeoutMs <= 5000
        && x.limits.maxChars <= 3 * 1024 * 1024 && x.limits.signal instanceof AbortSignal));
    const reads = f.calls.length;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.length, reads, "completed query must not poll or retry");
});

test("waiting requests perform no reads between native change notifications", async t => {
    const f = fixture(t);
    f.wait = true;
    const task = f.get();
    await flush();
    const reads = f.calls.length;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.length, reads);
    f.finish();
    assert.equal((await task).status, "ok");
});

test("offline preserves the original cached report, is host isolated and never exposes native error text", async t => {
    const f = fixture(t);
    const first = await f.get();
    first.snapshot.revision = 100;
    f.offline = true;
    const cached = await f.get();
    assert.equal(cached.status, "stale");
    assert.equal(cached.snapshot.generatedAt, Now);
    assert.equal(cached.snapshot.revision, 1);
    assert.equal(cached.error, "snapshot-unavailable");
    assert.equal((await f.get({ hostId: "remote-control:other", threadId: ThreadId })).snapshot, undefined);
});

for (const basis of PriorPricingBases)
test(`${basis} November 16 pricing responses require an update and never become an accepted remote cache`, async t => {
    const f = fixture(t);
    f.value = sample({ pricing: { ...sample().pricing, basis, asOf: "2026-11-16" } });
    assert.deepEqual(await f.get(), { status: "unavailable", error: "snapshot-update-required" });
    f.offline = true;
    assert.deepEqual(await f.get(), { status: "unavailable", error: "snapshot-unavailable" });
});

for (const basis of PriorPricingBases)
test(`${basis} November 16 pricing responses preserve only a previously accepted estimate as stale`, async t => {
    const f = fixture(t);
    f.value.rows = [{ date: "2026-11-16", model: "gpt-5.4", requests: 1, inputTokens: 300000,
        uncachedInputTokens: 100000, cachedInputTokens: 200000, cacheWriteTokens: 0, outputTokens: 10000,
        usd: 0.45, unpricedRequests: 0, estimatedRequests: 0 }];
    const first = await f.get();
    assert.equal(first.status, "ok");
    const accepted = first.snapshot;
    f.value = { ...accepted, revision: 2, generatedAt: Now + 1,
        rows: [{ ...accepted.rows[0], usd: 0.825 }], pricing: { ...accepted.pricing, basis, asOf: "2026-11-16" } };
    const result = await f.get();
    assert.equal(result.status, "stale");
    assert.equal(result.error, "snapshot-update-required");
    assert.deepEqual(result.snapshot, accepted);
    f.offline = true;
    assert.deepEqual((await f.get()).snapshot, accepted);
});

test("0.1.2 endpoints and unsupported notification watchers require an update without fallback reads", async t => {
    const f = fixture(t);
    f.oldPeer = true;
    assert.equal((await f.get()).error, "snapshot-update-required");
    assert.equal(f.markers.length, 0);
    assert.equal(f.calls.some(x => x.params.path === File), false);
    f.oldPeer = false;
    assert.equal((await f.get(undefined, { watch: undefined })).error, "snapshot-update-required");
    f.watch = async () => { throw new Error("Unknown method fs/watch"); };
    assert.equal((await f.get()).error, "snapshot-update-required");
    assert.equal(f.markers.length, 0);
});

test("abort sends sequence2 with original timestamps, unwatches and cannot affect a concurrent owner", async t => {
    const f = fixture(t);
    f.wait = true;
    const controller = new AbortController();
    const first = f.get(undefined, { signal: controller.signal });
    const rejected = assert.rejects(first, { name: "AbortError", code: "ABORT_ERR" });
    const second = f.get();
    await flush();
    assert.equal(f.markers.length, 2);
    const original = f.markers[0];
    const other = f.markers[1];
    assert.notEqual(original.requestId, other.requestId);
    controller.abort();
    await rejected;
    assert.deepEqual(f.markers.at(-1), { ...original, action: "cancel", sequence: 2 });
    assert.equal(f.watches[0].disposed, true);
    assert.equal(f.watches[1].disposed, false);
    f.finish(other.requestId);
    assert.equal((await second).status, "ok");
});

test("malformed, foreign, changed-publisher and future responses retain the prior report as stale", async t => {
    const f = fixture(t);
    await f.get();
    f.wait = true;
    for (const overrides of [{ requestId: OtherThreadId }, { publisherId: NextPublisher },
        { updatedAt: Now + 5001 }, { snapshot: sample({ generatedAt: Now + 5001 }) }, { snapshot: {} }]) {
        const task = f.get();
        await flush();
        f.finish(f.markers.findLast(x => x.action === "query").requestId, overrides);
        const result = await task;
        assert.equal(result.status, "stale");
        assert.equal(result.snapshot.revision, 1);
    }
});

test("host-wide replay checks survive thread switches and publisher changes", async t => {
    const f = fixture(t);
    f.value.revision = 3;
    await f.get();
    f.value = sample({ revision: 2 });
    assert.equal((await f.get({ hostId: Host, threadId: OtherThreadId })).error, "snapshot-replay");
    f.publisherId = NextPublisher;
    f.value = sample({ publisherId: NextPublisher, generatedAt: Now + 1 });
    assert.equal((await f.get()).status, "ok");
    f.publisherId = PublisherId;
    f.value = sample({ revision: 4, generatedAt: Now + 2 });
    assert.equal((await f.get()).error, "snapshot-replay");
});

test("invalid identities, wrong native context and symlink protocol directories fail before writing", async t => {
    const f = fixture(t);
    for (const identity of [{ hostId: "local", threadId: ThreadId }, { hostId: "bad\nhost", threadId: ThreadId },
        { hostId: Host, threadId: "../x" }]) assert.equal((await f.get(identity)).status, "unavailable");
    assert.equal(f.calls.length, 0);
    f.thread = { thread: { id: ThreadId, path: rollout(OtherThreadId) } };
    assert.equal((await f.get()).error, "snapshot-identity");
    f.thread = null;
    f.metadata = (path, info) => path === Requests ? { ...info, isSymlink: true } : info;
    assert.equal((await f.get()).error, "snapshot-invalid");
    assert.equal(f.markers.length, 0);
});

test("native context and protocol directory identities are rechecked before accepting results", async t => {
    const f = fixture(t);
    let reads = 0;
    const request = f.request;
    f.request = async (method, params, limits) => {
        if (method === "thread/read" && ++reads > 1) return { thread: { id: ThreadId,
            path: rollout(ThreadId).replace("/home/me", "/other/home") } };
        return request(method, params, limits);
    };
    assert.equal((await f.get()).error, "snapshot-identity");
    f.request = request;
    let visits = 0;
    f.metadata = (path, info) => path === Directory && ++visits > 1 ? { ...info, createdAtMs: 99 } : info;
    assert.equal((await f.get()).error, "snapshot-invalid");
});

test("disposal aborts all owners and rejects delayed results", async t => {
    const f = fixture(t);
    f.wait = true;
    const task = f.get();
    const rejected = assert.rejects(task, { name: "AbortError" });
    await flush();
    f.store.dispose();
    await rejected;
    f.finish();
    assert.equal((await f.get()).snapshot, undefined);
    assert.equal(f.watches[0].disposed, true);
});

function pageFixture(t, respond, options = {}) {
    const listeners = new Map();
    const win = { location: { origin: "https://codex.invalid" }, setTimeout, clearTimeout,
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        dispatchEvent(event) { for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event); } };
    const emit = (data, extra = {}) => win.dispatchEvent({ type: "message", data, source: null, ...extra });
    win.electronBridge = { sendMessageFromView: envelope => respond(envelope, emit) };
    const context = vm.createContext({ window: win, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } });
    const frame = { executeJavaScript(source) { return Promise.resolve(vm.runInContext(source, context)); } };
    const transport = createRemoteTransport({ timeoutMs: 50, ...options });
    t.after(() => transport.dispose());
    return { win, frame, transport, listeners };
}

const response = (envelope, result) => ({ type: "mcp-response", hostId: envelope.hostId,
    message: { id: envelope.request.id, result } });

test("transport binds responses to host and request id and returns the native RPC result", async t => {
    const f = pageFixture(t, (env, emit) => {
        emit({ ...response(env, { wrong: true }), hostId: "other" });
        emit(response(env, { wrong: true }), { source: {} });
        emit(response(env, { thread: { id: ThreadId, path: rollout(ThreadId) } }));
    });
    const result = await f.transport.request(f.frame, Host, "thread/read", { threadId: ThreadId, includeTurns: false });
    assert.equal(result.thread.path, rollout(ThreadId));
    assert.equal(f.listeners.get("message").size, 0);
});

test("transport rejects writes, invalid identities and unsafe limits before using the bridge", async t => {
    const f = pageFixture(t, () => assert.fail("must not send"));
    await assert.rejects(f.transport.request(f.frame, Host, "fs/writeFile", { path: File }));
    await assert.rejects(f.transport.request(f.frame, "local", "fs/readFile", { path: File }));
    await assert.rejects(f.transport.request(f.frame, Host, "fs/readFile", { path: File }, { maxChars: Infinity }));
});

function stream(emit, transferId) {
    let sequence = 0;
    return (kind, tokens) => emit({ marker: "codex-host-chunked-message-v1", transferId,
        sequence: sequence++, kind, ...(tokens ? { tokens } : {}) });
}

function responsePrefix(envelope) {
    return [{ type: "object-start" }, { type: "key", value: "type" }, { type: "value", value: "mcp-response" },
        { type: "key", value: "hostId" }, { type: "value", value: envelope.hostId },
        { type: "key", value: "message" }, { type: "object-start" },
        { type: "key", value: "id" }, { type: "value", value: envelope.request.id },
        { type: "key", value: "result" }, { type: "object-start" }];
}

const ResponseEnd = [{ type: "container-end" }, { type: "container-end" }, { type: "container-end" }];

test("chunked responses survive interleaved foreign streams and release listeners", async t => {
    const f = pageFixture(t, (env, emit) => {
        const own = stream(emit, "own"), foreign = stream(emit, "foreign");
        const prefix = responsePrefix(env);
        own("start");
        own("chunk", prefix.slice(0, 2));
        foreign("start");
        foreign("chunk", [{ type: "object-start" }, { type: "key", value: "hostId" },
            { type: "value", value: "another-host" }]);
        own("chunk", [...prefix.slice(2), { type: "key", value: "dataBase64" },
            { type: "string-start", target: "value" }, { type: "string-chunk", value: "e30=" },
            { type: "string-end" }, ...ResponseEnd]);
        own("end");
    });
    const result = await f.transport.request(f.frame, Host, "fs/readFile", { path: File });
    assert.equal(result.dataBase64, "e30=");
    assert.equal(f.listeners.get("message").size, 0);
});

test("matching oversized chunked snapshots fail immediately within the decoding budget", async t => {
    const f = pageFixture(t, (env, emit) => {
        const own = stream(emit, "own");
        own("start");
        own("chunk", [...responsePrefix(env), { type: "key", value: "dataBase64" },
            { type: "string-start", target: "value" }, { type: "string-chunk", value: "A".repeat(2048) }]);
    }, { maxChars: 1024 });
    await assert.rejects(f.transport.request(f.frame, Host, "fs/readFile", { path: File }),
        { code: "DAILY_USAGE_SNAPSHOT_TOO_LARGE" });
    assert.equal(f.listeners.get("message").size, 0);
});

test("transport timeouts clear page listeners and expired scripts do not issue a late request", async t => {
    let sends = 0;
    const f = pageFixture(t, () => { sends++; }, { timeoutMs: 10 });
    await assert.rejects(f.transport.request(f.frame, Host, "fs/readFile", { path: File }), /timed out/i);
    assert.equal(f.listeners.get("message").size, 0);
    const delayed = [];
    const frame = { executeJavaScript: source => new Promise((resolve, reject) => {
        delayed.push(() => f.frame.executeJavaScript(source).then(resolve, reject));
    }) };
    const pending = f.transport.request(frame, Host, "fs/readFile", { path: File });
    await assert.rejects(pending, /timed out/i);
    f.transport.dispose();
    for (const run of delayed) run();
    await flush();
    assert.equal(sends, 1);
    assert.equal(f.listeners.get("message").size, 0);
});

test("transport enforces response budget and cleans pending listeners on abort and disposal", async t => {
    const oversized = pageFixture(t, (env, emit) => emit(response(env, { dataBase64: "x".repeat(2000) })), { maxChars: 1024 });
    await assert.rejects(oversized.transport.request(oversized.frame, Host, "fs/readFile", { path: File }), /size limit/i);
    const f = pageFixture(t, () => {});
    const controller = new AbortController();
    const task = f.transport.request(f.frame, Host, "fs/readFile", { path: File }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(task, /cancel/i);
    assert.equal(f.listeners.get("message").size, 0);
    const pending = f.transport.request(f.frame, Host, "fs/readFile", { path: File });
    f.transport.dispose();
    await assert.rejects(pending, /disabled|cancel/i);
    assert.equal(f.listeners.get("message").size, 0);
});

test("binding discovers independent composers and selected subagent details without Session Stats keys", () => {
    const root = (props, composer, attrs = {}) => ({ __reactFiberTest: { memoizedProps: props }, dataset: attrs,
        hasAttribute(name) { return composer && name === "data-codex-composer-root"; }, getClientRects() { return [1]; } });
    const composer = root({ threadId: ThreadId, hostId: Host }, true);
    const child = root({ headerRows: [{ id: "subagent-detail", content: { props: {
        conversationId: OtherThreadId, hostId: "remote-control:child", privateText: "hidden" } } }] }, false);
    const window = { location: { pathname: "/index.html", search: "" } };
    const document = { querySelectorAll: () => [composer, child] };
    const value = vm.runInNewContext(bindingScript, { window, document, URLSearchParams });
    assert.deepEqual(JSON.parse(JSON.stringify(value)), [
        { bound: { threadId: ThreadId, hostId: Host } },
        { bound: { threadId: OtherThreadId, hostId: "remote-control:child" } },
    ]);
});

test("binding excludes hidden layout surfaces and conflicting scoped host identities", () => {
    const visible = { dataset: {}, getClientRects: () => [1], hasAttribute: () => true,
        __reactFiberTest: { memoizedProps: { threadId: ThreadId, hostId: Host } } };
    const hidden = { ...visible, getClientRects: () => [],
        __reactFiberTest: { memoizedProps: { threadId: OtherThreadId, hostId: "hidden-host" } } };
    const conflicting = { ...visible, __reactFiberTest: { memoizedProps: { threadId: OtherThreadId, hostId: Host },
        return: { memoizedProps: { hostId: "other-host" } } } };
    const value = vm.runInNewContext(bindingScript, { document: { querySelectorAll: () => [visible, hidden, conflicting] },
        window: { location: { pathname: "/index.html", search: "" } }, URLSearchParams });
    assert.deepEqual(JSON.parse(JSON.stringify(value)), [{ bound: { threadId: ThreadId, hostId: Host } }]);
});

test("native watchers queue notifications before ACK and isolate host, watch ID and disposal", async t => {
    let watcher;
    let emitNative;
    const f = pageFixture(t, (env, emit) => {
        emitNative = emit;
        if (env.request.method === "fs/watch") {
            watcher = env;
            emit({ type: "mcp-notification", hostId: env.hostId, method: "fs/changed",
                params: { watchId: env.request.params.watchId, changedPaths: ["x"] } });
        } else if (env.request.method === "fs/unwatch") emit(response(env, {}));
    });
    const task = f.transport.watch(f.frame, Host, `${Directory}/responses`);
    await flush();
    assert.equal(watcher.request.params.path, `${Directory}/responses`);
    emitNative(response(watcher, {}));
    const watch = await task;
    await watch.next();
    let changed = false;
    const next = watch.next().then(() => { changed = true; });
    emitNative({ type: "mcp-notification", hostId: "other-host", method: "fs/changed",
        params: { watchId: watcher.request.params.watchId } });
    emitNative({ type: "mcp-notification", hostId: Host, method: "fs/changed", params: { watchId: "other-id" } });
    await flush();
    assert.equal(changed, false);
    emitNative({ type: "mcp-notification", hostId: Host, method: "fs/changed",
        params: { watchId: watcher.request.params.watchId } });
    await next;
    const abandoned = watch.next();
    const rejected = assert.rejects(abandoned, /cancel|disposed/i);
    await watch.dispose();
    await rejected;
    assert.equal(f.listeners.get("message").size, 0);
    await assert.rejects(watch.next(), /cancel|disposed/i);
});

test("abort during watch ACK rejects immediately and a late ACK is unwatched", async t => {
    let watcher;
    let emitNative;
    const unwatched = [];
    const f = pageFixture(t, (env, emit) => {
        emitNative = emit;
        if (env.request.method === "fs/watch") watcher = env;
        else if (env.request.method === "fs/unwatch") {
            unwatched.push(env.request.params.watchId);
            emit(response(env, {}));
        }
    });
    const controller = new AbortController();
    const task = f.transport.watch(f.frame, Host, `${Directory}/responses`, { signal: controller.signal });
    await flush();
    controller.abort();
    await assert.rejects(task, /cancel/i);
    const before = unwatched.length;
    emitNative(response(watcher, {}));
    await flush();
    assert.ok(unwatched.length > before, "late registration must receive another unwatch");
    assert.equal(new Set(unwatched).size, 1);
    assert.equal(f.listeners.get("message").size, 0);
});

test("transport admits only fixed validated demand marker writes and response-directory watches", async t => {
    let sends = 0;
    const f = pageFixture(t, (env, emit) => { sends++; emit(response(env, {})); });
    const marker = { schemaVersion: 1, source: "com.kpk.daily-usage", demandVersion: 1, requestId: ThreadId,
        action: "query", sequence: 1, requestedAt: Date.now(), expiresAt: Date.now() + 1000 };
    const dataBase64 = Buffer.from(JSON.stringify(marker)).toString("base64");
    await f.transport.request(f.frame, Host, "fs/writeFile", {
        path: `${Directory}/requests/${ThreadId}.json`, dataBase64 });
    assert.equal(sends, 1);
    for (const params of [{ path: File, dataBase64 },
        { path: `${Directory}/requests/${OtherThreadId}.json`, dataBase64 },
        { path: `${Directory}/requests/../${ThreadId}.json`, dataBase64 },
        { path: `${Directory}/requests/${ThreadId}.json`, dataBase64, overwrite: true },
        { path: `${Directory}/requests/${ThreadId}.json`, dataBase64: Buffer.from("{}").toString("base64") }]) {
        await assert.rejects(f.transport.request(f.frame, Host, "fs/writeFile", params));
    }
    await assert.rejects(f.transport.watch(f.frame, Host, `${Home}/sessions`));
    assert.equal(sends, 1);
});

test("missing demand directories require an endpoint update before any writes", async t => {
    const f = fixture(t);
    const request = f.request;
    f.request = (method, params, limits) => {
        if (method === "fs/getMetadata" && params.path === Requests) {
            throw Object.assign(new Error("ENOENT old endpoint"), { code: "ENOENT" });
        }
        return request(method, params, limits);
    };
    assert.equal((await f.get()).error, "snapshot-update-required");
    assert.equal(f.markers.length, 0);
});

test("a pre-aborted query does no remote work", async t => {
    const f = fixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.get(undefined, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.markers.length, 0);
});

test("invalid response encodings, oversized files and changed machine identity cannot replace a report", async t => {
    const f = fixture(t);
    await f.get();
    for (const payload of ["%%%", "YQ=", Buffer.from([0xff]).toString("base64"),
        Buffer.alloc(2 * 1024 * 1024 + 4097).toString("base64"), Buffer.from("{}").toString("base64")]) {
        f.payload = payload;
        assert.equal((await f.get()).status, "stale");
    }
    f.payload = null;
    f.value = sample({ revision: 2, machineId: "66666666-6666-4666-8666-666666666666" });
    assert.equal((await f.get()).error, "snapshot-replay");
    f.metadata = (path, info) => path.startsWith(`${Responses}/`) ? { ...info, size: 2 * 1024 * 1024 + 4097 } : info;
    assert.equal((await f.get()).error, "snapshot-invalid");
});

test("watch notifications coalesce and transport disposal stops pending watchers", async t => {
    let watcher;
    let emitNative;
    const f = pageFixture(t, (env, emit) => {
        emitNative = emit;
        if (env.request.method === "fs/watch") watcher = env;
        emit(response(env, {}));
    });
    const watch = await f.transport.watch(f.frame, Host, Responses);
    for (let index = 0; index < 10; index++) emitNative({ type: "mcp-notification", hostId: Host,
        method: "fs/changed", params: { watchId: watcher.request.params.watchId, changedPaths: [] } });
    await watch.next();
    let resolved = false;
    const next = watch.next().then(() => { resolved = true; });
    const rejected = assert.rejects(next, /cancel|disposed/i);
    await flush();
    assert.equal(resolved, false);
    f.transport.dispose();
    await rejected;
    assert.equal(f.listeners.get("message").size, 0);
    await assert.rejects(f.transport.watch(f.frame, Host, Responses), /unavailable/i);
});

test("real two-end filesystem demand uses native notifications, delivers a fresh result and cancels runner work", async t => {
    const fs = require("node:fs/promises");
    const nativeFs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const { createDemandServer } = require("../src/demand-server.cjs");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "daily-usage-two-end-"));
    const watches = new Map();
    const calls = [];
    async function phase(promise, label) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Two-end phase timed out: ${label}; recent bridge calls: `
                    + JSON.stringify(calls.slice(-8)))), 5000);
            })]);
        } finally { clearTimeout(timer); }
    }
    let scans = 0;
    let hang = false;
    let abortedWork = 0;
    let announceStart;
    let announceAbort;
    const started = () => new Promise(resolve => { announceStart = resolve; });
    const cancelled = () => new Promise(resolve => { announceAbort = resolve; });
    const service = { ready: Promise.resolve(), getState: () => ({ status: "unavailable" }),
        query({ signal }) {
            scans++;
            announceStart?.();
            if (!hang) return Promise.resolve({ status: "ok", snapshot: sample({ generatedAt: Date.now(), revision: scans }) });
            return new Promise((resolve, reject) => signal.addEventListener("abort", () => {
                abortedWork++;
                announceAbort?.();
                reject(Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORT_ERR" }));
            }, { once: true }));
        } };
    const server = createDemandServer({ codexHome: home, service });
    const store = createRemoteStore();
    t.after(async () => {
        try {
            await phase(store.dispose(), "store cleanup");
            await phase(server.dispose(), "runner cleanup");
        } finally {
            for (const watch of watches.values()) watch.close();
            await fs.rm(home, { recursive: true, force: true });
        }
    });
    await phase(server.ready, "runner initialization");
    assert.equal(scans, 0);
    const f = pageFixture(t, (env, emit) => {
        const call = { method: env.request.method, params: env.request.params };
        calls.push(call);
        const { method, params } = env.request;
        Promise.resolve().then(async () => {
            if (method === "thread/read") return { thread: { id: ThreadId,
                path: path.join(home, "sessions", `rollout-2026-11-16T00-00-00-${ThreadId}.jsonl`) } };
            if (method === "fs/getMetadata") {
                const info = await fs.lstat(params.path);
                return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink(),
                    createdAtMs: info.birthtimeMs, modifiedAtMs: info.mtimeMs, size: info.size };
            }
            if (method === "fs/readFile") return { dataBase64: (await fs.readFile(params.path)).toString("base64") };
            if (method === "fs/writeFile") {
                await fs.writeFile(params.path, Buffer.from(params.dataBase64, "base64"));
                return {};
            }
            if (method === "fs/watch") {
                watches.set(params.watchId, nativeFs.watch(params.path, { persistent: false }, (_event, filename) => {
                    emit({ type: "mcp-notification", hostId: env.hostId, method: "fs/changed",
                        params: { watchId: params.watchId, changedPaths: [String(filename)] } });
                }));
                return {};
            }
            if (method === "fs/unwatch") {
                watches.get(params.watchId)?.close();
                watches.delete(params.watchId);
                return {};
            }
            throw new Error(`Unexpected method ${method}`);
        }).then(value => emit(response(env, value)), error => {
            call.error = error.code ?? error.message;
            emit({ type: "mcp-response", hostId: env.hostId,
                message: { id: env.request.id, error: { code: error.code, message: error.message } } });
        });
    }, { timeoutMs: 1000 });
    const request = (method, params, limits) => f.transport.request(f.frame, Host, method, params, limits);
    const watch = (directory, options) => f.transport.watch(f.frame, Host, directory, options);
    const fresh = await phase(store.get({ hostId: Host, threadId: ThreadId }, request, { watch }), "fresh report");
    assert.equal(fresh.status, "ok", JSON.stringify({ fresh, recentCalls: calls.slice(-8) }));
    assert.equal(fresh.snapshot.revision, 1);
    assert.equal(scans, 1);
    assert.equal(watches.size, 0);
    assert.equal(calls.filter(x => x.method === "fs/readFile").every(x =>
        ["capabilities.json", "capabilities-v2.json", "capabilities-v3.json"].includes(path.basename(x.params.path))
        || x.params.path.includes(`${path.sep}responses${path.sep}`)), true);
    const idleCalls = calls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls.length, idleCalls);
    assert.equal(scans, 1);
    hang = true;
    const hasStarted = started();
    const hasCancelled = cancelled();
    const controller = new AbortController();
    const task = store.get({ hostId: Host, threadId: ThreadId }, request, { watch, signal: controller.signal });
    try {
        await phase(Promise.race([hasStarted, task.then(value => {
            throw new Error("Remote query completed before runner start: "
                + JSON.stringify({ value, recentCalls: calls.slice(-8) }));
        })]), "cancellable query runner start");
        controller.abort();
        await phase(assert.rejects(task, { name: "AbortError" }), "viewer cancellation");
        await phase(hasCancelled, "runner cancellation");
    } finally { controller.abort(); }
    assert.equal(abortedWork, 1);
    assert.equal(watches.size, 0);
});

test("disposing a transport with another RPC pending still unwatches a late watch ACK", async t => {
    let watcher;
    let emitNative;
    const unwatches = [];
    const f = pageFixture(t, (env, emit) => {
        emitNative = emit;
        if (env.request.method === "fs/watch") watcher = env;
        if (env.request.method === "fs/unwatch") {
            unwatches.push(env.request.params.watchId);
            emit(response(env, {}));
        }
    });
    const watching = f.transport.watch(f.frame, Host, Responses);
    const reading = f.transport.request(f.frame, Host, "thread/read", { threadId: ThreadId, includeTurns: false });
    const cancelledWatch = assert.rejects(watching, /cancel/i);
    const cancelledRead = assert.rejects(reading, /disabled|cancel/i);
    await flush();
    f.transport.dispose();
    await Promise.all([cancelledWatch, cancelledRead]);
    const before = unwatches.length;
    emitNative(response(watcher, {}));
    await flush();
    assert.ok(unwatches.length > before, "other RPC cleanup must not erase pending watch ACK cleanup");
    assert.equal(f.listeners.get("message").size, 0);
});

test("store disposal waits for bounded cancel-marker and watcher cleanup before transport shutdown", async t => {
    const f = fixture(t);
    f.wait = true;
    let releaseCancel;
    const request = f.request;
    f.request = async (method, params, limits) => {
        const value = await request(method, params, limits);
        if (method === "fs/writeFile" && JSON.parse(Buffer.from(params.dataBase64, "base64")).action === "cancel") {
            await new Promise(resolve => { releaseCancel = resolve; });
        }
        return value;
    };
    const task = f.get();
    const rejected = assert.rejects(task, { name: "AbortError" });
    await flush();
    let stopped = false;
    const stopping = f.store.dispose().then(() => { stopped = true; });
    await flush();
    assert.equal(stopped, false);
    assert.equal(f.watches[0].disposed, true);
    releaseCancel();
    await Promise.all([stopping, rejected]);
    assert.equal(stopped, true);
});

test("the one-shot request deadline ends a silent watcher without any periodic response reads", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture(t);
    f.wait = true;
    const task = f.get();
    await flush();
    const before = f.calls.length;
    t.mock.timers.tick(299999);
    await flush();
    assert.equal(f.calls.length, before);
    t.mock.timers.tick(1);
    const result = await task;
    assert.equal(result.status, "unavailable");
    assert.equal(result.error, "snapshot-timeout");
    assert.equal(f.watches[0].disposed, true);
    assert.equal(f.markers.at(-1).action, "cancel");
});
