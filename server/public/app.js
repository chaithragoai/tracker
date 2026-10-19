/* Mac Activity Tracker dashboard — real data only via /api/analytics + existing endpoints */

const PALETTE = ['#5b8cff', '#3dd6c6', '#a78bfa', '#f59e0b', '#f07178', '#34d399', '#60a5fa', '#fb7185', '#c084fc', '#94a3b8'];
const VIEW_TITLES = {
  overview: 'Overview',
  apps: 'App Usage',
  browser: 'Browser Activity',
  timeline: 'Timeline',
  search: 'Search',
  assistant: 'Assistant',
  briefing: 'Daily Briefing',
  tasks: 'Tasks',
  memories: 'Memories',
  history: 'Activity History',
  reports: 'Reports & Privacy',
  manager: 'Manager',
};

const state = {
  rangeKey: 'today',
  from: null,
  to: null,
  analytics: null,
  charts: {},
  managerDevices: [],
  managerSelectedId: null,
};

function pad(n) { return String(n).padStart(2, '0'); }

function localDayBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString(), labelDay: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` };
}

function setRangePreset(key) {
  state.rangeKey = key;
  const now = new Date();
  if (key === 'today') {
    const b = localDayBounds(now);
    state.from = b.from;
    state.to = b.to;
  } else if (key === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const b = localDayBounds(y);
    state.from = b.from;
    state.to = b.to;
  } else if (key === '7d') {
    const end = localDayBounds(now);
    const start = new Date(now);
    start.setDate(start.getDate() - 6);
    const s = localDayBounds(start);
    state.from = s.from;
    state.to = end.to;
  }
  // custom: keep existing from/to until Apply
  document.querySelectorAll('.chip[data-range]').forEach((el) => {
    el.classList.toggle('active', el.dataset.range === key);
  });
  document.getElementById('custom-range').classList.toggle('hidden', key !== 'custom');
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function mins(sec) {
  // Prefer the same duration format as Overview metrics (not raw "12.3 min").
  return formatDuration(sec);
}

function row(html) {
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = html;
  return div;
}

function outcomeClass(o) {
  return `outcome-${o || 'unknown'}`;
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    delete state.charts[key];
  }
}

function donutConfig(labels, values, colors) {
  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: '#0b1220',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#8b9bb3', boxWidth: 12, padding: 14, font: { family: 'DM Sans', size: 11 } },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.parsed || 0;
              const sum = ctx.dataset.data.reduce((a, b) => a + b, 0) || 1;
              const pct = ((v / sum) * 100).toFixed(1);
              return ` ${ctx.label}: ${formatDuration(v)} (${pct}%)`;
            },
          },
        },
      },
    },
  };
}

function renderDonut(canvasId, emptyId, centerId, items, chartKey, centerTotalLabel, exclusiveTotalSeconds) {
  const canvas = document.getElementById(canvasId);
  const empty = document.getElementById(emptyId);
  const center = centerId ? document.getElementById(centerId) : null;
  destroyChart(chartKey);

  if (!items || !items.length) {
    canvas.style.display = 'none';
    if (center) center.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  canvas.style.display = 'block';
  empty.classList.add('hidden');
  const top = items.slice(0, 8);
  const rest = items.slice(8);
  const labels = top.map((i) => i.name);
  const values = top.map((i) => i.seconds);
  if (rest.length) {
    labels.push('Other');
    values.push(rest.reduce((s, i) => s + i.seconds, 0));
  }
  const colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
  state.charts[chartKey] = new Chart(canvas.getContext('2d'), donutConfig(labels, values, colors));
  if (center) {
    // Prefer exclusive Overview total so the donut center matches the metric cards
    // (summing ranked slices can still exceed exclusive wall-clock when orphans overlap).
    const total = exclusiveTotalSeconds != null
      ? exclusiveTotalSeconds
      : items.reduce((s, i) => s + i.seconds, 0);
    center.innerHTML = `${formatDuration(total)}<span>${centerTotalLabel}</span>`;
  }
}

function renderBar(canvasId, emptyId, points, chartKey) {
  const canvas = document.getElementById(canvasId);
  const empty = document.getElementById(emptyId);
  destroyChart(chartKey);
  if (!points || !points.length) {
    canvas.style.display = 'none';
    empty.classList.remove('hidden');
    return;
  }
  canvas.style.display = 'block';
  empty.classList.add('hidden');
  state.charts[chartKey] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: points.map((p) => {
        if (p.key.length === 10) return p.key.slice(5);
        return p.key.slice(11, 16);
      }),
      datasets: [{
        label: 'App time',
        data: points.map((p) => p.seconds),
        backgroundColor: 'rgba(91, 140, 255, 0.75)',
        borderRadius: 6,
        maxBarThickness: 28,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) { return ` ${formatDuration(ctx.parsed.y)}`; },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b9bb3', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          grid: { color: 'rgba(148,163,184,0.08)' },
        },
        y: {
          ticks: {
            color: '#8b9bb3',
            callback(v) { return formatDuration(v); },
          },
          grid: { color: 'rgba(148,163,184,0.08)' },
        },
      },
    },
  });
}

function renderRankList(el, items, emptyText) {
  el.innerHTML = '';
  if (!items || !items.length) {
    el.appendChild(row(`<div class="meta">${emptyText}</div>`));
    return;
  }
  for (const item of items.slice(0, 10)) {
    const pct = Number(item.percent || 0);
    const div = document.createElement('div');
    div.className = 'rank-row';
    div.innerHTML = `
      <div class="rank-name">${escapeHtml(item.name)}${item.incomplete ? ' <span class="muted tiny">(open)</span>' : ''}</div>
      <div class="rank-meta">${formatDuration(item.seconds)} · ${pct.toFixed(1)}%</div>
      <div class="bar" aria-hidden="true"><i style="width:${Math.min(100, pct)}%"></i></div>`;
    el.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyAnalytics(data) {
  state.analytics = data;
  const s = data.summary;
  document.getElementById('metric-total-app').textContent = formatDuration(s.totalTrackedAppSeconds);
  document.getElementById('metric-browser').textContent = formatDuration(s.totalBrowserSeconds);
  document.getElementById('metric-top-app').textContent = s.topApplication ? s.topApplication.name : '—';
  document.getElementById('metric-top-app-time').textContent = s.topApplication
    ? `${formatDuration(s.topApplication.seconds)} · ${s.topApplication.percent.toFixed(1)}% of app time`
    : 'No app sessions recorded';
  document.getElementById('metric-app-count').textContent = String(s.appCount);
  document.getElementById('metric-site-count').textContent = `${s.websiteCount} websites with tab time`;

  const note = document.getElementById('open-session-note');
  const openApps = data.notes?.openSessions?.apps || 0;
  const openTabs = data.notes?.openSessions?.tabs || 0;
  if (openApps || openTabs) {
    note.classList.remove('hidden');
    const heal = data.notes?.staleSessionHeal;
    const healNote = heal && (heal.tabsHealed || heal.appsHealed)
      ? ` Closed ${heal.appsHealed || 0} stale app and ${heal.tabsHealed || 0} stale tab orphans at last collector activity.`
      : '';
    note.textContent = `Some sessions are still open (${openApps} apps, ${openTabs} tabs). Open time clips to the collector activity ceiling (freezes if Mac/Chrome is stale).${healNote}`;
  } else {
    note.classList.add('hidden');
  }

  document.getElementById('range-label').textContent =
    `${new Date(data.range.from).toLocaleString()} → ${new Date(data.range.to).toLocaleString()}`;
  document.getElementById('timeline-mode-label').textContent =
    data.range.bucketMode === 'day' ? 'App activity by day' : 'App activity by hour (UTC buckets)';

  renderDonut('chart-apps', 'empty-apps', 'chart-apps-center', data.applications.items, 'apps', 'app time', s.totalTrackedAppSeconds);
  renderDonut('chart-sites', 'empty-sites', 'chart-sites-center', data.websites.items, 'sites', 'browser time', s.totalBrowserSeconds);
  renderDonut('chart-categories', 'empty-categories', null, data.categories.items, 'categories', '');
  renderBar('chart-timeline', 'empty-timeline', data.usageOverTime, 'timeline');
  renderDonut('chart-apps-lg', 'empty-apps-lg', null, data.applications.items, 'appsLg', '');
  renderDonut('chart-sites-lg', 'empty-sites-lg', null, data.websites.items, 'sitesLg', '');

  renderRankList(document.getElementById('top-apps'), data.applications.items, 'No application usage in this range.');
  renderRankList(document.getElementById('top-sites'), data.websites.items, 'No website usage in this range.');
  renderRankList(document.getElementById('apps-detail'), data.applications.items, 'No application usage in this range.');
  renderRankList(document.getElementById('sites-detail'), data.websites.items, 'No website usage in this range.');
}

async function loadAnalytics() {
  const params = new URLSearchParams({ from: state.from, to: state.to });
  const data = await fetch(`/api/analytics?${params}`).then((r) => {
    if (!r.ok) throw new Error(`analytics ${r.status}`);
    return r.json();
  });
  applyAnalytics(data);
}

async function loadStatusAndLists() {
  const params = new URLSearchParams({ from: state.from, to: state.to, limit: '100' });
  if (document.getElementById('filter-bundle').value.trim()) {
    params.set('bundle', document.getElementById('filter-bundle').value.trim());
  }
  if (document.getElementById('filter-q').value.trim()) {
    params.set('q', document.getElementById('filter-q').value.trim());
  }
  if (document.getElementById('filter-type').value) {
    params.set('type', document.getElementById('filter-type').value);
  }

  const dayForWeekly = state.to.slice(0, 10);
  const [status, health, events, idle, gaps, weekly, sessions] = await Promise.all([
    fetch('/api/status').then((r) => r.json()),
    fetch('/api/tracking/health').then((r) => r.json()).catch(() => ({})),
    fetch(`/api/events?${params}`).then((r) => r.json()),
    fetch('/api/idle').then((r) => r.json()),
    fetch('/api/gaps').then((r) => r.json()),
    fetch(`/api/summary/weekly?day=${dayForWeekly}`).then((r) => r.json()),
    fetch(`/api/sessions/apps?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`).then((r) => r.json()),
  ]);

  const pill = document.getElementById('status-pill');
  pill.textContent = status.status || 'unknown';
  pill.className = `pill ${status.status || ''}`;
  const healthEl = document.getElementById('health-line');
  if (healthEl) {
    const ext = health.extension_connected ? 'Chrome: connected' : 'Chrome: not recently seen';
    const mac = health.last_mac_event_at ? `Mac last event ${new Date(health.last_mac_event_at).toLocaleTimeString()}` : 'Mac: no recent events';
    healthEl.textContent = `${ext} · ${mac}`;
  }
  document.getElementById('current-app').textContent =
    status.current_app_name ? `${status.current_app_name}` : 'No frontmost app recorded';
  document.getElementById('current-tab').textContent =
    status.current_tab_title
      ? `${status.current_tab_title}${status.current_tab_url ? ` · ${status.current_tab_url}` : ''}`
      : 'No active tab recorded';

  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';
  const list = sessions.sessions || [];
  for (const s of list.slice(0, 50)) {
    timeline.appendChild(row(
      `<div><strong>${escapeHtml(s.app_name)}</strong> · ${s.duration_seconds != null ? formatDuration(s.duration_seconds) : 'open / collecting'}</div>
       <div class="meta">${escapeHtml(s.started_at)} → ${escapeHtml(s.ended_at || 'open')}${s.was_idle ? ' · idle-marked' : ''}</div>`
    ));
  }
  if (!list.length) timeline.appendChild(row('<div class="meta">No app sessions overlapping this range.</div>'));

  const idleEl = document.getElementById('idle-list');
  idleEl.innerHTML = '';
  for (const i of (idle.idle || []).slice(0, 20)) {
    idleEl.appendChild(row(`<div>${escapeHtml(i.started_at)} → ${escapeHtml(i.ended_at || 'open')}</div><div class="meta">${mins(i.duration_seconds)}</div>`));
  }
  if (!(idle.idle || []).length) idleEl.appendChild(row('<div class="meta">No idle periods.</div>'));

  const gapsEl = document.getElementById('gaps-list');
  gapsEl.innerHTML = '';
  for (const g of (gaps.gaps || []).slice(0, 20)) {
    gapsEl.appendChild(row(`<div>${escapeHtml(g.reason)}</div><div class="meta">${escapeHtml(g.started_at)} → ${escapeHtml(g.ended_at)} · ${mins(g.duration_seconds)}</div>`));
  }
  const failEvents = (events.events || []).filter((e) => e.outcome === 'failure' || e.type === 'error').slice(0, 10);
  for (const e of failEvents) {
    gapsEl.appendChild(row(`<div class="${outcomeClass(e.outcome)}">${escapeHtml(e.type)}</div><div class="meta">${escapeHtml(e.timestamp)}</div>`));
  }
  if (!(gaps.gaps || []).length && !failEvents.length) gapsEl.appendChild(row('<div class="meta">No gaps or errors.</div>'));

  const opsEl = document.getElementById('ops-list');
  opsEl.innerHTML = '';
  const ops = (events.events || []).filter((e) =>
    ['click', 'search', 'formSubmit', 'navigation', 'download', 'upload', 'operation'].includes(e.type)
  );
  for (const e of ops.slice(0, 40)) {
    let semantic = '';
    try { semantic = JSON.parse(e.metadata_json || '{}').semantic || ''; } catch { /* ignore */ }
    opsEl.appendChild(row(
      `<div><strong>${escapeHtml(e.type)}</strong> <span class="${outcomeClass(e.outcome)}">${escapeHtml(e.outcome)}</span> ${escapeHtml(semantic)}</div>
       <div class="meta">${escapeHtml(e.timestamp)}</div>`
    ));
  }
  if (!ops.length) opsEl.appendChild(row('<div class="meta">No browser operations in this filter.</div>'));

  const eventsEl = document.getElementById('events');
  eventsEl.innerHTML = '';
  for (const ev of events.events || []) {
    eventsEl.appendChild(row(
      `<div><strong>${escapeHtml(ev.type)}</strong> <span class="${outcomeClass(ev.outcome)}">${escapeHtml(ev.outcome)}</span> ${escapeHtml(ev.app_name || '')}</div>
       <div class="meta">${escapeHtml(ev.timestamp)} · ${escapeHtml(ev.bundle_identifier || '')} · ${escapeHtml(ev.source || '')}</div>`
    ));
  }
  if (!(events.events || []).length) eventsEl.appendChild(row('<div class="meta">No events for this filter.</div>'));

  const w = weekly.totals || {};
  document.getElementById('weekly').textContent =
    `Weekly (ending ${weekly.endDay || '—'}): active ${formatDuration(w.active)}, idle ${formatDuration(w.idle)}, gaps ${formatDuration(w.gaps)}, ops ${Number(w.ops) || 0}, errors ${Number(w.errors) || 0}`;

  const csv = document.getElementById('btn-csv');
  csv.href = `/api/export/csv?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
  const jsonBtn = document.getElementById('btn-json');
  if (jsonBtn) jsonBtn.href = `/api/export/json?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
}

async function runSearch() {
  const q = document.getElementById('search-q').value.trim();
  const params = new URLSearchParams({
    q,
    from: state.from,
    to: state.to,
    limit: '40',
  });
  const data = await fetch(`/api/search?${params}`).then((r) => r.json());
  const root = document.getElementById('search-results');
  root.innerHTML = '';
  if (!(data.results || []).length) {
    root.appendChild(row('<div class="meta">No matches in recorded data for this range.</div>'));
    return;
  }
  for (const r of data.results) {
    root.appendChild(row(
      `<div><strong>${escapeHtml(r.title)}</strong> <span class="muted tiny">[${escapeHtml(r.kind)} · ${escapeHtml(r.factType || 'recorded')}]</span></div>
       <div class="meta">${escapeHtml(r.snippet || '')}</div>
       <div class="meta">${escapeHtml(r.timestamp || r.day || '')} · ${escapeHtml(r.source || '')}${r.duration_seconds != null ? ` · ${formatDuration(r.duration_seconds)}` : ''}</div>`
    ));
  }
}

async function runAsk() {
  const question = document.getElementById('ask-q').value.trim();
  const res = await fetch('/api/assistant/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  }).then((r) => r.json());
  document.getElementById('ask-answer').innerHTML =
    `<div>${escapeHtml(res.answer)}</div><div class="meta">${escapeHtml(res.note || '')}</div>`;
  const meta = document.getElementById('ask-meta');
  meta.innerHTML = '';
  if (res.facts?.length) {
    meta.appendChild(row(`<div><strong>Facts</strong></div><div class="meta">${res.facts.map(escapeHtml).join('<br>')}</div>`));
  }
  if (res.estimates?.length) {
    meta.appendChild(row(`<div><strong>Estimates / caveats</strong></div><div class="meta">${res.estimates.map(escapeHtml).join('<br>')}</div>`));
  }
}

function workDay() {
  return typeof reportDayFromRange === 'function' ? reportDayFromRange() : state.to.slice(0, 10);
}

function setWorkMsg(text, isError = false) {
  const el = document.getElementById('work-msg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--fail)' : '';
}

function updateBriefingDayLabel(day) {
  const el = document.getElementById('briefing-day-label');
  if (!el) return;
  const range = document.getElementById('range-label')?.textContent || '';
  el.textContent = day
    ? `Showing work for ${day}${range && range !== 'Loading range…' ? ` · ${range}` : ''}`
    : 'Select a date range above, then generate a report.';
}

function formatClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(11, 16) || '—';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatClockRange(start, end) {
  return `${formatClock(start)} – ${end ? formatClock(end) : 'open'}`;
}

function kindLabelOf(s) {
  return s.kind_label || s.category || 'Other work';
}

function categoryKey(s) {
  return String(s.category || 'other').replace(/[^a-z0-9_]/gi, '_');
}

function shortWorkDescription(s) {
  if (s.category === 'uncertain' || s.status === 'uncertain') {
    return 'Not enough evidence to identify the exact task.';
  }
  const raw = String(s.summary || '').trim();
  if (!raw) return 'Activity recorded from apps and websites used.';
  // Drop repeated privacy boilerplate from card body
  const cleaned = raw
    .replace(/\s*Prompts, code changes, filenames, and test results are not captured\.?/gi, '')
    .replace(/\s*Confidence: (low|medium|high)[^.]*\.?/gi, '')
    .replace(/\s*Confidence is low[^.]*\.?/gi, '')
    .trim();
  if (cleaned.length <= 160) return cleaned;
  return `${cleaned.slice(0, 157)}…`;
}

function confidenceLabel(c) {
  const v = String(c || 'low').toLowerCase();
  if (v === 'high') return 'Confirmed / high confidence';
  if (v === 'medium') return 'Inferred';
  return 'Uncertain';
}

function toolsLabel(s) {
  if (s.tools?.label) return s.tools.label;
  if (typeof s.tools === 'string') return s.tools;
  return '';
}

function renderBriefingMetrics(time = {}, activityCount = 0) {
  const root = document.getElementById('briefing-metrics');
  if (!root) return;
  const items = [
    { label: 'Total active time', value: formatDuration(time.appActiveSeconds || 0), icon: 'A', tone: '' },
    { label: 'Estimated work time', value: formatDuration(time.estimatedTaskSecondsExclusive || 0), icon: 'W', tone: 'teal' },
    { label: 'Browser activity', value: formatDuration(time.browserElapsedSeconds || 0), icon: 'B', tone: '' },
    { label: 'Idle time', value: formatDuration(time.idleSeconds || 0), icon: 'I', tone: 'warn' },
    { label: 'Work activities', value: String(activityCount), icon: '#', tone: 'ok' },
  ];
  root.innerHTML = items.map((m) => `
    <article class="card metric briefing-metric">
      <div class="metric-icon ${m.tone}" aria-hidden="true">${m.icon}</div>
      <div class="metric-label">${escapeHtml(m.label)}</div>
      <div class="metric-value">${escapeHtml(m.value)}</div>
    </article>
  `).join('');
}

function renderWorkSummary(report) {
  const root = document.getElementById('work-report-out');
  if (!root) return;
  const tasks = report.identified_tasks || report.main_tasks || [];
  const unid = report.unidentified_activity || {};
  const byKind = {};
  for (const t of tasks) {
    const k = t.kind_label || t.category || 'Other';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const chips = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `<span class="briefing-chip"><strong>${n}</strong> ${escapeHtml(label)}</span>`)
    .join('');

  root.innerHTML = `
    <p class="briefing-summary-lead"><strong>Work report</strong> for ${escapeHtml(report.day || workDay())}.
      ${escapeHtml(report.overall_summary || 'No grouped work summary yet.')}</p>
    <div class="briefing-chips">${chips || '<span class="muted tiny">No tasks identified automatically yet.</span>'}</div>
    <div class="briefing-flags">
      <div class="briefing-flag">
        <span class="flag-label">Identified</span>
        ${tasks.length} task${tasks.length === 1 ? '' : 's'} from window context, apps, and engaged sites
      </div>
      <div class="briefing-flag warn">
        <span class="flag-label">Could not identify</span>
        ${unid.count || 0} block${(unid.count || 0) === 1 ? '' : 's'}${unid.estimated_duration ? ` · ${escapeHtml(unid.estimated_duration)}` : ''}
      </div>
    </div>
    <p class="briefing-disclaimer">${escapeHtml(report.disclaimer || 'Automatic summary from tracked evidence. Outcomes are inferred unless you optionally add a note.')}</p>
  `;
}

async function refreshBriefingHealthBanner() {
  const el = document.getElementById('briefing-health-banner');
  if (!el) return;
  try {
    const h = await fetch('/api/tracking/health').then((r) => r.json());
    const bits = [];
    if (!h.extension_connected) {
      bits.push('Chrome extension looks disconnected — browser sites will not improve work detection until it reconnects.');
    }
    if (h.chrome_event_age_seconds != null && h.chrome_event_age_seconds > 3600) {
      bits.push('No recent browser activity events.');
    }
    if (bits.length) {
      el.textContent = bits.join(' ');
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  } catch {
    el.classList.add('hidden');
  }
}

function attachWorkCardActions(container, s, day, sessions, idx) {
  const actions = document.createElement('div');
  actions.className = 'actions';

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'btn';
  rename.textContent = 'Edit title';
  rename.onclick = async () => {
    const next = window.prompt('Activity title', s.title);
    if (next == null || !String(next).trim()) return;
    await fetch(`/api/work/sessions/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next.trim() }),
    });
    await loadWorkTimeline();
  };

  const noteBtn = document.createElement('button');
  noteBtn.type = 'button';
  noteBtn.className = 'btn btn-primary';
  noteBtn.textContent = 'Add note';
  noteBtn.onclick = async () => {
    const body = window.prompt('What did you do in this activity?');
    if (body == null || !String(body).trim()) return;
    await fetch('/api/work/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, work_session_id: s.id, body: body.trim() }),
    });
    await loadWorkTimeline();
  };

  actions.appendChild(rename);
  actions.appendChild(noteBtn);

  if (sessions && idx < sessions.length - 1) {
    const mergeBtn = document.createElement('button');
    mergeBtn.type = 'button';
    mergeBtn.className = 'btn';
    mergeBtn.textContent = 'Merge with next';
    mergeBtn.onclick = async () => {
      await fetch('/api/work/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [s.id, sessions[idx + 1].id] }),
      }).then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      });
      await loadWorkTimeline();
    };
    actions.appendChild(mergeBtn);
  }

  if (s.started_at && s.ended_at && Date.parse(s.ended_at) > Date.parse(s.started_at) + 60000) {
    const splitBtn = document.createElement('button');
    splitBtn.type = 'button';
    splitBtn.className = 'btn';
    splitBtn.textContent = 'Split mid';
    splitBtn.onclick = async () => {
      const mid = new Date((Date.parse(s.started_at) + Date.parse(s.ended_at)) / 2).toISOString();
      await fetch('/api/work/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, at: mid }),
      }).then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      });
      await loadWorkTimeline();
    };
    actions.appendChild(splitBtn);
  }

  container.appendChild(actions);
}

