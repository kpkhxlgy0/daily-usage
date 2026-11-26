'use strict';

const PageIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#142b3b"/><rect x="6.5" y="8" width="19" height="18" rx="3" fill="none" stroke="#e6f3f5" stroke-width="1.8"/><path d="M11 6v4m10-4v4M7 13h18" fill="none" stroke="#e6f3f5" stroke-width="1.8" stroke-linecap="round"/><path d="M11 22v-3m5 3v-5m5 5v-7" fill="none" stroke="#65e3c4" stroke-width="2.6" stroke-linecap="round"/></svg>';
const DayMs = 86400000;
const counts = new Intl.NumberFormat('zh-CN');
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 4 });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23' });

const weeklyTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weeklyDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2 });
const weeklyPercent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

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

function formatWeeklyPercent(value)
{
    if (value > 0 && value < 0.1) return '<0.1%';
    if (value > 99.9 && value < 100) return '>99.9%';
    return weeklyPercent.format(value) + '%';
}

function hasWeeklyPrice(row, value)
{
    return row.requests === 0 || row.unpricedRequests < row.requests || value > 0;
}

function weeklyMoney(row, value)
{
    if (!hasWeeklyPrice(row, value)) return '—';
    return weeklyDollars.format(value) + (row.estimatedRequests ? '（含估算）' : '')
        + (row.unpricedRequests ? ' + 未定价部分' : '');
}

