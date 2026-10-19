import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { insertEvent } from '../src/services/events.js';
import { generateDailyHtmlReport, generateWeeklySummary } from '../src/services/reports.js';
import { maybeSummarize, buildLocalDigest } from '../src/services/aiSummary.js';
import { createServer } from '../src/http.js';

function tempDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-report-')), 't.sqlite');
}

test('HTML report and weekly summary', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'r1',
    timestamp: '2026-10-15T08:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'rep-sess',
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'r2',
    timestamp: '2026-10-15T08:10:00.000Z',
    type: 'sessionEnded',
    outcome: 'success',
    sessionId: 'rep-sess',
    durationSeconds: 600,
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'r3',
    timestamp: '2026-10-15T08:11:00.000Z',
    type: 'click',
    outcome: 'unknown',
    metadata: { semantic: 'opened_link' },
  }, 'chrome-extension');

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-html-'));
  const report = generateDailyHtmlReport(db, '2026-10-15', outDir);
  assert.equal(fs.existsSync(report.file), true);
  assert.match(report.filename, /daily-report-2026-10-15\.html/);
  assert.match(report.html, /Finder/);
  assert.match(report.html, /opened_link/);
  const html = fs.readFileSync(report.file, 'utf8');
  assert.equal(html, report.html);

  const weekly = generateWeeklySummary(db, '2026-10-15');
  assert.equal(weekly.days.length, 7);
  assert.ok(weekly.totals.active >= 600);
  closeDatabase(db);
});

test('daily HTML report and backup endpoints return downloadable attachments', async () => {
  const db = openDatabase(tempDb());
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-reports-'));
  const backupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-backups-'));
  process.env.TRACKER_REPORTS_DIR = reportsDir;
  process.env.TRACKER_BACKUPS_DIR = backupsDir;
  insertEvent(db, {
    id: 'dl1',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'dl-sess',
    app: { name: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'dl2',
    timestamp: '2026-10-15T10:05:00.000Z',
    type: 'sessionEnded',
    outcome: 'success',
    sessionId: 'dl-sess',
    durationSeconds: 300,
    app: { name: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit' },
  }, 'mac-agent');

  const app = createServer(db, { port: 8798 });
  await app.start();
  try {
    const reportRes = await fetch('http://127.0.0.1:8798/api/reports/daily', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: '2026-10-15', download: true }),
    });
    assert.equal(reportRes.status, 200);
    assert.match(reportRes.headers.get('content-type') || '', /text\/html/);
    assert.match(reportRes.headers.get('content-disposition') || '', /daily-report-2026-10-15\.html/);
    const html = await reportRes.text();
    assert.match(html, /TextEdit/);
    assert.match(html, /<!DOCTYPE html>/i);

    const backupRes = await fetch('http://127.0.0.1:8798/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ download: true }),
    });
    assert.equal(backupRes.status, 200);
    assert.match(backupRes.headers.get('content-disposition') || '', /\.db"/);
    const buf = Buffer.from(await backupRes.arrayBuffer());
    assert.ok(buf.length > 1000);
    // SQLite file header
    assert.equal(buf.subarray(0, 15).toString('utf8'), 'SQLite format 3');

    const probePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-bak-')), 'probe.db');
    fs.writeFileSync(probePath, buf);
    const probe = new Database(probePath, { readonly: true, fileMustExist: true });
    const tables = probe.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
    assert.ok(tables.includes('events'));
    assert.ok(tables.includes('app_sessions'));
    const evCount = probe.prepare('SELECT COUNT(*) AS c FROM events').get().c;
    assert.ok(evCount >= 2);
    probe.close();
  } finally {
    await app.stop();
    closeDatabase(db);
    delete process.env.TRACKER_REPORTS_DIR;
    delete process.env.TRACKER_BACKUPS_DIR;
  }
});

test('AI summaries disabled without consent', () => {
  const summary = {
    day: '2026-10-15',
    active_seconds: 100,
    idle_seconds: 20,
    app_breakdown_json: '{}',
    domain_breakdown_json: '{}',
    operation_count: 0,
    error_count: 0,
  };
  const off = maybeSummarize({ settings: { aiConsent: false, aiSummariesEnabled: true }, summary });
  assert.equal(off.enabled, false);

  const on = maybeSummarize({ settings: { aiConsent: true, aiSummariesEnabled: true }, summary });
  assert.equal(on.enabled, true);
  assert.equal(on.provider, 'local-digest');
  assert.match(buildLocalDigest(summary), /Local digest/);
});

test('tab sessions from extension-shaped events', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 't1',
    timestamp: '2026-10-15T09:00:00.000Z',
    type: 'tabSessionStarted',
    outcome: 'success',
    browser: 'Chrome',
    tabSessionId: 'tab-1',
    tab: { tabId: 3, title: 'Example', url: 'https://example.com/', domain: 'example.com', browser: 'Chrome' },
    domain: 'example.com',
    url: 'https://example.com/',
  }, 'chrome-extension');
  insertEvent(db, {
    id: 't2',
    timestamp: '2026-10-15T09:02:00.000Z',
    type: 'tabSessionEnded',
    outcome: 'success',
    tabSessionId: 'tab-1',
    durationSeconds: 120,
    domain: 'example.com',
  }, 'chrome-extension');

  const rows = db.prepare('SELECT * FROM tab_sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, 'example.com');
  assert.equal(rows[0].duration_seconds, 120);
  closeDatabase(db);
});
