'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createService } = require('../src/service.cjs');

function body()
{
    return { generatedAt: Date.parse('2026-11-16T12:00:00Z'), timezone: 'Asia/Shanghai',
        from: '2026-10-18', to: '2026-11-16', rows: [],
        coverage: { files: 1, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { basis: 'standard', asOf: '2026-11-16', source: 'https://developers.openai.com/api/docs/pricing' } };
}

async function setup(t)
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-service-'));
    const worker = new EventEmitter();
    worker.postMessage = () => {};
    worker.terminate = async () => { worker.terminated = true; };
    const service = createService({ codexHome: root, dataDir: path.join(root, 'data'),
        workerFactory: () => worker, now: () => body().generatedAt, refreshMs: 100000 });
    t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true }); });
    await service.ready;
    return { root, worker, service };
}

test('publishes validated aggregate atomically, keeping machine identity across restart', async t =>
{
    const { root, worker, service } = await setup(t);
    worker.emit('message', { type: 'result', report: body() });
    await service.settled();
    const report = JSON.parse(await fs.readFile(path.join(root, '.daily-usage/summary.json'), 'utf8'));
    assert.equal(report.source, 'com.kpk.daily-usage');
    assert.equal(report.revision, 1);
    assert.equal(service.getState().status, 'ok');
    assert.match(report.machineId, /^[0-9a-f-]{36}$/);
    worker.emit('message', { type: 'result', report: body() });
    await service.settled();
    assert.equal(service.getState().snapshot.revision, 2);
    await service.dispose();
    const nextWorker = new EventEmitter();
    nextWorker.postMessage = () => {};
    nextWorker.terminate = async () => {};
    const next = createService({ codexHome: root, dataDir: path.join(root, 'data'),
        workerFactory: () => nextWorker, now: () => body().generatedAt });
    t.after(() => next.dispose());
    await next.ready;
    assert.equal(next.getState().snapshot.machineId, report.machineId);
});

test('invalid worker result never replaces last successful report', async t =>
{
    const { worker, service } = await setup(t);
    worker.emit('message', { type: 'result', report: body() });
    await service.settled();
    worker.emit('message', { type: 'result', report: { ...body(), rows: [{ usd: -1 }] } });
    await service.settled();
    assert.equal(service.getState().snapshot.revision, 1);
    assert.equal(service.getState().status, 'error');
});

test('dispose terminates scanning and rejects late publication', async t =>
{
    const { root, worker, service } = await setup(t);
    await service.dispose();
    worker.emit('message', { type: 'result', report: body() });
    await service.settled();
    assert.equal(worker.terminated, true);
    await assert.rejects(fs.access(path.join(root, '.daily-usage/summary.json')), { code: 'ENOENT' });
});

test('real worker publishes a priced row from the native top-level usage envelope', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-worker-'));
    const threadId = '22222222-2222-4222-8222-222222222222';
    const timestamp = new Date().toISOString();
    await fs.mkdir(path.join(root, 'sessions'));
    const file = path.join(root, 'sessions', `rollout-${timestamp.slice(0, 10)}T10-00-00-${threadId}.jsonl`);
    const records = [
        { timestamp, type: 'session_meta', payload: { id: threadId } },
        { timestamp, type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-6.1-sol' } },
        { timestamp, type: 'token_usage_record', payload: { response_id: 'response-1', thread_id: threadId,
            turn_id: 'turn-1', usage: { input_tokens: 1000, cached_input_tokens: 900, cache_write_input_tokens: 0,
                output_tokens: 100, reasoning_output_tokens: 80, total_tokens: 1100 } } }
    ];
    await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const service = createService({ codexHome: root, dataDir: path.join(root, 'data') });
    t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true }); });
    await service.ready;
    const end = Date.now() + 6000;
    while (service.getState().status === 'loading' && Date.now() < end)
        await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.getState().status, 'ok', JSON.stringify(service.getState()));
    const row = service.getState().snapshot.rows[0];
    assert.equal(row?.requests, 1);
    assert.equal(row?.outputTokens, 100);
    assert.equal(row?.usd, 0.00129);
});