function buildWorkCardElement(s, day, sessions, idx) {
  const kind = kindLabelOf(s);
  const tools = toolsLabel(s);
  const outcomeLabel = s.outcome?.label || '';
  const evidenceBits = (s.evidence || [])
    .filter((e) => e.evidence_type === 'app_session' || e.evidence_type === 'tab_session' || e.evidence_type === 'signal')
    .slice(0, 8)
    .map((e) => e.label)
    .filter(Boolean);

  const card = document.createElement('article');
  card.className = 'work-card';
  card.innerHTML = `
    <div class="work-card-top">
      <span class="work-badge cat-${escapeHtml(categoryKey(s))}">${escapeHtml(kind)}</span>
      <span class="work-badge conf-${escapeHtml(String(s.confidence || 'low'))}">${escapeHtml(confidenceLabel(s.confidence))}</span>
      ${(s.notes || []).length ? '<span class="work-badge conf-high">Has note</span>' : ''}
    </div>
    <h3 class="work-card-title">${escapeHtml(s.title || kind)}</h3>
    <p class="work-card-desc">${escapeHtml(shortWorkDescription(s))}</p>
    <div class="work-card-meta">
      <span>${escapeHtml(formatClockRange(s.started_at, s.ended_at))}</span>
      <span>${escapeHtml(formatDuration(s.estimated_seconds || 0))}</span>
      ${tools ? `<span>${escapeHtml(tools)}</span>` : ''}
    </div>
    ${outcomeLabel ? `<div class="work-card-outcome">${escapeHtml(outcomeLabel)}</div>` : ''}
    ${s.unresolved ? `<div class="work-card-outcome needs">${escapeHtml(s.unresolved.label || s.unresolved.detail || '')}</div>` : ''}
    ${evidenceBits.length ? `<details class="work-more"><summary>More detail</summary><div>${escapeHtml(evidenceBits.join(' · '))}</div></details>` : ''}
  `;
  attachWorkCardActions(card, s, day, sessions, idx);
  return card;
}

