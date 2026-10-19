import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { insertEvent, queryEvents, exportEventsCsv, getStatus, refreshDailySummary } from '../src/services/events.js';
import { createServer } from '../src/http.js';
import { createEnrollmentToken, enrollDevice } from '../src/services/devices.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
  process.env.TRACKER_SKIP_BACKUP = '1';
  return path.join(dir, 'test.sqlite');
}

test('schema migrates and status row exists', () => {
  const db = openDatabase(tempDb());
  const status = getStatus(db);
  assert.equal(status.id, 1);
  assert.equal(status.status, 'stopped');
  closeDatabase(db);
});

test('app session timing and no duplicate events', () => {
  const db = openDatabase(tempDb());
  const sessionId = 'sess-1';
  const base = {
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder', processIdentifier: 1 },
    sessionId,
  };

  const a = insertEvent(db, {
    id: 'e1',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'trackerStarted',
    outcome: 'success',
  }, 'mac-agent');
  assert.equal(a.inserted, true);

  insertEvent(db, {
    id: 'e2',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    ...base,
  }, 'mac-agent');

  insertEvent(db, {
    id: 'e3',
    timestamp: '2026-10-15T10:00:10.000Z',
    type: 'sessionEnded',
    outcome: 'success',
    durationSeconds: 10,
    metadata: { reason: 'app_switch' },
    ...base,
  }, 'mac-agent');

  // Duplicate id ignored
  const dup = insertEvent(db, {
    id: 'e2',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    ...base,
  }, 'mac-agent');
  assert.equal(dup.inserted, false);

  const sessions = db.prepare('SELECT * FROM app_sessions').all();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].duration_seconds, 10);
  assert.equal(sessions[0].ended_at, '2026-10-15T10:00:10.000Z');

  const events = queryEvents(db, {});
  assert.equal(events.length, 3);
  closeDatabase(db);
});

test('idle periods and gaps recorded', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'idle1',
    timestamp: '2026-10-15T11:00:00.000Z',
    type: 'idleStarted',
    outcome: 'success',
    sessionId: 's-idle',
  }, 'mac-agent');
  insertEvent(db, {
    id: 'idle2',
    timestamp: '2026-10-15T11:01:00.000Z',
    type: 'idleEnded',
    outcome: 'success',
    durationSeconds: 60,
  }, 'mac-agent');
  insertEvent(db, {
    id: 'gap1',
    timestamp: '2026-10-15T12:00:00.000Z',
    type: 'gapDetected',
    outcome: 'unknown',
    metadata: {
      gapStart: '2026-10-15T11:50:00.000Z',
      gapEnd: '2026-10-15T12:00:00.000Z',
      reason: 'tracker_restart',
    },
  }, 'mac-agent');

  const idle = db.prepare('SELECT * FROM idle_periods').all();
  assert.equal(idle.length, 1);
  assert.equal(idle[0].duration_seconds, 60);

  const gaps = db.prepare('SELECT * FROM tracking_gaps').all();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, 'tracker_restart');
  closeDatabase(db);
});

test('daily summary and csv export', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 's1',
    timestamp: '2026-10-15T09:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'day-sess',
    app: { name: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 's2',
    timestamp: '2026-10-15T09:05:00.000Z',
    type: 'sessionEnded',
    outcome: 'success',
    sessionId: 'day-sess',
    durationSeconds: 300,
    app: { name: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit' },
  }, 'mac-agent');

  refreshDailySummary(db, '2026-10-15');
  const summary = db.prepare('SELECT * FROM daily_summaries WHERE day = ?').get('2026-10-15');
  assert.equal(summary.active_seconds, 300);

  const csv = exportEventsCsv(db, { from: '2026-10-15T00:00:00.000Z', to: '2026-10-15T23:59:59.000Z' });
  assert.match(csv, /sessionStarted/);
  assert.match(csv, /TextEdit/);
  closeDatabase(db);
});

