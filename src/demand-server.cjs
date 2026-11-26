'use strict';

const nativeFs = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { normalizeThreadId, validateSnapshot, snapshotForPeer } = require('./protocol.cjs');
const { demandPaths, validateMarker, validateCapabilities, validateResult,
    MaxDemandBytes, MaxResultBytes } = require('./demand-protocol.cjs');

const MaxConcurrentRequests = 8;
const MaxTrackedRequests = 1024;
const SharingRetryMs = 25;
const owns = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
const sameFile = (one, two) => one.dev === two.dev && one.ino === two.ino;

async function directoryInfo(directory, create = false)
{
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !owns(info)) throw new Error('unsafe-demand-directory');
    return info;
}

async function readOwnedJson(file, maxBytes)
{
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || !owns(before) || before.size > maxBytes)
        throw new Error('unsafe-demand-file');
    const handle = await fs.open(file, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0));
    try
    {
        const after = await handle.stat();
        if (!after.isFile() || !owns(after) || !sameFile(before, after) || after.size > maxBytes)
            throw new Error('unsafe-demand-file');
        const bytes = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < bytes.length)
        {
            const read = await handle.read(bytes, size, bytes.length - size, null);
            if (!read.bytesRead) break;
            size += read.bytesRead;
        }
        if (size > maxBytes) throw new Error('oversized-demand-file');
        return JSON.parse(bytes.toString('utf8', 0, size));
    }
    finally { await handle.close(); }
}