function renderUnidentifiedSection(sessions, day, reportUnidentified) {
  const root = document.getElementById('work-needs-confirm');
  const summary = document.getElementById('work-unidentified-summary');
  const wrap = document.getElementById('work-unidentified-wrap');
  if (!root) return;
  const needs = reportUnidentified?.sessions
    || (sessions || []).filter((s) => s.category === 'uncertain' || s.status === 'uncertain');
  const totalSec = reportUnidentified?.estimated_seconds
    ?? needs.reduce((a, s) => a + Number(s.estimated_seconds || 0), 0);
  if (summary) {
    summary.textContent = needs.length
      ? ` — ${needs.length} block${needs.length === 1 ? '' : 's'} · ${formatDuration(totalSec)}`
      : ' — none';
  }
  root.innerHTML = '';
  if (!needs.length) {
    root.innerHTML = '<div class="briefing-empty">All tracked blocks were classified, or there is no activity yet.</div>';
    if (wrap) wrap.open = false;
    return;
  }
  if (wrap) wrap.open = false; // collapsed by default — avoid spam
  const apps = [...new Set(needs.flatMap((s) => s.tools?.apps || [s.title]).filter(Boolean))].slice(0, 6);
  const intro = document.createElement('div');
  intro.className = 'work-needs-item';
  intro.innerHTML = `
    <h4>Unidentified time</h4>
    <p>${escapeHtml(reportUnidentified?.note || 'Not enough context to name these tasks.')}
      ${apps.length ? ` Apps seen: ${escapeHtml(apps.join(', '))}.` : ''}</p>
  `;
  const optionalNote = document.createElement('button');
  optionalNote.type = 'button';
  optionalNote.className = 'btn';
  optionalNote.textContent = 'Optional: add a day note';
  optionalNote.onclick = async () => {
    const body = window.prompt('Optional note for unidentified time (what were you working on?)');
    if (body == null || !String(body).trim()) return;
    await fetch('/api/work/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, body: body.trim() }),
    });
    await runWorkReport();
  };
  intro.appendChild(optionalNote);
  root.appendChild(intro);
}

