'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { Pricing } = require('../src/pricing.cjs');
const { mountPanel, startRenderer } = require('../src/renderer.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const now = Date.parse('2026-11-16T12:00:00Z');
function snapshot()
{
    return { generatedAt: now, from: '2026-10-18', to: '2026-11-16',
        rows: [
            { date: '2026-11-16', model: 'gpt-6.1-sol', requests: 2, inputTokens: 1000,
                uncachedInputTokens: 100, cachedInputTokens: 900, cacheWriteTokens: 0,
                outputTokens: 100, usd: 1.25, unpricedRequests: 0, estimatedRequests: 0 },
            { date: '2026-11-15', model: 'unknown', requests: 1, inputTokens: 100,
                uncachedInputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0,
                outputTokens: 10, usd: 0, unpricedRequests: 1, estimatedRequests: 0 }
        ], coverage: { files: 2, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { ...Pricing } };
}
async function setup(t, getReport, extra = {})
{
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const root = dom.window.document.getElementById('root');
    const stop = mountPanel(root, {
        getHosts: async () => [{ hostId: 'local', label: '本机' }, { hostId: 'remote-1', label: '远程一' }],
        getReport: getReport || (async () => ({ status: 'ok', snapshot: snapshot() })), now: () => now,
        ...extra
    });
    t.after(() => { stop(); dom.window.close(); });
    await tick(); await tick();
    return { root, dom, stop };
}

const weeklyModel = '<gpt-small>';
function completedWeek()
{
    return {
        startAt: Date.parse('2026-11-11T16:30:00Z'), startKind: 'reset',
        fullAt: Date.parse('2026-11-15T12:00:00Z'), usedPercent: 100,
        sampleAt: Date.parse('2026-11-15T13:00:00Z'), rows: [
            { model: weeklyModel, requests: 2, baseUsd: 0.01, usd: 0.01, unpricedRequests: 0, estimatedRequests: 0 },
            { model: 'unlisted-model', requests: 3, baseUsd: 23.5, usd: 0, unpricedRequests: 3, estimatedRequests: 0 },
            { model: 'large-model', requests: 15, baseUsd: 1789.266539, usd: 1856.32499152, unpricedRequests: 0, estimatedRequests: 1 }
        ]
    };
}

function selectRange(root, dom, value)
{
    const range = root.querySelector('[aria-label="统计时间范围"]');
    assert.ok([...range.options].some(option => option.value === value), 'The requested range is available');
    range.value = value;
    range.dispatchEvent(new dom.window.Event('change'));
}

test('weekly quota displays the reset-to-full window with model costs sorted by long-context estimate', async t =>
{
    const report = { ...snapshot(), weekly: completedWeek() };
    report.rows[0].usd = 1.2345;
    report.rows.push({ ...report.rows[0], date: '2026-11-01' });
    let queries = 0;
    const { root, dom } = await setup(t, async () =>
    {
        queries++;
        return { status: 'ok', snapshot: report };
    });
    assert.equal(root.querySelector('[data-summary="usd"]').textContent, '$1.2345');
    selectRange(root, dom, 'weekly');
    const weekly = root.querySelector('[data-weekly]');
    const table = weekly.querySelector('table[aria-label="本轮周额度模型用量"]');
    assert.equal(table.caption?.textContent, '按模型统计');
    const rows = [...table.tBodies[0].rows];
    assert.equal(weekly.hidden, false);
    assert.match(weekly.querySelector('[data-weekly-period]').textContent,
        /重置.*11\/12 00:30.*首次满额.*11\/15 20:00/);
    assert.match(weekly.querySelector('[data-weekly-summary="usd"]').textContent, /^\$1,856\.33(?:（|$)/);
    assert.equal(weekly.querySelector('[data-weekly-summary="requests"]').textContent, '20');
    assert.equal(weekly.querySelector('progress[aria-label="周额度已用"]').value, 100);
    assert.deepEqual(rows.map(row => row.cells[0].textContent.trim()), ['large-model', weeklyModel, 'unlisted-model']);
    assert.match(rows[0].cells[2].textContent, /^\$1,789\.27(?:（|$)/);
    assert.match(rows[0].cells[3].textContent, /^\$1,856\.32(?:（|$)/);
    assert.match(rows[1].cells[4].textContent, /<0\.1%/);
    assert.ok(rows[1].cells[4].querySelector('progress').value > 0);
    assert.equal(rows[1].querySelector('gpt-small'), null);
    assert.equal(rows[2].cells[2].textContent, '$23.50');
    assert.equal(rows[2].cells[3].textContent, '—');
    assert.equal(rows[2].cells[4].textContent, '—');
    assert.equal(rows[2].cells[4].querySelector('progress'), null);
    assert.match(weekly.textContent, /3 次请求未定价/);
    assert.match(weekly.textContent, /1 次请求.*估算/);

    selectRange(root, dom, '7');
    assert.equal(weekly.hidden, true);
    assert.match(root.querySelector('table[aria-label="每日模型用量"] tbody').textContent, /2026-11-15/);
    assert.doesNotMatch(root.querySelector('table[aria-label="每日模型用量"] tbody').textContent, /2026-11-01/);
    selectRange(root, dom, '30');
    assert.match(root.querySelector('table[aria-label="每日模型用量"] tbody').textContent, /2026-11-01/);
    assert.equal(queries, 1, 'Changing between weekly and daily views reuses the report');
});

test('weekly cache from the selected remote host uses its timestamp and observed quota', async t =>
{
    const remote = { ...snapshot(), generatedAt: Date.parse('2026-11-14T14:43:00Z'), weekly: {
        startAt: Date.parse('2026-11-12T15:00:00Z'), startKind: 'observed', fullAt: null,
        usedPercent: 99.95, sampleAt: Date.parse('2026-11-14T14:30:00Z'),
        rows: [{ model: 'remote-model', requests: 12, baseUsd: 16, usd: 0,
            unpricedRequests: 12, estimatedRequests: 0 }]
    } };
    const queries = [];
    const { root, dom } = await setup(t, async hostId =>
    {
        queries.push(hostId);
        return hostId === 'local' ? { status: 'ok', snapshot: { ...snapshot(), weekly: completedWeek() } }
            : { status: 'stale', snapshot: remote, error: 'offline' };
    });
    selectRange(root, dom, 'weekly');
    const host = root.querySelector('[aria-label="统计机器"]');
    host.value = 'remote-1';
    host.dispatchEvent(new dom.window.Event('change'));
    await tick();
    const weekly = root.querySelector('[data-weekly]');
    assert.match(root.querySelector('[data-status]').textContent, /缓存/);
    assert.match(weekly.querySelector('[data-weekly-period]').textContent,
        /首次观测.*11\/12 23:00.*缓存截至.*11\/14 22:43/);
    assert.match(weekly.textContent, /部分覆盖/);
    assert.match(weekly.textContent, /观测于.*11\/14 22:30/);
    assert.match(weekly.querySelector('[data-weekly-summary="percent"]').textContent, />99\.9%/);
    assert.equal(weekly.querySelector('progress[aria-label="周额度已用"]').value, 99.95);
    assert.equal(weekly.querySelector('[data-weekly-summary="usd"]').textContent, '—');
    assert.equal(weekly.querySelector('[data-weekly-summary="requests"]').textContent, '12');
    assert.match(weekly.textContent, /远程一.*请求数/);
    const remoteCells = weekly.querySelector('tbody tr').cells;
    assert.equal(remoteCells[2].textContent, '$16.00');
    assert.equal(remoteCells[3].textContent, '—');
    assert.match(weekly.textContent, /12 次请求未定价/);
    assert.doesNotMatch(weekly.textContent, /large-model|首次满额|NaN|\$0/);
    assert.deepEqual(queries, ['local', 'remote-1']);
});

test('an inferred weekly reset with complete log coverage shows recorded zero requests and dollars', async t =>
{
    const report = { ...snapshot(), weekly: { ...completedWeek(), startKind: 'inferred', fullAt: null,
        usedPercent: 0, rows: [] } };
    const { root, dom } = await setup(t, async () => ({ status: 'ok', snapshot: report }));
    selectRange(root, dom, 'weekly');
    const weekly = root.querySelector('[data-weekly]');
    assert.match(weekly.querySelector('[data-weekly-period]').textContent,
        /按重置时间推算.*11\/12 00:30.*当前.*11\/16 20:00/);
    assert.equal(weekly.querySelector('[data-weekly-summary="percent"]').textContent, '0%');
    assert.equal(weekly.querySelector('[data-weekly-summary="requests"]').textContent, '0');
    assert.equal(weekly.querySelector('[data-weekly-summary="usd"]').textContent, '$0.00');
    assert.match(weekly.textContent, /本机可读日志范围.*没有可统计的请求/);
    assert.equal(weekly.querySelectorAll('tbody tr').length, 0);
});

test('a weekly window with incomplete log coverage counts recorded zero without a zero-dollar estimate', async t =>
{
    const report = { ...snapshot(), weekly: { ...completedWeek(), rows: [] } };
    report.coverage.failedFiles = 1;
    const { root, dom } = await setup(t, async () => ({ status: 'ok', snapshot: report }));
    selectRange(root, dom, 'weekly');
    const weekly = root.querySelector('[data-weekly]');
    assert.equal(weekly.querySelector('[data-weekly-summary="requests"]').textContent, '0');
    assert.equal(weekly.querySelector('[data-weekly-summary="usd"]').textContent, '—');
    assert.match(weekly.textContent, /本机可读日志范围.*覆盖缺口/);
    assert.match(weekly.textContent, /1 个日志读取失败/);
});

test('weekly view distinguishes an older publisher from a report without quota observations', async t =>
{
    const report = snapshot();
    const { root, dom } = await setup(t, async () => ({ status: 'ok', snapshot: { ...report } }));
    selectRange(root, dom, 'weekly');
    const weekly = root.querySelector('[data-weekly]');
    assert.match(weekly.textContent, /更新.*Daily Usage|Daily Usage.*更新/);
    assert.equal(weekly.querySelector('[data-weekly-summary="usd"]').textContent, '—');
    report.weekly = null;
    root.querySelector('[data-refresh]').click();
    await tick();
    assert.match(weekly.textContent, /暂无周额度观测记录/);
    assert.doesNotMatch(weekly.textContent, /更新.*Daily Usage|Daily Usage.*更新|\$0/);
    assert.ok(weekly.querySelector('progress[aria-label="周额度已用"]').hidden);
    selectRange(root, dom, '1');
    assert.match(root.querySelector('[data-summary="usd"]').textContent, /\$1\.25/);
});

test('filters calendar dates and exposes unpriced requests instead of showing them as free', async t =>
{
    const { root, dom } = await setup(t);
    assert.equal(root.querySelectorAll('tbody tr').length, 1);
    assert.equal(root.querySelector('[data-summary="usd"]').previousElementSibling.textContent, '费用估算（USD）');
    assert.equal(root.querySelector('thead th:last-child').textContent, '费用估算（USD）');
    assert.match(root.querySelector('[data-summary="usd"]').textContent, /1\.25/);
    const range = root.querySelector('[aria-label="统计时间范围"]');
    range.value = '7'; range.dispatchEvent(new dom.window.Event('change'));
    assert.equal(root.querySelectorAll('tbody tr').length, 2);
    assert.match(root.querySelector('[data-coverage]').textContent, /1.*未定价/);
    assert.match(root.querySelector('tbody tr:last-child').textContent, /未定价/);
});

test('one query per open or explicit refresh, with no polling timers', async t =>
{
    const dom = new JSDOM('<!doctype html><main id="page"></main>');
    const root = dom.window.document.getElementById('page');
    dom.window.setInterval = () => { throw new Error('Periodic polling is forbidden'); };
    let queries = 0;
    const stop = mountPanel(root, { getHosts: async () => [{ hostId: 'local', label: '本机' }],
        getReport: async () => { queries++; return { status: 'ok', snapshot: snapshot() }; }, now: () => now });
    t.after(() => { stop(); dom.window.close(); });
    await tick(); await tick();
    assert.equal(queries, 1);
    const range = root.querySelector('[aria-label="统计时间范围"]');
    range.value = '7'; range.dispatchEvent(new dom.window.Event('change'));
    await tick();
    assert.equal(queries, 1, 'Range changes filter the current report');
    root.querySelector('[data-refresh]').click();
    await tick();
    assert.equal(queries, 2);
});

test('reopening updates remote names without changing the selected connection', async t =>
{
    let label = '远程 · 办公室电脑';
    const queries = [];
    const { root, dom } = await setup(t, async hostId =>
    {
        queries.push(hostId);
        return { status: 'ok', snapshot: snapshot() };
    }, { getHosts: async () => [{ hostId: 'remote-1', label }] });
    const host = root.querySelector('[aria-label="统计机器"]');
    host.value = 'remote-1';
    host.dispatchEvent(new dom.window.Event('change'));
    await tick();
    root.hidden = true;
    await tick();
    label = '远程 · 工作电脑';
    root.hidden = false;
    await tick(); await tick();
    assert.equal(host.value, 'remote-1');
    assert.equal(host.selectedOptions[0].textContent, label);
    assert.equal(host.options.length, 2);
    assert.match(root.querySelector('[data-status]').textContent, /工作电脑/);
    assert.deepEqual(queries, ['local', 'remote-1', 'remote-1']);
});

test('hiding retained settings content cancels immediately and re-opening starts a new query', async t =>
{
    const calls = [];
    const cancelled = [];
    const { root, dom } = await setup(t, (hostId, options) => new Promise(resolve =>
        calls.push({ hostId, options, resolve })), { cancelReport: id => { cancelled.push(id); } });
    root.style.display = 'none';
    await tick();
    assert.deepEqual(cancelled, [calls[0].options.requestId]);
    calls[0].resolve({ status: 'ok', snapshot: snapshot() });
    await tick();
    assert.equal(root.querySelectorAll('tbody tr').length, 0);
    root.style.display = '';
    await tick();
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].options.requestId, calls[0].options.requestId);
    root.remove();
    await tick();
    assert.equal(cancelled.length, 2);
    calls[1].resolve({ status: 'ok', snapshot: snapshot() });
    await tick();
    assert.equal(dom.window.document.querySelectorAll('.daily-usage-panel').length, 0);
});

