'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
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
        pricing: { basis: 'standard', asOf: '2026-11-16' } };
}
async function setup(t, getReport)
{
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const root = dom.window.document.getElementById('root');
    const stop = mountPanel(root, {
        getHosts: async () => [{ hostId: 'local', label: '本机' }, { hostId: 'remote-1', label: '远程一' }],
        getReport: getReport || (async () => ({ status: 'ok', snapshot: snapshot() })), now: () => now,
        pollMs: 100000
    });
    t.after(() => { stop(); dom.window.close(); });
    await tick(); await tick();
    return { root, dom, stop };
}

test('filters calendar dates and exposes unpriced requests instead of showing them as free', async t =>
{
    const { root, dom } = await setup(t);
    assert.equal(root.querySelectorAll('tbody tr').length, 1);
    assert.match(root.querySelector('[data-summary="usd"]').textContent, /1\.25/);
    const range = root.querySelector('[aria-label="统计时间范围"]');
    range.value = '7'; range.dispatchEvent(new dom.window.Event('change'));
    assert.equal(root.querySelectorAll('tbody tr').length, 2);
    assert.match(root.querySelector('[data-coverage]').textContent, /1.*未定价/);
    assert.match(root.querySelector('tbody tr:last-child').textContent, /未定价/);
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