function renderChronoTimeline(timeline) {
  const root = document.getElementById('work-chrono');
  if (!root) return;
  const items = timeline || [];
  if (!items.length) {
    root.innerHTML = '<div class="briefing-empty">No timeline entries for this day.</div>';
    return;
  }
  root.innerHTML = items.map((t) => `
    <div class="work-chrono-item">
      <div class="work-chrono-time">${escapeHtml(formatClockRange(t.started_at, t.ended_at))}</div>
      <div class="work-chrono-main">
        <strong>${escapeHtml(t.title || t.kind_label || 'Activity')}</strong>
        <span class="muted tiny">${escapeHtml(t.estimated_duration || formatDuration(t.estimated_seconds || 0))}</span>
      </div>
      <div class="work-chrono-sub">${escapeHtml(t.kind_label || t.category || '')}${t.tools ? ` · ${escapeHtml(t.tools)}` : ''}</div>
    </div>
  `).join('');
}

async function runBriefing() {
  const day = workDay();
  updateBriefingDayLabel(day);
  const root = document.getElementById('briefing-out');
  const details = document.querySelector('.briefing-usage-details');
  if (details) details.open = true;
  root.innerHTML = '';
  root.appendChild(row('<div class="meta">Loading usage briefing…</div>'));
  try {
    const data = await fetch('/api/briefing/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day }),
    }).then((r) => r.json());
    root.innerHTML = '';
    root.appendChild(row(`<div><strong>Usage briefing for ${escapeHtml(data.day)}</strong></div><div class="meta">${escapeHtml(data.disclaimer || '')}</div>`));
    for (const f of data.facts || []) root.appendChild(row(`<div>${escapeHtml(f)}</div>`));
    if (data.estimates?.length) {
      root.appendChild(row(`<div class="meta"><strong>Estimates:</strong> ${data.estimates.map(escapeHtml).join(' ')}</div>`));
    }
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(row(`<div class="meta">Briefing failed: ${escapeHtml(err.message || err)}</div>`));
  }
}

