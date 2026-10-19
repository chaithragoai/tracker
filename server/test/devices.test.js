import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { createServer } from '../src/http.js';
import {
  createEnrollmentToken,
  enrollDevice,
  revokeDevice,
  authenticateDevice,
  writeLocalCredentialsFile,
  readLocalCredentialsFile,
} from '../src/services/devices.js';
import { insertEvent, queryEvents } from '../src/services/events.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-dev-'));
  process.env.TRACKER_SKIP_BACKUP = '1';
  return path.join(dir, 'test.sqlite');
}

function authHeader(deviceId, secret) {
  return { Authorization: `Device ${deviceId} ${secret}` };
}

async function startServer(db, port) {
  const app = createServer(db, { port });
  await app.start();
  return app;
}

test('migration v3 adds devices tables and nullable device_id without wiping events', () => {
  const dbPath = tempDb();
  const db = openDatabase(dbPath);
  insertEvent(db, {
    id: 'legacy-1',
    timestamp: '2026-10-15T08:00:00.000Z',
    type: 'trackerStarted',
    outcome: 'success',
  }, 'mac-agent');
  closeDatabase(db);

  const db2 = openDatabase(dbPath);
  const ver = db2.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  assert.ok(ver >= 3);
  const tables = db2.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
  assert.ok(tables.includes('devices'));
  assert.ok(tables.includes('device_credentials'));
  assert.ok(tables.includes('enrollment_tokens'));
  assert.ok(tables.includes('audit_logs'));
  const cols = db2.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  assert.ok(cols.includes('device_id'));
  const legacy = db2.prepare('SELECT id, device_id FROM events WHERE id = ?').get('legacy-1');
  assert.equal(legacy.id, 'legacy-1');
  assert.equal(legacy.device_id, null); // no invented historical attribution
  closeDatabase(db2);
});

test('authorized enrollment returns device secret once; hash only stored', () => {
  const db = openDatabase(tempDb());
  const token = createEnrollmentToken(db, { displayNameHint: 'Test Mac', ttlSeconds: 300 });
  assert.ok(token.enrollment_token);
  const enrolled = enrollDevice(db, {
    enrollmentToken: token.enrollment_token,
    displayName: 'Test Mac',
    osName: 'macOS',
  });
  assert.ok(enrolled.device_id);
  assert.ok(enrolled.device_secret);
  const cred = db.prepare('SELECT secret_hash, secret_salt FROM device_credentials WHERE device_id = ?').get(enrolled.device_id);
  assert.ok(cred.secret_hash);
  assert.notEqual(cred.secret_hash, enrolled.device_secret);
  assert.equal(db.prepare('SELECT enrollment_status FROM devices WHERE id = ?').get(enrolled.device_id).enrollment_status, 'active');
  closeDatabase(db);
});

test('duplicate enrollment token use is rejected', () => {
  const db = openDatabase(tempDb());
  const token = createEnrollmentToken(db, { maxUses: 1 });
  enrollDevice(db, { enrollmentToken: token.enrollment_token, displayName: 'A' });
  assert.throws(
    () => enrollDevice(db, { enrollmentToken: token.enrollment_token, displayName: 'B' }),
    /Invalid|expired|already used/i
  );
  closeDatabase(db);
});

test('invalid and missing credentials rejected; revoked device blocked', async () => {
  const db = openDatabase(tempDb());
  const port = 8792;
  const app = await startServer(db, port);
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'trackerStarted', outcome: 'success' }),
    });
    assert.equal(noAuth.status, 401);

    const token = createEnrollmentToken(db, {});
    const enrolled = enrollDevice(db, {
      enrollmentToken: token.enrollment_token,
      displayName: 'Auth Mac',
    });

    const badSecret = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(enrolled.device_id, 'wrong-secret'),
      },
      body: JSON.stringify({ type: 'trackerStarted', id: 'bad1', outcome: 'success', source: 'mac-agent' }),
    });
    assert.equal(badSecret.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(enrolled.device_id, enrolled.device_secret),
      },
      body: JSON.stringify({
        id: 'ok1',
        timestamp: '2026-10-15T15:00:00.000Z',
        type: 'trackerStarted',
        outcome: 'success',
        source: 'mac-agent',
      }),
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.device_id, enrolled.device_id);

    revokeDevice(db, enrolled.device_id);
    const revoked = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(enrolled.device_id, enrolled.device_secret),
      },
      body: JSON.stringify({ type: 'trackerStarted', id: 'rev1', outcome: 'success', source: 'mac-agent' }),
    });
    assert.equal(revoked.status, 403);
  } finally {
    await app.stop();
    closeDatabase(db);
  }
});

