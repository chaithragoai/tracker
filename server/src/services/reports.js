import fs from 'node:fs';
import path from 'node:path';
import { refreshDailySummary } from './events.js';
import { formatDuration } from './analytics.js';

export function generateDailyHtmlReport(db, day, outDir) {
  refreshDailySummary(db, day);
  const summary = db.prepare('SELECT * FROM daily_summaries WHERE day = ?').get(day) || {
    day,
    active_seconds: 0,
    idle_seconds: 0,
    app_breakdown_json: '{}',
    domain_breakdown_json: '{}',
    operation_count: 0,
    error_count: 0,
    gap_seconds: 0,
  };

  const apps = JSON.parse(summary.app_breakdown_json || '{}');
  const domains = JSON.parse(summary.domain_breakdown_json || '{}');
  const ops = db.prepare(`
    SELECT timestamp, type, outcome, app_name, metadata_json
    FROM events
    WHERE substr(timestamp, 1, 10) = ?
      AND type IN ('click','search','formSubmit','navigation','download','upload','operation')
    ORDER BY timestamp ASC
    LIMIT 500
  `).all(day);
  const errors = db.prepare(`
    SELECT timestamp, type, outcome, metadata_json FROM events
    WHERE substr(timestamp, 1, 10) = ? AND (type = 'error' OR outcome = 'failure')
    ORDER BY timestamp ASC LIMIT 200
  `).all(day);
  const gaps = db.prepare(`
    SELECT * FROM tracking_gaps WHERE substr(started_at, 1, 10) = ? ORDER BY started_at
  `).all(day);

  const appRows = Object.entries(apps)
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([k, v]) => `<tr><td>${esc(v.name || k)}</td><td>${fmtMin(v.seconds)}</td></tr>`)
    .join('') || '<tr><td colspan="2">No app usage</td></tr>';

  const domainRows = Object.entries(domains)
    .sort((a, b) => b[1] - a[1])
    .map(([k, sec]) => `<tr><td>${esc(k)}</td><td>${fmtMin(sec)}</td></tr>`)
    .join('') || '<tr><td colspan="2">No website usage</td></tr>';

  const opRows = ops.map((o) => {
    let semantic = '';
    try { semantic = JSON.parse(o.metadata_json || '{}').semantic || ''; } catch { /* ignore */ }
    return `<tr><td>${esc(o.timestamp)}</td><td>${esc(o.type)}</td><td>${esc(o.outcome)}</td><td>${esc(semantic)}</td></tr>`;
  }).join('') || '<tr><td colspan="4">No operations</td></tr>';

  const errRows = errors.map((e) =>
    `<tr><td>${esc(e.timestamp)}</td><td>${esc(e.type)}</td><td>${esc(e.outcome)}</td></tr>`
  ).join('') || '<tr><td colspan="3">No errors</td></tr>';

  const gapRows = gaps.map((g) =>
    `<tr><td>${esc(g.started_at)}</td><td>${esc(g.ended_at)}</td><td>${fmtMin(g.duration_seconds)}</td><td>${esc(g.reason)}</td></tr>`
  ).join('') || '<tr><td colspan="4">No gaps</td></tr>';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Daily report ${esc(day)}</title>
<style>
  body{font-family:IBM Plex Sans,Segoe UI,sans-serif;margin:2rem;color:#142033;background:#f6f8fb}
  h1{margin-bottom:.25rem} .muted{color:#667}
  table{border-collapse:collapse;width:100%;margin:1rem 0;background:#fff}
  th,td{border:1px solid #d7dee8;padding:.5rem .65rem;text-align:left}
  th{background:#eef3f9}
  .cards{display:flex;gap:1rem;flex-wrap:wrap}
  .card{background:#fff;border:1px solid #d7dee8;padding:1rem 1.25rem;min-width:140px}
</style></head><body>
  <h1>Mac Activity Tracker — Daily report</h1>
  <p class="muted">${esc(day)} · generated ${esc(new Date().toISOString())}</p>
  <div class="cards">
    <div class="card"><strong>${fmtMin(summary.active_seconds)}</strong><div class="muted">Active</div></div>
    <div class="card"><strong>${fmtMin(summary.idle_seconds)}</strong><div class="muted">Idle</div></div>
    <div class="card"><strong>${fmtMin(summary.gap_seconds)}</strong><div class="muted">Gaps</div></div>
    <div class="card"><strong>${summary.operation_count || 0}</strong><div class="muted">Operations</div></div>
    <div class="card"><strong>${summary.error_count || 0}</strong><div class="muted">Errors</div></div>
  </div>
  <h2>Time by application</h2>
  <table><thead><tr><th>App</th><th>Duration</th></tr></thead><tbody>${appRows}</tbody></table>
  <h2>Time by website</h2>
  <table><thead><tr><th>Domain</th><th>Duration</th></tr></thead><tbody>${domainRows}</tbody></table>
  <h2>Significant operations</h2>
  <table><thead><tr><th>Time</th><th>Type</th><th>Outcome</th><th>Semantic</th></tr></thead><tbody>${opRows}</tbody></table>
  <h2>Errors</h2>
  <table><thead><tr><th>Time</th><th>Type</th><th>Outcome</th></tr></thead><tbody>${errRows}</tbody></table>
  <h2>Tracking gaps</h2>
  <table><thead><tr><th>Start</th><th>End</th><th>Minutes</th><th>Reason</th></tr></thead><tbody>${gapRows}</tbody></table>
</body></html>`;

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `daily-${day}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return { file, html, day, filename: `daily-report-${day}.html` };
}

export function generateWeeklySummary(db, endDay) {
  const end = new Date(`${endDay}T00:00:00.000Z`);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    refreshDailySummary(db, day);
    days.push(db.prepare('SELECT * FROM daily_summaries WHERE day = ?').get(day) || {
      day, active_seconds: 0, idle_seconds: 0, operation_count: 0, error_count: 0, gap_seconds: 0,
      app_breakdown_json: '{}', domain_breakdown_json: '{}',
    });
  }
  const totals = days.reduce((acc, d) => {
    acc.active += d.active_seconds || 0;
    acc.idle += d.idle_seconds || 0;
    acc.ops += d.operation_count || 0;
    acc.errors += d.error_count || 0;
    acc.gaps += d.gap_seconds || 0;
    return acc;
  }, { active: 0, idle: 0, ops: 0, errors: 0, gaps: 0 });
  return { endDay, days, totals };
}

function fmtMin(seconds) {
  return formatDuration(seconds);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
