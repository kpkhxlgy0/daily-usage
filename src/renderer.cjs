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
const weeklyPercent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const AmountLabel = 'Standard API 等价金额（USD）';
const WeekLabels = ['本轮', '历史周期 1', '历史周期 2', '历史周期 3'];
const WeekStartLabels = { reset: '已确认重置', inferred: '按重置时间推算', observed: '自首次观测' };
const WeeklyCoverageGaps = ['failedFiles', 'skippedRecords', 'discoveryErrors',
    'oversizedRecords', 'conflictingRequests', 'legacySkippedRecords'];

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

function formatUsd(value)
{
    return value > 0 && value < 0.0001 ? '<$0.0001' : dollars.format(value);
}

function hasPrice(row)
{
    return row.requests === 0 || row.unpricedRequests < row.requests || row.usd > 0;
}

function formatAmount(row)
{
    if (!hasPrice(row)) return '未定价';
    return formatUsd(row.usd) + (row.estimatedRequests ? '（含估算）' : '')
        + (row.unpricedRequests ? ' + 未定价部分' : '');
}

function formatSubtotal({ requests, usd })
{
    return counts.format(requests) + ' 次请求 · ' + formatUsd(usd);
}

function weeklyTotals(rows)
{
    return rows.reduce((sum, row) =>
    {
        sum.requests += row.requests;
        sum.usd += row.usd;
        sum.unpricedRequests += row.unpricedRequests;
        sum.estimatedRequests += row.estimatedRequests;
        return sum;
    }, { requests: 0, usd: 0, unpricedRequests: 0, estimatedRequests: 0 });
}

function hasPartialWeek(week, coverage)
{
    return week?.partial === true || week?.startKind === 'observed'
        || WeeklyCoverageGaps.some(field => coverage?.[field] > 0);
}

function weeklyScanWarning(coverage)
{
    const warnings = [...coverage.warnings];
    if (!warnings.length)
    {
        if (coverage.failedFiles) warnings.push(coverage.failedFiles + ' 个日志读取失败');
        if (coverage.skippedRecords) warnings.push(coverage.skippedRecords + ' 条记录无法归属');
    }
    return warnings.length ? '近 30 天日志扫描 · ' + warnings.join(' ') : '';
}

function appendComparisonAmount(tr, column, row)
{
    const cell = tr.insertCell();
    if (!column)
    {
        cell.textContent = '—';
        cell.title = '无周期记录';
        return;
    }
    if (row && !hasPrice(row))
    {
        cell.textContent = '未定价';
        return;
    }
    const usd = row?.usd ?? 0;
    const unknown = !row?.requests && column.coverageGap;
    cell.textContent = unknown ? '—' : formatUsd(usd);
    if (unknown) cell.title = '日志覆盖不全，金额暂不可用';
    const notes = [];
    if (row?.estimatedRequests) notes.push('含估算');
    if (row?.unpricedRequests) notes.push('部分未定价');
    if (notes.length)
    {
        const note = tr.ownerDocument.createElement('small');
        note.textContent = notes.join(' · ');
        cell.append(note);
    }
}