test('events attributed to authenticated device; spoofed body device_id ignored', async () => {
  const db = openDatabase(tempDb());
  const port = 8793;
  const app = await startServer(db, port);
  try {
    const t1 = createEnrollmentToken(db, {});
    const t2 = createEnrollmentToken(db, {});
    const a = enrollDevice(db, { enrollmentToken: t1.enrollment_token, displayName: 'Device A' });
    const b = enrollDevice(db, { enrollmentToken: t2.enrollment_token, displayName: 'Device B' });

    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(a.device_id, a.device_secret),
      },
      body: JSON.stringify({
        id: 'spoof-1',
        timestamp: '2026-10-15T15:10:00.000Z',
        type: 'sessionStarted',
        outcome: 'success',
        source: 'mac-agent',
        device_id: b.device_id,
        deviceId: b.device_id,
        sessionId: 'sess-a',
        app: { name: 'Finder', bundleIdentifier: 'com.apple.finder' },
      }),
    });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT device_id FROM events WHERE id = ?').get('spoof-1');
    assert.equal(row.device_id, a.device_id);
    assert.notEqual(row.device_id, b.device_id);
    const sess = db.prepare('SELECT device_id FROM app_sessions WHERE id = ?').get('sess-a');
    assert.equal(sess.device_id, a.device_id);
  } finally {
    await app.stop();
    closeDatabase(db);
  }
});

test('invalid event payload rejected', async () => {
  const db = openDatabase(tempDb());
  const port = 8794;
  const app = await startServer(db, port);
  try {
    const token = createEnrollmentToken(db, {});
    const enrolled = enrollDevice(db, {
      enrollmentToken: token.enrollment_token,
      displayName: 'Payload Mac',
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(enrolled.device_id, enrolled.device_secret),
      },
      body: JSON.stringify({ outcome: 'success' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await app.stop();
    closeDatabase(db);
  }
});

test('chrome-extension style event with device auth', async () => {
  const db = openDatabase(tempDb());
  const port = 8795;
  const app = await startServer(db, port);
  try {
    const token = createEnrollmentToken(db, {});
    const enrolled = enrollDevice(db, {
      enrollmentToken: token.enrollment_token,
      displayName: 'Chrome Mac',
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(enrolled.device_id, enrolled.device_secret),
      },
      body: JSON.stringify({
        id: 'chrome-1',
        timestamp: '2026-10-15T15:20:00.000Z',
        type: 'navigation',
        outcome: 'success',
        source: 'chrome-extension',
        browser: 'Chrome',
        title: 'Example Domain',
        url: 'https://example.com/',
        domain: 'example.com',
      }),
    });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT device_id, source FROM events WHERE id = ?').get('chrome-1');
    assert.equal(row.device_id, enrolled.device_id);
    assert.equal(row.source, 'chrome-extension');
  } finally {
    await app.stop();
    closeDatabase(db);
  }
});

test('admin enrollment HTTP + unauthorized enroll without token', async () => {
  const db = openDatabase(tempDb());
  const port = 8796;
  process.env.TRACKER_MODE = 'local';
  const app = await startServer(db, port);
  try {
    const tokenRes = await fetch(`http://127.0.0.1:${port}/api/admin/enrollment-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 120 }),
    });
    assert.equal(tokenRes.status, 201);
    const tokenBody = await tokenRes.json();

    const bad = await fetch(`http://127.0.0.1:${port}/api/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment_token: 'not-real', display_name: 'X' }),
    });
    assert.equal(bad.status, 401);

    const good = await fetch(`http://127.0.0.1:${port}/api/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollment_token: tokenBody.enrollment_token,
        display_name: 'HTTP Enrolled',
      }),
    });
    assert.equal(good.status, 201);
    const enrolled = await good.json();
    assert.ok(enrolled.device_secret);
    // Public list must not expose secrets
    const list = await fetch(`http://127.0.0.1:${port}/api/admin/devices`);
    const listBody = await list.json();
    assert.ok(listBody.devices.some((d) => d.id === enrolled.device_id));
    assert.ok(!JSON.stringify(listBody).includes(enrolled.device_secret));
  } finally {
    await app.stop();
    closeDatabase(db);
  }
});

test('local credentials file round-trip (no secret in audit)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-creds-'));
  process.env.TRACKER_SUPPORT_DIR = dir;
  writeLocalCredentialsFile({
    deviceId: 'dev-1',
    deviceSecret: 'secret-value-xyz',
    displayName: 'File Mac',
  });
  const read = readLocalCredentialsFile();
  assert.equal(read.device_id, 'dev-1');
  assert.equal(read.device_secret, 'secret-value-xyz');
  delete process.env.TRACKER_SUPPORT_DIR;
});

test('authenticateDevice helper rejects malformed header', () => {
  const db = openDatabase(tempDb());
  assert.throws(
    () => authenticateDevice(db, { headers: {} }),
    /Missing or malformed/
  );
  closeDatabase(db);
});

test('direct insertEvent still works for unit tests without HTTP auth', () => {
  const db = openDatabase(tempDb());
  const r = insertEvent(db, {
    id: 'unit-1',
    timestamp: '2026-10-15T16:00:00.000Z',
    type: 'trackerStarted',
    outcome: 'success',
  }, 'mac-agent', { deviceId: null });
  assert.equal(r.inserted, true);
  assert.equal(queryEvents(db, {}).length, 1);
  closeDatabase(db);
});
