'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createCollector } = require('../src/collector.cjs');

const Now = Date.parse('2026-11-16T12:00:00Z');
const Stamp = '2026-11-16T10:00:00Z';
const HasZstd = typeof zlib.zstdCompressSync === 'function';

function meta(id, extra = {})
{
    return { type: 'session_meta', timestamp: Stamp, payload: { id, ...extra } };
}

function context(turn, model = 'gpt-6.1-sol')
{
    return { type: 'turn_context', timestamp: Stamp, payload: { turn_id: turn, model } };
}

function modern(id, { thread = 'root', turn = 'turn-1', timestamp = Stamp, input = 1000,
    cached = 200, write = 0, writeTtl, output = 100, ...extra } = {})
{
    return { type: 'token_usage_record', timestamp, payload: { response_id: id,
        thread_id: thread, turn_id: turn, usage: { input_tokens: input, cached_input_tokens: cached,
            cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: 60,
            ...(writeTtl ? { cache_write_ttl: writeTtl } : {}),
            total_tokens: input + output }, ...extra } };
}

function legacy(input, output, { timestamp = Stamp, last, cached = 0 } = {})
{
    return { type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached,
            output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
        ...(last ? { last_token_usage: { input_tokens: last[0], cached_input_tokens: 0,
            output_tokens: last[1], total_tokens: last[0] + last[1] } } : {}),
    } } };
}

function quota(timestamp, reset, usedPercent, { limit = 'codex', slot = 'primary', minutes = 10080 } = {})
{
    const rate_limits = { [slot]: { used_percent: usedPercent, window_minutes: minutes,
        resets_at: Date.parse(reset) / 1000 } };
    if (limit !== null) rate_limits.limit_id = limit;
    return { type: 'event_msg', timestamp, payload: { type: 'token_count', info: null, rate_limits } };
}

async function fixture(t)
{
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-collector-'));
    const cacheDir = path.join(home, '.daily-usage');
    const collectors = [];
    t.after(async () =>
    {
        await Promise.all(collectors.map(value => value.dispose()));
        await fs.rm(home, { recursive: true });
    });
    async function write(relative, records, { compressed = false, mtime } = {})
    {
        const filename = path.join(home, relative);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        const content = typeof records === 'string' ? records : records.map(JSON.stringify).join('\n') + '\n';
        await fs.writeFile(filename, compressed ? zlib.zstdCompressSync(Buffer.from(content)) : content);
        if (mtime) await fs.utimes(filename, mtime, mtime);
        return filename;
    }
    function collector(options = {})
    {
        const value = createCollector({ codexHome: home, cacheDir, now: () => Now, ...options });
        collectors.push(value);
        return value;
    }
    return { home, cacheDir, write, collector };
}

function mutateAfterFirstRead(t, filename, mutate)
{
    const open = fs.open;
    let changed = false;
    t.mock.method(fs, 'open', async (...args) =>
    {
        const handle = await open(...args);
        if (args[0] === filename && !changed)
        {
            const read = handle.read.bind(handle);
            handle.read = async (...readArgs) =>
            {
                const result = await read(...readArgs);
                if (!changed)
                {
                    changed = true;
                    await mutate();
                }
                return result;
            };
        }
        return handle;
    });
}

test('modern paid requests survive discarded context and deduplicate globally across forks and archives', async t =>
{
    const f = await fixture(t);
    const shared = modern('paid-1');
    await f.write('sessions/root.jsonl', [meta('root'), context('turn-1'), shared,
        { type: 'event_msg', timestamp: Stamp, payload: { type: 'context_compacted' } },
        modern('paid-2')]);
    await f.write('archived_sessions/copied-fork.jsonl', [meta('fork', { forked_from_id: 'root' }),
        context('turn-1'), shared, modern('paid-3', { thread: 'fork' })]);
    const report = await f.collector().scan();
    assert.equal(report.rows.length, 1);
    assert.deepEqual(report.rows[0], { date: '2026-11-16', model: 'gpt-6.1-sol', requests: 3,
        inputTokens: 3000, uncachedInputTokens: 2400, cachedInputTokens: 600, cacheWriteTokens: 0,
        outputTokens: 300, usd: 0.00786, unpricedRequests: 0, estimatedRequests: 0 });
    assert.equal(report.coverage.duplicateRequests, 1);
    assert.equal(report.pricing.basis, 'codex-standard-estimate');
});

test('sanitized native usage and paired token_count count once with no false coverage gap', async t =>
{
    const f = await fixture(t);
    const native = await fs.readFile(path.join(__dirname, 'fixtures/native-modern.jsonl'), 'utf8');
    await f.write('sessions/native-real.jsonl', native);
    const report = await f.collector().scan();
    assert.deepEqual(report.rows, [{ date: '2026-11-16', model: 'gpt-6-astra', requests: 1,
        inputTokens: 34518, uncachedInputTokens: 27478, cachedInputTokens: 7040, cacheWriteTokens: 0,
        outputTokens: 175, usd: 0.29057, unpricedRequests: 0, estimatedRequests: 0 }]);
    assert.equal(report.coverage.legacySkippedRecords, 0);
    assert.equal(report.coverage.redundantLegacyRecords, 1);
    assert.equal(report.coverage.skippedRecords, 0);
    assert.deepEqual(report.coverage.warnings, []);
});

test('prior parsed-usage cache without response associations is rebuilt from the logs', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/schema.jsonl', [meta('root'), context('turn-1'), modern('native')]);
    const collector = f.collector();
    await collector.scan();
    await collector.dispose();
    const directory = path.join(f.cacheDir, 'usage-cache');
    const [name] = await fs.readdir(directory);
    const filename = path.join(directory, name);
    const cached = JSON.parse(await fs.readFile(filename, 'utf8'));
    cached.schemaVersion = 3;
    delete cached.data.modern[0].weeklyResets;
    await fs.writeFile(filename, JSON.stringify(cached));
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.parsedFiles, 1);
});

test('unchanged parsed usage caches are reused and long requests keep the Standard price', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/long-context.jsonl', [meta('root'), context('turn-1', 'gpt-6-astra'),
        modern('long-request', { input: 300000, cached: 280000, output: 1000 })]);
    const first = f.collector();
    await first.scan();
    await first.dispose();
    const report = await f.collector().scan();
    assert.equal(report.coverage.cachedFiles, 1);
    assert.equal(report.coverage.parsedFiles, 0);
    assert.equal(report.rows[0].inputTokens, 300000);
    assert.equal(report.rows[0].usd, 1.035);
    assert.equal(report.pricing.basis, 'codex-standard-estimate');
});

test('models resolve by matching turn rather than last context and child session_id is not source identity', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/native-child.jsonl', [meta('child', { session_id: 'root' }),
        context('first', 'gpt-6-luna'), context('second', 'gpt-6.1-terra'),
        modern('child-first', { thread: 'child', turn: 'first' }),
        modern('child-second', { thread: 'child', turn: 'second' }),
        modern('no-model', { thread: 'child', turn: 'unseen' })]);
    const report = await f.collector().scan();
    assert.deepEqual(report.rows.map(row => [row.model, row.requests, row.unpricedRequests]),
        [['gpt-6-luna', 1, 0], ['gpt-6.1-terra', 1, 0], ['unknown', 1, 1]]);
});

test('Beijing midnight and inclusive thirty calendar days use request timestamps', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/boundaries.jsonl', [meta('root'), context('turn-1'),
        modern('before', { timestamp: '2026-10-17T15:59:59Z' }),
        modern('first', { timestamp: '2026-10-17T16:00:00Z' }),
        modern('yesterday', { timestamp: '2026-11-15T15:59:59Z' }),
        modern('today', { timestamp: '2026-11-15T16:00:00Z' }),
        modern('future', { timestamp: '2026-11-17T16:00:00Z' })]);
    const report = await f.collector().scan();
    assert.equal(report.from, '2026-10-18');
    assert.equal(report.to, '2026-11-16');
    assert.deepEqual(report.rows.map(row => [row.date, row.requests]),
        [['2026-11-16', 1], ['2026-11-15', 1], ['2026-10-18', 1]]);
});