async function loadWorkTimeline({ rebuild = false, report = null } = {}) {
  const day = workDay();
  updateBriefingDayLabel(day);
  const root = document.getElementById('work-timeline');
  if (!root) return;
  root.innerHTML = '<div class="briefing-empty">Loading work activities…</div>';
  setWorkMsg('');
  try {
    let sessions;
    if (report) {
      sessions = [
        ...(report.identified_tasks || report.main_tasks || []).map((t) => ({ ...t, evidence: t.evidence || [] })),
      ];
      // Prefer full session rows for actions when available
      const listed = await fetch(`/api/work/sessions?day=${encodeURIComponent(day)}`).then((r) => r.json());
      const byId = Object.fromEntries((listed.sessions || []).map((s) => [s.id, s]));
      sessions = (report.identified_tasks || report.main_tasks || []).map((t) => byId[t.id] || t);
      renderUnidentifiedSection(listed.sessions || [], day, report.unidentified_activity);
    } else {
      const url = rebuild
        ? '/api/work/rebuild'
        : `/api/work/sessions?day=${encodeURIComponent(day)}`;
      const data = rebuild
        ? await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day }),
        }).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          return j;
        })
        : await fetch(url).then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          return j;
        });
      const all = data.sessions || [];
      sessions = all.filter((s) => s.category !== 'uncertain');
      renderUnidentifiedSection(all, day, {
        count: all.filter((s) => s.category === 'uncertain').length,
        estimated_seconds: all.filter((s) => s.category === 'uncertain')
          .reduce((a, s) => a + Number(s.estimated_seconds || 0), 0),
        sessions: all.filter((s) => s.category === 'uncertain'),
      });
    }
    root.innerHTML = '';
    if (!sessions.length) {
      root.innerHTML = '<div class="briefing-empty">No identified tasks yet. Keep the Chrome extension connected and allow Screen Recording for window titles.</div>';
      setWorkMsg(`No identified tasks for ${day}.`);
      return;
    }
    sessions.forEach((s, idx) => {
      root.appendChild(buildWorkCardElement(s, day, sessions, idx));
    });
    setWorkMsg(`${sessions.length} identified task${sessions.length === 1 ? '' : 's'} for ${day}.`);
  } catch (err) {
    root.innerHTML = `<div class="briefing-empty">Could not load activities: ${escapeHtml(err.message || err)}</div>`;
    setWorkMsg(String(err.message || err), true);
  }
}

