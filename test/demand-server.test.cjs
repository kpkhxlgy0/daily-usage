'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createDemandServer } = require('../src/demand-server.cjs');
const { demandPaths, makeMarker, validateCapabilities, validateResult } = require('../src/demand-protocol.cjs');
const { createService } = require('../src/service.cjs');

function report()
{
    return { schemaVersion: 1, source: 'com.kpk.daily-usage', machineId: randomUUID(), publisherId: randomUUID(),
        revision: 1, generatedAt: Date.now(), timezone: 'Asia/Shanghai', from: '2026-10-18', to: '2026-11-17',
        rows: [], coverage: { files: 0, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { basis: 'standard', asOf: '2026-11-16', source: 'https://developers.openai.com/api/docs/pricing' } };
}

async function setup(t, options = {})
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-demand-'));
    const paths = demandPaths(root);
    const calls = [];
    const service = options.service || { query({ signal })
    {
        return new Promise((resolve, reject) =>
        {
            calls.push({ signal, resolve, reject });
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'),
                { name: 'AbortError' })), { once: true });
        });
    } };
    await fs.mkdir(paths.requests, { recursive: true });
    if (options.beforeStart) await options.beforeStart(paths);
    const server = createDemandServer({ codexHome: root, service, now: options.now });
    t.after(async () =>
    {
        await server.dispose();
        await options.service?.dispose();
        await fs.rm(root, { recursive: true });
    });
    await server.ready;
    return { root, paths, calls, server, service };
}

async function write(paths, marker)
{
    await fs.writeFile(path.join(paths.requests, `${marker.requestId}.json`), JSON.stringify(marker));
}

