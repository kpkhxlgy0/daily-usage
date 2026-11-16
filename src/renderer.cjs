'use strict';

const DayMs = 86400000;
const counts = new Intl.NumberFormat('zh-CN');
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 4 });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' });

function localDate(milliseconds)
{
    return new Date(milliseconds + 8 * 3600000).toISOString().slice(0, 10);
}

function visibleElement(element)
{
    const doc = element.ownerDocument;
    if (!element.isConnected || doc.visibilityState === 'hidden') return false;
    for (let node = element; node; node = node.parentElement)
    {
        const style = doc.defaultView.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
    }
    return true;
}

function mountPanel(root, { getHosts, getReport, cancelReport = () => {}, now = Date.now })
{
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    let alive = true;
    let requestVersion = 0;
    let reportState;
    let fetching = false;
    let visible = false;
    let activeQuery;
    const hostNames = new Map([['local', '本机']]);
    const panel = doc.createElement('section');
    panel.className = 'daily-usage-panel';
    panel.innerHTML = `<style>
        .daily-usage-panel { color: var(--color-token-text-primary, inherit); font: inherit; min-width: 0; }
        .daily-usage-panel * { box-sizing: border-box; }
        .daily-usage-panel header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
        .daily-usage-panel h2 { font-size:22px; font-weight:600; margin:0 auto 0 0; }
        .daily-usage-panel select, .daily-usage-panel button { font:inherit; color:inherit;
            background:var(--color-token-bg-secondary, transparent); border:1px solid #8885;
            border-radius:8px; padding:7px 12px; }
        .daily-usage-panel button { cursor:pointer; }
        .daily-usage-panel button:disabled { cursor:wait; opacity:.6; }
        .daily-usage-cards { display:flex; flex-wrap:wrap; gap:12px; margin:18px 0; }
        .daily-usage-card { flex:1; min-width:150px; border:1px solid #8884; border-radius:12px; padding:16px; }
        .daily-usage-card small { display:block; opacity:.72; margin-bottom:8px; }
        .daily-usage-card strong { font-size:24px; font-weight:600; font-variant-numeric:tabular-nums; }
        .daily-usage-panel p { font-size:12px; opacity:.8; margin:8px 0; line-height:1.7; }
        .daily-usage-scroll { overflow-x:auto; max-height:48vh; }
        .daily-usage-panel table { width:100%; border-collapse:collapse; font-size:12px; white-space:nowrap; }
        .daily-usage-panel th, .daily-usage-panel td { text-align:right; padding:10px 12px; border-bottom:1px solid #8883;
            font-variant-numeric:tabular-nums; }
        .daily-usage-panel th:first-child, .daily-usage-panel td:first-child,
        .daily-usage-panel th:nth-child(2), .daily-usage-panel td:nth-child(2) { text-align:left; }
        .daily-usage-panel th { font-weight:600; }
        .daily-usage-panel [data-status] { min-height:22px; }
    </style>
    <header><h2>Daily Usage</h2><select aria-label="统计机器"><option value="local">本机</option></select>
    <select aria-label="统计时间范围"><option value="1">今天</option><option value="7">最近 7 天</option>
    <option value="30">最近 30 天</option></select><button type="button" data-refresh>刷新</button></header>
    <p>北京时间 · 包含子代理 · 按公开 Standard API 价格折算，计入长上下文费率；金额不代表订阅账单。</p>
    <div data-status role="status" aria-live="polite">正在读取统计…</div>
    <div class="daily-usage-cards">
        <div class="daily-usage-card"><small>Token 总量</small><strong data-summary="tokens">—</strong></div>
        <div class="daily-usage-card"><small>API 等值美元（已定价部分）</small><strong data-summary="usd">—</strong></div>
        <div class="daily-usage-card"><small>请求数</small><strong data-summary="requests">—</strong></div>
    </div><p data-updated></p><p data-coverage></p>
    <div class="daily-usage-scroll"><table aria-label="每日模型用量"><thead><tr>
    <th>日期</th><th>模型</th><th>请求</th><th>普通输入</th><th>缓存输入</th><th>缓存写入</th><th>输出</th><th>API 等值美元</th>
    </tr></thead><tbody></tbody></table></div>
    <p data-empty></p><p>机器列表包含本机和本窗口打开过的远程会话。远程机器需要安装并启用 Daily Usage。</p>
    <p data-price></p>`;
    root.append(panel);
    const host = panel.querySelector('[aria-label="统计机器"]');
    const range = panel.querySelector('[aria-label="统计时间范围"]');
    const refresh = panel.querySelector('[data-refresh]');
    const status = panel.querySelector('[data-status]');
    const body = panel.querySelector('tbody');

    function render()
    {
        if (!alive) return;
        body.replaceChildren();
        const snapshot = reportState?.snapshot;
        const state = reportState?.status;
        const from = localDate(now() - (Number(range.value) - 1) * DayMs);
        const to = localDate(now());
        const rows = snapshot?.rows.filter(row => row.date >= from && row.date <= to) || [];
        const totals = rows.reduce((sum, row) => ({ tokens: sum.tokens + row.inputTokens + row.outputTokens,
            requests: sum.requests + row.requests, usd: sum.usd + row.usd,
            unpriced: sum.unpriced + row.unpricedRequests, estimated: sum.estimated + row.estimatedRequests }),
        { tokens: 0, requests: 0, usd: 0, unpriced: 0, estimated: 0 });
        for (const key of ['tokens', 'requests', 'usd'])
        {
            panel.querySelector(`[data-summary="${key}"]`).textContent = snapshot
                ? (key === 'usd' ? (totals.requests && totals.unpriced === totals.requests && totals.usd === 0 ? '未定价'
                    : dollars.format(totals.usd)) : counts.format(totals[key])) : '—';
        }
        const stale = snapshot && (state === 'stale' || state === 'error' || now() - snapshot.generatedAt > 180000);
        status.textContent = reportState?.error === 'snapshot-update-required'
            ? '远端暂不支持按需查询，请确认两端均已启用 Daily Usage 0.1.3 或更新版本，且 Codex 支持文件通知。'
            : state === 'loading' ? '正在查询所选机器，完成后显示结果…'
            : stale ? '显示最后成功的缓存数据；当前连接不可用或统计尚未更新。'
            : snapshot ? `${hostNames.get(host.value) || host.value} · 统计已更新`
            : state === 'error' && host.value === 'local' ? '本机统计暂不可用，请稍后刷新。'
            : '暂无统计。请在运行端安装并启用 Daily Usage，并等待首次扫描完成。';
        panel.querySelector('[data-updated]').textContent = snapshot
            ? `数据截至 ${timeFormat.format(snapshot.generatedAt)}（北京时间） · 已读取 ${snapshot.from} 至 ${snapshot.to}` : '';
        const gaps = [];
        if (totals.unpriced) gaps.push(`${counts.format(totals.unpriced)} 次请求未定价`);
        if (totals.estimated) gaps.push(`${counts.format(totals.estimated)} 次旧版请求为估算`);
        if (snapshot?.coverage.failedFiles) gaps.push(`${snapshot.coverage.failedFiles} 个日志读取失败`);
        if (snapshot?.coverage.skippedRecords) gaps.push(`${snapshot.coverage.skippedRecords} 条记录无法归属`);
        if (snapshot) gaps.push(...snapshot.coverage.warnings);
        panel.querySelector('[data-coverage]').textContent = snapshot
            ? `覆盖 ${snapshot.coverage.files} 个日志${gaps.length ? '；' + gaps.join('；') : '；未发现已知读取缺口'}` : '';
        for (const row of rows)
        {
            const tr = doc.createElement('tr');
            const values = [row.date, row.model, counts.format(row.requests), counts.format(row.uncachedInputTokens),
                counts.format(row.cachedInputTokens), counts.format(row.cacheWriteTokens), counts.format(row.outputTokens),
                row.unpricedRequests === row.requests && row.usd === 0 ? '未定价'
                    : dollars.format(row.usd) + (row.unpricedRequests ? ' + 未定价部分' : '')];
            for (const value of values)
            {
                const cell = doc.createElement('td');
                cell.textContent = value;
                tr.append(cell);
            }
            body.append(tr);
        }
        panel.querySelector('[data-empty]').textContent = snapshot && !rows.length
            ? '所选日期没有可统计的请求。' : '';
        panel.querySelector('[data-price]').textContent = snapshot
            ? `价格表日期：${snapshot.pricing.asOf}。仅含模型 Token 费用，不含图像生成等工具独立收费。` : '';
    }

    function cancelActive()
    {
        requestVersion++;
        const query = activeQuery;
        activeQuery = null;
        fetching = false;
        refresh.disabled = false;
        if (query)
        {
            try { Promise.resolve(cancelReport(query.id)).catch(() => {}); }
            catch { /* 主进程已退出时无需继续取消。 */ }
        }
    }

    async function update(changed = false)
    {
        if (!alive || !visible || !visibleElement(panel) || (fetching && !changed)) return;
        if (activeQuery) cancelActive();
        const version = ++requestVersion;
        const query = activeQuery = { id: win.crypto.randomUUID() };
        fetching = true;
        refresh.disabled = true;
        reportState = { status: 'loading', snapshot: changed ? undefined : reportState?.snapshot };
        render();
        const selected = host.value;
        try
        {
            const result = await getReport(selected, { requestId: query.id });
            if (!alive || !visibleElement(panel) || version !== requestVersion) return;
            reportState = result;
            render();
        }
        catch
        {
            if (!alive || !visibleElement(panel) || version !== requestVersion) return;
            reportState = { status: reportState?.snapshot ? 'stale' : 'unavailable', snapshot: reportState?.snapshot };
            render();
        }
        finally
        {
            if (activeQuery === query) activeQuery = null;
            if (alive && version === requestVersion) { fetching = false; refresh.disabled = false; }
        }
    }

    async function loadHosts()
    {
        try
        {
            const hosts = await getHosts();
            if (!alive || !visibleElement(panel)) return;
            for (const entry of hosts)
            {
                if (hostNames.has(entry.hostId)) continue;
                hostNames.set(entry.hostId, entry.label || entry.hostId);
                const option = doc.createElement('option');
                option.value = entry.hostId;
                option.textContent = entry.label || entry.hostId;
                host.append(option);
            }
        }
        catch { /* 主进程重载期间保留已经确认的机器列表。 */ }
    }

    host.addEventListener('change', () => { void update(true); });
    range.addEventListener('change', render);
    refresh.addEventListener('click', () => { void update(); });
    const observer = new win.MutationObserver(reconcileVisibility);
    function observeAncestors()
    {
        observer.disconnect();
        for (let node = panel; node; node = node.parentElement)
            observer.observe(node, { childList: true, attributes: true,
                attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
    }
    function stop()
    {
        if (!alive) return;
        alive = false;
        visible = false;
        cancelActive();
        observer.disconnect();
        doc.removeEventListener('visibilitychange', reconcileVisibility);
        win.removeEventListener('pagehide', stop);
        panel.remove();
    }
    function reconcileVisibility()
    {
        if (!alive) return;
        if (!panel.isConnected) { stop(); return; }
        const next = visibleElement(panel);
        observeAncestors();
        if (next === visible) return;
        visible = next;
        if (visible) { void loadHosts(); void update(); }
        else cancelActive();
    }
    doc.addEventListener('visibilitychange', reconcileVisibility);
    win.addEventListener('pagehide', stop);
    reconcileVisibility();
    return stop;
}

function startRenderer(api, { window: win = window, document: doc = document } = {})
{
    const cleanups = new Set();
    let stopped = false;
    const data = { getHosts: async () =>
        {
            await api.ipc.invoke('discover');
            return api.ipc.invoke('hosts');
        },
        getReport: (hostId, options) => api.ipc.invoke('report', { hostId, ...options }),
        cancelReport: requestId => api.ipc.invoke('cancel', { requestId }) };
    function mount(root)
    {
        const release = mountPanel(root, data);
        const cleanup = () => { release(); cleanups.delete(cleanup); };
        cleanups.add(cleanup);
        return cleanup;
    }
    const page = api.settings?.registerPage({ id: 'daily-usage', title: 'Daily Usage',
        description: '每日 Token 与 API 等值费用', render: mount });
    let discovering = false;
    let rediscover = false;
    let queued = false;
    let lastIdentityKey;
    let nextRootId = 0;
    const rootIds = new WeakMap();
    const navigationEvents = ['popstate', 'hashchange', 'codexpp-pushState', 'codexpp-replaceState'];
    async function discoverChangedConversation()
    {
        queued = false;
        if (stopped || doc.visibilityState === 'hidden') return;
        if (discovering) { rediscover = true; return; }
        const roots = [...doc.querySelectorAll('[data-codex-composer-root],[data-app-shell-pane-content-viewport]')]
            .filter(visibleElement);
        if (!roots.length) return;
        const identityKey = JSON.stringify([win.location.href, ...roots.map(root =>
        {
            if (!rootIds.has(root)) rootIds.set(root, ++nextRootId);
            return [rootIds.get(root), root.dataset.conversationId, root.dataset.threadId, root.dataset.hostId];
        })]);
        if (identityKey === lastIdentityKey) return;
        lastIdentityKey = identityKey;
        discovering = true;
        try { await api.ipc.invoke('discover'); }
        catch { /* 在主进程准备好后重试。 */ }
        finally
        {
            discovering = false;
            if (rediscover) { rediscover = false; scheduleDiscovery(); }
        }
    }
    function scheduleDiscovery()
    {
        if (queued || stopped) return;
        queued = true;
        Promise.resolve().then(discoverChangedConversation);
    }
    const conversationObserver = new win.MutationObserver(scheduleDiscovery);
    conversationObserver.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['data-conversation-id', 'data-thread-id', 'data-host-id'] });
    for (const event of navigationEvents) win.addEventListener(event, scheduleDiscovery);
    doc.addEventListener('visibilitychange', scheduleDiscovery);
    scheduleDiscovery();
    api.log.info('Daily Usage renderer started; on-demand settings page, no polling');
    return { stop()
    {
        stopped = true;
        conversationObserver.disconnect();
        for (const event of navigationEvents) win.removeEventListener(event, scheduleDiscovery);
        doc.removeEventListener('visibilitychange', scheduleDiscovery);
        for (const cleanup of [...cleanups]) cleanup();
        page?.unregister();
    } };
}

module.exports = { mountPanel, startRenderer };