test('logical source preference chooses sessions before archives and plain before compressed',
    { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const records = [meta('root'), context('turn-1'), modern('plain')];
    await f.write('sessions/2026/11/16/rollout-same.jsonl', records);
    await f.write('sessions/2026/11/16/rollout-same.jsonl.zst',
        [...records, modern('stale-compressed')], { compressed: true });
    await f.write('archived_sessions/rollout-same.jsonl', [...records, modern('stale-archive')]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.files, 1);
});

test('compressed archives and concatenated frames are streamed completely', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.write('archived_sessions/native.jsonl.zst',
        [meta('archived'), context('turn-1'), modern('zstd-1')], { compressed: true });
    await fs.appendFile(filename, zlib.zstdCompressSync(Buffer.from(JSON.stringify(modern('zstd-2')) + '\n')));
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.coverage.failedFiles, 0);
});

test('legacy deltas suppress replay and decreases without resetting their high-water mark', async t =>
{
    const f = await fixture(t);
    const records = [meta('old'), context('turn-1'),
        legacy(100, 10, { timestamp: '2026-11-16T08:00:00Z' }),
        legacy(300, 30, { timestamp: '2026-11-16T08:01:00Z' }),
        legacy(300, 30, { timestamp: '2026-11-16T08:01:00Z' }),
        legacy(50, 5, { timestamp: '2026-11-16T08:02:00Z' }),
        legacy(400, 40, { timestamp: '2026-11-16T08:03:00Z' })];
    await f.write('sessions/old.jsonl', records);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.rows[0].inputTokens, 300);
    assert.equal(report.rows[0].outputTokens, 30);
    assert.equal(report.rows[0].estimatedRequests, 2);
    assert.equal(report.coverage.legacyRequests, 2);
    assert.ok(report.coverage.skippedRecords >= 2);
    assert.match(report.coverage.warnings.join(' '), /旧版/);
});

test('legacy explicit last usage counts a known first request and forked copies do not add it twice', async t =>
{
    const f = await fixture(t);
    const copied = legacy(1000, 100, { last: [100, 10] });
    await f.write('sessions/parent.jsonl', [meta('parent'), context('turn-1'), copied]);
    await f.write('sessions/fork.jsonl', [meta('fork', { forked_from_id: 'parent' }),
        context('turn-1'), copied, legacy(1200, 120, { timestamp: '2026-11-16T10:01:00Z' })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.rows[0].inputTokens, 300);
    assert.equal(report.rows[0].outputTokens, 30);
});

test('a fork copying only the tail of a legacy cumulative stream cannot bill part of a counted delta again', async t =>
{
    const f = await fixture(t);
    const copied = legacy(300, 30, { last: [100, 10], timestamp: '2026-11-16T10:01:00Z' });
    await f.write('sessions/parent.jsonl', [meta('parent'), context('turn-1'),
        legacy(100, 10, { timestamp: '2026-11-16T10:00:00Z' }), copied]);
    await f.write('sessions/fork.jsonl', [meta('fork', { forked_from_id: 'parent' }),
        context('turn-1'), copied]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.rows[0].inputTokens, 200);
});

test('a malformed persistent usage cache is ignored and rebuilt from original logs', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/rebuild.jsonl', [meta('root'), context('turn-1'), modern('real')]);
    const collector = f.collector();
    await collector.scan();
    await collector.dispose();
    const cacheDirectory = path.join(f.cacheDir, 'usage-cache');
    const [cacheName] = await fs.readdir(cacheDirectory);
    const cacheFile = path.join(cacheDirectory, cacheName);
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    cached.data.modern = [{ id: 'corrupt', timestamp: 'bad-date' }];
    await fs.writeFile(cacheFile, JSON.stringify(cached));
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.parsedFiles, 1);
    assert.equal(report.coverage.failedFiles, 0);
});

test('dispose cancels an active scan and queued refreshes without publishing completion', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/cancel.jsonl', [meta('root'), context('turn-1'), modern('not-published')]);
    const phases = [];
    let collector;
    collector = f.collector({ onProgress(value)
    {
        phases.push(value.phase);
        if (value.phase === 'scanning') void collector.dispose();
    } });
    const active = collector.scan();
    const queued = collector.scan();
    await assert.rejects(active, { code: 'ERR_DAILY_USAGE_DISPOSED' });
    await assert.rejects(queued, { code: 'ERR_DAILY_USAGE_DISPOSED' });
    assert.ok(!phases.includes('complete'));
});

test('legacy counters sharing a modern thread are excluded with an explicit coverage gap', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/mixed.jsonl', [meta('root'), context('turn-1'),
        legacy(100, 10, { last: [100, 10], timestamp: '2026-11-16T09:59:59Z' }), modern('modern-only')]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.legacyRequests, 0);
    assert.match(report.coverage.warnings.join(' '), /旧版.*逐请求|逐请求.*旧版/);
});

test('stable cumulative offsets require matching adjacent modern usage before becoming informational', async t =>
{
    const f = await fixture(t);
    const inside = legacy(52458050, 93069, { timestamp: '2026-11-16T10:00:02.412Z',
        cached: 52031488, last: [40741, 378] });
    inside.payload.info.last_token_usage.cached_input_tokens = 13824;
    const suffix = legacy(52509413, 93235, { timestamp: '2026-11-16T10:00:11.931Z',
        cached: 52072448, last: [51363, 166] });
    suffix.payload.info.last_token_usage.cached_input_tokens = 40960;
    await f.write('sessions/offset.jsonl', [meta('root'), context('turn-1', 'gpt-6-astra'),
        modern('offset-first', { timestamp: '2026-11-16T10:00:00Z', input: 40741, cached: 13824,
            output: 378, thread_token_usage: { input_tokens: 52908391, cached_input_tokens: 52481408,
                cache_write_input_tokens: 0, output_tokens: 97843 } }),
        inside,
        modern('offset-next', { timestamp: '2026-11-16T10:00:10Z', input: 51363, cached: 40960,
            output: 166, thread_token_usage: { input_tokens: 52959754, cached_input_tokens: 52522368,
                cache_write_input_tokens: 0, output_tokens: 98009 } }),
        suffix]);
    const report = await f.collector().scan();
    assert.deepEqual(report.rows, [{ date: '2026-11-16', model: 'gpt-6-astra', requests: 2,
        inputTokens: 92104, uncachedInputTokens: 37320, cachedInputTokens: 54784, cacheWriteTokens: 0,
        outputTokens: 544, usd: 0.455184, unpricedRequests: 0, estimatedRequests: 0 }]);
    assert.equal(report.coverage.redundantLegacyRecords, 2);
    assert.equal(report.coverage.legacySkippedRecords, 0);
    assert.equal(report.coverage.skippedRecords, 0);
    assert.deepEqual(report.coverage.warnings, []);
});

test('an uncorroborated legacy request between modern responses remains a real coverage gap', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/interior-gap.jsonl', [meta('root'), context('turn-1'),
        modern('before-gap', { timestamp: '2026-11-16T10:00:00Z', cached: 0,
            thread_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } }),
        legacy(1500, 150, { timestamp: '2026-11-16T10:00:10Z', last: [500, 50] }),
        modern('after-gap', { timestamp: '2026-11-16T10:00:20Z', cached: 0,
            thread_token_usage: { input_tokens: 2500, cached_input_tokens: 0, output_tokens: 250 } })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.rows[0].inputTokens, 2000);
    assert.equal(report.coverage.redundantLegacyRecords, 0);
    assert.equal(report.coverage.legacySkippedRecords, 1);
    assert.match(report.coverage.warnings.join(' '), /旧版.*逐请求/);
});

test('a single modern response cannot corroborate an offset even with equivalent counter retries',
    async t =>
{
    const f = await fixture(t);
    await f.write('sessions/consumed-offset.jsonl', [meta('root'), context('turn-1'),
        modern('one-response', { cached: 0,
            thread_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } }),
        legacy(5000, 500, { timestamp: '2026-11-16T10:00:01Z', last: [1000, 100] }),
        legacy(6000, 600, { timestamp: '2026-11-16T10:00:02Z', last: [1000, 100] }),
        legacy(5000, 500, { timestamp: '2026-11-16T10:00:03Z', last: [1000, 100] })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.redundantLegacyRecords, 0);
    assert.equal(report.coverage.legacySkippedRecords, 3);
    assert.match(report.coverage.warnings.join(' '), /旧版.*逐请求/);
});

