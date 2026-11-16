// Adapted from kpkhxlgy0/session-stats (MIT), Copyright (c) 2026 kpkhxlgy0.
"use strict";

const { randomUUID } = require("node:crypto");
const { validHostId, safePath, normalizeThreadId } = require("../protocol.cjs");
const { validateMarker, MaxDemandBytes } = require("../demand-protocol.cjs");
const ReadMethods = new Set(["thread/read", "fs/getMetadata", "fs/readFile"]);

function protocolPath(value, child) {
    const safe = safePath(value);
    if (!safe) return null;
    const api = safe.pathApi;
    const parent = child === "requests" ? api.dirname(safe.filename) : safe.filename;
    if (api.basename(parent) !== child || api.basename(api.dirname(parent)) !== ".daily-usage") return null;
    return safe;
}

function validWrite(params) {
    if (!params || Object.keys(params).length !== 2 || !Object.hasOwn(params, "path")
        || !Object.hasOwn(params, "dataBase64") || typeof params.dataBase64 !== "string"
        || params.dataBase64.length > Math.ceil(MaxDemandBytes / 3) * 4) return false;
    const safe = protocolPath(params.path, "requests");
    if (!safe) return false;
    const name = safe.pathApi.basename(safe.filename);
    const id = normalizeThreadId(name.slice(0, -5));
    if (!name.endsWith(".json") || !id) return false;
    try {
        const bytes = Buffer.from(params.dataBase64, "base64");
        const text = bytes.toString("utf8");
        if (bytes.length > MaxDemandBytes || bytes.toString("base64") !== params.dataBase64
            || !Buffer.from(text).equals(bytes)) return false;
        const marker = JSON.parse(text);
        return marker.requestId === id && validateMarker(marker, { now: Date.now() }).ok;
    } catch { return false; }
}

// 页面内只保留有界的订阅状态；next 等待原生通知，不创建轮询定时器。
function watchInPage(options, rpc) {
    const { stateKey, watchId, hostId, path, expiresAtMs, cancelEvent, maxChars } = options;
    if (expiresAtMs <= Date.now()) return Promise.reject(new Error("Daily Usage watch timed out"));
    const states = window[stateKey] ??= new Map();
    if (states.size >= 32) return Promise.reject(new Error("Daily Usage watch capacity exceeded"));
    let stopped = false;
    let queued = false;
    let waiting;
    let sequence = 0;
    const request = (method, params) => rpc({ hostId, id: `${watchId}:${++sequence}`, method, params,
        expiresAtMs: Date.now() + Math.max(1, Math.min(method === "fs/unwatch" ? 1000 : 5000,
            expiresAtMs - options.startedAtMs)), maxChars, cancelEvent });
    const unwatch = () => request("fs/unwatch", { watchId }).catch(() => {});
    function stop() {
        if (stopped) return Promise.resolve();
        stopped = true;
        window.removeEventListener("message", receive);
        window.removeEventListener("pagehide", stop);
        states.delete(watchId);
        if (!states.size) delete window[stateKey];
        waiting?.reject(new Error("Daily Usage watch cancelled"));
        waiting = null;
        return unwatch();
    }
    function receive(event) {
        if (stopped || event.source != null && (event.source !== window
            || window.location.origin !== "null" && event.origin !== window.location.origin)) return;
        const message = event.data;
        if (message?.type !== "mcp-notification" || message.hostId !== hostId
            || message.method !== "fs/changed" || message.params?.watchId !== watchId) return;
        if (waiting) {
            const current = waiting;
            waiting = null;
            current.resolve();
        } else queued = true;
    }
    states.set(watchId, { dispose: stop, next() {
        if (stopped) return Promise.reject(new Error("Daily Usage watch cancelled"));
        if (queued) { queued = false; return Promise.resolve(); }
        if (!waiting) {
            let resolve;
            let reject;
            const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
            waiting = { promise, resolve, reject };
        }
        return waiting.promise;
    } });
    window.addEventListener("message", receive);
    window.addEventListener("pagehide", stop);
    return request("fs/watch", { path, watchId }).then(async () => {
        if (stopped) { await unwatch(); throw new Error("Daily Usage watch cancelled"); }
    }, async error => { await stop(); throw error; });
}