test('hidden window cancels active remote query and ignores late results', async t =>
{
    const cancelled = [];
    const calls = [];
    const { root, dom } = await setup(t, (hostId, options) => new Promise(resolve => calls.push({ options, resolve })),
        { cancelReport: id => cancelled.push(id) });
    Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.deepEqual(cancelled, [calls[0].options.requestId]);
    calls[0].resolve({ status: 'ok', snapshot: snapshot() });
    await tick();
    assert.equal(root.querySelectorAll('tbody tr').length, 0);
});

test('old host response cannot overwrite newly selected machine and teardown removes content', async t =>
{
    let resolveOld;
    const { root, dom, stop } = await setup(t, hostId => hostId === 'local'
        ? new Promise(resolve => { resolveOld = resolve; })
        : Promise.resolve({ status: 'unavailable', error: 'remote-not-installed' }));
    const host = root.querySelector('[aria-label="统计机器"]');
    host.value = 'remote-1'; host.dispatchEvent(new dom.window.Event('change'));
    await tick();
    resolveOld({ status: 'ok', snapshot: snapshot() });
    await tick();
    assert.equal(root.querySelectorAll('tbody tr').length, 0);
    assert.match(root.textContent, /运行端/);
    stop();
    assert.equal(root.childElementCount, 0);
});