test('an exact cumulative counterpart reserves its response before a later identical request counter', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/direct-then-offset.jsonl', [meta('root'), context('turn-1'),
        modern('already-paired', { cached: 0,
            thread_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } }),
        legacy(1000, 100, { timestamp: '2026-11-16T10:00:01Z', last: [1000, 100] }),
        legacy(2000, 200, { timestamp: '2026-11-16T10:00:02Z', last: [1000, 100] })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.rows[0].inputTokens, 1000);
    assert.equal(report.coverage.redundantLegacyRecords, 1);
    assert.equal(report.coverage.legacySkippedRecords, 1);
    assert.match(report.coverage.warnings.join(' '), /旧版.*逐请求/);
});

test('offset corroboration uses the nearest preceding response and expires after five minutes', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/nearest.jsonl', [meta('root'), context('turn-1'),
        modern('older-matching', { timestamp: '2026-11-16T10:00:00Z', cached: 0 }),
        modern('newer-different', { timestamp: '2026-11-16T10:00:01Z', input: 2000, cached: 0, output: 200 }),
        legacy(5000, 500, { timestamp: '2026-11-16T10:00:02Z', last: [1000, 100] }),
        legacy(7000, 700, { timestamp: '2026-11-16T10:05:01.001Z', last: [2000, 200] })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.coverage.redundantLegacyRecords, 0);
    assert.equal(report.coverage.legacySkippedRecords, 2);
});

test('unpaired legacy prefixes and suffixes outside modern chronology remain explicit gaps', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/outside.jsonl', [meta('root'), context('turn-1'),
        legacy(100, 10, { last: [100, 10], timestamp: '2026-11-16T09:59:59Z' }),
        modern('middle'),
        legacy(1200, 120, { last: [100, 10], timestamp: '2026-11-16T10:00:10Z' })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.rows[0].inputTokens, 1000);
    assert.equal(report.coverage.legacySkippedRecords, 2);
    assert.equal(report.coverage.redundantLegacyRecords, 0);
    assert.equal(report.coverage.skippedRecords, 2);
    assert.match(report.coverage.warnings.join(' '), /旧版.*逐请求/);
});

test('suffix last usage cannot match a different thread even when another request has identical usage', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/other.jsonl', [meta('other'), context('turn-1'),
        modern('other-request', { thread: 'other', timestamp: '2026-11-16T10:00:01Z', input: 100,
            cached: 0, output: 10 })]);
    await f.write('sessions/isolated.jsonl', [meta('isolated'), context('turn-1'),
        modern('isolated-request', { thread: 'isolated' }),
        legacy(1100, 110, { last: [100, 10], timestamp: '2026-11-16T10:00:02Z' })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.coverage.legacySkippedRecords, 1);
    assert.equal(report.coverage.redundantLegacyRecords, 0);
});

test('native child legacy sources remain independent despite sharing the root session_id', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/a.jsonl', [meta('a', { session_id: 'root' }), context('turn-1'),
        legacy(100, 10, { last: [100, 10], timestamp: '2026-11-16T09:00:00Z' })]);
    await f.write('sessions/b.jsonl', [meta('b', { session_id: 'root' }), context('turn-1'),
        legacy(200, 20, { last: [200, 20], timestamp: '2026-11-16T09:01:00Z' })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.rows[0].inputTokens, 300);
});

test('missing cache write TTL uses the estimated Standard write rate and keeps distinct token categories', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/write.jsonl', [meta('root'), context('turn-1'), modern('write', { write: 100 })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].uncachedInputTokens, 700);
    assert.equal(report.rows[0].cacheWriteTokens, 100);
    assert.equal(report.rows[0].usd, 0.00267);
    assert.equal(report.rows[0].estimatedRequests, 1);
    assert.equal(report.rows[0].unpricedRequests, 0);
    assert.deepEqual(report.coverage.warnings, []);
});

test('persistent per-file metadata cache avoids reparsing, refreshes on append, and never saves chat text', async t =>
{
    const f = await fixture(t);
    const filename = await f.write('sessions/cache.jsonl', [meta('root'), context('turn-1'),
        { type: 'response_item', payload: { text: 'PRIVATE_CHAT_CANARY_493' } }, modern('first')]);
    const before = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    const first = f.collector();
    assert.equal((await first.scan()).coverage.parsedFiles, 1);
    assert.equal((await first.scan()).coverage.cachedFiles, 1);
    await first.dispose();
    const next = f.collector();
    assert.equal((await next.scan()).coverage.cachedFiles, 1);
    assert.equal(createHash('sha256').update(await fs.readFile(filename)).digest('hex'), before);
    const contents = [];
    async function readCache(directory)
    {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }))
        {
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) await readCache(child);
            else contents.push(await fs.readFile(child, 'utf8'));
        }
    }
    await readCache(f.cacheDir);
    assert.doesNotMatch(contents.join(''), /PRIVATE_CHAT_CANARY_493|response_item/);
    await fs.appendFile(filename, JSON.stringify(modern('appended')) + '\n');
    const report = await next.scan();
    assert.equal(report.coverage.parsedFiles, 1);
    assert.equal(report.rows[0].requests, 2);
});

test('a growing plain rollout contributes its complete initial records without caching the partial scan', async t =>
{
    const f = await fixture(t);
    const next = JSON.stringify(modern('append'));
    const filename = await f.write('sessions/growing.jsonl', [meta('root'), context('turn-1'), modern('initial')]);
    await fs.appendFile(filename, next.slice(0, 32));
    mutateAfterFirstRead(t, filename, () => fs.appendFile(filename, next.slice(32) + '\n'));
    const collector = f.collector();
    const first = await collector.scan();
    assert.equal(first.rows[0]?.requests, 1);
    assert.equal(first.coverage.failedFiles, 0);
    assert.equal(first.coverage.skippedRecords, 0);
    assert.equal(first.coverage.prefixFiles, 1);
    await assert.rejects(fs.readdir(path.join(f.cacheDir, 'usage-cache')), { code: 'ENOENT' });

    const second = await collector.scan();
    assert.equal(second.rows[0].requests, 2);
    assert.equal(second.coverage.parsedFiles, 1);
    assert.equal(second.coverage.prefixFiles, 0);
    assert.equal((await collector.scan()).coverage.cachedFiles, 1);
});

for (const change of ['replaced', 'truncated', 'rewritten and extended'])
{
    test(`a plain rollout ${change} during the scan cannot publish a prefix`, async t =>
    {
        const f = await fixture(t);
        const filename = await f.write('sessions/changing.jsonl', [meta('root'), context('turn-1'), modern('initial')]);
        const replacement = await f.write('replacement.tmp', [meta('root'), context('turn-1'), modern('other')]);
        mutateAfterFirstRead(t, filename, async () =>
        {
            if (change === 'replaced') await fs.rename(replacement, filename);
            else if (change === 'truncated') await fs.truncate(filename, 0);
            else await fs.writeFile(filename, (await fs.readFile(replacement, 'utf8')) + '\n'.repeat(100));
        });
        const report = await f.collector().scan();
        assert.deepEqual(report.rows, []);
        assert.equal(report.coverage.failedFiles, 1);
        await assert.rejects(fs.readdir(path.join(f.cacheDir, 'usage-cache')), { code: 'ENOENT' });
    });
}

test('old unchanged sources are excluded but old sessions resumed within retention are scanned', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/2020/01/01/old.jsonl', 'not scanned', { mtime: new Date('2020-01-01') });
    await f.write('sessions/2020/01/01/resumed.jsonl', [meta('root'), context('turn-1'), modern('resumed')]);
    const report = await f.collector().scan();
    assert.equal(report.coverage.files, 1);
    assert.equal(report.coverage.skippedRecords, 0);
    assert.equal(report.rows[0].requests, 1);
});

