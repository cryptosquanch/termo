import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let db: Database.Database | null = null;

export function initDatabase(dbPath: string): Database.Database {
  // Ensure data directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Run migrations
  runMigrations(db);

  return db;
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

function runMigrations(database: Database.Database): void {
  // Sessions table - stores named terminal sessions
  database.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    )
  `).run();

  // Command history table
  database.prepare(`
    CREATE TABLE IF NOT EXISTS command_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_name TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      exit_code INTEGER,
      duration INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create index if not exists (using a transaction)
  const indexExists = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_history_user_session'
  `).get();

  if (!indexExists) {
    database.prepare(`
      CREATE INDEX idx_history_user_session
        ON command_history(user_id, session_name, created_at DESC)
    `).run();
  }

  // Pinned projects table - quick project switcher
  database.prepare(`
    CREATE TABLE IF NOT EXISTS pinned_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    )
  `).run();

  // Bookmarks table - saved Claude responses
  database.prepare(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      project TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create bookmarks index
  const bookmarkIndexExists = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_bookmarks_user'
  `).get();

  if (!bookmarkIndexExists) {
    database.prepare(`
      CREATE INDEX idx_bookmarks_user
        ON bookmarks(user_id, created_at DESC)
    `).run();
  }

  // Token usage tracking table
  database.prepare(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_date DATE NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, session_date)
    )
  `).run();

  // Custom shortcuts/aliases table
  database.prepare(`
    CREATE TABLE IF NOT EXISTS shortcuts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, name)
    )
  `).run();

  // Project memory table - key-value storage per project
  database.prepare(`
    CREATE TABLE IF NOT EXISTS project_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, project_name, key)
    )
  `).run();

  // User settings table (voice mode, etc.)
  database.prepare(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY,
      voice_input_enabled INTEGER DEFAULT 1,
      voice_output_enabled INTEGER DEFAULT 0,
      current_project TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