test('HTTP ingest and status endpoint', async () => {
  const db = openDatabase(tempDb());
  const token = createEnrollmentToken(db, {});
  const enrolled = enrollDevice(db, {
    enrollmentToken: token.enrollment_token,
    displayName: 'HTTP Test Device',
  });
  const app = createServer(db, { port: 8791 });
  await app.start();
  try {
    const res = await fetch('http://127.0.0.1:8791/api/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Device ${enrolled.device_id} ${enrolled.device_secret}`,
      },
      body: JSON.stringify({
        id: 'http-1',
        timestamp: '2026-10-15T13:00:00.000Z',
        type: 'trackerStarted',
        outcome: 'success',
        source: 'mac-agent',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.device_id, enrolled.device_id);

    const statusRes = await fetch('http://127.0.0.1:8791/api/status');
    const status = await statusRes.json();
    assert.equal(status.status, 'running');
  } finally {
    await app.stop();
    closeDatabase(db);
  }
});

test('sessionStarted closes other open app sessions', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'app-a',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'app-open-a',
    app: { name: 'Cursor', bundleIdentifier: 'com.cursor' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'app-b',
    timestamp: '2026-10-15T10:20:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'app-open-b',
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent');

  const a = db.prepare('SELECT * FROM app_sessions WHERE id = ?').get('app-open-a');
  const b = db.prepare('SELECT * FROM app_sessions WHERE id = ?').get('app-open-b');
  assert.equal(a.ended_at, '2026-10-15T10:20:00.000Z');
  assert.equal(a.end_reason, 'superseded_by_frontmost_app');
  assert.equal(a.duration_seconds, 1200);
  assert.equal(b.ended_at, null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM app_sessions WHERE ended_at IS NULL').get().c,
    1,
  );
  closeDatabase(db);
});

test('tabSessionStarted closes other open tab sessions', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'tab-a',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'tabSessionStarted',
    outcome: 'success',
    tabSessionId: 'tab-open-a',
    tab: { domain: 'a.example', url: 'https://a.example/', title: 'A' },
  }, 'chrome-extension');
  insertEvent(db, {
    id: 'tab-b',
    timestamp: '2026-10-15T10:30:00.000Z',
    type: 'tabSessionStarted',
    outcome: 'success',
    tabSessionId: 'tab-open-b',
    tab: { domain: 'b.example', url: 'https://b.example/', title: 'B' },
  }, 'chrome-extension');

  const a = db.prepare('SELECT * FROM tab_sessions WHERE id = ?').get('tab-open-a');
  const b = db.prepare('SELECT * FROM tab_sessions WHERE id = ?').get('tab-open-b');
  assert.equal(a.ended_at, '2026-10-15T10:30:00.000Z');
  assert.equal(a.end_reason, 'superseded_by_active_tab');
  assert.equal(a.duration_seconds, 1800);
  assert.equal(b.ended_at, null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM tab_sessions WHERE ended_at IS NULL').get().c,
    1,
  );
  closeDatabase(db);
});

test('overlapping close does not rewrite ended session', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'o1',
    timestamp: '2026-10-15T14:00:00.000Z',
    type: 'sessionStarted',
    sessionId: 'overlap',
    outcome: 'success',
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'o2',
    timestamp: '2026-10-15T14:00:05.000Z',
    type: 'sessionEnded',
    sessionId: 'overlap',
    durationSeconds: 5,
    outcome: 'success',
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'o3',
    timestamp: '2026-10-15T14:00:09.000Z',
    type: 'sessionEnded',
    sessionId: 'overlap',
    durationSeconds: 99,
    outcome: 'success',
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent');

  const row = db.prepare('SELECT * FROM app_sessions WHERE id = ?').get('overlap');
  assert.equal(row.duration_seconds, 5);
  assert.equal(row.ended_at, '2026-10-15T14:00:05.000Z');
  closeDatabase(db);
});