test('malformed, oversized and invalid usage records expose gaps and do not truncate later requests', async t =>
{
    const f = await fixture(t);
    const records = [JSON.stringify(meta('root')), JSON.stringify(context('turn-1')), '{bad json',
        JSON.stringify({ type: 'response_item', text: 'x'.repeat(1024 * 1024 + 1) }),
        JSON.stringify(modern('invalid-count', { cached: 2000 })),
        JSON.stringify(modern('invalid-time', { timestamp: 'never' })),
        JSON.stringify(modern('valid-tail'))].join('\n');
    await f.write('sessions/partial.jsonl', records);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.skippedRecords, 4);
    assert.ok(report.coverage.warnings.length);
    assert.doesNotMatch(JSON.stringify(report), /partial\.jsonl|bad json/);
});

test('broken compressed source fails visibly while valid sources still produce a report', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    await f.write('sessions/ok.jsonl', [meta('root'), context('turn-1'), modern('valid')]);
    const broken = await f.write('archived_sessions/broken.jsonl.zst', [meta('broken')], { compressed: true });
    const bytes = await fs.readFile(broken);
    await fs.writeFile(broken, bytes.subarray(0, bytes.length - 1));
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.failedFiles, 1);
    assert.match(report.coverage.warnings.join(' '), /失败/);
});

test('missing sources yield an empty report and disposal rejects later scans', async t =>
{
    const f = await fixture(t);
    const collector = f.collector();
    const report = await collector.scan();
    assert.deepEqual(report.rows, []);
    assert.equal(report.coverage.files, 0);
    assert.equal(report.generatedAt, Now);
    await collector.dispose();
    await assert.rejects(collector.scan(), { code: 'ERR_DAILY_USAGE_DISPOSED' });
});

test('weekly usage starts at the current reset and counts all responses including after 100%', async t =>
{
    const f = await fixture(t);
    const start = '2026-11-12T12:00:11.038Z';
    const reset = '2026-11-19T12:00:03Z';
    const resetWithJitter = '2026-11-19T12:00:01Z';
    const fullAt = '2026-11-16T10:10:00Z';
    const latest = '2026-11-16T11:00:00Z';
    const fullResponse = modern('first-full', { timestamp: fullAt, input: 300000, cached: 280000, output: 1000 });
    await f.write('sessions/active.jsonl', [meta('root'), context('turn-1'),
        modern('copied-old', { timestamp: start }),
        modern('first-in-window', { timestamp: start }),
        fullResponse, quota(fullAt, resetWithJitter, 100),
        modern('after-full', { timestamp: latest }), quota(latest, reset, 100),
        quota('2026-11-16T11:10:00Z', '2026-11-20T11:10:00Z', 0, { limit: 'other' }),
        quota('2026-11-16T11:20:00Z', '2026-11-23T11:20:00Z', 0, { minutes: 300 })]);
    await f.write('archived_sessions/older.jsonl' + (HasZstd ? '.zst' : ''), [meta('old'), context('turn-1'),
        modern('copied-old', { timestamp: '2026-11-12T11:59:56Z' }),
        quota('2026-11-12T11:59:57Z', '2026-11-12T12:00:00Z', 100),
        quota(start, reset, 0, { slot: 'secondary' }),
        fullResponse], { compressed: HasZstd });
    const report = await f.collector().scan();
    assert.deepEqual(report.weekly, { startAt: Date.parse('2026-11-12T12:00:00Z'), startKind: 'reset',
        resetAt: Date.parse(resetWithJitter), endAt: Now, partial: false,
        fullAt: Date.parse(fullAt), usedPercent: 100, sampleAt: Date.parse(latest),
        afterFull: { requests: 1, usd: 0.00262 }, rows: [
            { model: 'gpt-6.1-sol', requests: 3, usd: 0.15624,
                unpricedRequests: 0, estimatedRequests: 0 },
        ] });
    assert.equal(report.rows.find(row => row.date === '2026-11-12').requests, 2);
    assert.equal(report.rows.find(row => row.date === '2026-11-16').usd, 0.15362);
    assert.equal(report.coverage.duplicateRequests, 2);
});

test('a valid weekly expiry infers the start and keeps legacy and unpriced requests before generatedAt', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-19T12:00:00Z';
    const start = '2026-11-12T12:00:00Z';
    const sampled = '2026-11-16T09:00:00Z';
    const future = '2026-11-16T12:00:01Z';
    await f.write('sessions/older.jsonl', [meta('old'), context('turn-1'),
        legacy(500, 50, { last: [500, 50], timestamp: '2026-11-12T11:59:59Z' }),
        legacy(1000, 100, { last: [500, 50], timestamp: start }),
        quota(sampled, reset, 38.5, { limit: null }), quota(future, reset, 100, { limit: null })]);
    await f.write('sessions/modern.jsonl', [meta('root'), context('turn-1', 'unpriced'),
        modern('unpriced', { timestamp: '2026-11-16T11:30:00Z' }), modern('future', { timestamp: future })]);
    let now = Now;
    const collector = f.collector({ now: () => now });
    const expected = { startAt: Date.parse(start), startKind: 'inferred',
        resetAt: Date.parse(reset), endAt: Now, partial: false,
        fullAt: null, usedPercent: 38.5, sampleAt: Date.parse(sampled), afterFull: { requests: 0, usd: 0 }, rows: [
            { model: 'gpt-6.1-sol', requests: 1, usd: 0.0015,
                unpricedRequests: 0, estimatedRequests: 1 },
            { model: 'unpriced', requests: 1, usd: 0, unpricedRequests: 1, estimatedRequests: 0 },
        ] };
    assert.deepEqual((await collector.scan()).weekly, expected);
    const cached = await collector.scan();
    assert.deepEqual(cached.weekly, expected);
    assert.equal(cached.coverage.cachedFiles, 2);
    now = Date.parse(future);
    const next = await collector.scan();
    assert.equal(next.coverage.parsedFiles, 1);
    assert.deepEqual(next.weekly, { ...expected, endAt: now, fullAt: now, usedPercent: 100, sampleAt: now,
        rows: [expected.rows[0], { ...expected.rows[1], requests: 2, unpricedRequests: 2 }] });
    now = Now;
    assert.deepEqual((await collector.scan()).weekly, expected);
});

test('expired or malformed weekly observations cannot label this cycle', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-19T12:00:00Z';
    await f.write('sessions/quota.jsonl', [meta('root'), context('turn-1'), modern('paid'),
        quota(Stamp, '2026-11-16T11:00:00Z', 100),
        quota(Stamp, '2026-11-16T12:00:00Z', 50),
        quota(Stamp, reset, -1), quota(Stamp, reset, '50'), quota(Stamp, reset, 101),
        quota(Stamp, 'invalid', 0), quota(Stamp, '2026-11-24T12:00:00Z', 0),
        quota('2026-11-16T14:00:00Z', reset, 0)]);
    const report = await f.collector().scan();
    assert.equal(report.weekly, null);
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.skippedRecords, 0);
});

test('expiry jitter that would place the inferred start after usage falls back to the earliest real sample', async t =>
{
    const f = await fixture(t);
    const firstSample = '2026-11-12T12:00:00Z';
    await f.write('sessions/early-quota.jsonl', [quota(firstSample, '2026-11-19T12:00:03Z', 1),
        quota(Stamp, '2026-11-19T12:00:04Z', 25)]);
    const report = await f.collector().scan();
    assert.deepEqual(report.weekly, { startAt: Date.parse(firstSample), startKind: 'observed', fullAt: null,
        resetAt: Date.parse('2026-11-19T12:00:03Z'), endAt: Now, partial: false,
        usedPercent: 25, sampleAt: Date.parse(Stamp), afterFull: { requests: 0, usd: 0 }, rows: [] });
});

test('weekly inference uses the earliest expiry in the current jitter range and ignores a late zero', async t =>
{
    const f = await fixture(t);
    const earliest = '2026-11-19T12:00:00Z';
    const latest = '2026-11-19T12:00:04Z';
    const first = '2026-11-12T12:00:10Z';
    await f.write('sessions/early-quota.jsonl', [meta('root'), context('turn-1'),
        modern('first-request', { timestamp: '2026-11-12T12:00:01Z' }), quota(first, earliest, 1),
        quota('2026-11-12T12:05:00Z', latest, 0), quota(Stamp, latest, 25)]);
    const report = await f.collector().scan();
    assert.deepEqual(report.weekly, { startAt: Date.parse('2026-11-12T12:00:00Z'), startKind: 'inferred',
        resetAt: Date.parse(earliest), endAt: Now, partial: false, afterFull: { requests: 0, usd: 0 },
        fullAt: null, usedPercent: 25, sampleAt: Date.parse(Stamp), rows: [{ model: 'gpt-6.1-sol',
            requests: 1, usd: 0.00262, estimatedRequests: 0, unpricedRequests: 0 }] });
});

