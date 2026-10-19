/**
 * Manager dashboard: device inventory, connectivity vs activity status, detail.
 * Secrets are never included. Status rules are documented in getStatusThresholds().
 */

import {
  buildAnalytics,
  activityCeilingMs,
  parseRange,
  queryOverlappingSessions,
} from './analytics.js';

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Documented, configurable thresholds (seconds). */
export function getStatusThresholds() {
  return {
    online_checkin_seconds: numEnv('TRACKER_STATUS_ONLINE_CHECKIN_SEC', 5 * 60),
    activity_stale_seconds: numEnv('TRACKER_STATUS_ACTIVITY_STALE_SEC', 15 * 60),
    offline_checkin_seconds: numEnv('TRACKER_STATUS_OFFLINE_CHECKIN_SEC', 30 * 60),
    notes: {
      online: 'Authenticated check-in within online_checkin_seconds.',
      activity_stale: 'Reachable (recent check-in) but no Mac/Chrome activity event within activity_stale_seconds. Idle user is NOT offline.',
      stale_checkin: 'Last check-in older than online threshold but younger than offline threshold.',
      offline: 'No usable check-in within offline_checkin_seconds.',
      needs_attention: 'Revoked enrollment or explicit problem signals.',
      unknown: 'Insufficient check-in evidence (e.g. never checked in).',
    },
  };
}

function ageSeconds(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 1000);
}