function renderWeekly(section, snapshot, hostLabel, endLabel)
{
    const weekly = snapshot?.weekly;
    const date = section.querySelector('[data-weekly-period]');
    const observation = section.querySelector('[data-weekly-observation]');
    const limit = section.querySelector('progress[aria-label="周额度已用"]');
    const empty = section.querySelector('[data-weekly-empty]');
    const coverage = section.querySelector('[data-weekly-coverage]');
    const updated = section.querySelector('[data-weekly-updated]');
    const table = section.querySelector('.daily-usage-scroll');
    const body = table.querySelector('tbody');
    const rows = weekly?.rows || [];
    const logCoverage = snapshot?.coverage;
    const coverageGap = weekly?.startKind === 'observed' || logCoverage?.failedFiles
        || logCoverage?.skippedRecords || logCoverage?.discoveryErrors || logCoverage?.warnings.length;
    body.replaceChildren();
    table.hidden = rows.length === 0;
    const totals = rows.reduce((sum, row) =>
    {
        sum.requests += row.requests;
        sum.usd += row.usd;
        sum.unpricedRequests += row.unpricedRequests;
        sum.estimatedRequests += row.estimatedRequests;
        return sum;
    }, { requests: 0, usd: 0, unpricedRequests: 0, estimatedRequests: 0 });
    section.querySelector('[data-weekly-host]').textContent = hostLabel + '请求数（含子代理）';
    section.querySelector('[data-weekly-summary="usd"]').textContent = weekly && (rows.length || !coverageGap)
        ? weeklyMoney(totals, totals.usd) : '—';
    section.querySelector('[data-weekly-summary="requests"]').textContent = weekly
        ? counts.format(totals.requests) : '—';
    const percent = weekly?.usedPercent;
    const hasPercent = Number.isFinite(percent) && percent >= 0 && percent <= 100;
    section.querySelector('[data-weekly-summary="percent"]').textContent = hasPercent
        ? formatWeeklyPercent(percent) : '—';
    limit.hidden = !hasPercent;
    limit.value = hasPercent ? percent : 0;
    observation.textContent = Number.isFinite(weekly?.sampleAt)
        ? '观测于 ' + weeklyTime.format(weekly.sampleAt) : '';
    date.textContent = '';
    updated.textContent = '';
    coverage.textContent = '';
    empty.textContent = '';
    if (!weekly)
    {
        if (!snapshot) return;
        empty.textContent = weekly === null ? '暂无周额度观测记录。'
            : '运行端旧版 Daily Usage 未提供本轮周额度，请更新后刷新。';
        return;
    }

    const startLabel = weekly.startKind === 'reset' ? '重置'
        : weekly.startKind === 'inferred' ? '按重置时间推算' : '自首次观测';
    const end = weekly.fullAt === null
        ? endLabel + ' ' + weeklyTime.format(snapshot.generatedAt)
        : '首次满额 ' + weeklyTime.format(weekly.fullAt);
    date.textContent = startLabel + ' ' + weeklyTime.format(weekly.startAt) + ' → ' + end + '（北京时间）'
        + (weekly.startKind === 'observed' ? ' · 部分覆盖' : '');
    if (weekly.fullAt !== null)
    {
        updated.textContent = endLabel + ' ' + weeklyTime.format(snapshot.generatedAt) + '（北京时间）';
    }
    if (!rows.length)
    {
        empty.textContent = hostLabel + '可读日志范围内，本轮没有可统计的请求。'
            + (coverageGap ? '已有覆盖缺口，金额暂不可用。' : '');
    }

    const gaps = [];
    if (totals.unpricedRequests)
    {
        gaps.push(counts.format(totals.unpricedRequests) + ' 次请求未定价'
            + (totals.usd > 0 ? '，金额占比按已定价金额计算' : ''));
    }
    if (totals.estimatedRequests) gaps.push(counts.format(totals.estimatedRequests) + ' 次请求含估算');
    const scanWarnings = [...logCoverage.warnings];
    if (!scanWarnings.length)
    {
        if (logCoverage.failedFiles) scanWarnings.push(logCoverage.failedFiles + ' 个日志读取失败');
        if (logCoverage.skippedRecords) scanWarnings.push(logCoverage.skippedRecords + ' 条记录无法归属');
    }
    if (scanWarnings.length) gaps.push('近 30 天日志扫描 · ' + scanWarnings.join(' '));
    coverage.textContent = gaps.join('；');
    const doc = section.ownerDocument;
    const orderedRows = [...rows].sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
    for (const row of orderedRows)
    {
        const tr = doc.createElement('tr');
        const rowUsd = weeklyMoney(row, row.usd);
        const share = hasWeeklyPrice(row, row.usd) && Number.isFinite(totals.usd) && totals.usd > 0
            ? row.usd / totals.usd * 100 : null;
        const base = hasWeeklyPrice(row, row.baseUsd) ? weeklyDollars.format(row.baseUsd) : '—';
        const values = [row.model, counts.format(row.requests), base, rowUsd];
        for (const value of values)
        {
            const cell = doc.createElement('td');
            cell.textContent = value;
            tr.append(cell);
        }
        const shareCell = doc.createElement('td');
        if (share === null)
        {
            shareCell.textContent = '—';
        }
        else
        {
            const indicator = doc.createElement('span');
            indicator.className = 'daily-usage-share';
            const bar = doc.createElement('progress');
            bar.max = 100;
            bar.value = share;
            bar.setAttribute('aria-hidden', 'true');
            indicator.append(bar, formatWeeklyPercent(share));
            shareCell.append(indicator);
        }
        tr.append(shareCell);
        body.append(tr);
    }
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

        .daily-usage-panel .daily-usage-period { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
        .daily-usage-weekly .daily-usage-card { min-width:min(100%, 185px); overflow-wrap:anywhere; }
        .daily-usage-weekly .daily-usage-card small:last-child { margin:4px 0 0; }
        .daily-usage-weekly progress { width:100%; height:8px; accent-color:#229982; }
        .daily-usage-weekly caption { text-align:left; font-size:16px; font-weight:600; padding:0 0 8px; }
        .daily-usage-weekly :is(th, td):nth-child(4) { font-weight:700; background:#22998214; }
        .daily-usage-share { display:inline-flex; align-items:center; gap:8px; }
        .daily-usage-share progress { width:clamp(64px, 12vw, 128px); height:6px; }
        .daily-usage-weekly td:first-child { white-space:normal; overflow-wrap:anywhere; min-width:100px; }
        .daily-usage-panel .daily-usage-weekly :is(th, td):nth-child(2) { text-align:right; }
    </style>
    <header><h2>Daily Usage</h2><select aria-label="统计机器"><option value="local">本机</option></select>
    <select aria-label="统计时间范围"><option value="1">今天</option><option value="7">最近 7 天</option>
    <option value="30">最近 30 天</option><option value="weekly">本轮周额度</option></select><button type="button" data-refresh>刷新</button></header>
    <p data-calendar-note>北京时间 · 包含子代理 · 按公开 Standard API 基础单价折算，不叠加长上下文或缓存保留时长加价；缓存写入按普通输入价计一次，金额不代表订阅账单。</p>
    <div data-status role="status" aria-live="polite">正在读取统计…</div>
    <div data-calendar>
    <div class="daily-usage-cards">
        <div class="daily-usage-card"><small>Token 总量</small><strong data-summary="tokens">—</strong></div>
        <div class="daily-usage-card"><small>费用估算（USD）</small><strong data-summary="usd">—</strong></div>
        <div class="daily-usage-card"><small>请求数</small><strong data-summary="requests">—</strong></div>
    </div><p data-updated></p><p data-coverage></p>
    <div class="daily-usage-scroll"><table aria-label="每日模型用量"><thead><tr>
    <th>日期</th><th>模型</th><th>请求</th><th>普通输入</th><th>缓存输入</th><th>缓存写入</th><th>输出</th><th>费用估算（USD）</th>
    </tr></thead><tbody></tbody></table></div>
    <p data-empty></p><p>机器列表包含本机和本窗口打开过的远程会话。远程机器需要安装并启用 Daily Usage。</p>
    <p data-price></p></div>
    <div class="daily-usage-weekly" data-weekly hidden>
        <p class="daily-usage-period" data-weekly-period></p>
        <div class="daily-usage-cards">
            <div class="daily-usage-card"><small>API 等价金额（USD）</small><strong data-weekly-summary="usd">—</strong>
                <small>Standard 含长上下文</small></div>
            <div class="daily-usage-card"><small>周额度已用</small><strong data-weekly-summary="percent">—</strong>
                <progress aria-label="周额度已用" max="100" value="0" hidden></progress>
                <p data-weekly-observation></p></div>
            <div class="daily-usage-card"><small data-weekly-host>本机请求数（含子代理）</small>
                <strong data-weekly-summary="requests">—</strong></div>
        </div>
        <p data-weekly-empty role="status"></p>
        <div class="daily-usage-scroll" role="region" aria-label="模型费用列表" tabindex="0" hidden>
            <table aria-label="本轮周额度模型用量">
                <caption>按模型统计</caption><thead><tr>
                <th scope="col">模型</th><th scope="col">请求数</th><th scope="col">基础价（USD）</th>
                <th scope="col" aria-sort="descending">含长上下文（USD）</th><th scope="col">金额占比</th>
            </tr></thead><tbody></tbody></table>
        </div>
        <p data-weekly-updated></p><p data-weekly-coverage></p>
        <p>周额度显示最近一次观测值。费用按 Standard API 价格折算，订阅账单以服务商为准。</p>
    </div>`;
    root.append(panel);
    const host = panel.querySelector('[aria-label="统计机器"]');
    const range = panel.querySelector('[aria-label="统计时间范围"]');
    const refresh = panel.querySelector('[data-refresh]');
    const status = panel.querySelector('[data-status]');
    const calendar = panel.querySelector('[data-calendar]');
    const calendarNote = panel.querySelector('[data-calendar-note]');
    const weekly = panel.querySelector('[data-weekly]');
    const body = calendar.querySelector('tbody');

    function render()
    {
        if (!alive) return;
        body.replaceChildren();
        const snapshot = reportState?.snapshot;
        const state = reportState?.status;
        const stale = snapshot && (state === 'stale' || state === 'error' || now() - snapshot.generatedAt > 180000);
        const hostLabel = hostNames.get(host.value) || host.value;
        status.textContent = reportState?.error === 'snapshot-update-required'
            ? '请在查看端和运行端安装并启用同一新版 Daily Usage，并确认 Codex 支持文件通知。'
            : state === 'loading' ? '正在查询所选机器，完成后显示结果…'
            : stale ? '显示最后成功的缓存数据；当前连接不可用或统计尚未更新。'
            : snapshot ? `${hostLabel} · 统计已更新`
            : state === 'error' && host.value === 'local' ? '本机统计暂不可用，请稍后刷新。'
            : '暂无统计。请在运行端安装并启用 Daily Usage，并等待首次扫描完成。';
        const showWeekly = range.value === 'weekly';
        calendar.hidden = calendarNote.hidden = showWeekly;
        if (!weekly.hidden && !showWeekly) weekly.querySelector('tbody').replaceChildren();
        weekly.hidden = !showWeekly;
        if (showWeekly)
        {
            const endLabel = stale ? '缓存截至' : state === 'loading' ? '上次数据截至' : '当前 · 数据截至';
            renderWeekly(weekly, snapshot, hostLabel, endLabel);
            return;
        }
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
                const label = entry.label || entry.hostId;
                hostNames.set(entry.hostId, label);
                const option = [...host.options].find(value => value.value === entry.hostId)
                    || doc.createElement('option');
                option.value = entry.hostId;
                option.textContent = label;
                if (!option.parentElement) host.append(option);
            }
            render();
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
        description: '每日 Token、费用估算（USD）与本轮周额度', iconSvg: PageIconSvg, render: mount });
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