function renderWeeklyComparison(section, snapshot, cycles, endLabel)
{
    const doc = section.ownerDocument;
    const table = section.querySelector('table');
    const head = table.tHead.rows[0];
    const body = table.tBodies[0];
    const footer = table.tFoot.rows[0];
    const header = head.cells[0];
    const totalHeader = footer.cells[0];
    head.replaceChildren(header);
    body.replaceChildren();
    footer.replaceChildren(totalHeader);

    const modelCosts = new Map();
    const columns = cycles.map((week, index) =>
    {
        const cell = doc.createElement('th');
        cell.scope = 'col';
        head.append(cell);
        const heading = doc.createElement(week ? 'button' : 'span');
        heading.className = 'daily-usage-cycle-heading';
        cell.append(heading);
        const label = doc.createElement('span');
        label.className = 'daily-usage-cycle-label';
        label.textContent = WeekLabels[index];
        heading.append(label);
        if (!week)
        {
            const missing = doc.createElement('small');
            missing.textContent = '无记录';
            heading.append(missing);
            return null;
        }

        heading.type = 'button';
        heading.dataset.weeklyCycle = index;
        const dates = [localDate(week.startAt), localDate(week.endAt)];
        const sameYear = dates[0].slice(0, 4) === dates[1].slice(0, 4);
        const range = doc.createElement('small');
        range.className = 'daily-usage-cycle-range';
        const times = dates.map(date =>
        {
            const time = doc.createElement('time');
            time.dateTime = date;
            time.textContent = (sameYear ? date.slice(5) : date).replaceAll('-', '/');
            return time;
        });
        range.append(times[0], '–', times[1]);
        heading.append(range);
        const partial = hasPartialWeek(week, snapshot.coverage);
        const note = doc.createElement('small');
        note.textContent = WeekStartLabels[week.startKind] + (partial ? ' · 部分覆盖' : '');
        heading.append(note);

        const rows = new Map();
        for (const row of week.rows)
        {
            rows.set(row.model, row);
            modelCosts.set(row.model, (modelCosts.get(row.model) || 0) + row.usd);
        }
        return { rows, totals: weeklyTotals(week.rows), coverageGap: partial };
    });
    const width = Math.max(...columns.map(column => formatUsd(column?.totals.usd ?? 0).length));
    table.style.setProperty('--daily-usage-amount-width', width + 'ch');
    const models = [...modelCosts].sort(([a, aUsd], [b, bUsd]) => bUsd - aUsd || a.localeCompare(b));
    for (const [model] of models)
    {
        const tr = body.insertRow();
        const name = doc.createElement('th');
        name.scope = 'row';
        name.textContent = model;
        tr.append(name);
        for (const column of columns) appendComparisonAmount(tr, column, column?.rows.get(model));
    }
    for (const column of columns) appendComparisonAmount(footer, column, column?.totals);
    section.querySelector('[data-weekly-comparison-empty]').textContent = snapshot && !cycles.some(Boolean)
        ? '暂无周额度观测记录。' : '';
    section.querySelector('[data-weekly-comparison-updated]').textContent = snapshot
        ? endLabel + ' ' + weeklyTime.format(snapshot.generatedAt) + '（北京时间）' : '';
    section.querySelector('[data-weekly-comparison-coverage]').textContent = snapshot
        ? weeklyScanWarning(snapshot.coverage) : '';
    const remainder = snapshot?.weeklyRemainder;
    section.querySelector('[data-weekly-remainder]').textContent = remainder
        ? '快照近 30 天（' + snapshot.from + ' 至 ' + snapshot.to + '） · 未列入上表的请求数及已定价金额'
            + ' · 较早周期 ' + formatSubtotal(remainder.earlier)
            + ' · 未归属周期 ' + formatSubtotal(remainder.unassigned)
        : '';
}

