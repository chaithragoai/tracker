export function listMemories(db) {
  return db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT 200').all();
}

export function createMemory(db, body) {
  const id = body.id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO memories (id, title, body, kind, project_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    String(body.title || '').trim() || 'Note',
    String(body.body || '').trim(),
    body.kind || 'note',
    body.project_id || null
  );
  indexMemory(db, id);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

export function updateMemory(db, id, patch) {
  const cur = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!cur) return null;
  db.prepare(`
    UPDATE memories SET title=?, body=?, kind=?, project_id=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(
    patch.title ?? cur.title,
    patch.body ?? cur.body,
    patch.kind ?? cur.kind,
    patch.project_id ?? cur.project_id,
    id
  );
  db.prepare(`DELETE FROM activity_fts WHERE doc_id = ? AND doc_type = 'memory'`).run(id);
  indexMemory(db, id);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

export function deleteMemory(db, id) {
  db.prepare(`DELETE FROM activity_fts WHERE doc_id = ? AND doc_type = 'memory'`).run(id);
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
}

function indexMemory(db, id) {
  const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!m) return;
  db.prepare(`
    INSERT INTO activity_fts (doc_id, doc_type, title, body, source, day)
    VALUES (?, 'memory', ?, ?, 'memory', ?)
  `).run(id, m.title, m.body, String(m.created_at).slice(0, 10));
}

export function listProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY name').all();
}

export function createProject(db, body) {
  const id = body.id || crypto.randomUUID();
  db.prepare(`INSERT INTO projects (id, name, color, notes) VALUES (?, ?, ?, ?)`).run(
    id,
    String(body.name || '').trim(),
    body.color || null,
    body.notes || null
  );
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function deleteProject(db, id) {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}
