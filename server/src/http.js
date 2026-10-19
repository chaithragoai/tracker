import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertEvent, queryEvents, getStatus, exportEventsCsv, refreshDailySummary, getTrackingHealth } from './services/events.js';
import { generateDailyHtmlReport, generateWeeklySummary } from './services/reports.js';
import { maybeSummarize } from './services/aiSummary.js';
import { getAnalytics } from './services/analytics.js';
import { searchActivity } from './services/search.js';
import { buildDailyBriefing, getDailyBriefing } from './services/briefing.js';
import { askAssistant } from './services/assistant.js';
import { listTasks, createTask, updateTask, deleteTask, suggestTasksFromActivity } from './services/tasks.js';
import { listMemories, createMemory, updateMemory, deleteMemory, listProjects, createProject, deleteProject } from './services/memories.js';
import {
  rebuildWorkSessions,
  listWorkSessions,
  getWorkSession,
  updateWorkSession,
  addWorkNote,
  mergeWorkSessions,
  splitWorkSession,
  buildDailyWorkReport,
} from './services/workUnderstanding.js';
import {
  authenticateDevice,
  createEnrollmentToken,
  enrollDevice,
  revokeDevice,
  listDevices,
  getDevicePublic,
  readLocalCredentialsFile,
  touchDeviceCheckIn,
} from './services/devices.js';
import { adminAuthorized, allowLocalCredentialRead } from './config.js';
import { getManagerSummary, listManagerDevices, getManagerDeviceDetail, getStatusThresholds } from './services/manager.js';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(__dirname, '../public');