test('a first zero an hour after the predicted reset keeps earlier requests in the inferred window', async t =>
{
    const f = await fixture(t);
    const start = '2026-11-12T12:00:00Z';
    const reset = '2026-11-19T12:00:00Z';
    const first = '2026-11-12T13:00:00Z';
    await f.write('sessions/late-first-quota.jsonl', [meta('root'), context('turn-1'),
        modern('paid-before-first-quota', { timestamp: '2026-11-12T12:01:00Z' }), quota(first, reset, 0)]);
    const report = await f.collector().scan();
    assert.deepEqual(report.weekly, { startAt: Date.parse(start), startKind: 'inferred',
        resetAt: Date.parse(reset), endAt: Now, partial: false, afterFull: { requests: 0, usd: 0 },
        fullAt: null, usedPercent: 0, sampleAt: Date.parse(first), rows: [{ model: 'gpt-6.1-sol',
            requests: 1, usd: 0.00262, estimatedRequests: 0, unpricedRequests: 0 }] });
});

test('an expired latest weekly cycle never falls back to older conflicting future expiry evidence', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/older-quota.jsonl', [quota('2026-11-16T09:00:00Z', '2026-11-17T12:00:00Z', 100)]);
    await f.write('sessions/newer-quota.jsonl', [quota(Stamp, '2026-11-16T11:00:00Z', 50)]);
    assert.equal((await f.collector().scan()).weekly, null);
});

test('reset jitter keeps one observed cycle and uses its earliest exclusive reset', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/quota.jsonl', [quota('2026-11-16T09:00:00Z', '2026-11-16T12:00:03Z', 100),
        quota(Stamp, '2026-11-16T11:59:59Z', 100)]);
    const report = await f.collector().scan();
    assert.equal(report.weekly, null);
    assert.equal(report.weeklyHistory.length, 1);
    assert.equal(report.weeklyHistory[0].resetAt, Date.parse('2026-11-16T11:59:59Z'));
    assert.equal(report.weeklyHistory[0].sampleAt, Date.parse(Stamp));
    assert.equal(report.weeklyHistory[0].fullAt, Date.parse('2026-11-16T09:00:00Z'));
});

test('calendar and weekly Standard agree on cache write charges and estimated or missing amounts', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/cache-write.jsonl', [meta('root'), context('turn-1'),
        modern('ttl-known', { input: 100000, cached: 0, write: 100000, writeTtl: '12h', output: 0 }),
        modern('ttl-unknown', { input: 100000, cached: 0, write: 100000, output: 0 }),
        modern('write-unpriced', { model: 'gpt-5.5', input: 1000, cached: 200, write: 100, writeTtl: '12h' }),
        quota(Stamp, '2026-11-19T12:00:00Z', 25)]);
    const report = await f.collector().scan();
    assert.deepEqual(report.weekly.rows, [
        { model: 'gpt-5.5', requests: 1, usd: 0.0066, unpricedRequests: 1, estimatedRequests: 0 },
        { model: 'gpt-6.1-sol', requests: 2, usd: 0.75, unpricedRequests: 0, estimatedRequests: 1 },
    ]);
    assert.deepEqual(report.rows.map(row => [row.model, row.usd, row.unpricedRequests, row.estimatedRequests]),
        [['gpt-5.5', 0.0066, 1, 0], ['gpt-6.1-sol', 0.75, 0, 1]]);
});

test('weekly history counts through the exclusive reset and keeps an after-full subtotal', async t =>
{
    const f = await fixture(t);
    const start = '2026-11-05T12:00:00Z';
    const reset = '2026-11-12T12:00:00Z';
    const fullAt = '2026-11-08T10:00:00Z';
    const last = '2026-11-11T12:00:00Z';
    const currentFull = '2026-11-14T10:00:00Z';
    await f.write('sessions/active.jsonl', [quota(start, reset, 0),
        modern('full', { timestamp: '2026-11-12T12:00:01Z', model: 'full' }),
        modern('current-start', { timestamp: reset, model: 'current' }),
        quota(reset, '2026-11-19T12:00:00Z', 0), quota(currentFull, '2026-11-19T12:00:17Z', 100),
        modern('current-after-full', { timestamp: Stamp, model: 'after-full' }),
        quota(Stamp, '2026-11-19T12:00:31Z', 100)]);
    await f.write('archived_sessions/older.jsonl', [
        quota('2026-11-02T12:00:00Z', start, 30),
        modern('before-reset', { timestamp: '2026-11-05T11:59:59.999Z', model: 'before-reset' }),
        modern('history-start', { timestamp: start, model: 'history' }),
        modern('full', { timestamp: fullAt, model: 'full' }),
        quota(fullAt, '2026-11-12T12:00:17Z', 100),
        modern('after-full', { timestamp: '2026-11-08T10:00:00.001Z', model: 'after-full' }),
        quota(last, reset, 100)]);
    const report = await f.collector().scan();
    assert.deepEqual(report.weeklyHistory.map(({ startAt, endAt, fullAt, sampleAt, usedPercent, rows }) => ({
        startAt, endAt, fullAt, sampleAt, usedPercent, models: rows.map(row => [row.model, row.requests]),
    })), [
        { startAt: Date.parse(start), endAt: Date.parse(reset) - 1, fullAt: Date.parse(fullAt),
            sampleAt: Date.parse(last), usedPercent: 100, models: [['after-full', 1], ['full', 1], ['history', 1]] },
        { startAt: Date.parse('2026-10-29T12:00:00Z'), endAt: Date.parse(start) - 1, fullAt: null,
            sampleAt: Date.parse('2026-11-02T12:00:00Z'), usedPercent: 30, models: [['before-reset', 1]] },
    ]);
    assert.equal(report.weekly.fullAt, Date.parse(currentFull));
    assert.deepEqual(report.weekly.rows.map(row => [row.model, row.requests]), [['after-full', 1], ['current', 1]]);
    assert.deepEqual(report.weekly.afterFull, { requests: 1, usd: 0 });
    assert.deepEqual(report.weeklyHistory[0].afterFull, { requests: 1, usd: 0 });
    assert.equal(report.coverage.duplicateRequests, 1);
});

test('weekly history keeps distinct observed cycles and marks its oldest truncated cycle partial', async t =>
{
    const f = await fixture(t);
    const now = Date.parse('2026-11-19T12:00:00Z');
    const collector = f.collector({ now: () => now });
    await f.write('sessions/active.jsonl', [
        quota('2026-11-19T11:00:00Z', '2026-11-20T12:00:00Z', 65),
        quota('2026-11-12T10:00:00Z', '2026-11-13T12:00:00Z', 75),
        quota('2026-10-29T10:00:00Z', '2026-10-30T12:00:00Z', 50),
        modern('before-retention', { timestamp: '2026-10-20T15:59:59.999Z', model: 'before-retention' }),
        modern('at-retention', { timestamp: '2026-10-20T16:00:00Z', model: 'retained' }),
        modern('unobserved-cycle', { timestamp: '2026-11-04T10:00:00Z', model: 'gap' })]);
    const report = await collector.scan();
    assert.deepEqual(report.weeklyHistory.map(period => [period.startAt, period.endAt, period.partial]), [
        [Date.parse('2026-11-06T12:00:00Z'), Date.parse('2026-11-13T12:00:00Z') - 1, false],
        [Date.parse('2026-10-23T12:00:00Z'), Date.parse('2026-10-30T12:00:00Z') - 1, false],
    ]);
    assert.deepEqual(report.weeklyHistory[1].rows, []);
    assert.deepEqual(report.weeklyRemainder.unassigned, { requests: 2, usd: 0 });
    await f.write('sessions/active.jsonl', [
        quota('2026-11-19T11:00:00Z', '2026-11-20T12:00:00Z', 65),
        quota('2026-11-12T10:00:00Z', '2026-11-13T12:00:00Z', 75),
        quota('2026-10-26T10:00:00Z', '2026-10-27T12:00:00Z', 50),
        modern('before-retention', { timestamp: '2026-10-20T15:59:59.999Z', model: 'before-retention' }),
        modern('at-retention', { timestamp: '2026-10-20T16:00:00Z', model: 'retained' })]);
    const partial = (await collector.scan()).weeklyHistory[1];
    assert.equal(partial.startAt, Date.parse('2026-10-20T12:00:00Z'));
    assert.equal(partial.partial, true);
    assert.deepEqual(partial.rows.map(row => [row.model, row.requests]), [['retained', 1]]);
});

