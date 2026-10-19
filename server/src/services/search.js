/**
 * Universal local search over events, sessions, tasks, memories.
 * Never returns secrets — only stored metadata titles/domains/notes.
 */

export function searchActivity(db, {
  q = '',
  from,
  to,
  type,
  source,
  limit = 50,
} = {}) {
  const lim = Math.min(Number(limit) || 50, 200);
  const results = [];
  const query = String(q || '').trim();

  // 1) FTS when query present
  if (query) {
    try {
      const fts = db.prepare(`
        SELECT doc_id, doc_type, title, body, source, day, rank
        FROM activity_fts
        WHERE activity_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(sanitizeFts(query), lim);
      for (const row of fts) {
        results.push({
          id: row.doc_id,
          kind: row.doc_type,
          title: row.title,
          snippet: row.body,
          source: row.source,
          day: row.day,
          relevance: 'fts',
          factType: 'recorded',
        });
      }
    } catch {
      // Fallback to LIKE if FTS query invalid
    }
  }

  // 2) Events LIKE / filters
  const clauses = [];
  const params = { limit: lim };
  if (from) { clauses.push('timestamp >= @from'); params.from = from; }
  if (to) { clauses.push('timestamp <= @to'); params.to = to; }
  if (type) { clauses.push('type = @type'); params.type = type; }
  if (source) { clauses.push('source = @source'); params.source = source; }
  if (query) {
    clauses.push('(app_name LIKE @q OR metadata_json LIKE @q OR type LIKE @q OR bundle_identifier LIKE @q)');
    params.q = `%${query}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const events = db.prepare(`
    SELECT id, timestamp, type, outcome, app_name, bundle_identifier, duration_seconds, metadata_json, source, session_id, tab_session_id
    FROM events ${where}
    ORDER BY timestamp DESC
    LIMIT @limit
  `).all(params);

  const seen = new Set(results.map((r) => r.id));
  for (const e of events) {
    if (seen.has(e.id)) continue;
    let meta = {};
    try { meta = JSON.parse(e.metadata_json || '{}'); } catch { /* ignore */ }
    results.push({
      id: e.id,
      kind: 'event',
      title: meta.title || e.app_name || e.type,
      snippet: [e.type, e.app_name, meta.domain, meta.url, meta.semantic].filter(Boolean).join(' · '),
      timestamp: e.timestamp,
      duration_seconds: e.duration_seconds,
      source: e.source,
      type: e.type,
      outcome: e.outcome,
      session_id: e.session_id,
      tab_session_id: e.tab_session_id,
      relevance: query ? 'like' : 'time',
      factType: 'recorded',
    });
  }

  // 3) Tab sessions by domain/title
  if (query || from || to) {
    const tClauses = [];
    const tParams = { limit: lim };
    if (from) { tClauses.push('started_at >= @from'); tParams.from = from; }
    if (to) { tClauses.push('started_at <= @to'); tParams.to = to; }
    if (query) {
      tClauses.push('(domain LIKE @q OR title LIKE @q OR url LIKE @q)');
      tParams.q = `%${query}%`;
    }
    const tWhere = tClauses.length ? `WHERE ${tClauses.join(' AND ')}` : '';
    const tabs = db.prepare(`SELECT * FROM tab_sessions ${tWhere} ORDER BY started_at DESC LIMIT @limit`).all(tParams);
    for (const t of tabs) {
      const id = `tab:${t.id}`;
      if (seen.has(t.id) || seen.has(id)) continue;
      results.push({
        id: t.id,
        kind: 'tab_session',
        title: t.title || t.domain || 'Tab session',
        snippet: [t.domain, t.url].filter(Boolean).join(' · '),
        timestamp: t.started_at,
        ended_at: t.ended_at,
        duration_seconds: t.duration_seconds,
        source: 'chrome-extension',
        relevance: 'session',
        factType: 'recorded',
      });
    }
  }

  // 4) Memories & tasks (curated)
  if (query) {
    const mems = db.prepare(`
      SELECT id, title, body, kind, created_at FROM memories
      WHERE title LIKE ? OR body LIKE ?
      ORDER BY updated_at DESC LIMIT ?
    `).all(`%${query}%`, `%${query}%`, lim);
    for (const m of mems) {
      results.push({
        id: m.id,
        kind: 'memory',
        title: m.title,
        snippet: m.body.slice(0, 200),
        timestamp: m.created_at,
        source: 'memory',
        relevance: 'memory',
        factType: 'curated',
      });
    }
    const tasks = db.prepare(`
      SELECT id, title, details, status, created_at, source, confirmed FROM tasks
      WHERE title LIKE ? OR IFNULL(details,'') LIKE ?
      ORDER BY updated_at DESC LIMIT ?
    `).all(`%${query}%`, `%${query}%`, lim);
    for (const t of tasks) {
      results.push({
        id: t.id,
        kind: 'task',
        title: t.title,
        snippet: `${t.status}${t.confirmed ? '' : ' · unconfirmed suggestion'}`,
        timestamp: t.created_at,
        source: t.source,
        relevance: 'task',
        factType: t.confirmed ? 'curated' : 'suggestion',
      });
    }
  }

  // Prefer time order when no query; keep FTS-first then merge unique
  if (!query) {
    results.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  }
  return { q: query, count: results.length, results: results.slice(0, lim) };
}

function sanitizeFts(q) {
  // Quote tokens for FTS5 prefix-safe simple match
  return q
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' AND ');
}
