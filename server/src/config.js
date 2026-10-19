/**
 * Runtime mode and admin gates for device enrollment.
 * Local default keeps 127.0.0.1 development usable via explicit local provision —
 * never opens unauthenticated event ingest.
 */
import os from 'node:os';
import path from 'node:path';

export function trackerMode() {
  const m = String(process.env.TRACKER_MODE || 'local').toLowerCase();
  return m === 'central' ? 'central' : 'local';
}

export function isLocalMode() {
  return trackerMode() === 'local';
}

/** Directory for SQLite, credentials file, backups. */
export function supportDir() {
  if (process.env.TRACKER_SUPPORT_DIR) return process.env.TRACKER_SUPPORT_DIR;
  return path.join(os.homedir(), 'Library', 'Application Support', 'MacActivityTracker');
}

export function credentialsFilePath() {
  return path.join(supportDir(), 'device-credentials.json');
}

/**
 * Admin APIs (create enrollment tokens, revoke) require either:
 * - TRACKER_MODE=local (machine owner running the laptop server), or
 * - Header X-Tracker-Admin-Token matching TRACKER_ADMIN_TOKEN env.
 */
export function adminAuthorized(req) {
  const envToken = process.env.TRACKER_ADMIN_TOKEN;
  if (envToken) {
    const hdr = req.headers['x-tracker-admin-token'];
    return Boolean(hdr && hdr === envToken);
  }
  // No admin token configured: only allow in local mode (loopback server).
  return isLocalMode();
}

/** Whether server may auto-provision a single local device when none exist. */
export function allowLocalAutoProvision() {
  if (process.env.TRACKER_LOCAL_AUTO_PROVISION === '0') return false;
  if (process.env.TRACKER_LOCAL_AUTO_PROVISION === '1') return true;
  return isLocalMode();
}

/** Localhost-only credential file read for agent/extension bootstrap. */
export function allowLocalCredentialRead() {
  if (process.env.TRACKER_LOCAL_CREDENTIAL_READ === '0') return false;
  return isLocalMode();
}