async function runWorkReport() {
  const day = workDay();
  updateBriefingDayLabel(day);
  await refreshBriefingHealthBanner();
  const root = document.getElementById('work-report-out');
  root.innerHTML = '<div class="briefing-empty">Generating work report…</div>';
  setWorkMsg('Generating work report…');
  try {
    const data = await fetch('/api/work/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, rebuild: true }),
    }).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || body.message || `HTTP ${r.status}`);
      return body;
    });
    const identifiedCount = (data.identified_tasks || data.main_tasks || []).length;
    renderBriefingMetrics(data.time || {}, identifiedCount);
    renderWorkSummary(data);
    renderChronoTimeline(data.timeline || data.timeline_all || []);
    await loadWorkTimeline({ report: data });
    setWorkMsg(`Work report ready for ${data.day}.`);
  } catch (err) {
    root.innerHTML = `<div class="briefing-empty">Work report failed: ${escapeHtml(err.message || err)}</div>`;
    setWorkMsg(String(err.message || err), true);
  }
}

async function loadTasks() {
  const data = await fetch('/api/tasks').then((r) => r.json());
  const root = document.getElementById('task-list');
  root.innerHTML = '';
  for (const t of data.tasks || []) {
    const div = row(
      `<div><strong>${escapeHtml(t.title)}</strong> <span class="muted tiny">${escapeHtml(t.status)}${t.confirmed ? '' : ' · suggestion'}</span></div>
       <div class="meta">${escapeHtml(t.details || '')}</div>`
    );
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (!t.confirmed) {
      const accept = document.createElement('button');
      accept.className = 'btn btn-primary';
      accept.textContent = 'Confirm';
      accept.onclick = async () => {
        await fetch(`/api/tasks/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, source: 'user' }) });
        await loadTasks();
      };
      actions.appendChild(accept);
    }
    const done = document.createElement('button');
    done.className = 'btn';
    done.textContent = t.status === 'done' ? 'Reopen' : 'Done';
    done.onclick = async () => {
      await fetch(`/api/tasks/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: t.status === 'done' ? 'open' : 'done' }) });
      await loadTasks();
    };
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.onclick = async () => {
      await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' });
      await loadTasks();
    };
    actions.appendChild(done);
    actions.appendChild(del);
    div.appendChild(actions);
    root.appendChild(div);
  }
  if (!(data.tasks || []).length) root.appendChild(row('<div class="meta">No tasks yet.</div>'));
}

async function loadMemories() {
  const [mems, projs] = await Promise.all([
    fetch('/api/memories').then((r) => r.json()),
    fetch('/api/projects').then((r) => r.json()),
  ]);
  const ml = document.getElementById('mem-list');
  const pl = document.getElementById('proj-list');
  ml.innerHTML = '<div class="muted tiny">Memories</div>';
  pl.innerHTML = '<div class="muted tiny">Projects</div>';
  for (const m of mems.memories || []) {
    const div = row(`<div><strong>${escapeHtml(m.title)}</strong></div><div class="meta">${escapeHtml(m.body)}</div>`);
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.onclick = async () => { await fetch(`/api/memories/${m.id}`, { method: 'DELETE' }); await loadMemories(); };
    div.appendChild(del);
    ml.appendChild(div);
  }
  for (const p of projs.projects || []) {
    const div = row(`<div><strong>${escapeHtml(p.name)}</strong></div><div class="meta">${escapeHtml(p.notes || '')}</div>`);
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.onclick = async () => { await fetch(`/api/projects/${p.id}`, { method: 'DELETE' }); await loadMemories(); };
    div.appendChild(del);
    pl.appendChild(div);
  }
}

async function loadSettings() {
  const s = await fetch('/api/settings').then((r) => r.json());
  document.getElementById('ai-consent').checked = !!s.aiConsent;
  document.getElementById('ai-enabled').checked = !!s.aiSummariesEnabled;
  document.getElementById('ai-enabled').disabled = !s.aiConsent;
  document.getElementById('excluded-domains').value = (s.excludedDomains || []).join(', ');
  document.getElementById('excluded-bundles').value = (s.excludedBundleIdentifiers || []).join(', ');
  document.getElementById('btn-pause').textContent = s.pauseTracking ? 'Resume tracking flag' : 'Pause tracking flag';
  return s;
}

async function refreshAll() {
  await Promise.all([loadAnalytics(), loadStatusAndLists()]);
  const active = document.querySelector('.nav-item.active')?.dataset?.view;
  if (active === 'manager') await loadManager().catch(console.error);
}

