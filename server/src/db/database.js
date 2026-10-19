import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export function defaultDbPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  const dir = path.join(home, 'Library', 'Application Support', 'MacActivityTracker');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'tracker.sqlite');
}

export function openDatabase(dbPath = process.env.TRACKER_DB || defaultDbPath()) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  // Backup existing DB before applying v3+ migrations (skip temp test DBs without prior file).
  if (fs.existsSync(dbPath)) {
    try {
      const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
      let ver = 0;
      try {
        const row = probe.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
        ver = row ? Number(row.version) : 0;
      } catch {
        ver = 0;
      }
      probe.close();
      if (ver < 3 && process.env.TRACKER_SKIP_BACKUP !== '1') {
        const { backupDatabaseIfNeeded } = awaitableBackup();
        backupDatabaseIfNeeded(dbPath);
      }
    } catch {
      // New or unreadable — migrate will create schema
    }
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function awaitableBackup() {
  // Lazy require to avoid circular imports during tests
  return {
    backupDatabaseIfNeeded(dbPath) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(path.dirname(dbPath), 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const dest = path.join(backupDir, `tracker-pre-v3-${stamp}.sqlite`);
      fs.copyFileSync(dbPath, dest);
      return dest;
    },
  };
}

function currentVersion(db) {
  const row = db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  return row ? Number(row.version) : 0;
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumnIfMissing(db, table, column, typeSql) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
  }
}

export function migrate(db) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
  if (currentVersion(db) < 1) {
    db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  }

  if (currentVersion(db) < 2) {
    addColumnIfMissing(db, 'tracker_status', 'last_mac_event_at', 'TEXT');
    addColumnIfMissing(db, 'tracker_status', 'last_chrome_event_at', 'TEXT');
    addColumnIfMissing(db, 'tracker_status', 'extension_last_seen_at', 'TEXT');
    addColumnIfMissing(db, 'tracker_status', 'extension_connected', 'INTEGER NOT NULL DEFAULT 0');

    db.exec(`
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
        target_type TEXT NOT NULL,
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
        status TEXT NOT NULL DEFAULT 'open',
        due_at TEXT,
        project_id TEXT,
        source TEXT NOT NULL DEFAULT 'user',
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
        kind TEXT NOT NULL DEFAULT 'note',
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

      CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(
        doc_id,
        doc_type,
        title,
        body,
        source,
        day,
        tokenize='porter'
      );
    `);

    db.prepare('INSERT INTO schema_migrations (version) VALUES (2)').run();
  }

  if (currentVersion(db) < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        os TEXT,
        os_version TEXT,
        agent_version TEXT,
        enrollment_status TEXT NOT NULL DEFAULT 'active',
        employee_display_name TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_check_in_at TEXT,
        last_mac_event_at TEXT,
        last_chrome_event_at TEXT,
        revoked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(enrollment_status);

      CREATE TABLE IF NOT EXISTS device_credentials (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        secret_salt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        revoked_at TEXT,
        FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_device_credentials_device ON device_credentials(device_id);

      CREATE TABLE IF NOT EXISTS enrollment_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        token_salt TEXT NOT NULL,
        display_name_hint TEXT,
        expires_at TEXT NOT NULL,
        max_uses INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        revoked_at TEXT,
        consumed_device_id TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT,
        device_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    `);

    addColumnIfMissing(db, 'events', 'device_id', 'TEXT');
    addColumnIfMissing(db, 'app_sessions', 'device_id', 'TEXT');
    addColumnIfMissing(db, 'tab_sessions', 'device_id', 'TEXT');

    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_app_sessions_device ON app_sessions(device_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tab_sessions_device ON tab_sessions(device_id);`);

    db.prepare('INSERT INTO schema_migrations (version) VALUES (3)').run();
  }

  if (currentVersion(db) < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_sessions (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        estimated_seconds REAL NOT NULL DEFAULT 0,
        summary TEXT,
        problems_json TEXT NOT NULL DEFAULT '[]',
        fixes_json TEXT NOT NULL DEFAULT '[]',
        tests_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'inferred',
        confidence TEXT NOT NULL DEFAULT 'low',
        user_edited INTEGER NOT NULL DEFAULT 0,
        project_id TEXT,
        merged_into_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_work_sessions_day ON work_sessions(day);
      CREATE INDEX IF NOT EXISTS idx_work_sessions_started ON work_sessions(started_at);

      CREATE TABLE IF NOT EXISTS work_session_evidence (
        id TEXT PRIMARY KEY,
        work_session_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        evidence_id TEXT,
        label TEXT,
        detail TEXT,
        fact_type TEXT NOT NULL DEFAULT 'observed',
        started_at TEXT,
        ended_at TEXT,
        seconds REAL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY(work_session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_work_evidence_session ON work_session_evidence(work_session_id);

      CREATE TABLE IF NOT EXISTS work_notes (
        id TEXT PRIMARY KEY,
        work_session_id TEXT,
        day TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY(work_session_id) REFERENCES work_sessions(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_work_notes_day ON work_notes(day);
    `);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (4)').run();
  }

  if (currentVersion(db) < 5) {
    addColumnIfMissing(db, 'app_sessions', 'window_title', 'TEXT');
    addColumnIfMissing(db, 'app_sessions', 'project_hint', 'TEXT');
    addColumnIfMissing(db, 'tab_sessions', 'engagement_score', 'REAL NOT NULL DEFAULT 0');
    db.prepare('INSERT INTO schema_migrations (version) VALUES (5)').run();
  }
}

export function closeDatabase(db) {
  db.close();
}