test('a stale cycle stays in history when no current quota has been observed', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/active.jsonl', [
        quota('2026-11-14T12:00:00Z', '2026-11-15T12:00:00Z', 65),
        modern('known', { timestamp: '2026-11-14T13:00:00Z', model: 'historical' }),
        modern('unknown', { timestamp: Stamp, model: 'unobserved' })]);
    const report = await f.collector().scan();
    assert.equal(report.weekly, null);
    assert.deepEqual(report.weeklyHistory.map(period => period.rows.map(row => [row.model, row.requests])), [
        [['historical', 1]],
    ]);
});

test('standalone quota readings preserve all overlapping resets without assigning nearby responses', async t =>
{
    const f = await fixture(t);
    const oldSample = '2026-11-11T09:00:00Z';
    await f.write('sessions/active.jsonl', [quota(Stamp, '2026-11-19T12:00:00Z', 65),
        quota('2026-11-13T09:00:00Z', '2026-11-15T12:00:00Z', 25),
        quota('2026-11-08T09:00:00Z', '2026-11-14T12:00:00Z', 40),
        quota(oldSample, '2026-11-13T12:00:00Z', 75),
        modern('confirmed', { timestamp: oldSample, model: 'confirmed' }),
        modern('ambiguous', { timestamp: '2026-11-11T10:00:00Z', model: 'ambiguous' }),
        modern('current', { timestamp: Stamp, model: 'current' })]);
    const report = await f.collector().scan();
    assert.deepEqual(report.weekly.rows.map(row => row.model), ['current']);
    assert.deepEqual(report.weeklyHistory.map(period => [period.endAt, period.partial, period.rows]), [
        [Date.parse('2026-11-15T12:00:00Z') - 1, true, []],
        [Date.parse('2026-11-14T12:00:00Z') - 1, true, []],
        [Date.parse('2026-11-13T12:00:00Z') - 1, true, []],
    ]);
    assert.deepEqual(report.weeklyRemainder.unassigned, { requests: 2, usd: 0 });
});

test('overlapping historical windows retain their bounds and count requests with unique timestamps', async t =>
{
    const f = await fixture(t);
    const newerStart = '2026-11-06T10:00:00Z';
    const newerFull = '2026-11-10T10:00:00Z';
    const olderSample = '2026-11-04T12:00:00Z';
    await f.write('sessions/active.jsonl', [quota(Stamp, '2026-11-19T12:00:00Z', 65),
        quota(newerStart, '2026-11-12T12:00:00Z', 35), quota(newerFull, '2026-11-12T12:00:00Z', 100),
        quota(olderSample, '2026-11-06T12:00:00Z', 75),
        modern('older-sample', { timestamp: olderSample, model: 'older' }),
        modern('overlap', { timestamp: '2026-11-05T15:00:00Z', model: 'overlap' }),
        modern('newer-full', { timestamp: newerFull, model: 'newer' })]);
    const { weeklyHistory, weeklyRemainder } = await f.collector().scan();
    assert.deepEqual(weeklyHistory.map(period => [period.startAt, period.endAt, period.fullAt, period.partial,
        period.rows.map(row => row.model)]), [
        [Date.parse('2026-11-05T12:00:00Z'), Date.parse('2026-11-12T12:00:00Z') - 1, Date.parse(newerFull), true, ['newer']],
        [Date.parse('2026-10-30T12:00:00Z'), Date.parse('2026-11-06T12:00:00Z') - 1, null, true, ['older']],
    ]);
    assert.deepEqual(weeklyRemainder.unassigned, { requests: 1, usd: 0 });
});

test('an overlapping inferred current start keeps its boundary and leaves ambiguous usage in the remainder', async t =>
{
    const f = await fixture(t);
    const currentSample = '2026-11-16T12:00:00Z';
    const olderSample = '2026-11-11T11:00:00Z';
    await f.write('sessions/active.jsonl', [quota(currentSample, '2026-11-19T12:00:00Z', 100),
        quota(olderSample, '2026-11-15T12:00:00Z', 75),
        modern('old', { timestamp: olderSample, model: 'old' }),
        modern('ambiguous', { timestamp: '2026-11-13T12:00:00Z', model: 'ambiguous' }),
        modern('full', { timestamp: currentSample, model: 'full' })]);
    const { weekly, weeklyHistory, weeklyRemainder } = await f.collector().scan();
    assert.equal(weekly.startAt, Date.parse('2026-11-12T12:00:00Z'));
    assert.equal(weekly.startKind, 'inferred');
    assert.equal(weekly.fullAt, Date.parse(currentSample));
    assert.deepEqual(weekly.rows.map(row => row.model), ['full']);
    assert.deepEqual(weeklyHistory.map(period => [period.endAt, period.partial, period.rows.map(row => row.model)]),
        [[Date.parse('2026-11-15T12:00:00Z') - 1, true, ['old']]]);
    assert.deepEqual(weeklyRemainder.unassigned, { requests: 1, usd: 0 });
});

test('an observed overlapping reset keeps a history slot even if its usage is unassigned', async t =>
{
    const f = await fixture(t);
    const currentSample = '2026-11-16T12:00:00Z';
    const disputedSample = '2026-11-14T10:00:00Z';
    const olderSample = '2026-11-07T18:00:00Z';
    await f.write('sessions/active.jsonl', [quota(currentSample, '2026-11-19T12:00:00Z', 65),
        quota(disputedSample, '2026-11-15T12:00:00Z', 50), quota(olderSample, '2026-11-08T12:00:00Z', 75),
        modern('old', { timestamp: olderSample, model: 'old' }),
        modern('disputed', { timestamp: disputedSample, model: 'disputed' }),
        modern('current', { timestamp: currentSample, model: 'current' })]);
    const { weekly, weeklyHistory, weeklyRemainder } = await f.collector().scan();
    assert.deepEqual(weekly.rows.map(row => row.model), ['current']);
    assert.deepEqual(weeklyHistory.map(period => [period.endAt, period.rows.map(row => row.model)]),
        [[Date.parse('2026-11-15T12:00:00Z') - 1, []], [Date.parse('2026-11-08T12:00:00Z') - 1, ['old']]]);
    assert.deepEqual(weeklyRemainder.unassigned, { requests: 1, usd: 0 });
});

test('a quota sample at the exact reset does not erase the prior cycle and its known first full response', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-12T12:00:00Z';
    const full = '2026-11-07T08:00:00Z';
    await f.write('sessions/active.jsonl', [quota('2026-11-06T02:00:00Z', reset, 40),
        quota(full, reset, 100), quota(reset, reset, 100), quota('2026-11-12T13:00:00Z', '2026-11-19T12:00:00Z', 4),
        quota('2026-11-16T12:00:00Z', '2026-11-19T12:00:00Z', 20),
        modern('full', { timestamp: full, model: 'full' }),
        modern('reset', { timestamp: reset, model: 'reset' })]);
    const { weekly, weeklyHistory } = await f.collector().scan();
    assert.deepEqual(weekly.rows.map(row => row.model), ['reset']);
    assert.deepEqual(weeklyHistory.map(period => [period.endAt, period.fullAt, period.rows.map(row => row.model)]),
        [[Date.parse(reset) - 1, Date.parse(full), ['full']]]);
});

