/**
 * Device enrollment, credentials, and auth for event ingest.
 * Plain device secrets are returned once at enrollment and never stored or logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hashSecret, verifySecret, randomToken } from './cryptoSecrets.js';
import {
  supportDir,
  credentialsFilePath,
  allowLocalAutoProvision,
  isLocalMode,
} from '../config.js';

function nowIso() {
  return new Date().toISOString();
}

function writeAudit(db, { action, actor = 'system', deviceId = null, detail = {} }) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, action, actor, device_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      action,
      actor,
      deviceId,
      JSON.stringify(detail),
      nowIso()
    );
  } catch {
    // audit table may not exist mid-migration
  }
}

export function createEnrollmentToken(db, {
  displayNameHint = null,
  ttlSeconds = 3600,
  maxUses = 1,
  actor = 'admin',
} = {}) {
  const plain = randomToken(32);
  const { salt, hash } = hashSecret(plain);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + Math.max(60, ttlSeconds) * 1000).toISOString();
  db.prepare(`
    INSERT INTO enrollment_tokens (
      id, token_hash, token_salt, display_name_hint, expires_at, max_uses, use_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, hash, salt, displayNameHint, expiresAt, maxUses, nowIso());
  writeAudit(db, {
    action: 'enrollment_token_created',
    actor,
    detail: { token_id: id, expires_at: expiresAt, max_uses: maxUses },
  });
  return {
    token_id: id,
    enrollment_token: plain,
    expires_at: expiresAt,
    max_uses: maxUses,
  };
}

function findValidEnrollmentToken(db, plainToken) {
  const rows = db.prepare(`
    SELECT * FROM enrollment_tokens
    WHERE revoked_at IS NULL
      AND datetime(expires_at) >= datetime('now')
      AND use_count < max_uses
  `).all();
  for (const row of rows) {
    if (verifySecret(plainToken, row.token_salt, row.token_hash)) return row;
  }
  return null;
}

export function enrollDevice(db, {
  enrollmentToken,
  displayName,
  osName = null,
  osVersion = null,
  agentVersion = null,
} = {}) {
  if (!enrollmentToken || typeof enrollmentToken !== 'string') {
    const err = new Error('enrollment_token is required');
    err.status = 400;
    err.code = 'missing_enrollment_token';
    throw err;
  }
  const name = String(displayName || '').trim() || 'Unnamed device';
  const tokenRow = findValidEnrollmentToken(db, enrollmentToken);
  if (!tokenRow) {
    const err = new Error('Invalid, expired, or already used enrollment token');
    err.status = 401;
    err.code = 'invalid_enrollment_token';
    throw err;
  }

  const deviceId = crypto.randomUUID();
  const secretPlain = randomToken(32);
  const { salt, hash } = hashSecret(secretPlain);
  const ts = nowIso();

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO devices (
        id, display_name, os, os_version, agent_version,
        enrollment_status, created_at, updated_at, last_check_in_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(deviceId, name, osName, osVersion, agentVersion, ts, ts, ts);

    db.prepare(`
      INSERT INTO device_credentials (id, device_id, secret_hash, secret_salt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), deviceId, hash, salt, ts);

    db.prepare(`
      UPDATE enrollment_tokens
      SET use_count = use_count + 1, consumed_device_id = ?
      WHERE id = ?
    `).run(deviceId, tokenRow.id);
  });
  tx();

  writeAudit(db, {
    action: 'device_enrolled',
    actor: 'enrollment',
    deviceId,
    detail: { display_name: name, token_id: tokenRow.id },
  });

  return {
    device_id: deviceId,
    device_secret: secretPlain,
    display_name: name,
    enrollment_status: 'active',
    created_at: ts,
  };
}

export function revokeDevice(db, deviceId, { actor = 'admin' } = {}) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    const err = new Error('Device not found');
    err.status = 404;
    err.code = 'device_not_found';
    throw err;
  }
  const ts = nowIso();
  db.prepare(`
    UPDATE devices SET enrollment_status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?
  `).run(ts, ts, deviceId);
  db.prepare(`
    UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL
  `).run(ts, deviceId);
  writeAudit(db, { action: 'device_revoked', actor, deviceId, detail: {} });
  return { device_id: deviceId, enrollment_status: 'revoked', revoked_at: ts };
}

export function listDevices(db) {
  return db.prepare(`
    SELECT id, display_name, os, os_version, agent_version, enrollment_status,
           employee_display_name, created_at, updated_at, last_check_in_at,
           last_mac_event_at, last_chrome_event_at, revoked_at
    FROM devices
    ORDER BY created_at DESC
  `).all();
}

export function getDevicePublic(db, deviceId) {
  return db.prepare(`
    SELECT id, display_name, os, os_version, agent_version, enrollment_status,
           employee_display_name, created_at, updated_at, last_check_in_at,
           last_mac_event_at, last_chrome_event_at, revoked_at
    FROM devices WHERE id = ?
  `).get(deviceId) || null;
}

/**
 * Authenticate Device Authorization header.
 * Format: Authorization: Device <device_id> <secret>
 * Returns { deviceId, device } or throws with .status
 */
