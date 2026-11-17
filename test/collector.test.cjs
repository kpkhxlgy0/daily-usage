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
    cached = 200, write = 0, output = 100, ...extra } = {})
{
    return { type: 'token_usage_record', timestamp, payload: { response_id: id,
        thread_id: thread, turn_id: turn, usage: { input_tokens: input, cached_input_tokens: cached,
            cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: 60,
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
    assert.equal(report.pricing.basis, 'standard-base-api');
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

test('pre-native-parser schema cache is invalidated rather than returning stale missing modern usage', async t =>
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
    cached.schemaVersion = 1;
    cached.data.modern = [];
    cached.data.modernThreads = [];
    await fs.writeFile(filename, JSON.stringify(cached));
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.parsedFiles, 1);
});

test('unchanged parsed usage caches are reused and long requests are repriced at base rates', async t =>
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
    assert.equal(report.rows[0].usd, 0.53);
    assert.equal(report.pricing.basis, 'standard-base-api');
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

test('one modern response corroborates one distinct offset counter while exact counter replay stays informational',
    async t =>
{
    const f = await fixture(t);
    await f.write('sessions/consumed-offset.jsonl', [meta('root'), context('turn-1'),
        modern('one-response', { cached: 0 }),
        legacy(5000, 500, { timestamp: '2026-11-16T10:00:01Z', last: [1000, 100] }),
        legacy(6000, 600, { timestamp: '2026-11-16T10:00:02Z', last: [1000, 100] }),
        legacy(5000, 500, { timestamp: '2026-11-16T10:00:03Z', last: [1000, 100] })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.redundantLegacyRecords, 2);
    assert.equal(report.coverage.legacySkippedRecords, 1);
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

test('unknown cache write TTL retains token category and priced subtotal', async t =>
{
    const f = await fixture(t);
    await f.write('sessions/write.jsonl', [meta('root'), context('turn-1'), modern('write', { write: 100 })]);
    const report = await f.collector().scan();
    assert.equal(report.rows[0].uncachedInputTokens, 700);
    assert.equal(report.rows[0].cacheWriteTokens, 100);
    assert.equal(report.rows[0].usd, 0.00242);
    assert.equal(report.rows[0].unpricedRequests, 1);
    assert.match(report.coverage.warnings.join(' '), /未定价/);
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
