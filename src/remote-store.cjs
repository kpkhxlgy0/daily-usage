"use strict";

const { randomUUID } = require("node:crypto");
const { snapshotContext, normalizeThreadId, validHostId, StaleAfterMs, FutureSkewMs } = require("./protocol.cjs");
const { demandPaths, makeMarker, validateCapabilities, validateResult,
    MaxDemandBytes, MaxResultBytes, MaxDemandMs } = require("./demand-protocol.cjs");

const RpcTimeoutMs = 5000;
const CleanupTimeoutMs = 1000;
const MaxResponseChars = 3 * 1024 * 1024;
const MaxHosts = 32;
const MaxPublishers = 64;
const MaxActive = 32;
const failure = reason => Object.assign(new Error(reason), { reason });
const aborted = () => Object.assign(new Error("Daily Usage request cancelled"), { name: "AbortError", code: "ABORT_ERR" });

function createRemoteStore({ now = Date.now } = {}) {
    if (typeof now !== "function") throw new TypeError("A snapshot clock is required");
    const hosts = new Map();
    const active = new Map();
    let disposed = false;
    let disposal;

    function bounded(operation, signal, timeoutMs, reason = "snapshot-unavailable") {
        const controller = new AbortController();
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", cancel);
                if (error) { controller.abort(); reject(error); }
                else resolve(value);
            };
            const cancel = () => finish(aborted());
            signal?.addEventListener("abort", cancel, { once: true });
            if (signal?.aborted) { cancel(); return; }
            timer = setTimeout(() => finish(failure(reason)), Math.max(1, timeoutMs));
            Promise.resolve().then(() => {
                if (controller.signal.aborted) throw aborted();
                return operation(controller.signal);
            }).then(value => finish(null, value), error => finish(error));
        });
    }

    function metadata(value, directory, limit = MaxResultBytes) {
        if (!value || value.isFile !== !directory || value.isDirectory !== directory || value.isSymlink !== false
            || !Number.isFinite(value.createdAtMs) || value.createdAtMs < 0
            || !Number.isFinite(value.modifiedAtMs) || value.modifiedAtMs < 0
            || !directory && value.size !== undefined && (!Number.isSafeInteger(value.size)
                || value.size < 0 || value.size > limit)) throw failure("snapshot-invalid");
        return value;
    }

    function context(response, threadId) {
        if (normalizeThreadId(response?.thread?.id) !== threadId) throw failure("snapshot-identity");
        const target = snapshotContext(response.thread.path, threadId);
        if (!target) throw failure("snapshot-identity");
        return target;
    }

    function decode(value, limit) {
        if (typeof value !== "string" || value.length > MaxResponseChars || value.length % 4 !== 0
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure("snapshot-invalid");
        const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        if (value.length / 4 * 3 - padding > limit) throw failure("snapshot-invalid");
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

    async function probe(entry, threadId, request, watch, signal) {
        const deadline = Date.now() + MaxDemandMs;
        let subscription;
        let marker;
        let markerPath;
        let markerAttempted = false;
        let completed = false;
        const remaining = () => {
            const value = deadline - Date.now();
            if (value <= 0) throw failure("snapshot-timeout");
            if (signal.aborted || disposed) throw aborted();
            return value;
        };
        const rpc = (method, params) => {
            const timeoutMs = Math.min(RpcTimeoutMs, remaining());
            return bounded(childSignal => request(method, params, { timeoutMs,
                maxChars: method === "fs/readFile" ? MaxResponseChars : 64 * 1024, signal: childSignal }),
            signal, timeoutMs);
        };
        try {
            const target = context(await rpc("thread/read", { threadId, includeTurns: false }), threadId);
            const paths = demandPaths(target.codexHome, target.pathApi);
            const parents = [target.codexHome, paths.directory, paths.requests, paths.responses];
            const inspect = () => Promise.all(parents.map(async path => {
                try { return metadata(await rpc("fs/getMetadata", { path }), true); }
                catch (error) {
                    if (error.code === "ENOENT" && path !== target.codexHome) throw failure("snapshot-update-required");
                    throw error;
                }
            }));
            const before = await inspect();
            const capabilities = async () => {
                try {
                    metadata(await rpc("fs/getMetadata", { path: paths.capabilities }), false, MaxDemandBytes);
                    const value = decode((await rpc("fs/readFile", { path: paths.capabilities }))?.dataBase64, MaxDemandBytes);
                    if (!validateCapabilities(value).ok) throw failure("snapshot-update-required");
                    return value;
                } catch (error) {
                    if (error.code === "ENOENT") throw failure("snapshot-update-required");
                    throw error;
                }
            };
            const peer = await capabilities();
            try {
                subscription = await bounded(childSignal => {
                    const pending = Promise.resolve(watch(paths.responses, { signal }));
                    pending.then(value => {
                        if (childSignal.aborted && typeof value?.dispose === "function") {
                            void Promise.resolve().then(() => value.dispose()).catch(() => {});
                        }
                    }, () => {});
                    return pending;
                }, signal, Math.min(RpcTimeoutMs, remaining()));
                if (typeof subscription?.next !== "function" || typeof subscription.dispose !== "function") {
                    throw failure("snapshot-update-required");
                }
            } catch (error) {
                if (signal.aborted || disposed) throw aborted();
                throw failure("snapshot-update-required");
            }
            marker = makeMarker(randomUUID(), now());
            markerPath = target.pathApi.join(paths.requests, `${marker.requestId}.json`);
            const responsePath = target.pathApi.join(paths.responses, `${marker.requestId}.json`);
            markerAttempted = true;
            await rpc("fs/writeFile", { path: markerPath,
                dataBase64: Buffer.from(JSON.stringify(marker), "utf8").toString("base64") });
            // 订阅先于写入；立即读一次捕获响应早于 ACK 的情况，其后仅由通知驱动。
            while (true) {
                let value;
                try {
                    metadata(await rpc("fs/getMetadata", { path: responsePath }), false);
                    value = decode((await rpc("fs/readFile", { path: responsePath }))?.dataBase64, MaxResultBytes);
                } catch (error) {
                    if (error.code !== "ENOENT") throw error;
                }
                if (value !== undefined) {
                    const checked = validateResult(value, { requestId: marker.requestId,
                        publisherId: peer.publisherId, now: now() });
                    if (!checked.ok) throw failure(`snapshot-${checked.reason}`);
                    if (value.updatedAt + FutureSkewMs < marker.requestedAt) throw failure("snapshot-replay");
                    if (value.status === "error") throw failure("snapshot-unavailable");
                    if (value.status === "cancelled") throw failure("snapshot-cancelled");
                    if (value.status === "ok") {
                        const [after, native, confirmedPeer] = await Promise.all([inspect(),
                            rpc("thread/read", { threadId, includeTurns: false }), capabilities()]);
                        const confirmed = context(native, threadId);
                        const canonical = value => target.pathApi.sep === "\\" ? value.toLowerCase() : value;
                        if (canonical(confirmed.codexHome) !== canonical(target.codexHome)
                            || confirmedPeer.publisherId !== peer.publisherId) throw failure("snapshot-identity");
                        // 原子发布可替换文件；父目录创建标识必须在读取前后保持一致。
                        if (before.some((value, index) => value.createdAtMs !== after[index].createdAtMs)) {
                            throw failure("snapshot-invalid");
                        }
                        remaining();
                        accept(entry, value.snapshot);
                        completed = true;
                        return;
                    }
                }
                await bounded(() => subscription.next(), signal, remaining(), "snapshot-timeout");
            }
        } finally {
            const cleanup = [];
            if (markerAttempted && !completed && marker.expiresAt > now()) {
                const cancel = makeMarker(marker.requestId, now(), "cancel", marker);
                cleanup.push(bounded(cleanupSignal => request("fs/writeFile", { path: markerPath,
                    dataBase64: Buffer.from(JSON.stringify(cancel), "utf8").toString("base64") },
                { timeoutMs: CleanupTimeoutMs, maxChars: 64 * 1024, signal: cleanupSignal }),
                undefined, CleanupTimeoutMs).catch(() => {}));
            }
            if (subscription) {
                cleanup.push(bounded(() => subscription.dispose(), undefined, CleanupTimeoutMs).catch(() => {}));
            }
            await Promise.all(cleanup);
        }
    }

    function result(entry, error) {
        if (disposed || !entry?.accepted) return { status: "unavailable", error: error ?? "snapshot-unavailable" };
        const age = now() - entry.accepted.generatedAt;
        if (age < -FutureSkewMs) return { status: "unavailable", error: "snapshot-future" };
        const stale = error || age > StaleAfterMs;
        // 调用方获得副本，不能修改缓存中的版本或统计字段。
        return { status: stale ? "stale" : "ok", snapshot: JSON.parse(entry.text),
            ...(stale ? { error: error ?? "snapshot-stale" } : {}) };
    }

    async function get(identity, request, { signal, watch } = {}) {
        const hostId = identity?.hostId;
        const threadId = normalizeThreadId(identity?.threadId);
        if (disposed || !validHostId(hostId) || !threadId || typeof request !== "function") {
            return { status: "unavailable", error: disposed ? "snapshot-cancelled" : "snapshot-identity" };
        }
        if (signal?.aborted) throw aborted();
        let entry = hosts.get(hostId);
        if (!entry) {
            if (hosts.size >= MaxHosts) return { status: "unavailable", error: "snapshot-capacity" };
            entry = { accepted: null, text: null, retired: new Set() };
            hosts.set(hostId, entry);
        }
        if (typeof watch !== "function") return result(entry, "snapshot-update-required");
        if (active.size >= MaxActive) return result(entry, "snapshot-capacity");
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        let finish;
        active.set(controller, new Promise(resolve => { finish = resolve; }));
        if (signal?.aborted) cancel();
        try {
            await probe(entry, threadId, request, watch, controller.signal);
            if (controller.signal.aborted) throw aborted();
            return result(entry);
        } catch (error) {
            if (controller.signal.aborted || disposed || error.name === "AbortError") throw aborted();
            return result(entry, error.reason ?? (error.code === "ENOENT" ? "snapshot-missing" : "snapshot-unavailable"));
        } finally {
            controller.abort();
            active.delete(controller);
            signal?.removeEventListener("abort", cancel);
            finish();
        }
    }

    function dispose() {
        if (disposed) return disposal;
        disposed = true;
        disposal = Promise.all([...active.values()]).then(() => {});
        for (const controller of active.keys()) controller.abort();
        hosts.clear();
        return disposal;
    }

    return { get, dispose };
}

module.exports = { createRemoteStore };
