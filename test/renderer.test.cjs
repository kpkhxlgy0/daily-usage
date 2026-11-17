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
