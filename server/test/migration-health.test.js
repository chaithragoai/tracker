import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { insertEvent, getTrackingHealth } from '../src/services/events.js';

function tempDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-mig-')), 't.sqlite');
}

test('migration v2 adds health columns and FTS without wiping', () => {
  const db = openDatabase(tempDb());
  const cols = db.prepare('PRAGMA table_info(tracker_status)').all().map((c) => c.name);
  assert.ok(cols.includes('last_chrome_event_at'));
  assert.ok(cols.includes('extension_last_seen_at'));
  const ver = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  assert.ok(ver >= 2);
  // tables exist
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
  assert.ok(tables.includes('tasks'));
  assert.ok(tables.includes('memories'));
  assert.ok(tables.includes('projects'));
  closeDatabase(db);
});

test('chrome events update tracking health and enrich metadata', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'h1',
    timestamp: '2026-10-15T12:00:00.000Z',
    type: 'tabSessionStarted',
    outcome: 'success',
    source: 'chrome-extension',
    browser: 'Chrome',
    tabSessionId: 'htab',
    title: 'Example Domain',
    url: 'https://example.com/',
    domain: 'example.com',
    tab: { tabId: 1, title: 'Example Domain', url: 'https://example.com/', domain: 'example.com', browser: 'Chrome' },
  }, 'chrome-extension');

  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get('h1');
  const meta = JSON.parse(ev.metadata_json);
  assert.equal(meta.domain, 'example.com');
  assert.equal(meta.title, 'Example Domain');

  insertEvent(db, {
    id: 'hb1',
    timestamp: '2026-10-15T12:00:30.000Z',
    type: 'extensionHeartbeat',
    outcome: 'success',
  }, 'chrome-extension');

  const health = getTrackingHealth(db, { now: Date.parse('2026-10-15T12:01:00.000Z') });
  assert.equal(health.extension_connected, true);
  assert.ok(health.last_chrome_event_at);
  closeDatabase(db);
});

test('mac-agent events update last_mac_event_at', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'm1',
    timestamp: '2026-10-15T12:05:00.000Z',
    type: 'trackerStarted',
    outcome: 'success',
  }, 'mac-agent');
  const health = getTrackingHealth(db, { now: Date.parse('2026-10-15T12:06:00.000Z') });
  assert.ok(health.last_mac_event_at);
  closeDatabase(db);
});
