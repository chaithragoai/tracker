-- Additive migration for personal assistant features (safe on existing DBs)

ALTER TABLE tracker_status ADD COLUMN last_mac_event_at TEXT;
ALTER TABLE tracker_status ADD COLUMN last_chrome_event_at TEXT;
ALTER TABLE tracker_status ADD COLUMN extension_last_seen_at TEXT;
ALTER TABLE tracker_status ADD COLUMN extension_connected INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS activity_labels (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL, -- event | app_session | tab_session
  target_id TEXT NOT NULL,
  project_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_labels_target ON activity_labels(target_type, target_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | done | dismissed
  due_at TEXT,
  project_id TEXT,
  source TEXT NOT NULL DEFAULT 'user', -- user | ai_suggestion
  confirmed INTEGER NOT NULL DEFAULT 1,
  linked_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note', -- note | fact | preference | summary
  project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS daily_briefings (
  day TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  content_json TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'deterministic'
);

-- FTS for universal search (content only, never secrets)
CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(
  doc_id,
  doc_type,
  title,
  body,
  source,
  day,
  tokenize = 'porter'
);