function createDemandServer({ codexHome, service, now = Date.now })
{
    const paths = demandPaths(codexHome);
    const publisherId = randomUUID();
    const lifetime = new AbortController();
    const entries = new Map();
    const reads = new Map();
    const tasks = new Set();
    let stopped = false;
    let watcher;
    let activeCount = 0;
    let disposal;
    let rootInfo;
    let requestInfo;
    let responseInfo;
    let sweeping = false;

    function track(promise)
    {
        const safe = promise.catch(() => {});
        tasks.add(safe);
        safe.finally(() => tasks.delete(safe));
        return safe;
    }

    async function checkDirectories()
    {
        if (!sameFile(rootInfo, await directoryInfo(paths.directory))
            || !sameFile(requestInfo, await directoryInfo(paths.requests))
            || !sameFile(responseInfo, await directoryInfo(paths.responses)))
            throw new Error('demand-directory-changed');
    }

    async function atomicWrite(file, value, valid, signal = lifetime.signal)
    {
        if (stopped || !valid()) return;
        await checkDirectories();
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        try
        {
            await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
            let retried = false;
            for (;;)
            {
                await checkDirectories();
                if (stopped || !valid()) return;
                try
                {
                    // 最终判定与原子提交不让出事件循环；提交后的取消不撤销已发布文件。
                    nativeFs.renameSync(temporary, file);
                    break;
                }
                catch (error)
                {
                    if (retried || process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
                    retried = true;
                    await delay(SharingRetryMs, undefined, { signal });
                }
            }
        }
        finally
        {
            await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
    }

    function publish(entry, status, extras = {})
    {
        const value = { schemaVersion: 1, source: 'com.kpk.daily-usage', demandVersion: 1,
            requestId: entry.marker.requestId, publisherId, updatedAt: now(), status, ...extras };
        const valid = () => entries.get(entry.marker.requestId) === entry
            && (status === 'cancelled' ? entry.cancelled : !entry.cancelled);
        entry.writing = (entry.writing || Promise.resolve()).catch(() => {}).then(async () =>
        {
            if (!valid() || stopped) return;
            if (!validateResult(value, { requestId: entry.marker.requestId, publisherId, now: now() }).ok
                || Buffer.byteLength(JSON.stringify(value)) > MaxResultBytes) throw new Error('invalid-demand-result');
            const signal = status === 'cancelled' ? lifetime.signal : entry.controller?.signal || lifetime.signal;
            await atomicWrite(path.join(paths.responses, `${entry.marker.requestId}.json`), value, valid, signal);
        });
        track(entry.writing);
        return entry.writing;
    }

    function finish(entry)
    {
        clearTimeout(entry.timer);
        entry.timer = null;
        if (entry.active)
        {
            entry.active = false;
            activeCount--;
        }
    }

    function cancel(entry)
    {
        if (entry.cancelled) return;
        entry.cancelled = true;
        entry.sequence = 2;
        finish(entry);
        entry.controller?.abort();
        publish(entry, 'cancelled');
    }

    function cleanupExpired()
    {
        for (const [id, entry] of entries)
        {
            if (entry.marker.expiresAt > now()) continue;
            if (entry.active) cancel(entry);
            entries.delete(id);
            track((async () =>
            {
                await entry.writing?.catch(() => {});
                if (stopped) return;
                await checkDirectories();
                const requestFile = path.join(paths.requests, `${id}.json`);
                try
                {
                    const marker = await readOwnedJson(requestFile, MaxDemandBytes);
                    if (!entries.has(id) && marker.requestId === id && marker.expiresAt <= now()
                        && validateMarker(marker, { now: marker.requestedAt }).ok) await fs.unlink(requestFile);
                }
                catch { /* 仅清理由本协议确认归属且已过期的文件。 */ }
                const resultFile = path.join(paths.responses, `${id}.json`);
                try
                {
                    const result = await readOwnedJson(resultFile, MaxResultBytes);
                    if (!entries.has(id) && validateResult(result, { requestId: id, publisherId, now: now() }).ok)
                        await fs.unlink(resultFile);
                }
                catch { /* 其他发布者的响应由其自身管理。 */ }
            })());
        }
        if (sweeping) return;
        sweeping = true;
        track((async () =>
        {
            try
            {
                await checkDirectories();
                const directory = await fs.opendir(paths.requests);
                let inspected = 0;
                for await (const file of directory)
                {
                    if (stopped || inspected++ >= MaxTrackedRequests) break;
                    const id = file.name.endsWith('.json') && normalizeThreadId(file.name.slice(0, -5));
                    if (!file.isFile() || !id || entries.has(id)) continue;
                    try
                    {
                        const requestFile = path.join(paths.requests, file.name);
                        const marker = await readOwnedJson(requestFile, MaxDemandBytes);
                        if (marker.requestId !== id || marker.expiresAt > now()
                            || !validateMarker(marker, { now: marker.requestedAt }).ok) continue;
                        await checkDirectories();
                        if (stopped || entries.has(id)) continue;
                        await fs.unlink(requestFile);
                        const resultFile = path.join(paths.responses, `${id}.json`);
                        const result = await readOwnedJson(resultFile, MaxResultBytes);
                        if (!entries.has(id) && validateResult(result,
                            { requestId: id, publisherId: result.publisherId, now: now() }).ok)
                            await fs.unlink(resultFile);
                    }
                    catch { /* 旧实例仅保留可确认归属的过期协议文件。 */ }
                }
            }
            finally { sweeping = false; }
        })());
    }

    async function run(entry)
    {
        try
        {
            await publish(entry, 'running');
            if (stopped || entry.cancelled) return;
            const state = await service.query({ signal: entry.controller.signal });
            if (stopped || entry.cancelled) return;
            finish(entry);
            if (state?.status === 'ok')
            {
                if (!validateSnapshot(state.snapshot, { now: now() }).ok) throw new Error('invalid-report');
                const snapshot = { ...snapshotForPeer(state.snapshot, entry.marker.snapshotVersion), publisherId };
                await publish(entry, 'ok', { snapshot });
            }
            else await publish(entry, 'error', { error: 'collector-failed' });
        }
        catch
        {
            if (!stopped && !entry.cancelled)
            {
                finish(entry);
                await publish(entry, 'error', { error: 'collector-failed' });
            }
        }
        finally { finish(entry); }
    }

    async function processFile(filename)
    {
        if (stopped) return;
        await checkDirectories();
        const id = normalizeThreadId(filename.slice(0, -5));
        const marker = await readOwnedJson(path.join(paths.requests, filename), MaxDemandBytes);
        if (stopped || marker.requestId !== id || !validateMarker(marker, { now: now() }).ok) return;
        cleanupExpired();
        const previous = entries.get(id);
        if (previous)
        {
            if (marker.requestedAt !== previous.marker.requestedAt || marker.expiresAt !== previous.marker.expiresAt
                || marker.sequence <= previous.sequence) return;
            cancel(previous);
            return;
        }
        if (entries.size >= MaxTrackedRequests) return;
        const entry = { marker, sequence: marker.sequence };
        entries.set(id, entry);
        if (marker.action === 'cancel')
        {
            cancel(entry);
            return;
        }
        if (activeCount >= MaxConcurrentRequests)
        {
            publish(entry, 'error', { error: 'runner-busy' });
            return;
        }
        entry.controller = new AbortController();
        entry.active = true;
        activeCount++;
        entry.timer = setTimeout(() => cancel(entry), Math.max(1, marker.expiresAt - now()));
        entry.timer.unref?.();
        track(run(entry));
    }

    function changed(event, filename)
    {
        if (stopped || filename === null) return;
        const name = String(filename);
        if (!/^[0-9a-f-]{36}\.json$/i.test(name) || !normalizeThreadId(name.slice(0, -5))) return;
        const current = reads.get(name);
        if (current)
        {
            current.dirty = true;
            return;
        }
        const reading = { dirty: true };
        reads.set(name, reading);
        track((async () =>
        {
            try
            {
                while (reading.dirty && !stopped)
                {
                    reading.dirty = false;
                    await processFile(name).catch(() => {});
                }
            }
            finally { reads.delete(name); }
        })());
    }

    const ready = (async () =>
    {
        rootInfo = await directoryInfo(paths.directory, true);
        requestInfo = await directoryInfo(paths.requests, true);
        responseInfo = await directoryInfo(paths.responses, true);
        if (stopped) return;
        watcher = nativeFs.watch(paths.requests, { persistent: false }, changed);
        watcher.on('error', () => { void dispose(); });
        const capabilities = { schemaVersion: 1, source: 'com.kpk.daily-usage', demandVersion: 1, publisherId };
        await atomicWrite(paths.capabilities, capabilities, () => true);
        try { await atomicWrite(paths.capabilitiesV2, capabilities, () => true); }
        catch { /* 周快照协商不可用时仍能处理原有日报请求。 */ }
    })();

    function dispose()
    {
        if (disposal) return disposal;
        stopped = true;
        lifetime.abort();
        watcher?.close();
        for (const entry of entries.values())
        {
            finish(entry);
            entry.cancelled = true;
            entry.controller?.abort();
        }
        disposal = (async () =>
        {
            await ready.catch(() => {});
            await Promise.all([...tasks]);
            if (!rootInfo || !requestInfo || !responseInfo) return;
            for (const filename of [paths.capabilities, paths.capabilitiesV2])
            {
                try
                {
                    await checkDirectories();
                    const capability = await readOwnedJson(filename, MaxDemandBytes);
                    if (validateCapabilities(capability).ok && capability.publisherId === publisherId)
                        await fs.unlink(filename);
                }
                catch { /* 不删除被其他发布者接管的能力文件。 */ }
            }
            entries.clear();
        })();
        return disposal;
    }

    return { ready, dispose };
}

module.exports = { createDemandServer };
