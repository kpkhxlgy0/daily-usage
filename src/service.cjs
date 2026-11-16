'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { validateSnapshot } = require('./protocol.cjs');

const MaxSnapshotBytes = 2 * 1024 * 1024;
const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function atomicWrite(file, value, active = () => true)
{
    const directory = path.dirname(file);
    const before = await ensureDirectory(directory);
    const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try
    {
        await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        const after = await fs.lstat(directory);
        if (!active()) return;
        if (after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev)
            throw new Error('data-directory-changed');
        await fs.rename(temp, file);
    }
    finally
    {
        await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

function createService({ codexHome, dataDir, now = Date.now, refreshMs = 60000,
    workerFactory = options => new Worker(path.join(__dirname, 'worker.cjs'), options) })
{
    const directory = path.join(codexHome, '.daily-usage');
    const reportFile = path.join(directory, 'summary.json');
    const publisherId = randomUUID();
    let machineId;
    let revision = 0;
    let stopped = false;
    let worker;
    let timer;
    let busy = false;
    let state = { status: 'loading', progress: null };
    let publishing = Promise.resolve();
    let disposal;

    const fail = error =>
    {
        if (stopped) return;
        busy = false;
        state = { ...state, status: 'error', error: String(error?.message || error).slice(0, 180), progress: null };
    };

    function refresh()
    {
        if (stopped || busy || !worker) return;
        busy = true;
        state = { ...state, status: 'loading', error: null, progress: null };
        worker.postMessage({ type: 'scan' });
    }

    const ready = (async () =>
    {
        await ensureDirectory(directory);
        await ensureDirectory(dataDir);
        const identityFile = path.join(directory, 'machine.json');
        try
        {
            const value = await readJson(identityFile, 1024);
            if (!Uuid.test(value.machineId)) throw new Error('invalid-machine-identity');
            machineId = value.machineId;
        }
        catch (error)
        {
            if (error.code !== 'ENOENT') throw error;
            machineId = randomUUID();
            await atomicWrite(identityFile, { machineId }, () => !stopped);
        }
        try
        {
            const previous = await readJson(reportFile);
            if (validateSnapshot(previous, { now: now() }).ok && previous.machineId === machineId)
                state = { status: 'loading', snapshot: previous, progress: null };
        }
        catch { /* 缓存损坏时重新统计，不改写原始日志。 */ }
        if (stopped) return;
        worker = workerFactory({ workerData: { codexHome, cacheDir: path.join(dataDir, 'cache') } });
        worker.on('message', message =>
        {
            if (stopped) return;
            if (message.type === 'progress') state = { ...state, progress: message.progress };
            else if (message.type === 'error') fail(message.error);
            else if (message.type === 'result')
            {
                publishing = publishing.then(async () =>
                {
                    if (stopped) return;
                    const snapshot = { ...message.report, schemaVersion: 1, source: 'com.kpk.daily-usage',
                        machineId, publisherId, revision: revision + 1 };
                    if (!validateSnapshot(snapshot, { now: now() }).ok
                        || Buffer.byteLength(JSON.stringify(snapshot)) > MaxSnapshotBytes)
                        throw new Error('invalid-report');
                    await atomicWrite(reportFile, snapshot, () => !stopped);
                    if (stopped) return;
                    revision++;
                    busy = false;
                    state = { status: 'ok', snapshot, progress: null };
                }).catch(fail);
            }
        });
        worker.on('error', fail);
        worker.on('exit', code => { if (!stopped) { worker = null; fail(`collector-exited-${code}`); } });
        refresh();
        timer = setInterval(refresh, refreshMs);
        timer.unref?.();
    })().catch(fail);

    return {
        ready, refresh,
        getState: () => state,
        settled: () => publishing,
        dispose()
        {
            if (disposal) return disposal;
            stopped = true;
            clearInterval(timer);
            disposal = (async () =>
            {
                await ready;
                if (worker) await worker.terminate();
                await publishing;
            })();
            return disposal;
        }
    };
}

module.exports = { createService };
