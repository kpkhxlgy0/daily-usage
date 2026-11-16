'use strict';

const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { validateSnapshot, MaxSnapshotBytes, normalizeThreadId } = require('./protocol.cjs');

const SharingRetryMs = 25;

async function ensureDirectory(directory)
{
    await fs.mkdir(directory, { recursive: true });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe-data-directory');
    return info;
}

async function readJson(file, maxBytes = MaxSnapshotBytes)
{
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('unsafe-data-file');
    const bytes = await fs.readFile(file);
    if (bytes.length > maxBytes) throw new Error('data-too-large');
    return JSON.parse(bytes.toString('utf8'));
}

async function atomicWrite(file, value, active = () => true, signal)
{
    const directory = path.dirname(file);
    const before = await ensureDirectory(directory);
    const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try
    {
        await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        let retried = false;
        for (;;)
        {
            const after = await fs.lstat(directory);
            if (after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev)
                throw new Error('data-directory-changed');
            if (!active()) return;
            try
            {
                // 最终判定与原子提交不让出事件循环；提交后的取消不撤销已发布文件。
                nativeFs.renameSync(temp, file);
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
        await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

function abortError()
{
    return Object.assign(new Error('Daily Usage query cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function createService({ codexHome, dataDir, now = Date.now,
    workerFactory = options => new Worker(path.join(__dirname, 'worker.cjs'), options) })
{
    const directory = path.join(codexHome, '.daily-usage');
    const reportFile = path.join(directory, 'summary.json');
    const publisherId = randomUUID();
    const lifetime = new AbortController();
    const pending = new Set();
    const terminations = new Set();
    let machineId;
    let revision = 0;
    let stopped = false;
    let current;
    let initializationError;
    let state = { status: 'unavailable', progress: null };
    let publishing = Promise.resolve();
    let disposal;

    function terminate(job)
    {
        if (job.termination) return job.termination;
        job.termination = Promise.resolve(job.worker?.terminate()).catch(() => {});
        terminations.add(job.termination);
        job.termination.finally(() => terminations.delete(job.termination));
        return job.termination;
    }

    const active = job => !stopped && current === job && job.subscribers.size > 0;

    function settle(subscriber, error, value)
    {
        if (subscriber.settled) return;
        subscriber.settled = true;
        pending.delete(subscriber);
        subscriber.signal?.removeEventListener('abort', subscriber.abort);
        if (error) subscriber.reject(error);
        else subscriber.resolve(value);
    }

    function abandon(job)
    {
        if (current !== job) return;
        current = null;
        job.controller?.abort();
        state = { ...state, status: state.snapshot ? 'stale' : 'unavailable', progress: null };
        terminate(job);
    }

    async function complete(job, error, snapshot)
    {
        if (!active(job)) return;
        await terminate(job);
        if (!active(job)) return;
        current = null;
        if (error)
            state = { ...state, status: 'error', error: String(error.message || error).slice(0, 180), progress: null };
        else
        {
            revision++;
            state = { status: 'ok', snapshot, progress: null };
        }
        for (const subscriber of job.subscribers) settle(subscriber, null, state);
        job.subscribers.clear();
    }

    function start(job)
    {
        job.controller = new AbortController();
        state = { ...state, status: 'loading', error: null, progress: null };
        try
        {
            job.worker = workerFactory({ workerData: { codexHome, cacheDir: path.join(dataDir, 'cache') } });
            job.worker.on('message', message =>
            {
                if (!active(job) || job.finished) return;
                if (message?.type === 'progress') state = { ...state, progress: message.progress };
                else if (message?.type === 'error')
                {
                    job.finished = true;
                    void complete(job, message.error || 'collector-failed');
                }
                else if (message?.type === 'result')
                {
                    job.finished = true;
                    publishing = publishing.then(async () =>
                    {
                        if (!active(job)) return;
                        const snapshot = { ...message.report, schemaVersion: 1, source: 'com.kpk.daily-usage',
                            machineId, publisherId, revision: revision + 1 };
                        if (!validateSnapshot(snapshot, { now: now() }).ok
                            || Buffer.byteLength(JSON.stringify(snapshot)) > MaxSnapshotBytes)
                            throw new Error('invalid-report');
                        await atomicWrite(reportFile, snapshot, () => active(job), job.controller.signal);
                        await complete(job, null, snapshot);
                    }).catch(error => complete(job, error));
                }
            });
            job.worker.on('error', error =>
            {
                if (!active(job) || job.finished) return;
                job.finished = true;
                void complete(job, error);
            });
            job.worker.on('exit', code =>
            {
                if (!active(job) || job.finished) return;
                job.finished = true;
                void complete(job, `collector-exited-${code}`);
            });
            job.worker.postMessage({ type: 'scan' });
        }
        catch (error)
        {
            job.finished = true;
            void complete(job, error);
        }
    }

    const ready = (async () =>
    {
        await ensureDirectory(directory);
        await ensureDirectory(dataDir);
        const identityFile = path.join(directory, 'machine.json');
        try
        {
            const value = await readJson(identityFile, 1024);
            if (!normalizeThreadId(value.machineId)) throw new Error('invalid-machine-identity');
            machineId = value.machineId;
        }
        catch (error)
        {
            if (error.code !== 'ENOENT') throw error;
            machineId = randomUUID();
            await atomicWrite(identityFile, { machineId }, () => !stopped, lifetime.signal);
        }
        try
        {
            const previous = await readJson(reportFile);
            if (validateSnapshot(previous, { now: now() }).ok && previous.machineId === machineId)
                state = { status: 'stale', snapshot: previous, progress: null };
        }
        catch { /* 缓存损坏时仅在查询时重新统计，不改写原始日志。 */ }
    })().catch(error =>
    {
        initializationError = error;
        state = { status: 'error', error: String(error.message || error).slice(0, 180), progress: null };
    });

    return {
        ready,
        getState: () => state,
        query({ signal } = {})
        {
            if (stopped || signal?.aborted) return Promise.reject(abortError());
            return new Promise((resolve, reject) =>
            {
                const subscriber = { resolve, reject, signal };
                subscriber.abort = () =>
                {
                    settle(subscriber, abortError());
                    const job = subscriber.job;
                    if (!job) return;
                    job.subscribers.delete(subscriber);
                    if (!job.subscribers.size) abandon(job);
                };
                pending.add(subscriber);
                signal?.addEventListener('abort', subscriber.abort, { once: true });
                ready.then(() =>
                {
                    if (subscriber.settled) return;
                    if (stopped || signal?.aborted) return subscriber.abort();
                    if (initializationError) return settle(subscriber, null, state);
                    const job = current || { subscribers: new Set() };
                    subscriber.job = job;
                    job.subscribers.add(subscriber);
                    if (!current)
                    {
                        current = job;
                        start(job);
                    }
                });
            });
        },
        dispose()
        {
            if (disposal) return disposal;
            stopped = true;
            lifetime.abort();
            for (const subscriber of [...pending]) subscriber.abort();
            disposal = (async () =>
            {
                await ready;
                await publishing;
                await Promise.all([...terminations]);
            })();
            return disposal;
        }
    };
}

module.exports = { createService };