async function bounded(promise, operation)
{
    let timer;
    try
    {
        return await Promise.race([promise, new Promise((resolve, reject) =>
        {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${operation}`)), 2500);
        })]);
    }
    finally { clearTimeout(timer); }
}

async function waitFor(read, predicate = Boolean)
{
    const end = Date.now() + 2500;
    while (Date.now() < end)
    {
        try
        {
            const value = await read();
            if (predicate(value)) return value;
        }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Timed out waiting for filesystem observation');
}

const response = (paths, id) => fs.readFile(path.join(paths.responses, `${id}.json`), 'utf8').then(JSON.parse);

test('native watcher advertises ready then runs exactly one query per fresh marker and leaves idle unchanged', async t =>
{
    const oldMarker = makeMarker(randomUUID(), Date.now());
    const { paths, calls, server } = await setup(t, { beforeStart: paths => write(paths, oldMarker) });
    const capabilities = JSON.parse(await fs.readFile(paths.capabilities, 'utf8'));
    assert.equal(validateCapabilities(capabilities).ok, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.length, 0);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length), count => count === 1);
    assert.equal((await response(paths, marker.requestId)).status, 'running');
    calls[0].resolve({ status: 'ok', snapshot: report() });
    const result = await waitFor(() => response(paths, marker.requestId), value => value.status === 'ok');
    assert.equal(validateResult(result, { requestId: marker.requestId,
        publisherId: capabilities.publisherId }).ok, true);
    await write(paths, marker);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.length, 1);
    const before = (await fs.stat(path.join(paths.responses, `${marker.requestId}.json`))).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await fs.stat(path.join(paths.responses, `${marker.requestId}.json`))).mtimeMs, before);
    await server.dispose();
    await write(paths, makeMarker(randomUUID(), Date.now()));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
    await assert.rejects(fs.access(paths.capabilities), { code: 'ENOENT' });
});

test('cancel markers abort immediately, reject late success and tombstone delayed queries', async t =>
{
    const { paths, calls } = await setup(t);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    await write(paths, makeMarker(marker.requestId, Date.now(), 'cancel', marker));
    await waitFor(() => Promise.resolve(calls[0].signal.aborted));
    calls[0].resolve({ status: 'ok', snapshot: report() });
    await waitFor(() => response(paths, marker.requestId), value => value.status === 'cancelled');
    await write(paths, marker);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
    assert.equal((await response(paths, marker.requestId)).status, 'cancelled');
    const early = makeMarker(randomUUID(), Date.now());
    await write(paths, makeMarker(early.requestId, Date.now(), 'cancel', early));
    await waitFor(() => response(paths, early.requestId), value => value.status === 'cancelled');
    await write(paths, early);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
});

test('native change events finish partial writes and preserve rapid cancellation overwrites', async t =>
{
    const { paths, calls } = await setup(t);
    const marker = makeMarker(randomUUID(), Date.now());
    const text = JSON.stringify(marker);
    const file = path.join(paths.requests, `${marker.requestId}.json`);
    await fs.writeFile(file, text.slice(0, 60));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 0);
    await fs.appendFile(file, text.slice(60));
    await waitFor(() => Promise.resolve(calls.length));
    await write(paths, makeMarker(marker.requestId, Date.now(), 'cancel', marker));
    await waitFor(() => response(paths, marker.requestId), value => value.status === 'cancelled');
    for (let index = 0; index < 3; index++)
    {
        const rapid = makeMarker(randomUUID(), Date.now());
        await write(paths, rapid);
        await write(paths, makeMarker(rapid.requestId, Date.now(), 'cancel', rapid));
        await waitFor(() => response(paths, rapid.requestId), value => value.status === 'cancelled');
        await write(paths, rapid);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(calls.every(call => call.signal.aborted));
});

test('request deadline and disposal abort work without successful late publication', async t =>
{
    const { paths, calls, server } = await setup(t);
    const marker = { ...makeMarker(randomUUID(), Date.now()), expiresAt: Date.now() + 80 };
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    await waitFor(() => Promise.resolve(calls[0].signal.aborted));
    await waitFor(() => response(paths, marker.requestId), value => value.status === 'cancelled');
    const next = makeMarker(randomUUID(), Date.now());
    await write(paths, next);
    await waitFor(() => Promise.resolve(calls.length), count => count === 2);
    await server.dispose();
    assert.equal(calls[1].signal.aborted, true);
    calls[1].resolve({ status: 'ok', snapshot: report() });
    assert.equal((await response(paths, next.requestId)).status, 'running');
});

test('cancellation during asynchronous response preparation suppresses successful publication',
    { timeout: 5000 }, async t =>
{
    const { paths, calls } = await setup(t);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    const resultFile = path.join(paths.responses, `${marker.requestId}.json`);
    let prepared;
    let release;
    const preparing = new Promise(resolve => { prepared = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const writeFile = fs.writeFile;
    const commits = [];
    const rename = fs.rename;
    const renameSync = nativeFs.renameSync;
    t.mock.method(fs, 'writeFile', async (file, ...args) =>
    {
        const result = await writeFile(file, ...args);
        if (path.dirname(file) === paths.responses && JSON.parse(args[0]).status === 'ok')
        {
            prepared();
            await gate;
        }
        return result;
    });
    t.mock.method(fs, 'rename', async (from, to) =>
    {
        if (to === resultFile) commits.push(JSON.parse(await fs.readFile(from, 'utf8')).status);
        return rename(from, to);
    });
    t.mock.method(nativeFs, 'renameSync', (from, to) =>
    {
        if (to === resultFile) commits.push(JSON.parse(nativeFs.readFileSync(from, 'utf8')).status);
        return renameSync(from, to);
    });
    calls[0].resolve({ status: 'ok', snapshot: report() });
    try
    {
        await bounded(preparing, 'response preparation');
        await write(paths, makeMarker(marker.requestId, Date.now(), 'cancel', marker));
        await waitFor(() => Promise.resolve(calls[0].signal.aborted));
    }
    finally { release(); }
    await waitFor(() => response(paths, marker.requestId), value => value.status === 'cancelled');
    assert.deepEqual(commits, ['cancelled']);
});

test('response commit cannot yield to disposal before successful publication becomes visible',
    { timeout: 5000 }, async t =>
{
    const { paths, calls, server } = await setup(t);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    const resultFile = path.join(paths.responses, `${marker.requestId}.json`);
    const events = [];
    let cancelled;
    let disposal;
    const cancellation = new Promise(resolve => { cancelled = resolve; });
    const cancel = () => queueMicrotask(() =>
    {
        events.push('cancelled');
        disposal = server.dispose();
        cancelled();
    });
    const rename = fs.rename;
    const renameSync = nativeFs.renameSync;
    t.mock.method(fs, 'rename', async (from, to) =>
    {
        if (to !== resultFile) return rename(from, to);
        cancel();
        await new Promise(resolve => setImmediate(resolve));
        await rename(from, to);
        events.push('committed');
    });
    t.mock.method(nativeFs, 'renameSync', (from, to) =>
    {
        if (to !== resultFile) return renameSync(from, to);
        cancel();
        renameSync(from, to);
        events.push('committed');
    });
    calls[0].resolve({ status: 'ok', snapshot: report() });
    await bounded(cancellation, 'response commit');
    await bounded(disposal, 'runner disposal');
    assert.deepEqual(events, ['committed', 'cancelled']);
    assert.equal((await response(paths, marker.requestId)).status, 'ok');
});

for (const code of ['EPERM', 'EBUSY'])
{
    test(`response publication recovers once from a Windows ${code} sharing violation`,
        { skip: process.platform !== 'win32', timeout: 5000 }, async t =>
    {
        const { paths, calls } = await setup(t);
        const marker = makeMarker(randomUUID(), Date.now());
        await write(paths, marker);
        await waitFor(() => Promise.resolve(calls.length));
        const resultFile = path.join(paths.responses, `${marker.requestId}.json`);
        const renameSync = nativeFs.renameSync;
        let locked = true;
        t.mock.method(nativeFs, 'renameSync', (from, to) =>
        {
            if (to === resultFile && locked)
            {
                locked = false;
                throw Object.assign(new Error('sharing-violation'), { code });
            }
            return renameSync(from, to);
        });
        calls[0].resolve({ status: 'ok', snapshot: report() });
        const result = await waitFor(() => response(paths, marker.requestId), value => value.status !== 'running');
        assert.equal(result.status, 'ok');
        assert.equal((await fs.readdir(paths.responses)).some(name => name.endsWith('.tmp')), false);
    });
}

test('runner disposal during a sharing backoff prevents another response commit attempt',
    { skip: process.platform !== 'win32', timeout: 5000 }, async t =>
{
    const { paths, calls, server } = await setup(t);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    const resultFile = path.join(paths.responses, `${marker.requestId}.json`);
    const renameSync = nativeFs.renameSync;
    let attempts = 0;
    let disposal;
    let cancelled;
    const cancellation = new Promise(resolve => { cancelled = resolve; });
    t.mock.method(nativeFs, 'renameSync', (from, to) =>
    {
        if (to !== resultFile) return renameSync(from, to);
        attempts++;
        queueMicrotask(() => { disposal = server.dispose(); cancelled(); });
        throw Object.assign(new Error('sharing-violation'), { code: 'EPERM' });
    });
    calls[0].resolve({ status: 'ok', snapshot: report() });
    await bounded(cancellation, 'retry cancellation');
    await bounded(disposal, 'retry disposal');
    assert.equal(attempts, 1);
    assert.equal((await response(paths, marker.requestId)).status, 'running');
    assert.equal((await fs.readdir(paths.responses)).some(name => name.endsWith('.tmp')), false);
});

test('a failed final publication does not poison the serialized error response', { timeout: 5000 }, async t =>
{
    const { paths, calls } = await setup(t);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    const resultFile = path.join(paths.responses, `${marker.requestId}.json`);
    const renameSync = nativeFs.renameSync;
    t.mock.method(nativeFs, 'renameSync', (from, to) =>
    {
        if (to === resultFile && JSON.parse(nativeFs.readFileSync(from, 'utf8')).status === 'ok')
            throw Object.assign(new Error('write-failed'), { code: 'EIO' });
        return renameSync(from, to);
    });
    calls[0].resolve({ status: 'ok', snapshot: report() });
    const result = await waitFor(() => response(paths, marker.requestId), value => value.status !== 'running');
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'collector-failed');
});

test('ignores malformed, oversized, expired and foreign markers and bounds concurrent queries', async t =>
{
    const { paths, calls } = await setup(t);
    await fs.writeFile(path.join(paths.requests, 'arbitrary.json'), '{}');
    const mismatch = makeMarker(randomUUID(), Date.now());
    await fs.writeFile(path.join(paths.requests, `${randomUUID()}.json`), JSON.stringify(mismatch));
    await write(paths, { ...makeMarker(randomUUID(), Date.now()), source: 'foreign' });
    await write(paths, makeMarker(randomUUID(), Date.now() - 400000));
    await fs.writeFile(path.join(paths.requests, `${randomUUID()}.json`), ' '.repeat(2049));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.length, 0);
    const markers = Array.from({ length: 9 }, () => makeMarker(randomUUID(), Date.now()));
    for (const marker of markers) await write(paths, marker);
    const results = await waitFor(async () => Promise.all(markers.map(async marker =>
    {
        try { return await response(paths, marker.requestId); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    })), values => values.every(Boolean));
    assert.equal(calls.length, 8);
    assert.equal(results.filter(value => value.status === 'error' && value.error === 'runner-busy').length, 1);
});

test('rejects unsafe owned directories before advertising capability', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-unsafe-'));
    t.after(() => fs.rm(root, { recursive: true }));
    const paths = demandPaths(root);
    const other = path.join(root, 'elsewhere');
    await fs.mkdir(other);
    await fs.symlink(other, paths.directory, 'junction');
    const server = createDemandServer({ codexHome: root, service: { query() { assert.fail('unsafe query'); } } });
    t.after(() => server.dispose());
    await assert.rejects(server.ready, /unsafe/);
    await assert.rejects(fs.access(paths.capabilities), { code: 'ENOENT' });
});

test('rejects symlink request files and cancellation markers with changed original timestamps', async t =>
{
    const { root, paths, calls } = await setup(t);
    const linked = makeMarker(randomUUID(), Date.now());
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, JSON.stringify(linked));
    try { await fs.symlink(outside, path.join(paths.requests, `${linked.requestId}.json`)); }
    catch (error)
    {
        if (error.code !== 'EPERM') throw error;
        t.diagnostic('File symlink creation is unavailable for this Windows account');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls.length, 0);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    const cancellation = makeMarker(marker.requestId, Date.now(), 'cancel', marker);
    await write(paths, { ...cancellation, requestedAt: marker.requestedAt + 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls[0].signal.aborted, false);
    calls[0].resolve({ status: 'ok', snapshot: report() });
    await waitFor(() => response(paths, marker.requestId), value => value.status === 'ok');
});

test('collector errors and invalid snapshots produce bounded protocol errors', async t =>
{
    const { paths, calls } = await setup(t);
    const marker = makeMarker(randomUUID(), Date.now());
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    calls[0].resolve({ status: 'error', error: 'private host/path details' });
    const first = await waitFor(() => response(paths, marker.requestId), value => value.status === 'error');
    assert.equal(first.error, 'collector-failed');
    const next = makeMarker(randomUUID(), Date.now());
    await write(paths, next);
    await waitFor(() => Promise.resolve(calls.length), count => count === 2);
    calls[1].resolve({ status: 'ok', snapshot: { ...report(), rows: [{ usd: -1 }] } });
    assert.equal((await waitFor(() => response(paths, next.requestId), value => value.status === 'error')).error,
        'collector-failed');
});

test('completed expired protocol files are cleaned only on new demand activity', async t =>
{
    const { paths, calls } = await setup(t);
    const marker = { ...makeMarker(randomUUID(), Date.now()), expiresAt: Date.now() + 80 };
    await write(paths, marker);
    await waitFor(() => Promise.resolve(calls.length));
    calls[0].resolve({ status: 'ok', snapshot: report() });
    await waitFor(() => response(paths, marker.requestId), value => value.status === 'ok');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await response(paths, marker.requestId)).status, 'ok');
    await fs.access(path.join(paths.requests, `${marker.requestId}.json`));
    await write(paths, makeMarker(randomUUID(), Date.now()));
    await waitFor(() => fs.access(path.join(paths.responses, `${marker.requestId}.json`))
        .then(() => false, error => error.code === 'ENOENT'));
    await assert.rejects(fs.access(path.join(paths.requests, `${marker.requestId}.json`)), { code: 'ENOENT' });
});

test('new activity also cleans validated expired files left by a previous runner', async t =>
{
    const old = makeMarker(randomUUID(), Date.now() - 400000);
    const { paths, calls } = await setup(t, { beforeStart: paths => write(paths, old) });
    await new Promise(resolve => setTimeout(resolve, 20));
    await fs.access(path.join(paths.requests, `${old.requestId}.json`));
    assert.equal(calls.length, 0);
    await write(paths, makeMarker(randomUUID(), Date.now()));
    await waitFor(() => fs.access(path.join(paths.requests, `${old.requestId}.json`))
        .then(() => false, error => error.code === 'ENOENT'));
    assert.equal(calls.length, 1);
});

test('idle service and native demand watcher do not keep a child process alive', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-idle-process-'));
    t.after(() => fs.rm(root, { recursive: true }));
    const script = `const {createService}=require(${JSON.stringify(require.resolve('../src/service.cjs'))});
        const {createDemandServer}=require(${JSON.stringify(require.resolve('../src/demand-server.cjs'))});
        const service=createService({codexHome:${JSON.stringify(root)},dataDir:${JSON.stringify(path.join(root, 'data'))}});
        const server=createDemandServer({codexHome:${JSON.stringify(root)},service});
        Promise.all([service.ready,server.ready]).catch(()=>process.exitCode=1);`;
    const child = spawnSync(process.execPath, ['-e', script], { timeout: 3000, encoding: 'utf8', windowsHide: true });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    await assert.rejects(fs.access(path.join(root, '.daily-usage/summary.json')), { code: 'ENOENT' });
});

test('native request/response watcher roundtrip uses a real lazy collector with no startup scan', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-roundtrip-'));
    const service = createService({ codexHome: root, dataDir: path.join(root, 'data') });
    const paths = demandPaths(root);
    const server = createDemandServer({ codexHome: root, service });
    t.after(async () => { await server.dispose(); await service.dispose(); await fs.rm(root, { recursive: true }); });
    await Promise.all([service.ready, server.ready]);
    await assert.rejects(fs.access(path.join(paths.directory, 'summary.json')), { code: 'ENOENT' });
    const marker = makeMarker(randomUUID(), Date.now());
    let changed;
    const notification = new Promise(resolve => { changed = resolve; });
    const watcher = nativeFs.watch(paths.responses, { persistent: false }, () => changed());
    t.after(() => watcher.close());
    await write(paths, marker);
    await notification;
    const result = await waitFor(() => response(paths, marker.requestId), value => value.status === 'ok');
    assert.equal(result.snapshot.rows.length, 0);
    assert.equal(result.snapshot.coverage.files, 0);
    const summary = path.join(paths.directory, 'summary.json');
    const publishedAt = (await fs.stat(summary)).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((await fs.stat(summary)).mtimeMs, publishedAt);
});