export function createServer(db, { port = 8787 } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      await route(db, req, res);
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: 'internal_error', message: String(err.message || err) });
    }
  });
  return {
    server,
    start() {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          console.log(`Mac Activity Tracker server listening on http://127.0.0.1:${port}`);
          resolve(server);
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function route(db, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/events') {
    let auth;
    try {
      auth = authenticateDevice(db, req);
    } catch (err) {
      sendJson(res, err.status || 401, { error: err.code || 'unauthorized', message: err.message });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: 'invalid_json', message: 'Request body must be JSON' });
      return;
    }
    const events = Array.isArray(body) ? body : [body];
    if (!events.length) {
      sendJson(res, 400, { error: 'empty_payload', message: 'No events provided' });
      return;
    }
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || !ev.type) {
        sendJson(res, 400, { error: 'invalid_event', message: 'Each event requires a type' });
        return;
      }
    }
    const results = [];
    const tx = db.transaction((list) => {
      for (const ev of list) {
        // Strip any client-claimed device identity before insert.
        const { device_id: _d1, deviceId: _d2, ...safe } = ev;
        results.push(insertEvent(db, safe, safe.source || guessSource(safe), { deviceId: auth.deviceId }));
      }
    });
    try {
      tx(events);
    } catch (err) {
      sendJson(res, 400, { error: 'ingest_failed', message: String(err.message || err) });
      return;
    }
    sendJson(res, 200, { ok: true, device_id: auth.deviceId, results });
    return;
  }

  // --- Device enrollment (Phase 2) ---

  if (req.method === 'POST' && pathname === '/api/admin/enrollment-tokens') {
    if (!adminAuthorized(req)) {
      sendJson(res, 403, { error: 'admin_forbidden', message: 'Admin token required (or TRACKER_MODE=local)' });
      return;
    }
    const body = await readJson(req).catch(() => ({}));
    const token = createEnrollmentToken(db, {
      displayNameHint: body.display_name_hint || body.displayName || null,
      ttlSeconds: Number(body.ttl_seconds || body.ttlSeconds || 3600),
      maxUses: Number(body.max_uses || body.maxUses || 1),
      actor: 'admin_api',
    });
    sendJson(res, 201, {
      ok: true,
      ...token,
      note: 'Store enrollment_token securely. It is shown once and only a hash is retained.',
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/devices/enroll') {
    const body = await readJson(req).catch(() => ({}));
    try {
      const enrolled = enrollDevice(db, {
        enrollmentToken: body.enrollment_token || body.enrollmentToken,
        displayName: body.display_name || body.displayName,
        osName: body.os || body.osName || null,
        osVersion: body.os_version || body.osVersion || null,
        agentVersion: body.agent_version || body.agentVersion || null,
      });
      sendJson(res, 201, {
        ok: true,
        ...enrolled,
        note: 'Store device_secret securely. It is shown once; only a hash is retained server-side.',
      });
    } catch (err) {
      sendJson(res, err.status || 400, { error: err.code || 'enroll_failed', message: err.message });
    }
    return;
  }

  {
    const revokeMatch = pathname.match(/^\/api\/admin\/devices\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      if (!adminAuthorized(req)) {
        sendJson(res, 403, { error: 'admin_forbidden', message: 'Admin token required (or TRACKER_MODE=local)' });
        return;
      }
      try {
        const result = revokeDevice(db, revokeMatch[1], { actor: 'admin_api' });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.code || 'revoke_failed', message: err.message });
      }
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/admin/devices') {
    if (!adminAuthorized(req)) {
      sendJson(res, 403, { error: 'admin_forbidden', message: 'Admin token required (or TRACKER_MODE=local)' });
      return;
    }
    sendJson(res, 200, { devices: listDevices(db) });
    return;
  }

  {
    const getMatch = pathname.match(/^\/api\/admin\/devices\/([^/]+)$/);
    if (req.method === 'GET' && getMatch) {
      if (!adminAuthorized(req)) {
        sendJson(res, 403, { error: 'admin_forbidden', message: 'Admin token required (or TRACKER_MODE=local)' });
        return;
      }
      const device = getDevicePublic(db, getMatch[1]);
      if (!device) {
        sendJson(res, 404, { error: 'device_not_found' });
        return;
      }
      sendJson(res, 200, { device });
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/devices/check-in') {
    let auth;
    try {
      auth = authenticateDevice(db, req);
    } catch (err) {
      sendJson(res, err.status || 401, { error: err.code || 'unauthorized', message: err.message });
      return;
    }
    // Heartbeat only — does not invent app/site activity timestamps.
    const body = await readJson(req).catch(() => ({}));
    touchDeviceCheckIn(db, auth.deviceId, { source: null });
    sendJson(res, 200, {
      ok: true,
      device_id: auth.deviceId,
      checked_in_at: new Date().toISOString(),
      client: body.client || null,
    });
    return;
  }

  // --- Manager dashboard (Phase 3): same gate as admin for now; full RBAC in Phase 4 ---

  if (req.method === 'GET' && pathname === '/api/manager/thresholds') {
    if (!adminAuthorized(req)) {
      sendJson(res, 403, { error: 'manager_forbidden', message: 'Manager authorization required' });
      return;
    }
    sendJson(res, 200, { thresholds: getStatusThresholds() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/manager/summary') {
    if (!adminAuthorized(req)) {
      sendJson(res, 403, { error: 'manager_forbidden', message: 'Manager authorization required' });
      return;
    }
    sendJson(res, 200, getManagerSummary(db, {
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
    }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/manager/devices') {
    if (!adminAuthorized(req)) {
      sendJson(res, 403, { error: 'manager_forbidden', message: 'Manager authorization required' });
      return;
    }
    sendJson(res, 200, listManagerDevices(db, {
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || '',
      sort: url.searchParams.get('sort') || 'last_check_in_at',
      order: url.searchParams.get('order') || 'desc',
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
    }));
    return;
  }

  {
    const detailMatch = pathname.match(/^\/api\/manager\/devices\/([^/]+)$/);
    if (req.method === 'GET' && detailMatch) {
      if (!adminAuthorized(req)) {
        sendJson(res, 403, { error: 'manager_forbidden', message: 'Manager authorization required' });
        return;
      }
      try {
        const detail = getManagerDeviceDetail(db, detailMatch[1], {
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
          eventLimit: Number(url.searchParams.get('limit') || 50),
        });
        sendJson(res, 200, detail);
      } catch (err) {
        sendJson(res, err.status || 400, { error: err.code || 'detail_failed', message: err.message });
      }
      return;
    }
  }

  /** Local-only: agent/extension may load credentials written by enroll/auto-provision. Never includes hashes. */
  if (req.method === 'GET' && pathname === '/api/local/device-config') {
    if (!allowLocalCredentialRead()) {
      sendJson(res, 403, { error: 'local_config_disabled', message: 'Local credential read disabled' });
      return;
    }
    const creds = readLocalCredentialsFile();
    if (!creds) {
      sendJson(res, 404, {
        error: 'no_local_credentials',
        message: 'Run scripts/enroll-local-device.sh or start server once in TRACKER_MODE=local',
      });
      return;
    }
    const device = getDevicePublic(db, creds.device_id);
    if (!device || device.enrollment_status !== 'active') {
      sendJson(res, 403, { error: 'device_inactive', message: 'Local credentials refer to a revoked or missing device' });
      return;
    }
    sendJson(res, 200, {
      device_id: creds.device_id,
      device_secret: creds.device_secret,
      display_name: creds.display_name || device.display_name,
      server_url: creds.server_url || 'http://127.0.0.1:8787',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, getStatus(db));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/tracking/health') {
    sendJson(res, 200, getTrackingHealth(db));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    const rows = queryEvents(db, {
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
      type: url.searchParams.get('type') || undefined,
      bundle: url.searchParams.get('bundle') || undefined,
      q: url.searchParams.get('q') || undefined,
      limit: url.searchParams.get('limit') || 200,
    });
    sendJson(res, 200, { events: rows });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions/apps') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const clauses = [];
    const params = {};
    if (from) { clauses.push('started_at >= @from'); params.from = from; }
    if (to) { clauses.push('started_at <= @to'); params.to = to; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM app_sessions ${where} ORDER BY started_at DESC LIMIT 500`).all(params);
    sendJson(res, 200, { sessions: rows });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions/tabs') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const clauses = [];
    const params = {};
    if (from) { clauses.push('started_at >= @from'); params.from = from; }
    if (to) { clauses.push('started_at <= @to'); params.to = to; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM tab_sessions ${where} ORDER BY started_at DESC LIMIT 500`).all(params);
    sendJson(res, 200, { sessions: rows });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/idle') {
    const rows = db.prepare('SELECT * FROM idle_periods ORDER BY started_at DESC LIMIT 200').all();
    sendJson(res, 200, { idle: rows });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/gaps') {
    const rows = db.prepare('SELECT * FROM tracking_gaps ORDER BY started_at DESC LIMIT 200').all();
    sendJson(res, 200, { gaps: rows });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/summary/daily') {
    const day = url.searchParams.get('day') || new Date().toISOString().slice(0, 10);
    refreshDailySummary(db, day);
    const row = db.prepare('SELECT * FROM daily_summaries WHERE day = ?').get(day);
    sendJson(res, 200, row || { day, active_seconds: 0 });
    return;
  }

  // Range analytics for dashboard charts (backward-compatible addition)
  if (req.method === 'GET' && pathname === '/api/analytics') {
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    try {
      const settings = loadSettings();
      sendJson(res, 200, getAnalytics(db, {
        from,
        to,
        excludedBundles: settings.excludedBundleIdentifiers || [],
      }));
    } catch (err) {
      if (String(err.message) === 'invalid_range') {
        sendJson(res, 400, { error: 'invalid_range' });
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/export/csv') {
    const csv = exportEventsCsv(db, {
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
    });
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="activity-export.csv"',
    });
    res.end(csv);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/reports/daily') {
    const body = await readJson(req);
    const day = sanitizeDay(body.day) || new Date().toISOString().slice(0, 10);
    const outDir = process.env.TRACKER_REPORTS_DIR
      || path.join(os.homedir(), 'Library/Application Support/MacActivityTracker/reports');
    const report = generateDailyHtmlReport(db, day, outDir);
    // Prefer browser download over returning a local filesystem path alone.
    const download = body.download !== false;
    if (download) {
      sendDownload(res, {
        filename: report.filename,
        contentType: 'text/html; charset=utf-8',
        body: report.html,
      });
      return;
    }
    sendJson(res, 200, { ok: true, file: report.file, day: report.day, filename: report.filename });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/summary/weekly') {
    const day = url.searchParams.get('day') || new Date().toISOString().slice(0, 10);
    sendJson(res, 200, generateWeeklySummary(db, day));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, loadSettings());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readJson(req);
    const next = saveSettings(body);
    sendJson(res, 200, next);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/backup') {
    const body = await readJson(req).catch(() => ({}));
    const destDir = process.env.TRACKER_BACKUPS_DIR
      || path.join(os.homedir(), 'Library/Application Support/MacActivityTracker/backups');
    fs.mkdirSync(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `tracker-backup-${stamp}.db`;
    const dest = path.join(destDir, filename);
    // Consistent online backup (safer than copying a live main DB file alone).
    await db.backup(dest);
    const download = body?.download !== false;
    if (download) {
      const buf = fs.readFileSync(dest);
      sendDownload(res, {
        filename,
        contentType: 'application/vnd.sqlite3',
        body: buf,
      });
      return;
    }
    sendJson(res, 200, { ok: true, file: dest, filename });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/summary/ai') {
    const day = url.searchParams.get('day') || new Date().toISOString().slice(0, 10);
    refreshDailySummary(db, day);
    const summary = db.prepare('SELECT * FROM daily_summaries WHERE day = ?').get(day) || { day };
    const weekly = generateWeeklySummary(db, day);
    sendJson(res, 200, maybeSummarize({ settings: loadSettings(), summary, weekly }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/search') {
    sendJson(res, 200, searchActivity(db, {
      q: url.searchParams.get('q') || '',
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
      type: url.searchParams.get('type') || undefined,
      source: url.searchParams.get('source') || undefined,
      limit: url.searchParams.get('limit') || 50,
    }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/briefing/daily') {
    const day = url.searchParams.get('day') || new Date().toISOString().slice(0, 10);
    const existing = url.searchParams.get('cached') === '1' ? getDailyBriefing(db, day) : null;
    sendJson(res, 200, existing || buildDailyBriefing(db, day));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/briefing/daily') {
    const body = await readJson(req);
    const day = body.day || new Date().toISOString().slice(0, 10);
    sendJson(res, 200, buildDailyBriefing(db, day));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/assistant/ask') {
    const body = await readJson(req);
    sendJson(res, 200, askAssistant(db, { question: body.question || body.q }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/work/sessions') {
    const day = url.searchParams.get('day') || new Date().toISOString().slice(0, 10);
    const rebuild = url.searchParams.get('rebuild') === '1';
    if (rebuild) {
      sendJson(res, 200, rebuildWorkSessions(db, day));
      return;
    }
    sendJson(res, 200, { day, sessions: listWorkSessions(db, day) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/work/rebuild') {
    const body = await readJson(req);
    const day = body.day || new Date().toISOString().slice(0, 10);
    sendJson(res, 200, rebuildWorkSessions(db, day));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/work/report') {
    const body = await readJson(req);
    const day = body.day || new Date().toISOString().slice(0, 10);
    sendJson(res, 200, buildDailyWorkReport(db, day, {
      rebuild: body.rebuild !== false,
      fromMs: body.from ? Date.parse(body.from) : null,
      toMs: body.to ? Date.parse(body.to) : null,
    }));
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/work/sessions/')) {
    const id = pathname.slice('/api/work/sessions/'.length);
    const row = getWorkSession(db, id);
    sendJson(res, row ? 200 : 404, row || { error: 'not_found' });
    return;
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/work/sessions/')) {
    const id = pathname.slice('/api/work/sessions/'.length);
    const body = await readJson(req);
    const row = updateWorkSession(db, id, body);
    sendJson(res, row ? 200 : 404, row || { error: 'not_found' });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/work/notes') {
    const body = await readJson(req);
    try {
      sendJson(res, 200, addWorkNote(db, {
        day: body.day,
        body: body.body || body.note,
        workSessionId: body.work_session_id || body.workSessionId || null,
      }));
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'invalid_note' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/work/merge') {
    const body = await readJson(req);
    try {
      sendJson(res, 200, mergeWorkSessions(db, body.ids || []));
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'merge_failed' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/work/split') {
    const body = await readJson(req);
    try {
      const result = splitWorkSession(db, body.id, body.at);
      sendJson(res, result ? 200 : 404, result || { error: 'not_found' });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'split_failed' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/tasks') {
    sendJson(res, 200, {
      tasks: listTasks(db, {
        status: url.searchParams.get('status') || undefined,
        confirmed: url.searchParams.has('confirmed')
          ? url.searchParams.get('confirmed') === '1'
          : undefined,
      }),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/tasks') {
    const body = await readJson(req);
    sendJson(res, 200, createTask(db, body));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/tasks/suggest') {
    const body = await readJson(req);
    const day = body.day || new Date().toISOString().slice(0, 10);
    sendJson(res, 200, { suggestions: suggestTasksFromActivity(db, day) });
    return;
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/tasks/')) {
    const id = pathname.slice('/api/tasks/'.length);
    const body = await readJson(req);
    const row = updateTask(db, id, body);
    sendJson(res, row ? 200 : 404, row || { error: 'not_found' });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/tasks/')) {
    const id = pathname.slice('/api/tasks/'.length);
    sendJson(res, 200, { ok: deleteTask(db, id) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/memories') {
    sendJson(res, 200, { memories: listMemories(db) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/memories') {
    const body = await readJson(req);
    sendJson(res, 200, createMemory(db, body));
    return;
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/memories/')) {
    const id = pathname.slice('/api/memories/'.length);
    const body = await readJson(req);
    const row = updateMemory(db, id, body);
    sendJson(res, row ? 200 : 404, row || { error: 'not_found' });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/memories/')) {
    const id = pathname.slice('/api/memories/'.length);
    sendJson(res, 200, { ok: deleteMemory(db, id) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: listProjects(db) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/projects') {
    const body = await readJson(req);
    sendJson(res, 200, createProject(db, body));
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/projects/')) {
    const id = pathname.slice('/api/projects/'.length);
    sendJson(res, 200, { ok: deleteProject(db, id) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/export/json') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const events = queryEvents(db, { from, to, limit: 5000 });
    const payload = {
      exported_at: new Date().toISOString(),
      from,
      to,
      events,
      note: 'Local export of recorded events metadata only.',
    };
    const data = JSON.stringify(payload, null, 2);
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="activity-export.json"',
    });
    res.end(data);
    return;
  }

  // Static dashboard
  if (req.method === 'GET') {
    const filePath = staticPath(pathname);
    if (filePath && fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': contentType(ext), ...corsHeaders() });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  sendJson(res, 404, { error: 'not_found' });
}

function staticPath(pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(DASHBOARD_DIR, rel);
  if (!full.startsWith(DASHBOARD_DIR)) return null;
  return full;
}

function contentType(ext) {
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
  })[ext] || 'application/octet-stream';
}

function guessSource(ev) {
  if (ev.source) return ev.source;
  if (String(ev.type || '').startsWith('tab') || ev.tab || ev.browser) return 'chrome-extension';
  if (String(ev.type || '').startsWith('app') || ev.app) return 'mac-agent';
  return 'unknown';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tracker-Admin-Token',
  };
}

function sanitizeDay(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function sendDownload(res, { filename, contentType, body }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const safeName = String(filename || 'download').replace(/[^\w.\-]+/g, '_');
  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${safeName}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const SETTINGS_PATH = path.join(
  os.homedir(),
  'Library/Application Support/MacActivityTracker/settings.json'
);

function defaultSettings() {
  return {
    pauseTracking: false,
    excludedBundleIdentifiers: [],
    excludedDomains: [],
    aiSummariesEnabled: false,
    aiConsent: false,
  };
}

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch, updatedAt: new Date().toISOString() };
  // AI stays off unless both flags are explicitly true
  if (!next.aiConsent) next.aiSummariesEnabled = false;
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  // Mirror exclusions for the Swift agent
  const exclusions = {
    bundleIdentifiers: next.excludedBundleIdentifiers || [],
    appNames: [],
  };
  fs.writeFileSync(
    path.join(path.dirname(SETTINGS_PATH), 'exclusions.json'),
    JSON.stringify(exclusions, null, 2)
  );
  return next;
}