function watchOperationInPage(stateKey, watchId, action) {
    const state = window[stateKey]?.get(watchId);
    if (state) return state[action]();
    if (action === "next") return Promise.reject(new Error("Daily Usage watch disposed"));
    return Promise.resolve();
}

// 此函数整体序列化到主页面，使用现有连接；不访问 Node 或更改应用的消息处理器。
function requestInPage(options) {
    return new Promise((resolve, reject) => {
        const { hostId, id, method, params, expiresAtMs, maxChars, cancelEvent } = options;
        const transfers = new Map();
        let retainedChars = 0;
        let timer;
        let settled = false;

        function finish(error, value) {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            window.removeEventListener("message", receive);
            window.removeEventListener("pagehide", cancel);
            window.removeEventListener(cancelEvent, cancel);
            transfers.clear();
            retainedChars = 0;
            if (error) reject(error);
            else resolve(value);
        }
        function cancel(event) {
            if (!event?.detail || event.detail === id) finish(new Error("Daily Usage request cancelled"));
        }

        function removeTransfer(transfer) {
            if (transfers.get(transfer.id) !== transfer) return;
            transfers.delete(transfer.id);
            retainedChars -= transfer.size;
        }
        function route(transfer) {
            if (!transfer.hasRoot) return "unknown";
            const root = transfer.root;
            if (!root || typeof root !== "object" || Array.isArray(root)) return "foreign";
            if ((Object.hasOwn(root, "type") && root.type !== "mcp-response")
                || (Object.hasOwn(root, "hostId") && root.hostId !== hostId)) return "foreign";
            if (Object.hasOwn(root, "message")) {
                if (!root.message || typeof root.message !== "object" || Array.isArray(root.message)
                    || (Object.hasOwn(root.message, "id") && root.message.id !== id)) return "foreign";
            }
            return root.type === "mcp-response" && root.hostId === hostId && root.message?.id === id
                ? "own" : "unknown";
        }
        function save(transfer, value) {
            const parent = transfer.stack.at(-1);
            if (!parent) {
                if (transfer.hasRoot) throw new Error("Duplicate root");
                transfer.root = value;
                transfer.hasRoot = true;
            } else if (Array.isArray(parent.value)) parent.value.push(value);
            else {
                if (parent.key === null) throw new Error("Missing key");
                parent.value[parent.key] = value;
                parent.key = null;
            }
        }
        function key(transfer, value) {
            const parent = transfer.stack.at(-1);
            if (!parent || Array.isArray(parent.value) || parent.key !== null || typeof value !== "string") {
                throw new Error("Invalid key");
            }
            parent.key = value;
        }
        function consume(transfer, tokens) {
            if (!Array.isArray(tokens)) throw new Error("Invalid tokens");
            for (const token of tokens) {
                if (!token || typeof token !== "object") throw new Error("Invalid token");
                const cost = 16 + (typeof token.value === "string" ? token.value.length : 0);
                if (transfer.size + cost > maxChars) throw new Error("Response too large");
                if (transfer.strings && !["string-chunk", "string-end"].includes(token.type)) {
                    throw new Error("Unfinished string");
                }
                switch (token.type) {
                    case "array-start":
                    case "object-start": {
                        if (transfer.stack.length >= 64) throw new Error("Response too deep");
                        const value = token.type === "array-start" ? [] : Object.create(null);
                        save(transfer, value);
                        transfer.stack.push({ value, key: null });
                        break;
                    }
                    case "container-end": {
                        const parent = transfer.stack.pop();
                        if (!parent || parent.key !== null) throw new Error("Invalid container end");
                        break;
                    }
                    case "key": key(transfer, token.value); break;
                    case "value":
                        if (token.value != null && !["string", "number", "boolean"].includes(typeof token.value)) {
                            throw new Error("Invalid value");
                        }
                        save(transfer, token.value);
                        break;
                    case "string-start":
                        if (!["key", "value"].includes(token.target)) throw new Error("Invalid string target");
                        transfer.strings = [];
                        transfer.target = token.target;
                        break;
                    case "string-chunk":
                        if (!transfer.strings || typeof token.value !== "string") throw new Error("Invalid string");
                        transfer.strings.push(token.value);
                        break;
                    case "string-end": {
                        if (!transfer.strings) throw new Error("Invalid string end");
                        const value = transfer.strings.join("");
                        transfer.strings = null;
                        if (transfer.target === "key") key(transfer, value);
                        else save(transfer, value);
                        break;
                    }
                    default: throw new Error("Unknown token");
                }
                const routing = route(transfer);
                if (routing === "foreign") {
                    removeTransfer(transfer);
                    return;
                }
                if (retainedChars + cost > maxChars && routing === "own") {
                    // 已匹配的响应优先保留；未识别的旁路消息不能占满它的预算。
                    for (const candidate of transfers.values()) {
                        if (candidate !== transfer && route(candidate) !== "own") removeTransfer(candidate);
                        if (retainedChars + cost <= maxChars) break;
                    }
                }
                if (retainedChars + cost > maxChars) throw new Error("Response decoding budget exceeded");
                transfer.size += cost;
                retainedChars += cost;
            }
        }
        function decode(message) {
            if (message?.marker !== "codex-host-chunked-message-v1") return message;
            if (typeof message.transferId !== "string" || !Number.isSafeInteger(message.sequence)
                || message.sequence < 0) return null;
            const transfer = transfers.get(message.transferId);
            if (message.kind === "start") {
                if (transfer) removeTransfer(transfer);
                // 未识别的额外 start 不驱逐已有流，且标识符本身也计入保留预算。
                else if (transfers.size < 16 && retainedChars + message.transferId.length <= maxChars) {
                    transfers.set(message.transferId, { id: message.transferId, next: message.sequence + 1,
                        stack: [], hasRoot: false, strings: null, size: message.transferId.length });
                    retainedChars += message.transferId.length;
                }
                return null;
            }
            if (!transfer) return null;
            if (transfer.next++ !== message.sequence) { removeTransfer(transfer); return null; }
            try {
                if (message.kind === "chunk") { consume(transfer, message.tokens); return null; }
                if (message.kind !== "end" || !transfer.hasRoot || transfer.stack.length || transfer.strings) {
                    throw new Error("Incomplete response");
                }
                const result = transfer.root;
                removeTransfer(transfer);
                return result;
            } catch (error) {
                const partial = transfer.root;
                if (error.message === "Response too large" && method === "fs/readFile"
                    && partial?.type === "mcp-response" && partial.hostId === hostId && partial.message?.id === id) {
                    finish(new Error("Remote Daily Usage snapshot exceeds size limit"));
                }
                removeTransfer(transfer);
                return null;
            }
        }
        function receive(event) {
            // 原生 preload 派发的 MessageEvent 没有 source；不接收 iframe 的消息。
            if (event.source != null && (event.source !== window
                || (window.location.origin !== "null" && event.origin !== window.location.origin))) return;
            const message = decode(event.data);
            if (message?.type !== "mcp-response" || message.hostId !== hostId || message.message?.id !== id) return;
            const response = message.message;
            if (response.error || !Object.hasOwn(response, "result")) {
                const missing = response.error?.code === "ENOENT" || response.error?.data?.code === "ENOENT"
                    || /^(?:ENOENT\b|No such file or directory\b|The system cannot find the (?:file|path) specified\b)|\(os error [23]\)\s*$/i
                        .test(String(response.error?.message ?? ""));
                finish(new Error(missing ? "Remote Daily Usage source not found" : "Remote Daily Usage request failed"));
            } else {
                try {
                    if (JSON.stringify(response.result).length > maxChars) {
                        finish(new Error("Remote Daily Usage snapshot exceeds size limit"));
                    } else finish(null, response.result);
                } catch { finish(new Error("Remote Daily Usage response invalid")); }
            }
        }

        const remainingMs = expiresAtMs - Date.now();
        if (remainingMs <= 0) {
            finish(new Error("Remote Daily Usage request timed out"));
            return;
        }
        if (typeof window.electronBridge?.sendMessageFromView !== "function") {
            finish(new Error("Codex host bridge unavailable"));
            return;
        }
        window.addEventListener("message", receive);
        window.addEventListener("pagehide", cancel);
        window.addEventListener(cancelEvent, cancel);
        timer = window.setTimeout(() => finish(new Error("Remote Daily Usage request timed out")), remainingMs);
        // ACK 由 Codex 自己的接收器负责；这里只旁听，避免重复确认影响应用消息流。
        try {
            Promise.resolve(window.electronBridge.sendMessageFromView({ type: "mcp-request", hostId,
                request: { id, method, params }, timeoutMs: remainingMs }))
                .catch(() => finish(new Error("Codex host bridge unavailable")));
        } catch { finish(new Error("Codex host bridge unavailable")); }
    });
}

