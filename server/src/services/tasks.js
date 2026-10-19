export function listTasks(db, { status, confirmed } = {}) {
  const clauses = [];
  const params = {};
  if (status) { clauses.push('status = @status'); params.status = status; }
  if (confirmed != null) { clauses.push('confirmed = @confirmed'); params.confirmed = confirmed ? 1 : 0; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT 200`).all(params);
}

export function createTask(db, body) {
  const id = body.id || crypto.randomUUID();
  const confirmed = body.confirmed === false || body.source === 'ai_suggestion' ? 0 : 1;
  const source = body.source || 'user';
  db.prepare(`
    INSERT INTO tasks (id, title, details, status, due_at, project_id, source, confirmed, linked_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(body.title || '').trim() || 'Untitled task',
    body.details || null,
    body.status || 'open',
    body.due_at || null,
    body.project_id || null,
    source,
    confirmed,
    body.linked_event_id || null
  );
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function updateTask(db, id, patch) {
  const cur = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!cur) return null;
  const next = {
    title: patch.title ?? cur.title,
    details: patch.details ?? cur.details,
    status: patch.status ?? cur.status,
    due_at: patch.due_at ?? cur.due_at,
    project_id: patch.project_id ?? cur.project_id,
    confirmed: patch.confirmed != null ? (patch.confirmed ? 1 : 0) : cur.confirmed,
  };
  db.prepare(`
    UPDATE tasks SET title=?, details=?, status=?, due_at=?, project_id=?, confirmed=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(next.title, next.details, next.status, next.due_at, next.project_id, next.confirmed, id);
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function deleteTask(db, id) {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}

/** Suggest tasks only with weak evidence — never auto-confirm. */
export function suggestTasksFromActivity(db, day) {
  const top = db.prepare(`
    SELECT app_name, COUNT(*) AS switches FROM events
    WHERE substr(timestamp,1,10)=? AND type='sessionStarted' AND app_name IS NOT NULL
    GROUP BY app_name ORDER BY switches DESC LIMIT 3
  `).all(day);
  return top.map((row) => ({
    title: `Follow up on work in ${row.app_name}`,
    details: `Suggested because ${row.switches} app session starts were recorded in ${row.app_name} on ${day}. This is not proof of unfinished work.`,
    source: 'ai_suggestion',
    confirmed: false,
    evidence: { day, switches: row.switches, app_name: row.app_name },
    factType: 'suggestion',
  }));
}
