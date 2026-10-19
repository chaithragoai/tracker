import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { createServer } from '../src/http.js';
import { createEnrollmentToken, enrollDevice, revokeDevice, touchDeviceCheckIn } from '../src/services/devices.js';
import { insertEvent } from '../src/services/events.js';
import { classifyDeviceStatus, getManagerSummary, listManagerDevices, getManagerDeviceDetail } from '../src/services/manager.js';

function tempDb() {
  process.env.TRACKER_SKIP_BACKUP = '1';
  process.env.TRACKER_MODE = 'local';
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-mgr-')), 't.sqlite');
}

function enroll(db, name = 'Mgr Device') {
  const token = createEnrollmentToken(db, {});
  return enrollDevice(db, { enrollmentToken: token.enrollment_token, displayName: name, osName: 'macOS' });
}

test('status: online vs activity_stale vs offline vs unknown vs needs_attention', () => {
  const now = Date.parse('2026-10-15T12:00:00.000Z');
  const thresholds = {
    online_checkin_seconds: 300,
    activity_stale_seconds: 900,
    offline_checkin_seconds: 1800,
  };

  assert.equal(classifyDeviceStatus({ enrollment_status: 'active' }, { now, thresholds }).status, 'unknown');

  assert.equal(classifyDeviceStatus({
    enrollment_status: 'active',
    last_check_in_at: '2026-10-15T11:59:00.000Z',
    last_mac_event_at: '2026-10-15T11:58:00.000Z',
  }, { now, thresholds }).status, 'online');

  assert.equal(classifyDeviceStatus({
    enrollment_status: 'active',
    last_check_in_at: '2026-10-15T11:59:00.000Z',
    last_mac_event_at: '2026-10-15T10:00:00.000Z',
  }, { now, thresholds }).status, 'activity_stale');

  assert.equal(classifyDeviceStatus({
    enrollment_status: 'active',
    last_check_in_at: '2026-10-15T11:50:00.000Z',
  }, { now, thresholds }).status, 'stale_checkin');

  assert.equal(classifyDeviceStatus({
    enrollment_status: 'active',
    last_check_in_at: '2026-10-15T10:00:00.000Z',
  }, { now, thresholds }).status, 'offline');

  assert.equal(classifyDeviceStatus({
    enrollment_status: 'revoked',
    revoked_at: '2026-10-15T11:00:00.000Z',
    last_check_in_at: '2026-10-15T11:59:00.000Z',
  }, { now, thresholds }).status, 'needs_attention');
});

test('manager summary and list with empty and enrolled devices', () => {
  const db = openDatabase(tempDb());
  let summary = getManagerSummary(db);
  assert.equal(summary.counts.total_enrolled, 0);

  const a = enroll(db, 'Alpha Mac');
  touchDeviceCheckIn(db, a.device_id, {});
  insertEvent(db, {
    id: 'm1',
    timestamp: new Date().toISOString(),
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'ms1',
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent', { deviceId: a.device_id });

  summary = getManagerSummary(db);
  assert.equal(summary.counts.total_enrolled, 1);
  assert.ok(summary.thresholds.online_checkin_seconds);

  const list = listManagerDevices(db, { q: 'Alpha' });
  assert.equal(list.devices.length, 1);
  assert.equal(list.devices[0].id, a.device_id);
  assert.ok(!JSON.stringify(list).includes('device_secret'));
  assert.ok(!JSON.stringify(list).includes('secret_hash'));
  closeDatabase(db);
});

test('device detail scoped to one device; no cross-device leakage', () => {
  const db = openDatabase(tempDb());
  const a = enroll(db, 'Device A');
  const b = enroll(db, 'Device B');
  const from = '2026-10-15T00:00:00.000Z';
  const to = '2026-10-15T23:59:59.000Z';

  insertEvent(db, {
    id: 'ea1',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'sa1',
    app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
  }, 'mac-agent', { deviceId: a.device_id });
  insertEvent(db, {
    id: 'eb1',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'sb1',
    app: { name: 'SecretApp', bundleIdentifier: 'com.secret' },
  }, 'mac-agent', { deviceId: b.device_id });

  const detail = getManagerDeviceDetail(db, a.device_id, { from, to });
  assert.equal(detail.device.id, a.device_id);
  assert.ok(detail.events.every((e) => e.id !== 'eb1'));
  assert.ok(!JSON.stringify(detail).includes('SecretApp'));
  assert.ok(!JSON.stringify(detail).includes('device_secret'));
  closeDatabase(db);
});

test('manager HTTP APIs authorize and return real data', async () => {
  const db = openDatabase(tempDb());
  const enrolled = enroll(db, 'HTTP Mgr');
  touchDeviceCheckIn(db, enrolled.device_id, {});
  const app = createServer(db, { port: 8797 });
  await app.start();
  try {
    process.env.TRACKER_MODE = 'central';
    delete process.env.TRACKER_ADMIN_TOKEN;
    const forbidden = await fetch('http://127.0.0.1:8797/api/manager/devices');
    assert.equal(forbidden.status, 403);

    process.env.TRACKER_MODE = 'local';
    const ok = await fetch('http://127.0.0.1:8797/api/manager/devices');
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.devices.some((d) => d.id === enrolled.device_id));

    const detail = await fetch(`http://127.0.0.1:8797/api/manager/devices/${enrolled.device_id}`);
    assert.equal(detail.status, 200);
    const dbody = await detail.json();
    assert.equal(dbody.device.id, enrolled.device_id);

    const missing = await fetch('http://127.0.0.1:8797/api/manager/devices/not-a-real-id');
    assert.equal(missing.status, 404);
  } finally {
    process.env.TRACKER_MODE = 'local';
    await app.stop();
    closeDatabase(db);
  }
});

test('extensionHeartbeat updates check-in only, not chrome activity timestamp', () => {
  const db = openDatabase(tempDb());
  const enrolled = enroll(db, 'HB Device');
  insertEvent(db, {
    id: 'hb-only',
    timestamp: '2026-10-15T12:00:00.000Z',
    type: 'extensionHeartbeat',
    outcome: 'success',
  }, 'chrome-extension', { deviceId: enrolled.device_id });
  const row = db.prepare('SELECT last_check_in_at, last_chrome_event_at FROM devices WHERE id = ?').get(enrolled.device_id);
  assert.equal(row.last_check_in_at, '2026-10-15T12:00:00.000Z');
  assert.equal(row.last_chrome_event_at, null);
  closeDatabase(db);
});

test('revoked device appears as needs_attention in manager list', () => {
  const db = openDatabase(tempDb());
  const enrolled = enroll(db, 'Revoke Me');
  touchDeviceCheckIn(db, enrolled.device_id, {});
  revokeDevice(db, enrolled.device_id);
  const list = listManagerDevices(db, {});
  const row = list.devices.find((d) => d.id === enrolled.device_id);
  assert.equal(row.status, 'needs_attention');
  closeDatabase(db);
});