test('offline cached report keeps its timestamp and is labeled stale', async t =>
{
    const { root } = await setup(t, async () => ({ status: 'stale', snapshot: snapshot(), error: 'offline' }));
    assert.match(root.querySelector('[data-status]').textContent, /离线|旧数据|缓存/);
    assert.match(root.querySelector('[data-updated]').textContent, /2026/);
});

test('legacy pricing is shown as an update requirement without an old dollar total', async t =>
{
    const { root } = await setup(t, async () => ({ status: 'unavailable', error: 'snapshot-update-required' }));
    assert.match(root.querySelector('[data-status]').textContent, /查看端和运行端.*Daily Usage.*文件通知/);
    assert.equal(root.querySelector('[data-summary="usd"]').textContent, '—');
    assert.match(root.textContent, /基础单价.*不.*长上下文.*缓存保留时长.*订阅账单/);
});

test('partially priced request retains known dollar subtotal with missing-price label', async t =>
{
    const partial = snapshot();
    partial.rows = [{ ...partial.rows[0], requests: 1, unpricedRequests: 1, usd: 0.005 }];
    const { root } = await setup(t, async () => ({ status: 'ok', snapshot: partial }));
    assert.match(root.querySelector('[data-summary="usd"]').textContent, /0\.005/);
    assert.match(root.querySelector('tbody tr').textContent, /0\.005.*未定价部分/);
});

