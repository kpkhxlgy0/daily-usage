"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
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
        pricing: { basis: "standard", asOf: "2026-11-16", source: "https://openai.com/api/pricing/" }, ...overrides };
}

function fixture(t) {
    const state = { now: Now, value: sample(), calls: [], offline: false, metadata: null, thread: null, payload: null };
    state.store = createRemoteStore({ now: () => state.now });
    t.after(() => state.store.dispose());
    state.request = async (method, params, limits) => {
        state.calls.push({ method, params, limits });
        if (state.offline) throw new Error("Offline private host info");
        if (method === "thread/read") return state.thread ?? { thread: { id: params.threadId, path: rollout(params.threadId) } };
        assert.ok([Home, Directory, File].includes(params.path), `Unexpected path ${params.path}`);
        if (method === "fs/getMetadata") {
            const info = { isFile: params.path === File, isDirectory: params.path !== File,
                isSymlink: false, createdAtMs: 10, modifiedAtMs: 20 };
            return state.metadata ? state.metadata(params.path, info) : info;
        }
        assert.equal(method, "fs/readFile");
        return { dataBase64: state.payload ?? Buffer.from(JSON.stringify(state.value)).toString("base64") };
    };
    state.get = (identity = { hostId: Host, threadId: ThreadId }) => state.store.get(identity, state.request);
    return state;
}

test("remote store reads only the fixed aggregate with bounded read-only RPCs", async t => {
    const f = fixture(t);
    const result = await f.get();
    assert.equal(result.status, "ok");
    assert.deepEqual(result.snapshot, sample());
    assert.deepEqual(f.calls[0].params, { threadId: ThreadId, includeTurns: false });
    assert.deepEqual(f.calls.filter(x => x.method === "fs/readFile").map(x => x.params), [{ path: File }]);
    assert.ok(f.calls.every(x => ["thread/read", "fs/getMetadata", "fs/readFile"].includes(x.method)));
    assert.ok(f.calls.every(x => x.limits.timeoutMs > 0 && x.limits.timeoutMs <= 5000
        && x.limits.maxChars <= 3 * 1024 * 1024 && x.limits.signal instanceof AbortSignal));
});

test("offline retains the original timestamp as stale and never borrows another host cache", async t => {
    const f = fixture(t);
    await f.get();
    f.now += 1000;
    f.offline = true;
    const cached = await f.get();
    assert.equal(cached.status, "stale");
    assert.equal(cached.snapshot.generatedAt, Now);
    assert.equal(cached.error, "snapshot-unavailable");
    const other = await f.get({ hostId: "remote-control:other", threadId: ThreadId });
    assert.equal(other.status, "unavailable");
    assert.equal(other.snapshot, undefined);
});

test("missing remote snapshot has an actionable missing state without exposing native error text", async t => {
    const f = fixture(t);
    f.request = async () => { throw Object.assign(new Error("ENOENT /private/runner/token"), { code: "ENOENT" }); };
    assert.deepEqual(await f.get(), { status: "unavailable", error: "snapshot-missing" });
});

test("callers cannot mutate the cached revision or rows through returned objects", async t => {
    const f = fixture(t);
    const first = await f.get();
    first.snapshot.revision = 100;
    first.snapshot.coverage.files = 100;
    f.offline = true;
    const cached = await f.get();
    assert.equal(cached.snapshot.revision, 1);
    assert.equal(cached.snapshot.coverage.files, 2);
});

test("a snapshot becomes stale after three minutes even when the host is reachable", async t => {
    const f = fixture(t);
    f.now += 180000;
    assert.equal((await f.get()).status, "ok");
    f.now += 1;
    assert.equal((await f.get()).status, "stale");
});

test("rejects future snapshots, replayed revisions, reused revisions with changed content and retired publishers", async t => {
    const f = fixture(t);
    f.value.generatedAt = Now + 5001;
    assert.equal((await f.get()).status, "unavailable");
    f.value = sample({ revision: 2 });
    await f.get();
    f.value = sample({ revision: 1 });
    assert.equal((await f.get()).error, "snapshot-replay");
    f.value = sample({ revision: 2, generatedAt: Now + 1 });
    assert.equal((await f.get()).error, "snapshot-replay");
    f.value = sample({ publisherId: NextPublisher, generatedAt: Now + 2 });
    assert.equal((await f.get()).status, "ok");
    f.value = sample({ revision: 3, generatedAt: Now + 3 });
    const retired = await f.get();
    assert.equal(retired.error, "snapshot-replay");
    assert.equal(retired.snapshot.publisherId, NextPublisher);
});

test("host-wide revision checks also cover switching between threads", async t => {
    const f = fixture(t);
    f.value.revision = 3;
    await f.get();
    f.value.revision = 2;
    const result = await f.get({ hostId: Host, threadId: OtherThreadId });
    assert.equal(result.error, "snapshot-replay");
    assert.equal(result.snapshot.revision, 3);
});

test("a publisher cannot change machine identity within its revision stream", async t => {
    const f = fixture(t);
    await f.get();
    f.value = sample({ revision: 2, machineId: "66666666-6666-4666-8666-666666666666" });
    assert.equal((await f.get()).error, "snapshot-replay");
});

test("native thread context is checked after the read without requiring a stable atomic file revision", async t => {
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
    let fileReads = 0;
    f.metadata = (path, info) => path === File ? { ...info, modifiedAtMs: ++fileReads } : info;
    assert.equal((await f.get()).status, "ok");
});

test("rejects invalid identities and wrong native path without reading raw logs", async t => {
    const f = fixture(t);
    for (const identity of [{ hostId: "local", threadId: ThreadId }, { hostId: "bad\nhost", threadId: ThreadId },
        { hostId: Host, threadId: "../x" }]) assert.equal((await f.get(identity)).status, "unavailable");
    assert.equal(f.calls.length, 0);
    f.thread = { thread: { id: ThreadId, path: rollout(OtherThreadId) } };
    assert.equal((await f.get()).error, "snapshot-identity");
    assert.deepEqual(f.calls.map(x => x.method), ["thread/read"]);
});

test("rejects symlink or wrong-type parents before reading and checks them again afterward", async t => {
    const f = fixture(t);
    f.metadata = (path, info) => path === Directory ? { ...info, isSymlink: true } : info;
    assert.equal((await f.get()).error, "snapshot-invalid");
    assert.equal(f.calls.some(x => x.method === "fs/readFile"), false);
    let visits = 0;
    f.metadata = (path, info) => path === Directory && ++visits > 1 ? { ...info, createdAtMs: 99 } : info;
    assert.equal((await f.get()).error, "snapshot-invalid");
});

test("rejects malformed base64, non-UTF8, oversized and unrecognized JSON snapshots", async t => {
    const f = fixture(t);
    for (const payload of ["%%%", "YQ=", Buffer.from([0xff]).toString("base64"),
        Buffer.alloc(2 * 1024 * 1024 + 1, 32).toString("base64"), Buffer.from("{}").toString("base64")]) {
        f.payload = payload;
        assert.equal((await f.get()).status, "unavailable");
    }
});

test("disposal cancels in-flight requests and does not accept their eventual result", async t => {
    const f = fixture(t);
    let complete;
    let signal;
    f.request = (method, params, limits) => { signal = limits.signal; return new Promise(resolve => { complete = resolve; }); };
    const task = f.get();
    await flush();
    f.store.dispose();
    assert.equal((await task).status, "unavailable");
    assert.equal(signal.aborted, true);
    complete({ thread: { id: ThreadId, path: rollout(ThreadId) } });
    assert.equal((await f.get()).snapshot, undefined);
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
