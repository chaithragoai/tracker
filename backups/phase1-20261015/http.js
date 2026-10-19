import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertEvent, queryEvents, getStatus, exportEventsCsv, refreshDailySummary } from './services/events.js';
import { generateDailyHtmlReport, generateWeeklySummary } from './services/reports.js';
import { maybeSummarize } from './services/aiSummary.js';
import { getAnalytics } from './services/analytics.js';
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
    const body = await readJson(req);
    const events = Array.isArray(body) ? body : [body];
    const results = [];
    const tx = db.transaction((list) => {
      for (const ev of list) {
        results.push(insertEvent(db, ev, ev.source || guessSource(ev)));
      }
    });
    tx(events);
    sendJson(res, 200, { ok: true, results });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, getStatus(db));
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
      sendJson(res, 200, getAnalytics(db, { from, to }));
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
    const day = body.day || new Date().toISOString().slice(0, 10);
    const outDir = path.join(os.homedir(), 'Library/Application Support/MacActivityTracker/reports');
    const file = generateDailyHtmlReport(db, day, outDir);
    sendJson(res, 200, { ok: true, file });
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
    const destDir = path.join(os.homedir(), 'Library/Application Support/MacActivityTracker/backups');
    fs.mkdirSync(destDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(destDir, `tracker-${stamp}.sqlite`);
    // Checkpoint WAL then copy
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(db.name, dest);
    sendJson(res, 200, { ok: true, file: dest });
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
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
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