function fmtTs(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusBadge(status) {
  const label = String(status || 'unknown').replace(/_/g, ' ');
  return `<span class="status-badge ${escapeHtml(status || 'unknown')}">${escapeHtml(label)}</span>`;
}

function showManagerError(msg) {
  const el = document.getElementById('manager-error');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function loadManager() {
  const loading = document.getElementById('manager-loading');
  const empty = document.getElementById('manager-empty');
  const tbody = document.getElementById('manager-tbody');
  loading?.classList.remove('hidden');
  showManagerError('');
  try {
    const q = document.getElementById('mgr-q')?.value?.trim() || '';
    const status = document.getElementById('mgr-status')?.value || '';
    const sort = document.getElementById('mgr-sort')?.value || 'last_check_in_at';
    const params = new URLSearchParams({
      from: state.from,
      to: state.to,
      sort,
      order: 'desc',
    });
    if (q) params.set('q', q);
    if (status) params.set('status', status);

    const [summaryRes, listRes] = await Promise.all([
      fetch(`/api/manager/summary?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`),
      fetch(`/api/manager/devices?${params}`),
    ]);
    if (!summaryRes.ok || !listRes.ok) {
      const errBody = await (summaryRes.ok ? listRes : summaryRes).json().catch(() => ({}));
      throw new Error(errBody.message || `Manager API failed (${summaryRes.status}/${listRes.status})`);
    }
    const summary = await summaryRes.json();
    const list = await listRes.json();
    state.managerDevices = list.devices || [];

    document.getElementById('mgr-total').textContent = String(summary.counts?.total_enrolled ?? 0);
    document.getElementById('mgr-online').textContent = String(summary.counts?.online ?? 0);
    document.getElementById('mgr-activity-stale').textContent = String(summary.counts?.activity_stale ?? 0);
    const attention = (summary.counts?.needs_attention || 0)
      + (summary.counts?.offline || 0)
      + (summary.counts?.stale_checkin || 0);
    document.getElementById('mgr-attention').textContent = String(attention);

    const th = summary.thresholds || list.thresholds || {};
    document.getElementById('manager-threshold-note').textContent =
      `Online ≤ ${Math.round((th.online_checkin_seconds || 300) / 60)}m check-in · `
      + `Activity stale > ${Math.round((th.activity_stale_seconds || 900) / 60)}m · `
      + `Offline > ${Math.round((th.offline_checkin_seconds || 1800) / 60)}m. Idle ≠ offline.`;

    tbody.innerHTML = '';
    if (!state.managerDevices.length) {
      empty?.classList.remove('hidden');
    } else {
      empty?.classList.add('hidden');
      for (const d of state.managerDevices) {
        const tr = document.createElement('tr');
        tr.dataset.deviceId = d.id;
        tr.innerHTML = `
          <td><strong>${escapeHtml(d.display_name || d.id)}</strong><div class="muted tiny mono">${escapeHtml(d.id.slice(0, 8))}…</div></td>
          <td>${escapeHtml([d.os, d.os_version].filter(Boolean).join(' ') || '—')}</td>
          <td>${escapeHtml(d.employee_display_name || '—')}</td>
          <td>${statusBadge(d.status)}</td>
          <td>${escapeHtml(fmtTs(d.last_check_in_at))}</td>
          <td>${escapeHtml(fmtTs(d.last_mac_event_at))}</td>
          <td>${escapeHtml(fmtTs(d.last_chrome_event_at))}</td>
          <td>${escapeHtml(formatDuration(d.tracked_seconds_in_range || 0))}</td>
        `;
        tr.addEventListener('click', () => openManagerDetail(d.id).catch(console.error));
        tbody.appendChild(tr);
      }
    }
  } catch (err) {
    showManagerError(err.message || String(err));
    tbody.innerHTML = '';
    empty?.classList.add('hidden');
  } finally {
    loading?.classList.add('hidden');
  }
}

async function openManagerDetail(deviceId) {
  state.managerSelectedId = deviceId;
  document.getElementById('manager-list-card')?.classList.add('hidden');
  document.getElementById('manager-summary-cards')?.classList.add('hidden');
  const card = document.getElementById('manager-detail-card');
  card?.classList.remove('hidden');
  document.getElementById('manager-detail-title').textContent = 'Loading device…';
  showManagerError('');
  try {
    const params = new URLSearchParams({ from: state.from, to: state.to, limit: '40' });
    const res = await fetch(`/api/manager/devices/${encodeURIComponent(deviceId)}?${params}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Detail failed (${res.status})`);
    }
    const data = await res.json();
    const d = data.device;
    document.getElementById('manager-detail-title').textContent = d.display_name || d.id;
    document.getElementById('manager-detail-meta').innerHTML = `
      ${statusBadge(d.status)} · ${escapeHtml(d.enrollment_status)} · ${escapeHtml(d.os || 'OS unknown')}
      ${d.employee_display_name ? ` · Employee: ${escapeHtml(d.employee_display_name)}` : ''}
      <br/>Check-in: ${escapeHtml(fmtTs(d.last_check_in_at))} · Mac: ${escapeHtml(fmtTs(d.last_mac_event_at))} · Chrome: ${escapeHtml(fmtTs(d.last_chrome_event_at))}
      <br/>Tracked in range: ${escapeHtml(formatDuration(d.tracked_seconds_in_range || 0))}
      ${(d.status_reasons || []).length ? `<br/>${escapeHtml((d.status_reasons || []).join(' · '))}` : ''}
    `;

    const appsEl = document.getElementById('manager-detail-apps');
    appsEl.innerHTML = (data.applications || []).length
      ? data.applications.map((a) => `<div class="row"><div>${escapeHtml(a.name)}</div><div class="meta">${escapeHtml(formatDuration(a.seconds))}</div></div>`).join('')
      : '<div class="muted tiny">No app sessions in this range for this device.</div>';

    const sitesEl = document.getElementById('manager-detail-sites');
    sitesEl.innerHTML = (data.websites || []).length
      ? data.websites.map((s) => `<div class="row"><div>${escapeHtml(s.name)}</div><div class="meta">${escapeHtml(formatDuration(s.seconds))}</div></div>`).join('')
      : '<div class="muted tiny">No website sessions in this range for this device.</div>';

    const evEl = document.getElementById('manager-detail-events');
    evEl.innerHTML = (data.events || []).length
      ? data.events.map((e) => `<div class="row"><div>${escapeHtml(e.type)} · ${escapeHtml(e.app_name || e.source || '')}</div><div class="meta">${escapeHtml(e.timestamp)}</div></div>`).join('')
      : '<div class="muted tiny">No events in this range.</div>';

    const issues = [
      ...(data.gaps || []).map((g) => ({ kind: 'gap', ...g })),
      ...(data.errors || []).map((e) => ({ kind: 'error', ...e })),
    ];
    const issueEl = document.getElementById('manager-detail-issues');
    issueEl.innerHTML = issues.length
      ? issues.map((i) => `<div class="row"><div>${escapeHtml(i.kind)} · ${escapeHtml(i.type || i.metadata?.reason || '')}</div><div class="meta">${escapeHtml(i.timestamp)}</div></div>`).join('')
      : '<div class="muted tiny">No gaps or failures in this range.</div>';
  } catch (err) {
    showManagerError(err.message || String(err));
  }
}

function closeManagerDetail() {
  state.managerSelectedId = null;
  document.getElementById('manager-detail-card')?.classList.add('hidden');
  document.getElementById('manager-list-card')?.classList.remove('hidden');
  document.getElementById('manager-summary-cards')?.classList.remove('hidden');
}

function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.id === `view-${name}`);
  });
  document.getElementById('view-title').textContent = VIEW_TITLES[name] || name;
  // Charts in hidden tabs need resize after show
  requestAnimationFrame(() => {
    Object.values(state.charts).forEach((c) => c.resize());
  });
  if (name === 'tasks') loadTasks().catch(console.error);
  if (name === 'memories') loadMemories().catch(console.error);
  if (name === 'briefing') {
    updateBriefingDayLabel(workDay());
    const metrics = document.getElementById('briefing-metrics');
    if (metrics && !metrics.children.length) {
      renderBriefingMetrics({}, 0);
    }
    // Auto-generate daily work understanding when opening the page
    runWorkReport().catch(console.error);
  }
  if (name === 'manager') {
    closeManagerDetail();
    loadManager().catch(console.error);
  }
}

