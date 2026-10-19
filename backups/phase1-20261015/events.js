/**
 * Event ingest + session projection.
 * Duplicate primary keys are ignored (restart-safe).
 */

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

export function insertEvent(db, raw, source = 'unknown') {
  const id = raw.id || crypto.randomUUID();
  const timestamp = asIso(raw.timestamp);
  const type = raw.type;
  if (!type) {
    throw new Error('event.type is required');
  }

  const app = raw.app || {};
  const outcome = raw.outcome || 'unknown';

  const insert = db.prepare(`
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
    metadata_json: metadataJson(raw.metadata),
    source,
  });

  const inserted = info.changes > 0;
  if (inserted) {
    projectEvent(db, {
      id,
      timestamp,
      type,
      outcome,
      app,
      sessionId: raw.sessionId,
      tabSessionId: raw.tabSessionId,
      durationSeconds: raw.durationSeconds,
      metadata: typeof raw.metadata === 'object' && raw.metadata ? raw.metadata : JSON.parse(metadataJson(raw.metadata)),
      ...raw,
    });
    touchStatus(db, { timestamp, type, app, raw });
  }

  return { id, inserted };
}

function projectEvent(db, event) {
  switch (event.type) {
    case 'sessionStarted':
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
      upsertOpenTabSession(db, event);
      break;
    case 'tabSessionEnded':
      closeTabSession(db, event);
      break;
    default:
      break;
  }
  refreshDailySummary(db, event.timestamp.slice(0, 10));
}

function upsertOpenAppSession(db, event) {
  if (!event.sessionId) return;
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

function upsertOpenTabSession(db, event) {
  if (!event.tabSessionId && !event.sessionId) return;
  const id = event.tabSessionId || event.sessionId;
  const tab = event.tab || {};
  db.prepare(`
    INSERT OR IGNORE INTO tab_sessions (
      id, browser, tab_id, title, url, domain, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event.browser || tab.browser || 'Chrome',
    tab.tabId ?? event.tabId ?? null,
    tab.title ?? event.title ?? null,
    tab.url ?? event.url ?? null,
    tab.domain ?? event.domain ?? domainFromUrl(tab.url || event.url),
    event.timestamp
  );
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

function touchStatus(db, { timestamp, type, app, raw }) {
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

  const fields = Object.keys(patch);
  const sets = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE tracker_status SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`).run(patch);
}

export function refreshDailySummary(db, day) {
  const appRows = db.prepare(`
    SELECT bundle_identifier, app_name, COALESCE(SUM(duration_seconds), 0) AS seconds
    FROM app_sessions
    WHERE substr(started_at, 1, 10) = ? AND was_idle = 0
    GROUP BY COALESCE(bundle_identifier, app_name)
  `).all(day);

  const domainRows = db.prepare(`
    SELECT domain, COALESCE(SUM(duration_seconds), 0) AS seconds
    FROM tab_sessions
    WHERE substr(started_at, 1, 10) = ? AND domain IS NOT NULL
    GROUP BY domain
  `).all(day);

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
  let active = 0;
  for (const row of appRows) {
    const key = row.bundle_identifier || row.app_name;
    appBreakdown[key] = { name: row.app_name, seconds: row.seconds };
    active += row.seconds;
  }
  const domainBreakdown = {};
  for (const row of domainRows) {
    domainBreakdown[row.domain] = row.seconds;
  }

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