export function authenticateDevice(db, req) {
  const header = req.headers.authorization || '';
  const match = /^Device\s+(\S+)\s+(\S+)\s*$/i.exec(header);
  if (!match) {
    const err = new Error('Missing or malformed Authorization: Device <device_id> <secret>');
    err.status = 401;
    err.code = 'missing_device_credentials';
    throw err;
  }
  const deviceId = match[1];
  const secret = match[2];

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    const err = new Error('Unknown device');
    err.status = 401;
    err.code = 'unknown_device';
    throw err;
  }
  if (device.enrollment_status !== 'active' || device.revoked_at) {
    const err = new Error('Device revoked or inactive');
    err.status = 403;
    err.code = 'device_revoked';
    throw err;
  }

  const cred = db.prepare(`
    SELECT * FROM device_credentials
    WHERE device_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(deviceId);
  if (!cred || !verifySecret(secret, cred.secret_salt, cred.secret_hash)) {
    const err = new Error('Invalid device credentials');
    err.status = 401;
    err.code = 'invalid_device_credentials';
    throw err;
  }

  return { deviceId, device };
}

export function touchDeviceCheckIn(db, deviceId, { source = null, timestamp = null } = {}) {
  const ts = timestamp || nowIso();
  const patch = { last_check_in_at: ts, updated_at: ts };
  if (source === 'mac-agent') patch.last_mac_event_at = ts;
  if (source === 'chrome-extension') patch.last_chrome_event_at = ts;
  const fields = Object.keys(patch);
  const sets = fields.map((f) => `${f} = @${f}`).join(', ');
  const params = { id: deviceId, ...patch };
  db.prepare(`UPDATE devices SET ${sets} WHERE id = @id`).run(params);
}

export function recordDeviceActivity(db, deviceId, source, timestamp) {
  const ts = timestamp || nowIso();
  touchDeviceCheckIn(db, deviceId, { source, timestamp: ts });
}

/** Persist plaintext credentials for local agent/extension (mode=local only). Never logged. */
export function writeLocalCredentialsFile({
  deviceId,
  deviceSecret,
  displayName,
  serverUrl = 'http://127.0.0.1:8787',
}) {
  const dir = supportDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    device_id: deviceId,
    device_secret: deviceSecret,
    display_name: displayName,
    server_url: serverUrl,
    created_at: nowIso(),
    note: 'Local device credentials. Do not commit or share. Rotate by re-enrolling.',
  };
  const file = credentialsFilePath();
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows may ignore chmod
  }
  return file;
}

export function readLocalCredentialsFile() {
  const file = credentialsFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data.device_id || !data.device_secret) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * If local mode and no active devices, create enrollment + device and write credentials.
 * Returns device public info or null if skipped.
 */
export function ensureLocalDeviceProvisioned(db) {
  if (!allowLocalAutoProvision()) return null;
  const active = db.prepare(`
    SELECT COUNT(*) AS n FROM devices WHERE enrollment_status = 'active' AND revoked_at IS NULL
  `).get().n;
  if (active > 0) {
    // Ensure credentials file exists for clients when we still have the secret (may not).
    return null;
  }

  const token = createEnrollmentToken(db, {
    displayNameHint: 'Local development device',
    ttlSeconds: 600,
    maxUses: 1,
    actor: 'local_auto_provision',
  });
  const enrolled = enrollDevice(db, {
    enrollmentToken: token.enrollment_token,
    displayName: `${os.hostname() || 'Local Mac'} (local)`,
    osName: process.platform === 'darwin' ? 'macOS' : process.platform,
    osVersion: os.release(),
    agentVersion: 'local-auto',
  });
  writeLocalCredentialsFile({
    deviceId: enrolled.device_id,
    deviceSecret: enrolled.device_secret,
    displayName: enrolled.display_name,
  });
  writeAudit(db, {
    action: 'local_auto_provision',
    actor: 'system',
    deviceId: enrolled.device_id,
    detail: { mode: 'local' },
  });
  console.log(`[devices] Local device provisioned: ${enrolled.device_id} (credentials written to ${credentialsFilePath()})`);
  return {
    device_id: enrolled.device_id,
    display_name: enrolled.display_name,
    credentials_path: credentialsFilePath(),
  };
}

export function backupDatabaseIfNeeded(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `tracker-pre-v3-${stamp}.sqlite`);
  fs.copyFileSync(dbPath, dest);
  // Also copy WAL/SHM if present for consistency
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix;
    if (fs.existsSync(side)) {
      try {
        fs.copyFileSync(side, dest + suffix);
      } catch {
        // ignore
      }
    }
  }
  return dest;
}

export { isLocalMode, credentialsFilePath };