function createRemoteTransport({ timeoutMs = 5000, maxChars = 3 * 1024 * 1024 } = {}) {
    if (![timeoutMs, maxChars].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new Error("Invalid remote request limits");
    }
    timeoutMs = Math.min(timeoutMs, 5000);
    maxChars = Math.min(maxChars, 3 * 1024 * 1024);
    const pending = new Set();
    const cancelEvent = `daily-usage-cancel-${randomUUID()}`;
    const stateKey = `__dailyUsageWatch_${randomUUID()}`;
    const watches = new Set();
    let disposed = false;

    function cancelPage(frame, id) {
        try {
            const source = `window.dispatchEvent(new CustomEvent(${JSON.stringify(cancelEvent)}, `
                + `{detail:${JSON.stringify(id ?? null)}}))`;
            Promise.resolve(frame.executeJavaScript(source)).catch(() => {});
        } catch { /* 页面已销毁时无需清理页面监听器。 */ }
    }

    async function request(frame, hostId, method, params, limits = {}) {
        if (disposed || !(ReadMethods.has(method) || method === "fs/writeFile" && validWrite(params))
            || !validHostId(hostId)
            || typeof frame?.executeJavaScript !== "function") throw new Error("Remote Daily Usage request unavailable");
        if (!limits || typeof limits !== "object" || Array.isArray(limits)
            || ["timeoutMs", "maxChars"].some(key => limits[key] !== undefined
                && (!Number.isSafeInteger(limits[key]) || limits[key] <= 0))
            || limits.signal !== undefined && (typeof limits.signal?.addEventListener !== "function"
                || typeof limits.signal?.removeEventListener !== "function")) {
            throw new Error("Invalid remote request limits");
        }
        if (limits.signal?.aborted) throw new Error("Daily Usage request cancelled");
        const requestTimeoutMs = Math.min(timeoutMs, limits.timeoutMs ?? Infinity);
        const responseLimit = Math.min(maxChars, limits.maxChars ?? Infinity);
        const options = { hostId, id: `daily-usage:${randomUUID()}`, method, params,
            expiresAtMs: Date.now() + requestTimeoutMs, maxChars: responseLimit, cancelEvent };
        let timer;
        let abort;
        const entry = { frame };
        pending.add(entry);
        try {
            return await new Promise((resolve, reject) => {
                entry.reject = reject;
                abort = () => {
                    cancelPage(frame, options.id);
                    reject(new Error("Daily Usage request cancelled"));
                };
                limits.signal?.addEventListener("abort", abort, { once: true });
                if (limits.signal?.aborted) { abort(); return; }
                timer = setTimeout(() => {
                    cancelPage(frame, options.id);
                    reject(new Error("Remote Daily Usage request timed out"));
                }, requestTimeoutMs);
                Promise.resolve(frame.executeJavaScript(`(${requestInPage.toString()})(${JSON.stringify(options)})`))
                    .then(resolve, reject);
            });
        } catch (error) {
            const message = String(error?.message ?? error);
            if (message.includes("Remote Daily Usage source not found")) {
                throw Object.assign(new Error("Remote Daily Usage source not found"), { code: "ENOENT" });
            }
            if (message.includes("exceeds size limit")) {
                throw Object.assign(new Error("Remote Daily Usage snapshot exceeds size limit"),
                    { code: "DAILY_USAGE_SNAPSHOT_TOO_LARGE" });
            }
            throw error;
        } finally {
            clearTimeout(timer);
            limits.signal?.removeEventListener("abort", abort);
            pending.delete(entry);
        }
    }

    async function watch(frame, hostId, path, { signal } = {}) {
        if (disposed || !validHostId(hostId) || !protocolPath(path, "responses")
            || typeof frame?.executeJavaScript !== "function") throw new Error("Daily Usage watch unavailable");
        if (signal !== undefined && (typeof signal?.addEventListener !== "function"
            || typeof signal?.removeEventListener !== "function")) throw new Error("Invalid watch signal");
        if (signal?.aborted) throw new Error("Daily Usage watch cancelled");
        if (watches.size >= 32) throw new Error("Daily Usage watch capacity exceeded");
        const watchId = `daily-usage-watch:${randomUUID()}`;
        const operation = action => {
            try {
                return Promise.resolve(frame.executeJavaScript(`(${watchOperationInPage.toString()})`
                    + `(${JSON.stringify(stateKey)},${JSON.stringify(watchId)},${JSON.stringify(action)})`));
            } catch (error) { return Promise.reject(error); }
        };
        let stopped = false;
        let rejectStart;
        let cleanup;
        let timer;
        const entry = { dispose() {
            if (stopped) return cleanup ?? Promise.resolve();
            stopped = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            watches.delete(entry);
            rejectStart?.(new Error("Daily Usage watch cancelled"));
            cleanup = operation("dispose").catch(() => {});
            return cleanup;
        } };
        const abort = () => { void entry.dispose(); };
        watches.add(entry);
        signal?.addEventListener("abort", abort, { once: true });
        const startedAtMs = Date.now();
        const options = { stateKey, watchId, hostId, path, startedAtMs, expiresAtMs: startedAtMs + timeoutMs,
            cancelEvent: `${cancelEvent}:watch`, maxChars: Math.min(maxChars, 64 * 1024) };
        try {
            await new Promise((resolve, reject) => {
                rejectStart = reject;
                if (signal?.aborted) { abort(); return; }
                timer = setTimeout(() => {
                    void entry.dispose();
                    reject(new Error("Daily Usage watch timed out"));
                }, timeoutMs);
                Promise.resolve(frame.executeJavaScript(`(${watchInPage.toString()})`
                    + `(${JSON.stringify(options)},${requestInPage.toString()})`)).then(resolve, reject);
            });
            clearTimeout(timer);
            rejectStart = null;
            if (stopped) throw new Error("Daily Usage watch cancelled");
            return { next() {
                return stopped ? Promise.reject(new Error("Daily Usage watch cancelled")) : operation("next");
            }, dispose: entry.dispose };
        } catch (error) {
            void entry.dispose();
            throw error;
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const entry of [...watches]) void entry.dispose();
        for (const frame of new Set([...pending].map(entry => entry.frame))) cancelPage(frame);
        for (const entry of pending) entry.reject(new Error("Daily Usage disabled"));
        pending.clear();
    }

    return { request, watch, dispose };
}

module.exports = { createRemoteTransport };
