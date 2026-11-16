"use strict";

const { validateSnapshot, snapshotContext, normalizeThreadId, validHostId,
    MaxSnapshotBytes, StaleAfterMs, FutureSkewMs } = require("./protocol.cjs");

const TimeoutMs = 5000;
const MaxResponseChars = 3 * 1024 * 1024;
const MaxHosts = 32;
const MaxPublishers = 64;
const failure = reason => Object.assign(new Error(reason), { reason });

function createRemoteStore({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("A snapshot clock is required");
    const hosts = new Map();
    const pending = new Set();
    let disposed = false;

    function call(request, method, params, deadline) {
        if (disposed) return Promise.reject(failure("snapshot-cancelled"));
        const remaining = deadline - Date.now();
        if (remaining <= 0) return Promise.reject(failure("snapshot-unavailable"));
        const controller = new AbortController();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                pending.delete(cancel);
                if (error) { controller.abort(); reject(error); }
                else resolve(value);
            };
            const cancel = () => finish(failure("snapshot-cancelled"));
            const timer = setTimeout(() => finish(failure("snapshot-unavailable")), remaining);
            pending.add(cancel);
            Promise.resolve().then(() => {
                if (disposed) throw failure("snapshot-cancelled");
                return request(method, params, { timeoutMs: remaining,
                    maxChars: method === "fs/readFile" ? MaxResponseChars : 64 * 1024, signal: controller.signal });
            }).then(value => finish(null, value), error => finish(error));
        });
    }

    function metadata(value, directory) {
        if (!value || value.isFile !== !directory || value.isDirectory !== directory || value.isSymlink !== false
            || !Number.isFinite(value.createdAtMs) || value.createdAtMs < 0
            || !Number.isFinite(value.modifiedAtMs) || value.modifiedAtMs < 0
            || !directory && value.size !== undefined && (!Number.isSafeInteger(value.size)
                || value.size < 0 || value.size > MaxSnapshotBytes)) throw failure("snapshot-invalid");
        return value;
    }

    function context(response, threadId) {
        if (normalizeThreadId(response?.thread?.id) !== threadId) throw failure("snapshot-identity");
        const target = snapshotContext(response.thread.path, threadId);
        if (!target) throw failure("snapshot-identity");
        return target;
    }

    function decode(value) {
        if (typeof value !== "string" || value.length > MaxResponseChars || value.length % 4 !== 0
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure("snapshot-invalid");
        const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        if (value.length / 4 * 3 - padding > MaxSnapshotBytes) throw failure("snapshot-invalid");
        const bytes = Buffer.from(value, "base64");
        if (bytes.toString("base64") !== value) throw failure("snapshot-invalid");
        const text = bytes.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(bytes)) throw failure("snapshot-invalid");
        try { return JSON.parse(text); }
        catch { throw failure("snapshot-invalid"); }
    }

    function accept(entry, snapshot) {
        const previous = entry.accepted;
        const text = JSON.stringify(snapshot);
        if (previous) {
            if (snapshot.publisherId === previous.publisherId) {
                if (snapshot.machineId !== previous.machineId || snapshot.revision < previous.revision
                    || snapshot.generatedAt < previous.generatedAt
                    || snapshot.revision === previous.revision && text !== entry.text) throw failure("snapshot-replay");
            } else {
                if (entry.retired.has(snapshot.publisherId) || snapshot.generatedAt < previous.generatedAt
                    || entry.retired.size >= MaxPublishers) throw failure("snapshot-replay");
                entry.retired.add(previous.publisherId);
            }
        }
        entry.accepted = snapshot;
        entry.text = text;
    }

    async function probe(entry, threadId, request) {
        const deadline = Date.now() + TimeoutMs;
        const rpc = (method, params) => call(request, method, params, deadline);
        const target = context(await rpc("thread/read", { threadId, includeTurns: false }), threadId);
        const paths = [target.codexHome, target.directory, target.file];
        const inspect = async () => {
            const values = await Promise.allSettled(paths.map(async (path, index) =>
                metadata(await rpc("fs/getMetadata", { path }), index !== 2)));
            const failed = values.find(value => value.status === "rejected");
            if (failed) throw failed.reason;
            return values.map(value => value.value);
        };
        const before = await inspect();
        const value = decode((await rpc("fs/readFile", { path: target.file }))?.dataBase64);
        const [after, native] = await Promise.all([inspect(), rpc("thread/read", { threadId, includeTurns: false })]);
        const confirmed = context(native, threadId);
        const canonical = value => target.pathApi.sep === "\\" ? value.toLowerCase() : value;
        if (canonical(confirmed.file) !== canonical(target.file)) throw failure("snapshot-identity");
        // 原子发布可替换文件；父目录创建标识必须在读取前后保持一致。
        if (before.slice(0, 2).some((value, index) => value.createdAtMs !== after[index].createdAtMs)) {
            throw failure("snapshot-invalid");
        }
        const checked = validateSnapshot(value, { now: now() });
        if (!checked.ok) throw failure(`snapshot-${checked.reason}`);
        if (disposed) throw failure("snapshot-cancelled");
        accept(entry, value);
    }

    function result(entry, error) {
        if (disposed || !entry?.accepted) return { status: "unavailable", error: error ?? "snapshot-unavailable" };
        const snapshot = entry.accepted;
        const age = now() - snapshot.generatedAt;
        if (age < -FutureSkewMs) return { status: "unavailable", error: "snapshot-future" };
        const stale = error || age > StaleAfterMs;
        // 调用方获得副本，不能修改缓存中的版本或统计字段。
        return { status: stale ? "stale" : "ok", snapshot: JSON.parse(entry.text),
            ...(stale ? { error: error ?? "snapshot-stale" } : {}) };
    }

    async function get(identity, request) {
        const hostId = identity?.hostId;
        const threadId = normalizeThreadId(identity?.threadId);
        if (disposed || !validHostId(hostId) || !threadId || typeof request !== "function") {
            return { status: "unavailable", error: disposed ? "snapshot-cancelled" : "snapshot-identity" };
        }
        let entry = hosts.get(hostId);
        if (!entry) {
            if (hosts.size >= MaxHosts) return { status: "unavailable", error: "snapshot-capacity" };
            entry = { accepted: null, text: null, retired: new Set(), task: null };
            hosts.set(hostId, entry);
        }
        if (!entry.task) {
            entry.task = probe(entry, threadId, request).then(() => null,
                error => error.reason ?? (error.code === "ENOENT" ? "snapshot-missing" : "snapshot-unavailable"));
        }
        const task = entry.task;
        const error = await task;
        if (entry.task === task) entry.task = null;
        return result(entry, error);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const cancel of [...pending]) cancel();
        hosts.clear();
    }

    return { get, dispose };
}

module.exports = { createRemoteStore };