test('an ordinary pre-reset reading survives an exact reset and invalidates only the affected old cache', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-12T12:00:00Z';
    const priorSample = '2026-11-07T08:00:00Z';
    const prior = await f.write('sessions/prior.jsonl', [quota('2026-11-06T02:00:00Z', reset, 40),
        quota(priorSample, reset, 70), quota(reset, reset, 75)]);
    await f.write('sessions/current.jsonl', [quota('2026-11-12T13:00:00Z', '2026-11-19T12:00:00Z', 4),
        quota('2026-11-16T12:00:00Z', '2026-11-19T12:00:00Z', 20)]);
    const first = f.collector();
    const report = await first.scan();
    assert.deepEqual(report.weeklyHistory.map(period => [period.sampleAt, period.usedPercent, period.endAt]),
        [[Date.parse(priorSample), 70, Date.parse(reset) - 1]]);
    await first.dispose();

    const key = createHash('sha256').update(path.relative(f.home, prior)).digest('hex');
    const cacheDirectory = path.join(f.cacheDir, 'usage-cache');
    for (const name of await fs.readdir(cacheDirectory))
    {
        const filename = path.join(cacheDirectory, name);
        const cache = JSON.parse(await fs.readFile(filename, 'utf8'));
        for (const sample of cache.data.weeklySamples) delete sample.beforeJitter;
        if (name === key + '.json')
            Object.assign(cache.data.weeklySamples[0], { sampleAt: Date.parse(reset), usedPercent: 75 });
        await fs.writeFile(filename, JSON.stringify(cache));
    }

    const next = f.collector();
    const repaired = await next.scan();
    assert.equal(repaired.coverage.parsedFiles, 1);
    assert.equal(repaired.coverage.cachedFiles, 1);
    assert.deepEqual(repaired.weeklyHistory, report.weeklyHistory);
    const cached = await next.scan();
    assert.equal(cached.coverage.cachedFiles, 2);
    assert.deepEqual(cached.weeklyHistory, report.weeklyHistory);
});

test('overlapping reset jitter retains an ordinary reading recorded before either advertised boundary', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-12T12:00:00Z';
    const laterReset = '2026-11-12T12:00:19Z';
    const visibleSample = '2026-11-11T11:00:00Z';
    await f.write('sessions/prior.jsonl', [quota('2026-11-07T08:00:00Z', reset, 68),
        quota(visibleSample, laterReset, 70), quota('2026-11-12T12:00:11Z', laterReset, 75)]);
    await f.write('sessions/current.jsonl', [quota('2026-11-12T13:00:00Z', '2026-11-19T12:00:00Z', 4),
        quota('2026-11-16T12:00:00Z', '2026-11-19T12:00:00Z', 20)]);
    const collector = f.collector();
    const { weeklyHistory } = await collector.scan();
    assert.deepEqual(weeklyHistory.map(period => [period.sampleAt, period.usedPercent, period.endAt]),
        [[Date.parse(visibleSample), 70, Date.parse(reset) - 1]]);
    const cached = await collector.scan();
    assert.equal(cached.coverage.cachedFiles, 2);
    assert.deepEqual(cached.weeklyHistory, weeklyHistory);
});

test('overlap is assigned by originating response evidence and preserves a full-cycle partition', async t =>
{
    const f = await fixture(t);
    const oldReset = '2026-11-14T12:00:00Z';
    const newReset = '2026-11-19T12:00:00Z';
    const oldFull = '2026-11-11T17:59:59Z';
    const first = '2026-11-12T18:00:00Z';
    const second = '2026-11-12T18:01:00Z';
    const third = '2026-11-12T18:02:00Z';
    function counters(input, output)
    {
        return { input_tokens: input, cached_input_tokens: 0, output_tokens: output };
    }
    function paired(id, stamp, seconds, reset, input, total, legacyTotal, options = {})
    {
        const timestamp = new Date(Date.parse(stamp) + seconds * 1000).toISOString();
        const observation = legacy(legacyTotal, legacyTotal / 10, { timestamp, last: [input, input / 10] });
        observation.payload.rate_limits = quota(timestamp, reset, 100).payload.rate_limits;
        return [modern(id, { model: 'gpt-6.1-sol', timestamp: stamp, input, cached: 0, output: input / 10,
            thread_token_usage: counters(total, total / 10), ...options }), observation];
    }
    const oldPair = paired('first-offset', first, 1, oldReset, 1000, 10000, 9000);
    const retry = structuredClone(oldPair[1]);
    retry.timestamp = '2026-11-12T18:00:02Z';
    retry.payload.rate_limits.primary.resets_at++;
    await f.write('sessions/origin.jsonl', [meta('root'), context('turn-1'), quota(oldFull, oldReset, 100),
        ...oldPair, retry, ...paired('second-offset', second, 1, oldReset, 2000, 12000, 11000),
        ...paired('exact-other-cycle', third, 1, newReset, 3000, 15000, 15000),
        ...paired('uncorroborated', '2026-11-12T18:03:00Z', 1, oldReset, 4000, 19000, 10000),
        quota('2026-11-16T11:00:00Z', newReset, 100),
        modern('current-after-full', { timestamp: '2026-11-16T11:30:00Z' }),
        modern('future', { timestamp: '2026-11-16T12:00:01Z' })]);
    await f.write('archived_sessions/fork.jsonl', [meta('fork'), context('turn-1'),
        ...paired('uncorroborated', '2026-11-12T18:03:00Z', 2, newReset, 4000, 19000, 19000)]);
    const collector = f.collector();
    const { rows, weekly, weeklyHistory, weeklyRemainder } = await collector.scan();
    assert.deepEqual(weeklyHistory.map(period => [period.resetAt, period.endAt, period.fullAt, period.rows,
        period.afterFull]), [[Date.parse(oldReset), Date.parse(oldReset) - 1, Date.parse(oldFull),
        [{ model: 'gpt-6.1-sol', requests: 2, usd: 0.009, estimatedRequests: 0, unpricedRequests: 0 }],
        { requests: 2, usd: 0.009 }]]);
    assert.deepEqual(weekly.rows, [
        { model: 'gpt-6.1-sol', requests: 2, usd: 0.01162, estimatedRequests: 0, unpricedRequests: 0 },
    ]);
    assert.deepEqual(weekly.afterFull, { requests: 1, usd: 0.00262 });
    assert.deepEqual(weeklyRemainder, { earlier: { requests: 0, usd: 0 }, unassigned: { requests: 1, usd: 0.012 } });
    assert.deepEqual(rows.map(row => [row.requests, row.usd]), [[1, 0.00262], [4, 0.03]]);
    assert.equal((await collector.scan()).coverage.cachedFiles, 2);
});

test('older observed windows and uncovered dates remain visible in the weekly remainder', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/windows.jsonl', [meta('root'), context('turn-1'),
        quota('2026-10-18T10:00:00Z', '2026-10-21T12:00:00Z', 20),
        quota('2026-10-27T10:00:00Z', '2026-10-28T12:00:00Z', 40),
        quota('2026-11-04T10:00:00Z', '2026-11-05T12:00:00Z', 45),
        quota('2026-11-08T10:00:00Z', '2026-11-10T12:00:00Z', 60),
        quota(Stamp, '2026-11-17T12:00:00Z', 70),
        modern('earlier', { timestamp: '2026-10-20T10:00:00Z' }),
        modern('gap', { timestamp: '2026-10-29T10:00:00Z' })]);
    const { weeklyHistory, weeklyRemainder } = await f.collector().scan();
    assert.deepEqual(weeklyHistory.map(period => new Date(period.resetAt).toISOString()),
        ['2026-11-10T12:00:00.000Z', '2026-11-05T12:00:00.000Z', '2026-10-28T12:00:00.000Z']);
    assert.deepEqual(weeklyRemainder, { earlier: { requests: 1, usd: 0.00262 }, unassigned: { requests: 1, usd: 0.00262 } });
});