test('keeps the settings page and never creates a main-sidebar clone', async t =>
{
    const dom = new JSDOM('<!doctype html><aside id="native-rail"><button>Home</button><button>History</button></aside><main id="settings"></main>');
    const doc = dom.window.document;
    const nativeRail = doc.getElementById('native-rail');
    const before = nativeRail.outerHTML;
    let page;
    let pageDisposed = false;
    let sidebarRegistrations = 0;
    const controller = startRenderer({
        ipc: { invoke: async method => method === 'hosts' ? [{ hostId: 'local', label: '本机' }]
            : method === 'report' ? { status: 'ok', snapshot: snapshot() } : undefined },
        log: { info() {} },
        settings: {
            register() { return { unregister() {} }; },
            registerPage(value) { page = value; return { unregister() { pageDisposed = true; } }; }
        },
        codex: { sidebar: { registerAction()
        {
            sidebarRegistrations++;
            const clone = nativeRail.cloneNode(true);
            clone.removeAttribute('id');
            doc.body.append(clone);
            return { setActive() {}, dispose() { clone.remove(); } };
        } } }
    }, { window: dom.window, document: doc });
    t.after(() => { controller.stop(); dom.window.close(); });
    assert.equal(sidebarRegistrations, 0, 'The main-sidebar API can clone an entire native rail');
    assert.equal(page.title, 'Daily Usage');
    const releasePage = page.render(doc.getElementById('settings'));
    await tick();
    assert.equal(doc.querySelectorAll('.daily-usage-panel').length, 1);
    for (const visible of ['true', 'false'])
    {
        doc.documentElement.dataset.codexppSettingsSurface = visible;
        dom.window.dispatchEvent(new dom.window.CustomEvent('codexpp:settings-surface'));
    }
    assert.equal(sidebarRegistrations, 0);
    assert.equal(doc.querySelectorAll('aside').length, 1);
    assert.equal(nativeRail.outerHTML, before);
    assert.equal(doc.querySelectorAll('dialog').length, 0);
    releasePage();
    controller.stop();
    assert.equal(pageDisposed, true);
    assert.equal(doc.querySelectorAll('.daily-usage-panel').length, 0);
    assert.equal(nativeRail.outerHTML, before);
});