// Wire UI
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.querySelectorAll('.chip[data-range]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    setRangePreset(btn.dataset.range);
    if (btn.dataset.range !== 'custom') {
      await refreshAll().catch(console.error);
    }
  });
});
document.getElementById('btn-apply-custom').addEventListener('click', async () => {
  const fromDay = document.getElementById('from-date').value;
  const toDay = document.getElementById('to-date').value;
  if (!fromDay || !toDay) return;
  const from = new Date(`${fromDay}T00:00:00`);
  const to = new Date(`${toDay}T23:59:59.999`);
  state.from = from.toISOString();
  state.to = to.toISOString();
  state.rangeKey = 'custom';
  await refreshAll().catch(console.error);
});
document.getElementById('btn-refresh').addEventListener('click', () => refreshAll().catch(console.error));
document.getElementById('btn-apply').addEventListener('click', () => loadStatusAndLists().catch(console.error));
document.getElementById('btn-mgr-refresh')?.addEventListener('click', () => loadManager().catch(console.error));
document.getElementById('btn-mgr-back')?.addEventListener('click', () => {
  closeManagerDetail();
  loadManager().catch(console.error);
});
document.getElementById('mgr-q')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadManager().catch(console.error);
});
document.getElementById('mgr-status')?.addEventListener('change', () => loadManager().catch(console.error));
document.getElementById('mgr-sort')?.addEventListener('change', () => loadManager().catch(console.error));
document.getElementById('btn-search')?.addEventListener('click', () => runSearch().catch(console.error));
document.getElementById('search-q')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch().catch(console.error);
});
document.getElementById('btn-ask')?.addEventListener('click', () => runAsk().catch(console.error));
document.getElementById('ask-q')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runAsk().catch(console.error);
});
document.getElementById('btn-briefing')?.addEventListener('click', () => runBriefing().catch(console.error));
document.getElementById('btn-work-report')?.addEventListener('click', () => runWorkReport().catch(console.error));
document.getElementById('btn-work-rebuild')?.addEventListener('click', () => loadWorkTimeline({ rebuild: true }).catch(console.error));
document.getElementById('btn-work-note')?.addEventListener('click', async () => {
  const body = document.getElementById('work-note-body')?.value?.trim();
  if (!body) {
    setWorkMsg('Enter a note first.', true);
    return;
  }
  try {
    await fetch('/api/work/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: workDay(), body }),
    }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    });
    document.getElementById('work-note-body').value = '';
    setWorkMsg('Note saved.');
    await loadWorkTimeline();
  } catch (err) {
    setWorkMsg(String(err.message || err), true);
  }
});
document.getElementById('btn-task-add')?.addEventListener('click', async () => {
  const title = document.getElementById('task-title').value.trim();
  if (!title) return;
  await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  document.getElementById('task-title').value = '';
  await loadTasks();
});
document.getElementById('btn-task-suggest')?.addEventListener('click', async () => {
  const day = state.to.slice(0, 10);
  const data = await fetch('/api/tasks/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ day }) }).then((r) => r.json());
  const root = document.getElementById('task-suggestions');
  root.innerHTML = '<div class="muted tiny">Suggestions (not saved until you confirm)</div>';
  for (const s of data.suggestions || []) {
    const div = row(`<div><strong>${escapeHtml(s.title)}</strong></div><div class="meta">${escapeHtml(s.details)}</div>`);
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Save as unconfirmed suggestion';
    btn.onclick = async () => {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: s.title, details: s.details, source: 'ai_suggestion', confirmed: false }),
      });
      await loadTasks();
    };
    div.appendChild(btn);
    root.appendChild(div);
  }
});
document.getElementById('btn-mem-add')?.addEventListener('click', async () => {
  const title = document.getElementById('mem-title').value.trim();
  const body = document.getElementById('mem-body').value.trim();
  if (!title || !body) return;
  await fetch('/api/memories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }) });
  document.getElementById('mem-title').value = '';
  document.getElementById('mem-body').value = '';
  await loadMemories();
});
document.getElementById('btn-proj-add')?.addEventListener('click', async () => {
  const name = document.getElementById('proj-name').value.trim();
  if (!name) return;
  await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  document.getElementById('proj-name').value = '';
  await loadMemories();
});


function reportDayFromRange() {
  // Local calendar day of the selected range end (not raw UTC ISO slice).
  const d = new Date(state.to);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function setReportsMsg(text, isError = false) {
  const el = document.getElementById('reports-msg');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--danger, #c44)' : '';
}

async function downloadFromResponse(res, fallbackName) {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      msg = j.message || j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(cd);
  const raw = match ? (match[1] || match[2] || match[3] || '').trim() : '';
  const filename = raw ? decodeURIComponent(raw.replace(/['"]/g, '')) : fallbackName;
  const blob = await res.blob();
  if (!blob || blob.size === 0) throw new Error('Download was empty');
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return { filename, size: blob.size };
}

document.getElementById('btn-html').addEventListener('click', async () => {
  const day = reportDayFromRange();
  setReportsMsg(`Generating daily report for ${day}…`);
  try {
    const res = await fetch('/api/reports/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, download: true }),
    });
    const { filename, size } = await downloadFromResponse(res, `daily-report-${day}.html`);
    setReportsMsg(`Downloaded ${filename} (${size} bytes).`);
  } catch (err) {
    setReportsMsg(`HTML report failed: ${err.message || err}`, true);
  }
});

document.getElementById('btn-backup').addEventListener('click', async () => {
  setReportsMsg('Creating database backup…');
  try {
    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ download: true }),
    });
    const { filename, size } = await downloadFromResponse(res, 'tracker-backup.db');
    setReportsMsg(`Downloaded ${filename} (${size} bytes). Tracking was not stopped.`);
  } catch (err) {
    setReportsMsg(`Backup failed: ${err.message || err}`, true);
  }
});
document.getElementById('ai-consent').addEventListener('change', (e) => {
  document.getElementById('ai-enabled').disabled = !e.target.checked;
  if (!e.target.checked) document.getElementById('ai-enabled').checked = false;
});
document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const body = {
    aiConsent: document.getElementById('ai-consent').checked,
    aiSummariesEnabled: document.getElementById('ai-enabled').checked,
    excludedDomains: document.getElementById('excluded-domains').value.split(',').map((s) => s.trim()).filter(Boolean),
    excludedBundleIdentifiers: document.getElementById('excluded-bundles').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  document.getElementById('settings-msg').textContent = 'Settings saved. AI summaries stay local-only and off unless both boxes are checked.';
  await loadSettings();
});
document.getElementById('btn-pause').addEventListener('click', async () => {
  const s = await loadSettings();
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pauseTracking: !s.pauseTracking }),
  });
  await loadSettings();
  document.getElementById('settings-msg').textContent =
    'Pause flag saved. Also use the mac-agent "pause" command and the Chrome popup to fully pause collectors.';
});

// Boot
setRangePreset('today');
const today = localDayBounds();
document.getElementById('from-date').value = today.labelDay;
document.getElementById('to-date').value = today.labelDay;

loadSettings()
  .then(refreshAll)
  .catch((err) => {
    document.getElementById('range-label').textContent = `Failed to load: ${err.message}. Is the server running?`;
  });

setInterval(() => refreshAll().catch(() => {}), 15000);