function renderWeekly(section, snapshot, weekly, hostLabel, endLabel, cycleLabel)
{
    const date = section.querySelector('[data-weekly-period]');
    const observation = section.querySelector('[data-weekly-observation]');
    const limit = section.querySelector('progress[aria-label="周额度已用"]');
    const empty = section.querySelector('[data-weekly-empty]');
    const coverage = section.querySelector('[data-weekly-coverage]');
    const updated = section.querySelector('[data-weekly-updated]');
    const table = section.querySelector('.daily-usage-scroll');
    const cycle = cycleLabel || '本轮';
    table.querySelector('table').setAttribute('aria-label', cycle + '周额度模型用量');
    const body = table.querySelector('tbody');
    const rows = weekly?.rows || [];
    const logCoverage = snapshot?.coverage;
    const partial = hasPartialWeek(weekly, logCoverage);
    body.replaceChildren();
    table.hidden = rows.length === 0;
    const totals = weeklyTotals(rows);
    section.querySelector('[data-weekly-host]').textContent = hostLabel + '请求数（含子代理）';
    section.querySelector('[data-weekly-summary="usd"]').textContent = weekly && (!partial || totals.requests)
        ? formatAmount(totals) : '—';
    section.querySelector('[data-weekly-summary="requests"]').textContent = weekly
        ? counts.format(totals.requests) : '—';
    const percent = weekly?.usedPercent;
    const hasPercent = Number.isFinite(percent);
    section.querySelector('[data-weekly-summary="percent"]').textContent = hasPercent
        ? formatWeeklyPercent(percent) : '—';
    limit.hidden = !hasPercent;
    limit.value = hasPercent ? percent : 0;
    observation.textContent = hasPercent ? '观测于 ' + weeklyTime.format(weekly.sampleAt)
        : weekly ? '暂无周额度观测记录' : '';
    const split = section.querySelector('[data-weekly-split]');
    split.textContent = '';
    date.textContent = '';
    updated.textContent = '';
    coverage.textContent = '';
    empty.textContent = '';
    if (!weekly) return;

    date.textContent = cycle + ' · ' + WeekStartLabels[weekly.startKind] + ' ' + weeklyTime.format(weekly.startAt)
        + ' → ' + weeklyTime.format(weekly.endAt) + '（北京时间）' + (partial ? ' · 部分覆盖' : '');
    updated.textContent = endLabel + ' ' + weeklyTime.format(snapshot.generatedAt) + '（北京时间）';
    if (weekly.resetAt > snapshot.generatedAt)
        updated.textContent += ' · 预计重置 ' + weeklyTime.format(weekly.resetAt) + '（北京时间）';
    if (weekly.fullAt !== null)
    {
        const after = weekly.afterFull;
        const beforeRequests = totals.requests - after.requests;
        const before = { requests: beforeRequests, usd: beforeRequests ? Math.max(0, totals.usd - after.usd) : 0 };
        split.textContent = '首次观测满额 ' + weeklyTime.format(weekly.fullAt) + '（北京时间）'
            + ' · 截至首次观测的 100%（含该时刻） ' + formatSubtotal(before)
            + ' · 首次观测的 100% 之后 ' + formatSubtotal(after) + '。金额为已定价部分。';
    }
    else if (hasPercent) split.textContent = '本轮暂无 100% 观测记录。';

    if (!rows.length)
    {
        empty.textContent = hostLabel + '可读日志范围内，' + cycle + '没有可统计的请求。'
            + (partial ? '已有覆盖缺口，金额暂不可用。' : '');
    }

    const gaps = [];
    if (totals.unpricedRequests)
    {
        gaps.push(counts.format(totals.unpricedRequests) + ' 次请求未定价'
            + (totals.usd > 0 ? '，金额占比按已定价金额计算' : ''));
    }
    if (totals.estimatedRequests) gaps.push(counts.format(totals.estimatedRequests) + ' 次请求含估算');
    const scanWarning = weeklyScanWarning(logCoverage);
    if (scanWarning) gaps.push(scanWarning);
    coverage.textContent = gaps.join('；');
    const doc = section.ownerDocument;
    const orderedRows = [...rows].sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
    for (const row of orderedRows)
    {
        const tr = doc.createElement('tr');
        const share = hasPrice(row) && totals.usd > 0 ? row.usd / totals.usd * 100 : null;
        const values = [row.model, counts.format(row.requests), formatAmount(row)];
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
    let selectedCycle = null;
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
        .daily-usage-weekly [data-weekly-detail] :is(th, td):nth-child(3) { font-weight:700; background:#22998214; }
        .daily-usage-share { display:inline-flex; align-items:center; gap:8px; }
        .daily-usage-share progress { width:clamp(64px, 12vw, 128px); height:6px; }
        .daily-usage-weekly td:first-child { white-space:normal; overflow-wrap:anywhere; min-width:100px; }
        .daily-usage-panel .daily-usage-weekly :is(th, td):nth-child(2) { text-align:right; }
        .daily-usage-panel [data-weekly-comparison] .daily-usage-scroll { max-height:max(20rem, 64vh); scrollbar-gutter:stable; }
        .daily-usage-panel [data-weekly-comparison] table { --daily-usage-cycle-share:calc(.75 / 4);
            min-width:max(490px, calc((var(--daily-usage-amount-width, 0ch) + 24px) / var(--daily-usage-cycle-share)));
            table-layout:fixed; border-collapse:separate; border-spacing:0; font-variant-numeric:tabular-nums; }
        .daily-usage-panel [data-weekly-comparison] :is(th, td) { vertical-align:top; line-height:1.45; }
        .daily-usage-panel [data-weekly-comparison] :is(th, td):nth-child(2) {
            background-image:linear-gradient(#22998214, #22998214); }
        .daily-usage-panel [data-weekly-comparison] th:first-child { white-space:normal; overflow-wrap:anywhere; }
        .daily-usage-panel [data-weekly-comparison] thead th:not(:first-child) {
            width:calc(100% * var(--daily-usage-cycle-share)); text-align:right; padding:0; }
        .daily-usage-panel [data-weekly-comparison] .daily-usage-cycle-heading { display:block; width:100%;
            margin:0; border:0; padding:10px 12px; font:inherit; text-align:inherit; background:none; }
        .daily-usage-panel [data-weekly-comparison] .daily-usage-cycle-label { display:block; }
        .daily-usage-panel [data-weekly-comparison] th button:hover { background:#8882; }
        .daily-usage-panel [data-weekly-comparison] button .daily-usage-cycle-label {
            text-decoration:underline; text-underline-offset:3px; }
        .daily-usage-panel [data-weekly-comparison] :is(time, small) { display:block; margin-top:3px;
            font-size:11px; font-weight:400; opacity:.8; white-space:normal; overflow-wrap:anywhere; }
        .daily-usage-panel [data-weekly-comparison] .daily-usage-cycle-range time { display:inline; margin:0; opacity:1; }
        .daily-usage-panel [data-weekly-comparison] tfoot :is(th, td) { position:sticky; bottom:0; z-index:1;
            background-color:var(--color-token-bg-primary, var(--daily-usage-comparison-bg, Canvas));
            border-top:1px solid #8885; font-weight:700; }
    </style>
    <header><h2>Daily Usage</h2><select aria-label="统计机器"><option value="local">本机</option></select>
    <select aria-label="统计时间范围"><option value="1">今天</option><option value="7">最近 7 天</option>
    <option value="30">最近 30 天</option><option value="weekly">周额度历史</option></select><button type="button" data-refresh>刷新</button></header>
    <p>北京时间 · 包含子代理 · 金额按公开 Standard API 价格折算。订阅账单与额度以服务商记录为准。</p>
    <div data-status role="status" aria-live="polite">正在读取统计…</div>
    <div data-calendar>
    <div class="daily-usage-cards">
        <div class="daily-usage-card"><small>Token 总量</small><strong data-summary="tokens">—</strong></div>
        <div class="daily-usage-card"><small>${AmountLabel}</small><strong data-summary="usd">—</strong></div>
        <div class="daily-usage-card"><small>请求数</small><strong data-summary="requests">—</strong></div>
    </div><p data-updated></p><p data-coverage></p>
    <div class="daily-usage-scroll"><table aria-label="每日模型用量"><thead><tr>
    <th>日期</th><th>模型</th><th>请求</th><th>普通输入</th><th>缓存输入</th><th>缓存写入</th><th>输出</th><th title="${AmountLabel}">金额</th>
    </tr></thead><tbody></tbody></table></div>
    <p data-empty></p><p>机器列表包含本机和本窗口打开过的远程会话。远程机器需要安装并启用 Daily Usage。</p>
    </div>
    <div class="daily-usage-weekly" data-weekly hidden>
        <div data-weekly-comparison hidden>
            <p>周期日期采用北京时间。各列统计该轮记录的全部用量，点击周期查看明细。</p>
            <div class="daily-usage-scroll" role="region" aria-label="周额度费用对比表" tabindex="0">
                <table aria-label="周额度历史对比">
                    <caption>${AmountLabel}</caption>
                    <thead><tr><th scope="col">模型</th></tr></thead>
                    <tbody></tbody><tfoot><tr><th scope="row">合计</th></tr></tfoot>
                </table>
            </div>
            <p data-weekly-comparison-empty role="status"></p>
            <p data-weekly-remainder></p>
            <p data-weekly-comparison-updated></p>
            <p data-weekly-comparison-coverage></p>
        </div>
        <div data-weekly-detail hidden>
            <button type="button" data-weekly-back hidden>返回周额度对比</button>
            <p class="daily-usage-period" data-weekly-period></p>
            <div class="daily-usage-cards">
                <div class="daily-usage-card"><small>${AmountLabel}</small>
                    <strong data-weekly-summary="usd">—</strong><small>整轮记录</small></div>
                <div class="daily-usage-card"><small>周额度已用</small>
                    <strong data-weekly-summary="percent">—</strong>
                    <progress aria-label="周额度已用" max="100" value="0" hidden></progress>
                    <p data-weekly-observation></p></div>
                <div class="daily-usage-card"><small data-weekly-host>本机请求数（含子代理）</small>
                    <strong data-weekly-summary="requests">—</strong></div>
            </div>
            <p data-weekly-split></p>
            <p data-weekly-empty role="status"></p>
            <div class="daily-usage-scroll" role="region" aria-label="模型费用列表" tabindex="0" hidden>
                <table aria-label="本轮周额度模型用量">
                    <caption>按模型统计</caption><thead><tr>
                    <th scope="col">模型</th><th scope="col">请求数</th>
                    <th scope="col" aria-sort="descending" title="${AmountLabel}">金额</th><th scope="col">金额占比</th>
                </tr></thead><tbody></tbody></table>
            </div>
            <p data-weekly-updated></p><p data-weekly-coverage></p>
        </div>
    </div><p data-price></p>`;
    root.append(panel);
    const host = panel.querySelector('[aria-label="统计机器"]');
    const range = panel.querySelector('[aria-label="统计时间范围"]');
    const refresh = panel.querySelector('[data-refresh]');
    const status = panel.querySelector('[data-status]');
    const calendar = panel.querySelector('[data-calendar]');
    const weekly = panel.querySelector('[data-weekly]');
    const comparison = weekly.querySelector('[data-weekly-comparison]');
    const detail = weekly.querySelector('[data-weekly-detail]');
    const back = detail.querySelector('[data-weekly-back]');
    const body = calendar.querySelector('tbody');

    function render()
    {
        if (!alive) return;
        body.replaceChildren();
        const snapshot = reportState?.snapshot;
        const state = reportState?.status;
        const updateRequired = reportState?.error === 'snapshot-update-required';
        const oversized = reportState?.error === 'snapshot-too-large';
        const timestamp = now();
        const stale = snapshot && (updateRequired || oversized || state === 'stale' || state === 'error'
            || timestamp - snapshot.generatedAt > 180000);
        const hostLabel = hostNames.get(host.value) || host.value;
        status.textContent = updateRequired
            ? '两端需升级并启用新版 Daily Usage，以使用统一计价。远程统计还需要 Codex 支持文件通知。'
                + (snapshot ? '当前显示最后成功的兼容缓存。' : '')
            : oversized ? '统计报告超出传输大小限制。' + (snapshot ? '显示最后成功的缓存数据。' : '')
            : state === 'loading' ? '正在查询所选机器，完成后显示结果…'
            : stale ? '显示最后成功的缓存数据；当前连接不可用或统计尚未更新。'
            : snapshot ? `${hostLabel} · 统计已更新`
            : state === 'error' && host.value === 'local' ? '本机统计暂不可用，请稍后刷新。'
            : '暂无统计。请在运行端安装并启用 Daily Usage，并等待首次扫描完成。';
        panel.querySelector('[data-price]').textContent = snapshot
            ? `价格表日期 ${snapshot.pricing.asOf}。缓存写入时长缺失时按 30 分钟价格估算。金额仅含模型 Token 费用。` : '';
        const showWeekly = range.value === 'weekly';
        calendar.hidden = showWeekly;
        if (!weekly.hidden && !showWeekly)
        {
            comparison.querySelector('tbody').replaceChildren();
            detail.querySelector('tbody').replaceChildren();
        }
        weekly.hidden = !showWeekly;
        const endLabel = stale ? '缓存截至' : state === 'loading' ? '上次数据截至' : '数据截至';
        if (showWeekly)
        {
            const cycles = WeekLabels.map((_, index) => index === 0
                ? snapshot?.weekly : snapshot?.weeklyHistory[index - 1]);
            const selected = selectedCycle === null ? null : cycles[selectedCycle];
            comparison.hidden = !snapshot || Boolean(selected);
            detail.hidden = !selected;
            back.hidden = !selected;
            if (!selected)
            {
                const focused = comparison.contains(doc.activeElement) ? doc.activeElement.dataset.weeklyCycle : null;
                renderWeeklyComparison(comparison, snapshot, cycles, endLabel);
                if (focused != null) comparison.querySelector('[data-weekly-cycle="' + focused + '"]')?.focus();
            }
            renderWeekly(detail, snapshot, selected, hostLabel, endLabel, WeekLabels[selectedCycle]);
            return;
        }
        const useSnapshotRange = range.value === '30' && snapshot;
        const from = useSnapshotRange ? snapshot.from : localDate(timestamp - (Number(range.value) - 1) * DayMs);
        const to = useSnapshotRange ? snapshot.to : localDate(timestamp);
        const rows = snapshot?.rows.filter(row => row.date >= from && row.date <= to) || [];
        const totals = rows.reduce((sum, row) => ({ tokens: sum.tokens + row.inputTokens + row.outputTokens,
            requests: sum.requests + row.requests, usd: sum.usd + row.usd,
            unpricedRequests: sum.unpricedRequests + row.unpricedRequests,
            estimatedRequests: sum.estimatedRequests + row.estimatedRequests }),
        { tokens: 0, requests: 0, usd: 0, unpricedRequests: 0, estimatedRequests: 0 });
        for (const key of ['tokens', 'requests', 'usd'])
        {
            panel.querySelector(`[data-summary="${key}"]`).textContent = snapshot
                ? (key === 'usd' ? formatAmount(totals) : counts.format(totals[key])) : '—';
        }
        panel.querySelector('[data-updated]').textContent = snapshot
            ? `${endLabel} ${timeFormat.format(snapshot.generatedAt)}（北京时间） · 已读取 ${snapshot.from} 至 ${snapshot.to}` : '';
        const gaps = [];
        if (totals.unpricedRequests) gaps.push(counts.format(totals.unpricedRequests) + ' 次请求未定价');
        if (totals.estimatedRequests) gaps.push(counts.format(totals.estimatedRequests) + ' 次请求含估算');
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
                formatAmount(row)];
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
        selectedCycle = null;
        reportState = { status: 'loading', snapshot: changed ? undefined : reportState?.snapshot };
        render();
        const selected = host.value;
        try
        {
            const result = await getReport(selected, { requestId: query.id });
            if (!alive || !visibleElement(panel) || version !== requestVersion) return;
            selectedCycle = null;
            reportState = result?.snapshot && result.snapshot.schemaVersion !== 4
                ? { status: 'unavailable', error: 'snapshot-update-required' } : result;
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
    range.addEventListener('change', () =>
    {
        selectedCycle = null;
        render();
    });
    comparison.addEventListener('click', event =>
    {
        const button = event.target.closest('button[data-weekly-cycle]');
        if (!button || comparison.hidden) return;
        selectedCycle = Number(button.dataset.weeklyCycle);
        render();
        back.focus();
    });
    back.addEventListener('click', () =>
    {
        const cycle = selectedCycle;
        selectedCycle = null;
        render();
        comparison.querySelector('[data-weekly-cycle="' + cycle + '"]')?.focus();
    });
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
        description: `每日 Token、${AmountLabel}与周额度历史`, iconSvg: PageIconSvg, render: mount });
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