function latestActivityAt(device) {
  const times = [device.last_mac_event_at, device.last_chrome_event_at].filter(Boolean);
  if (!times.length) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/**
 * Classify connectivity separately from user activity.
 * @returns {{ status, connectivity, activity, reasons: string[] }}
 */
export function classifyDeviceStatus(device, { now = Date.now(), thresholds = getStatusThresholds() } = {}) {
  const reasons = [];
  const checkInAge = ageSeconds(device.last_check_in_at, now);
  const activityAt = latestActivityAt(device);
  const activityAge = ageSeconds(activityAt, now);

  if (device.enrollment_status === 'revoked' || device.revoked_at) {
    return {
      status: 'needs_attention',
      connectivity: 'revoked',
      activity: activityAge == null ? 'unknown' : (activityAge <= thresholds.activity_stale_seconds ? 'recent' : 'stale'),
      reasons: ['Device enrollment revoked'],
      check_in_age_seconds: checkInAge,
      activity_age_seconds: activityAge,
    };
  }

  if (checkInAge == null) {
    return {
      status: 'unknown',
      connectivity: 'unknown',
      activity: activityAge == null ? 'unknown' : (activityAge <= thresholds.activity_stale_seconds ? 'recent' : 'stale'),
      reasons: ['No authenticated check-in recorded yet'],
      check_in_age_seconds: null,
      activity_age_seconds: activityAge,
    };
  }

  let connectivity;
  if (checkInAge <= thresholds.online_checkin_seconds) {
    connectivity = 'online';
  } else if (checkInAge <= thresholds.offline_checkin_seconds) {
    connectivity = 'stale';
    reasons.push('Check-in older than online threshold');
  } else {
    connectivity = 'offline';
    reasons.push('Check-in older than offline threshold');
  }

  let activity;
  if (activityAge == null) {
    activity = 'unknown';
    reasons.push('No Mac or Chrome activity timestamps yet');
  } else if (activityAge <= thresholds.activity_stale_seconds) {
    activity = 'recent';
  } else {
    activity = 'stale';
    if (connectivity === 'online') {
      reasons.push('Reachable but no recent activity (idle is not offline)');
    }
  }

  let status;
  if (connectivity === 'offline') status = 'offline';
  else if (connectivity === 'stale') status = 'stale_checkin';
  else if (connectivity === 'online' && activity === 'stale') status = 'activity_stale';
  else if (connectivity === 'online' && (activity === 'recent' || activity === 'unknown')) status = 'online';
  else status = 'unknown';

  return {
    status,
    connectivity,
    activity,
    reasons,
    check_in_age_seconds: checkInAge,
    activity_age_seconds: activityAge,
  };
}

function publicDeviceRow(device, classified, durationSeconds = 0) {
  return {
    id: device.id,
    display_name: device.display_name,
    os: device.os,
    os_version: device.os_version,
    agent_version: device.agent_version,
    enrollment_status: device.enrollment_status,
    employee_display_name: device.employee_display_name || null,
    created_at: device.created_at,
    updated_at: device.updated_at,
    last_check_in_at: device.last_check_in_at,
    last_mac_event_at: device.last_mac_event_at,
    last_chrome_event_at: device.last_chrome_event_at,
    revoked_at: device.revoked_at,
    status: classified.status,
    connectivity: classified.connectivity,
    activity: classified.activity,
    status_reasons: classified.reasons,
    check_in_age_seconds: classified.check_in_age_seconds,
    activity_age_seconds: classified.activity_age_seconds,
    tracked_seconds_in_range: durationSeconds,
  };
}

function analyticsForDevice(db, deviceId, from, to, now = Date.now()) {
  if (!from || !to) return null;
  const range = parseRange({ from, to, now });
  const device = db.prepare(`
    SELECT last_mac_event_at, last_chrome_event_at FROM devices WHERE id = ?
  `).get(deviceId) || {};
  const appSessions = queryOverlappingSessions(db, 'app_sessions', range.fromIso, range.toIso)
    .filter((s) => s.device_id === deviceId);
  const tabSessions = queryOverlappingSessions(db, 'tab_sessions', range.fromIso, range.toIso)
    .filter((s) => s.device_id === deviceId);
  return buildAnalytics({
    appSessions,
    tabSessions,
    fromMs: range.fromMs,
    toMs: range.toMs,
    nowMs: range.nowMs,
    macActivityCeilingMs: activityCeilingMs(device.last_mac_event_at, range.nowMs),
    chromeActivityCeilingMs: activityCeilingMs(device.last_chrome_event_at, range.nowMs),
  });
}

function durationForDevice(db, deviceId, from, to, now = Date.now()) {
  const analytics = analyticsForDevice(db, deviceId, from, to, now);
  if (!analytics) return 0;
  // Manager "tracked in range" = exclusive app + exclusive browser (separate signals, summed for a single device score).
  return Number(analytics.summary.totalTrackedAppSeconds || 0)
    + Number(analytics.summary.totalBrowserSeconds || 0);
}

export function getManagerSummary(db, { from, to, now = Date.now() } = {}) {
  const thresholds = getStatusThresholds();
  const devices = db.prepare(`
    SELECT id, display_name, os, os_version, agent_version, enrollment_status,
           employee_display_name, created_at, updated_at, last_check_in_at,
           last_mac_event_at, last_chrome_event_at, revoked_at
    FROM devices
  `).all();

  const counts = {
    total_enrolled: 0,
    online: 0,
    activity_stale: 0,
    stale_checkin: 0,
    offline: 0,
    needs_attention: 0,
    unknown: 0,
    revoked: 0,
  };

  for (const d of devices) {
    if (d.enrollment_status === 'active') counts.total_enrolled += 1;
    if (d.enrollment_status === 'revoked') counts.revoked += 1;
    const c = classifyDeviceStatus(d, { now, thresholds });
    if (counts[c.status] != null) counts[c.status] += 1;
  }

  return {
    thresholds,
    counts,
    range: { from: from || null, to: to || null },
    generated_at: new Date(now).toISOString(),
  };
}

export function listManagerDevices(db, {
  q = '',
  status = '',
  sort = 'last_check_in_at',
  order = 'desc',
  from,
  to,
  now = Date.now(),
} = {}) {
  const thresholds = getStatusThresholds();
  let devices = db.prepare(`
    SELECT id, display_name, os, os_version, agent_version, enrollment_status,
           employee_display_name, created_at, updated_at, last_check_in_at,
           last_mac_event_at, last_chrome_event_at, revoked_at
    FROM devices
  `).all();

  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    devices = devices.filter((d) => {
      const hay = [d.display_name, d.os, d.employee_display_name, d.id, d.enrollment_status]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }

  let rows = devices.map((d) => {
    const classified = classifyDeviceStatus(d, { now, thresholds });
    const dur = from && to ? durationForDevice(db, d.id, from, to, now) : 0;
    return publicDeviceRow(d, classified, dur);
  });

  if (status) {
    rows = rows.filter((r) => r.status === status);
  }

  const dir = String(order).toLowerCase() === 'asc' ? 1 : -1;
  const sortKey = ['display_name', 'last_check_in_at', 'status', 'tracked_seconds_in_range', 'os'].includes(sort)
    ? sort
    : 'last_check_in_at';
  rows.sort((a, b) => {
    const av = a[sortKey] ?? '';
    const bv = b[sortKey] ?? '';
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av > bv ? dir : -dir;
  });

  return { thresholds, devices: rows, generated_at: new Date(now).toISOString() };
}

export function getManagerDeviceDetail(db, deviceId, { from, to, now = Date.now(), eventLimit = 50 } = {}) {
  const device = db.prepare(`
    SELECT id, display_name, os, os_version, agent_version, enrollment_status,
           employee_display_name, created_at, updated_at, last_check_in_at,
           last_mac_event_at, last_chrome_event_at, revoked_at
    FROM devices WHERE id = ?
  `).get(deviceId);
  if (!device) {
    const err = new Error('Device not found');
    err.status = 404;
    err.code = 'device_not_found';
    throw err;
  }

  const thresholds = getStatusThresholds();
  const classified = classifyDeviceStatus(device, { now, thresholds });
  const deviceAnalytics = from && to ? analyticsForDevice(db, deviceId, from, to, now) : null;
  const trackedSeconds = deviceAnalytics
    ? Number(deviceAnalytics.summary.totalTrackedAppSeconds || 0)
      + Number(deviceAnalytics.summary.totalBrowserSeconds || 0)
    : 0;

  const apps = deviceAnalytics
    ? deviceAnalytics.applications.items.slice(0, 25).map((a) => ({
      name: a.name,
      bundle_identifier: a.key,
      seconds: a.seconds,
    }))
    : [];

  const sites = deviceAnalytics
    ? deviceAnalytics.websites.items.slice(0, 25).map((s) => ({
      name: s.name,
      domain: s.key,
      seconds: s.seconds,
    }))
    : [];

  const events = db.prepare(`
    SELECT id, timestamp, type, outcome, app_name, bundle_identifier, source, duration_seconds, metadata_json
    FROM events
    WHERE device_id = ?
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(deviceId, from || null, from || null, to || null, to || null, eventLimit);

  const gaps = db.prepare(`
    SELECT e.id, e.timestamp, e.metadata_json, e.duration_seconds
    FROM events e
    WHERE e.device_id = ? AND e.type = 'gapDetected'
      AND (? IS NULL OR e.timestamp >= ?)
      AND (? IS NULL OR e.timestamp <= ?)
    ORDER BY e.timestamp DESC
    LIMIT 20
  `).all(deviceId, from || null, from || null, to || null, to || null);

  const errors = db.prepare(`
    SELECT id, timestamp, type, outcome, source, metadata_json
    FROM events
    WHERE device_id = ?
      AND (outcome = 'failure' OR type = 'error' OR lower(coalesce(outcome,'')) = 'failure')
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    ORDER BY timestamp DESC
    LIMIT 20
  `).all(deviceId, from || null, from || null, to || null, to || null);

  const audits = db.prepare(`
    SELECT id, action, actor, created_at, detail_json
    FROM audit_logs
    WHERE device_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(deviceId);

  return {
    thresholds,
    device: publicDeviceRow(device, classified, trackedSeconds),
    range: { from: from || null, to: to || null },
    applications: apps.map((a) => ({ name: a.name, bundle_identifier: a.bundle_identifier, seconds: Number(a.seconds) || 0 })),
    websites: sites.map((s) => ({ name: s.name, domain: s.domain, seconds: Number(s.seconds) || 0 })),
    events: events.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      outcome: e.outcome,
      app_name: e.app_name,
      bundle_identifier: e.bundle_identifier,
      source: e.source,
      duration_seconds: e.duration_seconds,
      // metadata may include URLs/titles — already sanitized at ingest; never secrets
      metadata: safeParse(e.metadata_json),
    })),
    gaps: gaps.map((g) => ({ id: g.id, timestamp: g.timestamp, duration_seconds: g.duration_seconds, metadata: safeParse(g.metadata_json) })),
    errors: errors.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      type: e.type,
      outcome: e.outcome,
      source: e.source,
      metadata: safeParse(e.metadata_json),
    })),
    audit: audits.map((a) => ({
      id: a.id,
      action: a.action,
      actor: a.actor,
      created_at: a.created_at,
      detail: safeParse(a.detail_json),
    })),
    generated_at: new Date(now).toISOString(),
  };
}

function safeParse(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}
