/**
 * Event ingest + session projection.
 * Duplicate primary keys are ignored (restart-safe).
 */

import { buildAnalytics, activityCeilingMs } from './analytics.js';

function asIso(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function metadataJson(meta) {
  if (!meta) return '{}';
  if (typeof meta === 'string') return meta;
  return JSON.stringify(meta);
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.deviceId] Server-authenticated device id only (never trust body.device_id).
 */
export function insertEvent(db, raw, source = 'unknown', opts = {}) {
  const id = raw.id || crypto.randomUUID();
  const timestamp = asIso(raw.timestamp);
  const type = raw.type;
  if (!type) {
    throw new Error('event.type is required');
  }

  const app = raw.app || {};
  const outcome = raw.outcome || 'unknown';
  const enrichedMeta = enrichMetadata(raw);
  // Attribution comes only from authenticated context — ignore client-supplied device_id.
  const deviceId = opts.deviceId ?? null;

  const hasDeviceCol = columnExists(db, 'events', 'device_id');
  const insert = db.prepare(hasDeviceCol ? `
    INSERT OR IGNORE INTO events (
      id, timestamp, type, outcome,
      app_name, bundle_identifier, process_identifier,
      session_id, tab_session_id, duration_seconds,
      metadata_json, source, device_id
    ) VALUES (
      @id, @timestamp, @type, @outcome,
      @app_name, @bundle_identifier, @process_identifier,
      @session_id, @tab_session_id, @duration_seconds,
      @metadata_json, @source, @device_id
    )
  ` : `
    INSERT OR IGNORE INTO events (
      id, timestamp, type, outcome,
      app_name, bundle_identifier, process_identifier,
      session_id, tab_session_id, duration_seconds,
      metadata_json, source
    ) VALUES (
      @id, @timestamp, @type, @outcome,
      @app_name, @bundle_identifier, @process_identifier,
      @session_id, @tab_session_id, @duration_seconds,
      @metadata_json, @source
    )
  `);

  const info = insert.run({
    id,
    timestamp,
    type,
    outcome,
    app_name: app.name ?? null,
    bundle_identifier: app.bundleIdentifier ?? null,
    process_identifier: app.processIdentifier ?? null,
    session_id: raw.sessionId ?? null,
    tab_session_id: raw.tabSessionId ?? null,
    duration_seconds: raw.durationSeconds ?? null,
    metadata_json: metadataJson(enrichedMeta),
    source,
    device_id: deviceId,
  });

  const inserted = info.changes > 0;
  if (inserted) {
    projectEvent(db, {
      ...raw,
      id,
      timestamp,
      type,
      outcome,
      app,
      sessionId: raw.sessionId,
      tabSessionId: raw.tabSessionId,
      durationSeconds: raw.durationSeconds,
      metadata: enrichedMeta,
      deviceId, // always server-auth attribution; overrides any body field
    });
    touchStatus(db, { timestamp, type, app, raw, source });
    if (deviceId) {
      // Heartbeats confirm reachability only — do not invent "recent activity".
      if (type === 'extensionHeartbeat') {
        requireDeviceActivity().recordCheckInOnly(db, deviceId, timestamp);
      } else {
        requireDeviceActivity().recordDeviceActivity(db, deviceId, source, timestamp);
      }
    }
    indexEventForSearch(db, {
      id,
      type,
      timestamp,
      source,
      app,
      metadata: enrichedMeta,
    });
  }

  return { id, inserted, device_id: deviceId };
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function requireDeviceActivity() {
  return {
    recordCheckInOnly(db, deviceId, timestamp) {
      db.prepare(`
        UPDATE devices SET last_check_in_at = ?, updated_at = ? WHERE id = ?
      `).run(timestamp, timestamp, deviceId);
    },
    recordDeviceActivity(db, deviceId, source, timestamp) {
      const ts = timestamp;
      const fields = ['last_check_in_at = ?', 'updated_at = ?'];
      const params = [ts, ts];
      if (source === 'mac-agent') {
        fields.push('last_mac_event_at = ?');
        params.push(ts);
      }
      if (source === 'chrome-extension') {
        fields.push('last_chrome_event_at = ?');
        params.push(ts);
      }
      params.push(deviceId);
      db.prepare(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    },
  };
}

/** Merge safe browser fields into metadata for search (never passwords/values). */
function enrichMetadata(raw) {
  const base = typeof raw.metadata === 'object' && raw.metadata ? { ...raw.metadata } : {};
  const tab = raw.tab || {};
  if (raw.title || tab.title) base.title = String(raw.title || tab.title).slice(0, 300);
  if (raw.url || tab.url) base.url = String(raw.url || tab.url).slice(0, 500);
  if (raw.domain || tab.domain) base.domain = String(raw.domain || tab.domain).slice(0, 200);
  if (raw.browser || tab.browser) base.browser = String(raw.browser || tab.browser);
  return base;
}

function indexEventForSearch(db, { id, type, timestamp, source, app, metadata }) {
  try {
    const title = metadata.title || app?.name || type;
    const body = [type, app?.name, app?.bundleIdentifier, metadata.domain, metadata.url, metadata.semantic, metadata.reason]
      .filter(Boolean)
      .join(' ');
    db.prepare(`
      INSERT INTO activity_fts (doc_id, doc_type, title, body, source, day)
      VALUES (?, 'event', ?, ?, ?, ?)
    `).run(id, title || type, body, source || 'unknown', String(timestamp).slice(0, 10));
  } catch {
    // FTS table may not exist on very old DBs mid-migration
  }
}

function projectEvent(db, event) {
  switch (event.type) {
    case 'sessionStarted':
      // Frontmost-app model: a new app session ends other still-open app sessions so
      // orphans from agent restarts do not keep accumulating concurrent time.
      closeOtherOpenAppSessions(db, event);
      upsertOpenAppSession(db, event);
      break;
    case 'sessionEnded':
    case 'appDeactivated':
      closeAppSession(db, event);
      break;
    case 'idleStarted':
      openIdle(db, event);
      break;
    case 'idleEnded':
      closeIdle(db, event);
      break;
    case 'gapDetected':
      insertGap(db, event);
      break;
    case 'tabSessionStarted':
      // Active-tab model: a new tab session ends other still-open tab sessions so
      // orphaned rows from extension reloads do not keep accumulating forever.
      closeOtherOpenTabSessions(db, event);
      upsertOpenTabSession(db, event);
      break;
    case 'tabSessionEnded':
      closeTabSession(db, event);
      break;
    case 'contextUpdated':
      applyAppContext(db, event);
      break;
    case 'click':
    case 'search':
      bumpTabEngagement(db, event, event.type === 'search' ? 2 : 1);
      break;
    case 'navigation':
      if (event.outcome === 'success') bumpTabEngagement(db, event, 0.5);
      break;
    default:
      break;
  }
  refreshDailySummary(db, event.timestamp.slice(0, 10));
}

function applyAppContext(db, event) {
  const sid = event.sessionId;
  if (!sid) return;
  const title = event.metadata?.windowTitle || event.metadata?.window_title || null;
  const hint = event.metadata?.projectHint || event.metadata?.project_hint || null;
  if (!title && !hint) return;
  if (!columnExists(db, 'app_sessions', 'window_title')) return;
  db.prepare(`
    UPDATE app_sessions
    SET window_title = COALESCE(?, window_title),
        project_hint = COALESCE(?, project_hint)
    WHERE id = ?
  `).run(title, hint, sid);
}

function bumpTabEngagement(db, event, amount) {
  if (!columnExists(db, 'tab_sessions', 'engagement_score')) return;
  const id = event.tabSessionId;
  if (id) {
    db.prepare(`
      UPDATE tab_sessions SET engagement_score = COALESCE(engagement_score,0) + ?
      WHERE id = ?
    `).run(amount, id);
    return;
  }
  // Fall back: bump the currently open tab session
  const open = db.prepare(`
    SELECT id FROM tab_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
  `).get();
  if (open) {
    db.prepare(`
      UPDATE tab_sessions SET engagement_score = COALESCE(engagement_score,0) + ?
      WHERE id = ?
    `).run(amount, open.id);
  }
}

function closeOtherOpenAppSessions(db, event) {
  const keepId = event.sessionId;
  if (!keepId) return;
  const ts = event.timestamp;
  const open = db.prepare(`
    SELECT id, started_at FROM app_sessions
    WHERE ended_at IS NULL AND id != ?
  `).all(keepId);
  const upd = db.prepare(`
    UPDATE app_sessions
    SET ended_at = ?, duration_seconds = ?, end_reason = ?
    WHERE id = ? AND ended_at IS NULL
  `);
  for (const row of open) {
    const start = Date.parse(row.started_at);
    const end = Date.parse(ts);
    const duration = Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, (end - start) / 1000)
      : 0;
    upd.run(ts, duration, 'superseded_by_frontmost_app', row.id);
  }
}

function upsertOpenAppSession(db, event) {
  if (!event.sessionId) return;
  const title = event.metadata?.windowTitle || event.metadata?.window_title || null;
  const hint = event.metadata?.projectHint || event.metadata?.project_hint || null;
  const hasCtx = columnExists(db, 'app_sessions', 'window_title');
  const hasDevice = columnExists(db, 'app_sessions', 'device_id');

  if (hasDevice && hasCtx) {
    db.prepare(`
      INSERT INTO app_sessions (
        id, app_name, bundle_identifier, process_identifier, started_at, was_idle, device_id, window_title, project_hint
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        window_title = COALESCE(excluded.window_title, app_sessions.window_title),
        project_hint = COALESCE(excluded.project_hint, app_sessions.project_hint)
    `).run(
      event.sessionId,
      event.app?.name || 'Unknown',
      event.app?.bundleIdentifier ?? null,
      event.app?.processIdentifier ?? null,
      event.timestamp,
      event.deviceId ?? null,
      title,
      hint
    );
    return;
  }

  if (hasDevice) {
    db.prepare(`
      INSERT OR IGNORE INTO app_sessions (
        id, app_name, bundle_identifier, process_identifier, started_at, was_idle, device_id
      ) VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(
      event.sessionId,
      event.app?.name || 'Unknown',
      event.app?.bundleIdentifier ?? null,
      event.app?.processIdentifier ?? null,
      event.timestamp,
      event.deviceId ?? null
    );
    return;
  }

  if (hasCtx) {
    db.prepare(`
      INSERT INTO app_sessions (
        id, app_name, bundle_identifier, process_identifier, started_at, was_idle, window_title, project_hint
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        window_title = COALESCE(excluded.window_title, app_sessions.window_title),
        project_hint = COALESCE(excluded.project_hint, app_sessions.project_hint)
    `).run(
      event.sessionId,
      event.app?.name || 'Unknown',
      event.app?.bundleIdentifier ?? null,
      event.app?.processIdentifier ?? null,
      event.timestamp,
      title,
      hint
    );
    return;
  }

  db.prepare(`
    INSERT OR IGNORE INTO app_sessions (
      id, app_name, bundle_identifier, process_identifier, started_at, was_idle
    ) VALUES (?, ?, ?, ?, ?, 0)
  `).run(
    event.sessionId,
    event.app?.name || 'Unknown',
    event.app?.bundleIdentifier ?? null,
    event.app?.processIdentifier ?? null,
    event.timestamp
  );
}

function closeAppSession(db, event) {
  if (!event.sessionId) return;
  const existing = db.prepare('SELECT id, started_at, ended_at FROM app_sessions WHERE id = ?').get(event.sessionId);
  if (!existing) {
    // Late close without start — still record a closed row from metadata if possible
    db.prepare(`
      INSERT OR IGNORE INTO app_sessions (
        id, app_name, bundle_identifier, process_identifier,
        started_at, ended_at, duration_seconds, end_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.sessionId,
      event.app?.name || 'Unknown',
      event.app?.bundleIdentifier ?? null,
      event.app?.processIdentifier ?? null,
      event.timestamp,
      event.timestamp,
      event.durationSeconds ?? 0,
      event.metadata?.reason ?? event.type
    );
    return;
  }
  if (existing.ended_at) return; // already closed — no overlap rewrite

  const duration = event.durationSeconds ?? secondsBetween(existing.started_at, event.timestamp);
  db.prepare(`
    UPDATE app_sessions
    SET ended_at = ?, duration_seconds = ?, end_reason = ?
    WHERE id = ? AND ended_at IS NULL
  `).run(event.timestamp, duration, event.metadata?.reason ?? event.type, event.sessionId);
}

function openIdle(db, event) {
  const id = event.id;
  db.prepare(`
    INSERT OR IGNORE INTO idle_periods (id, started_at, interrupted_session_id)
    VALUES (?, ?, ?)
  `).run(id, event.timestamp, event.sessionId ?? null);

  if (event.sessionId) {
    db.prepare('UPDATE app_sessions SET was_idle = 1 WHERE id = ?').run(event.sessionId);
  }
}

function closeIdle(db, event) {
  const open = db.prepare(`
    SELECT id, started_at FROM idle_periods
    WHERE ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `).get();
  if (!open) return;
  const duration = event.durationSeconds ?? secondsBetween(open.started_at, event.timestamp);
  db.prepare(`
    UPDATE idle_periods SET ended_at = ?, duration_seconds = ? WHERE id = ?
  `).run(event.timestamp, duration, open.id);
}

function insertGap(db, event) {
  const start = event.metadata?.gapStart || event.timestamp;
  const end = event.metadata?.gapEnd || event.timestamp;
  db.prepare(`
    INSERT OR IGNORE INTO tracking_gaps (id, started_at, ended_at, duration_seconds, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    event.id,
    asIso(start),
    asIso(end),
    event.durationSeconds ?? secondsBetween(start, end),
    event.metadata?.reason || 'unknown'
  );
}

function closeOtherOpenTabSessions(db, event) {
  const keepId = event.tabSessionId || event.sessionId;
  if (!keepId) return;
  const ts = event.timestamp;
  const open = db.prepare(`
    SELECT id, started_at FROM tab_sessions
    WHERE ended_at IS NULL AND id != ?
  `).all(keepId);
  const upd = db.prepare(`
    UPDATE tab_sessions
    SET ended_at = ?, duration_seconds = ?, end_reason = ?
    WHERE id = ? AND ended_at IS NULL
  `);
  for (const row of open) {
    const start = Date.parse(row.started_at);
    const end = Date.parse(ts);
    const duration = Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, (end - start) / 1000)
      : 0;
    upd.run(ts, duration, 'superseded_by_active_tab', row.id);
  }
}

function upsertOpenTabSession(db, event) {
  if (!event.tabSessionId && !event.sessionId) return;
  const id = event.tabSessionId || event.sessionId;
  const tab = event.tab || {};
  const args = [
    id,
    event.browser || tab.browser || 'Chrome',
    tab.tabId ?? event.tabId ?? null,
    tab.title ?? event.title ?? null,
    tab.url ?? event.url ?? null,
    tab.domain ?? event.domain ?? domainFromUrl(tab.url || event.url),
    event.timestamp,
  ];
  if (columnExists(db, 'tab_sessions', 'device_id')) {
    db.prepare(`
      INSERT OR IGNORE INTO tab_sessions (
        id, browser, tab_id, title, url, domain, started_at, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...args, event.deviceId ?? null);
    return;
  }
  db.prepare(`
    INSERT OR IGNORE INTO tab_sessions (
      id, browser, tab_id, title, url, domain, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(...args);
}

function closeTabSession(db, event) {
  const id = event.tabSessionId || event.sessionId;
  if (!id) return;
  const existing = db.prepare('SELECT started_at, ended_at FROM tab_sessions WHERE id = ?').get(id);
  if (!existing || existing.ended_at) return;
  const duration = event.durationSeconds ?? secondsBetween(existing.started_at, event.timestamp);
  db.prepare(`
    UPDATE tab_sessions
    SET ended_at = ?, duration_seconds = ?, end_reason = ?
    WHERE id = ? AND ended_at IS NULL
  `).run(event.timestamp, duration, event.metadata?.reason ?? event.type, id);
}

function touchStatus(db, { timestamp, type, app, raw, source }) {
  const statusMap = {
    trackerStarted: 'running',
    trackerStopped: 'stopped',
    trackerPaused: 'paused',
    trackerResumed: 'running',
  };
  const patch = {
    last_event_at: timestamp,
  };
  if (statusMap[type]) patch.status = statusMap[type];
  if (app?.name) {
    patch.current_app_name = app.name;
    patch.current_bundle_identifier = app.bundleIdentifier ?? null;
  }
  if (raw.tab?.title || raw.title) {
    patch.current_tab_title = raw.tab?.title || raw.title;
    patch.current_tab_url = raw.tab?.url || raw.url || null;
  }

  const src = source || raw.source || '';
  if (src === 'mac-agent' || String(type).startsWith('app') || type === 'sessionStarted' || type === 'sessionEnded' || type === 'idleStarted' || type === 'idleEnded' || type === 'gapDetected' || type === 'sleep' || type === 'wake' || statusMap[type]) {
    patch.last_mac_event_at = timestamp;
  }
  if (src === 'chrome-extension' || type === 'extensionHeartbeat' || String(type).startsWith('tab') || ['click', 'search', 'formSubmit', 'navigation', 'download', 'upload', 'operation'].includes(type)) {
    patch.last_chrome_event_at = timestamp;
    patch.extension_last_seen_at = timestamp;
    patch.extension_connected = 1;
  }
  if (type === 'extensionHeartbeat') {
    patch.extension_last_seen_at = timestamp;
    patch.extension_connected = 1;
  }

  // Only update columns that exist (pre-migration safety)
  const existing = new Set(db.prepare('PRAGMA table_info(tracker_status)').all().map((c) => c.name));
  const fields = Object.keys(patch).filter((f) => existing.has(f));
  if (!fields.length) return;
  const sets = fields.map((f) => `${f} = @${f}`).join(', ');
  const params = {};
  for (const f of fields) params[f] = patch[f];
  db.prepare(`UPDATE tracker_status SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`).run(params);
}

/** Tracking health for dashboard / extension popup. */
export function getTrackingHealth(db, { now = Date.now() } = {}) {
  const status = db.prepare('SELECT * FROM tracker_status WHERE id = 1').get() || {};
  const chromeAgeSec = status.last_chrome_event_at
    ? Math.max(0, (now - Date.parse(status.last_chrome_event_at)) / 1000)
    : null;
  const macAgeSec = status.last_mac_event_at
    ? Math.max(0, (now - Date.parse(status.last_mac_event_at)) / 1000)
    : null;
  const extAgeSec = status.extension_last_seen_at
    ? Math.max(0, (now - Date.parse(status.extension_last_seen_at)) / 1000)
    : null;

  // Extension considered connected if seen within 3 minutes
  const extensionConnected = extAgeSec != null && extAgeSec < 180;

  return {
    status: status.status || 'unknown',
    current_app_name: status.current_app_name || null,
    current_bundle_identifier: status.current_bundle_identifier || null,
    current_tab_title: status.current_tab_title || null,
    current_tab_url: status.current_tab_url || null,
    last_event_at: status.last_event_at || null,
    last_mac_event_at: status.last_mac_event_at || null,
    last_chrome_event_at: status.last_chrome_event_at || null,
    extension_last_seen_at: status.extension_last_seen_at || null,
    extension_connected: extensionConnected,
    mac_event_age_seconds: macAgeSec,
    chrome_event_age_seconds: chromeAgeSec,
    notes: {
      timezone: 'Timestamps stored in UTC ISO-8601; dashboard displays local time.',
      appWebsiteSeparate: true,
      websiteTiming: 'Website time counts active-tab sessions (after Phase 1 hardening).',
    },
  };
}

export function refreshDailySummary(db, day, { now = Date.now() } = {}) {
  // Include open sessions by clipping to now (or end of UTC day), same idea as analytics.
  // Using only duration_seconds left open rows at 0 and made Reports/Weekly look random/too small.
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const dayEnd = Date.parse(`${day}T23:59:59.999Z`);
  const clipEndMs = Math.min(now, dayEnd);

  const appSessions = db.prepare(`
    SELECT * FROM app_sessions
    WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) AND was_idle = 0
  `).all(new Date(dayEnd).toISOString(), new Date(dayStart).toISOString());

  const tabSessions = db.prepare(`
    SELECT * FROM tab_sessions
    WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) AND domain IS NOT NULL
  `).all(new Date(dayEnd).toISOString(), new Date(dayStart).toISOString());

  let status = {};
  try {
    status = db.prepare(`
      SELECT last_mac_event_at, last_chrome_event_at FROM tracker_status WHERE id = 1
    `).get() || {};
  } catch {
    status = {};
  }
  const analytics = buildAnalytics({
    appSessions,
    tabSessions,
    fromMs: dayStart,
    toMs: dayEnd,
    nowMs: clipEndMs,
    macActivityCeilingMs: activityCeilingMs(status.last_mac_event_at, clipEndMs),
    chromeActivityCeilingMs: activityCeilingMs(status.last_chrome_event_at, clipEndMs),
  });

  const idle = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS seconds FROM idle_periods
    WHERE substr(started_at, 1, 10) = ?
  `).get(day).seconds;

  const gaps = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS seconds FROM tracking_gaps
    WHERE substr(started_at, 1, 10) = ?
  `).get(day).seconds;

  const ops = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE substr(timestamp, 1, 10) = ?
      AND (
        type LIKE 'operation%'
        OR type IN ('click','search','formSubmit','navigation','download','upload')
      )
  `).get(day).c;

  const errors = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE substr(timestamp, 1, 10) = ? AND (type = 'error' OR outcome = 'failure')
  `).get(day).c;

  const appBreakdown = {};
  for (const item of analytics.applications.items) {
    appBreakdown[item.key] = { name: item.name, seconds: item.seconds };
  }
  const domainBreakdown = {};
  for (const item of analytics.websites.items) {
    domainBreakdown[item.key] = item.seconds;
  }
  const active = analytics.summary.totalTrackedAppSeconds;

  db.prepare(`
    INSERT INTO daily_summaries (
      day, active_seconds, idle_seconds, app_breakdown_json, domain_breakdown_json,
      operation_count, error_count, gap_seconds, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(day) DO UPDATE SET
      active_seconds = excluded.active_seconds,
      idle_seconds = excluded.idle_seconds,
      app_breakdown_json = excluded.app_breakdown_json,
      domain_breakdown_json = excluded.domain_breakdown_json,
      operation_count = excluded.operation_count,
      error_count = excluded.error_count,
      gap_seconds = excluded.gap_seconds,
      updated_at = excluded.updated_at
  `).run(
    day,
    active,
    idle,
    JSON.stringify(appBreakdown),
    JSON.stringify(domainBreakdown),
    ops,
    errors,
    gaps
  );
}

function secondsBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, ms / 1000);
}

function domainFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function queryEvents(db, { from, to, type, bundle, q, limit = 200 } = {}) {
  const clauses = [];
  const params = {};
  if (from) { clauses.push('timestamp >= @from'); params.from = from; }
  if (to) { clauses.push('timestamp <= @to'); params.to = to; }
  if (type) { clauses.push('type = @type'); params.type = type; }
  if (bundle) { clauses.push('bundle_identifier = @bundle'); params.bundle = bundle; }
  if (q) {
    clauses.push('(app_name LIKE @q OR metadata_json LIKE @q OR type LIKE @q)');
    params.q = `%${q}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.limit = Math.min(Number(limit) || 200, 2000);
  return db.prepare(`SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT @limit`).all(params);
}

export function getStatus(db) {
  return db.prepare('SELECT * FROM tracker_status WHERE id = 1').get();
}

export function exportEventsCsv(db, { from, to } = {}) {
  const rows = queryEvents(db, { from, to, limit: 10000 });
  const header = ['id', 'timestamp', 'type', 'outcome', 'app_name', 'bundle_identifier', 'session_id', 'duration_seconds', 'source'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      csv(r.id), csv(r.timestamp), csv(r.type), csv(r.outcome),
      csv(r.app_name), csv(r.bundle_identifier), csv(r.session_id),
      r.duration_seconds ?? '', csv(r.source),
    ].join(','));
  }
  return lines.join('\n');
}

function csv(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