test('conversation identity discovery follows changes rather than a background interval', async t =>
{
    const dom = new JSDOM('<!doctype html><div data-codex-composer-root data-conversation-id="one"><p>message</p></div>');
    dom.window.setInterval = () => { throw new Error('Background polling is forbidden'); };
    const calls = [];
    const controller = startRenderer({
        ipc: { invoke: async method => { calls.push(method); } }, log: { info() {} },
        settings: { registerPage: () => ({ unregister() {} }) }
    }, { window: dom.window, document: dom.window.document });
    t.after(() => { controller.stop(); dom.window.close(); });
    await tick();
    assert.deepEqual(calls, ['discover']);
    const composer = dom.window.document.querySelector('[data-codex-composer-root]');
    composer.querySelector('p').textContent = 'streaming text';
    await tick();
    assert.deepEqual(calls, ['discover']);
    composer.dataset.conversationId = 'two';
    await tick();
    assert.deepEqual(calls, ['discover', 'discover']);
    controller.stop();
    composer.dataset.conversationId = 'three';
    await tick();
    assert.equal(calls.length, 2);
});

test('conversation navigation during identity discovery is not lost', async t =>
{
    const dom = new JSDOM('<!doctype html><div data-codex-composer-root data-conversation-id="one"></div>');
    const pending = [];
    const controller = startRenderer({
        ipc: { invoke: () => new Promise(resolve => pending.push(resolve)) }, log: { info() {} },
        settings: { registerPage: () => ({ unregister() {} }) }
    }, { window: dom.window, document: dom.window.document });
    t.after(() => { controller.stop(); dom.window.close(); });
    await tick();
    dom.window.document.querySelector('[data-codex-composer-root]').dataset.conversationId = 'two';
    await tick();
    pending[0]();
    await tick();
    assert.equal(pending.length, 2);
    pending[1]();
});
