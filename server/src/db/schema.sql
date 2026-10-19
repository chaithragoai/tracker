-- Mac Activity Tracker schema (versioned via schema_migrations)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'unknown',
  app_name TEXT,
  bundle_identifier TEXT,
  process_identifier INTEGER,
  session_id TEXT,
  tab_session_id TEXT,
  duration_seconds REAL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_bundle ON events(bundle_identifier);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

CREATE TABLE IF NOT EXISTS app_sessions (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  bundle_identifier TEXT,
  process_identifier INTEGER,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds REAL,
  was_idle INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_started ON app_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_app_sessions_bundle ON app_sessions(bundle_identifier);

CREATE TABLE IF NOT EXISTS tab_sessions (
  id TEXT PRIMARY KEY,
  browser TEXT NOT NULL,
  tab_id INTEGER,
  title TEXT,
  url TEXT,
  domain TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds REAL,
  end_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_tab_sessions_started ON tab_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_tab_sessions_domain ON tab_sessions(domain);

CREATE TABLE IF NOT EXISTS idle_periods (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds REAL,
  interrupted_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tracking_gaps (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_seconds REAL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  day TEXT PRIMARY KEY,
  active_seconds REAL NOT NULL DEFAULT 0,
  idle_seconds REAL NOT NULL DEFAULT 0,
  app_breakdown_json TEXT NOT NULL DEFAULT '{}',
  domain_breakdown_json TEXT NOT NULL DEFAULT '{}',
  operation_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  gap_seconds REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS tracker_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'stopped',
  current_app_name TEXT,
  current_bundle_identifier TEXT,
  current_tab_title TEXT,
  current_tab_url TEXT,
  last_event_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO tracker_status (id, status) VALUES (1, 'stopped');