test('an earlier copy uses one canonical timestamp for both Beijing dates and reset windows', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-12T16:00:00Z';
    const nextReset = '2026-11-19T16:00:00Z';
    await f.write('sessions/copy.jsonl', [meta('fork'), context('turn-1'),
        modern('copied', { timestamp: '2026-11-12T16:00:00Z' }), quota(Stamp, nextReset, 20),
        modern('current', { timestamp: '2026-11-16T12:00:01Z', model: 'future-copy' })]);
    await f.write('archived_sessions/original.jsonl', [meta('root'), context('turn-1'),
        modern('copied', { timestamp: '2026-11-12T15:59:59.999Z' }),
        quota('2026-11-12T15:59:59.999Z', reset, 80), modern('current')]);
    const { rows, weekly, weeklyHistory } = await f.collector().scan();
    assert.deepEqual(rows.map(row => [row.date, row.requests, row.usd]), [
        ['2026-11-16', 1, 0.00262], ['2026-11-12', 1, 0.00262],
    ]);
    assert.equal(weekly.rows[0].requests, 1);
    assert.equal(weeklyHistory[0].rows[0].requests, 1);
});

test('an offset cannot borrow corroboration from a response with different exact evidence', async t =>
{
    const f = await fixture(t);
    const oldReset = '2026-11-14T12:00:00Z';
    const newReset = '2026-11-19T12:00:00Z';
    function observation(total, timestamp, reset)
    {
        const event = legacy(total, total / 10, { timestamp, last: [1000, 100] });
        event.payload.rate_limits = quota(timestamp, reset, 43).payload.rate_limits;
        return event;
    }
    function response(id, timestamp, total)
    {
        return modern(id, { timestamp, cached: 0,
            thread_token_usage: { input_tokens: total, output_tokens: total / 10 } });
    }
    await f.write('sessions/origin.jsonl', [meta('root'), context('turn-1'),
        response('exact', '2026-11-13T10:00:00Z', 1000),
        observation(1000, '2026-11-13T10:00:01Z', newReset),
        observation(5000, '2026-11-13T10:00:02Z', oldReset),
        response('no-exact', '2026-11-13T10:00:03Z', 2000),
        observation(6000, '2026-11-13T10:00:04Z', oldReset), quota(Stamp, newReset, 61)]);
    const { weekly, weeklyHistory, weeklyRemainder } = await f.collector().scan();
    assert.equal(weekly.rows[0].requests, 1);
    assert.deepEqual(weeklyHistory[0].rows, []);
    assert.deepEqual(weeklyRemainder.unassigned, { requests: 1, usd: 0.003 });
});

test('a positive unmatched snapshot vetoes time-only attribution in a single window', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-19T12:00:00Z';
    const snapshotAt = '2026-11-16T09:00:00.030Z';
    const snapshot = legacy(5000, 500, { timestamp: snapshotAt, last: [0, 0] });
    snapshot.payload.rate_limits = quota(snapshotAt, reset, 30).payload.rate_limits;
    await f.write('sessions/origin.jsonl', [meta('root'), context('turn-1'),
        modern('contradicted', { timestamp: '2026-11-16T09:00:00Z', cached: 0,
            thread_token_usage: { input_tokens: 6000, output_tokens: 600 } }), snapshot,
        modern('no-usage-observation'), quota('2026-11-16T10:00:01Z', reset, 35)]);
    const collector = f.collector();
    const report = await collector.scan();
    assert.deepEqual(report.weekly.rows, [
        { model: 'gpt-6.1-sol', requests: 1, usd: 0.00262, estimatedRequests: 0, unpricedRequests: 0 },
    ]);
    assert.deepEqual(report.weeklyRemainder.unassigned, { requests: 1, usd: 0.003 });
    assert.equal(report.weekly.partial, true);
    assert.deepEqual((await collector.scan()).weeklyRemainder, report.weeklyRemainder);
});

test('the most recently sampled open reset is current and the other open reset remains visible', async t =>
{
    const f = await fixture(t);
    const currentReset = '2026-11-19T12:00:00Z';
    const alternateReset = '2026-11-20T12:00:00Z';
    const observedAt = '2026-11-16T10:00:01Z';
    const paired = legacy(1000, 100, { timestamp: observedAt, last: [1000, 100] });
    paired.payload.rate_limits = quota(observedAt, alternateReset, 20).payload.rate_limits;
    await f.write('sessions/switched.jsonl', [meta('root'), context('turn-1'),
        quota('2026-11-11T10:00:00Z', '2026-11-12T12:00:00Z', 15),
        modern('alternate', { cached: 0, thread_token_usage: { input_tokens: 1000, output_tokens: 100 } }),
        paired, quota('2026-11-16T11:00:00Z', currentReset, 25)]);
    const { weekly, weeklyHistory, weeklyRemainder } = await f.collector().scan();
    assert.equal(weekly.resetAt, Date.parse(currentReset));
    assert.deepEqual(weeklyHistory.map(period => [period.resetAt, period.endAt, period.rows.length]), [
        [Date.parse(alternateReset), Now, 1],
        [Date.parse('2026-11-12T12:00:00Z'), Date.parse('2026-11-12T12:00:00Z') - 1, 0],
    ]);
    assert.equal(weeklyHistory[0].rows[0].usd, 0.003);
    assert.deepEqual(weeklyRemainder.unassigned, { requests: 0, usd: 0 });
});

test('the previous reset anchors the next week when the first zero is observed thirty seconds later', async t =>
{
    const f = await fixture(t);
    const start = '2026-11-12T12:00:00Z';
    const reset = '2026-11-19T12:00:00Z';
    await f.write('sessions/reset.jsonl', [meta('root'), context('turn-1'),
        quota('2026-11-12T11:20:00Z', start, 100),
        modern('first-at-reset', { timestamp: start }),
        modern('before-first-zero', { timestamp: '2026-11-12T12:00:29.999Z' }),
        quota('2026-11-12T12:00:30Z', reset, 0), quota(Stamp, reset, 30)]);
    const { weekly, weeklyHistory, weeklyRemainder } = await f.collector().scan();
    assert.equal(weekly.startAt, Date.parse(start));
    assert.equal(weekly.startKind, 'reset');
    assert.equal(weekly.rows[0].requests, 2);
    assert.equal(weeklyHistory[0].endAt, Date.parse(start) - 1);
    assert.deepEqual(weeklyRemainder.unassigned, { requests: 0, usd: 0 });
});

test('different sources with resets thirty seconds apart and conflicting percentages keep both cycles', async t =>
{
    const f = await fixture(t);
    const firstReset = '2026-11-19T12:00:00Z';
    const secondReset = '2026-11-19T12:00:30Z';
    await f.write('sessions/first.jsonl', [meta('first'), quota(Stamp, firstReset, 100)]);
    await f.write('sessions/second.jsonl', [meta('second'), quota('2026-11-16T10:01:00Z', secondReset, 8)]);
    const { weekly, weeklyHistory } = await f.collector().scan();
    assert.deepEqual([weekly, ...weeklyHistory].map(period => [period.resetAt, period.usedPercent, period.fullAt]), [
        [Date.parse(secondReset), 8, null], [Date.parse(firstReset), 100, Date.parse(Stamp)],
    ]);
});

test('a conflicting replay keeps the earliest calendar date and leaves its weekly usage unassigned', async t =>
{
    const f = await fixture(t);
    const reset = '2026-11-12T16:00:00Z';
    const nextReset = '2026-11-19T16:00:00Z';
    const observed = '2026-11-12T15:59:59.030Z';
    const originalSnapshot = legacy(1700, 100, { timestamp: observed, last: [1700, 100] });
    originalSnapshot.payload.rate_limits = quota(observed, reset, 75).payload.rate_limits;
    await f.write('sessions/replay.jsonl', [meta('fork'), context('turn-1'),
        modern('conflict', { timestamp: reset }), quota(Stamp, nextReset, 20)]);
    await f.write('archived_sessions/original.jsonl', [meta('root'), context('turn-1'),
        modern('conflict', { timestamp: '2026-11-12T15:59:59Z', input: 1700, cached: 0,
            thread_token_usage: { input_tokens: 1700, output_tokens: 100 } }), originalSnapshot]);
    const report = await f.collector().scan();
    assert.deepEqual(report.rows.map(row => [row.date, row.requests, row.usd]), [['2026-11-12', 1, 0.00262]]);
    assert.deepEqual(report.weekly.rows, []);
    assert.deepEqual(report.weeklyHistory[0].rows, []);
    assert.deepEqual(report.weeklyRemainder.unassigned, { requests: 1, usd: 0.00262 });
    assert.equal(report.coverage.conflictingRequests, 1);
});
