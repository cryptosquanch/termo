import { getDatabase } from './database.js';

export interface SessionRecord {
  id: number;
  user_id: number;
  name: string;
  cwd: string;
  created_at: string;
  last_used: string;
}

export function saveSession(userId: number, name: string, cwd: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO sessions (user_id, name, cwd)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      cwd = excluded.cwd,
      last_used = CURRENT_TIMESTAMP
  `).run(userId, name, cwd);
}

export function getSession(userId: number, name: string): SessionRecord | undefined {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ? AND name = ?
  `).get(userId, name) as SessionRecord | undefined;
}

export function getAllSessions(userId: number): SessionRecord[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM sessions
    WHERE user_id = ?
    ORDER BY last_used DESC
  `).all(userId) as SessionRecord[];
}

export function deleteSession(userId: number, name: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM sessions
    WHERE user_id = ? AND name = ?
  `).run(userId, name);
  return result.changes > 0;
}

export function updateSessionCwd(userId: number, name: string, cwd: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE sessions
    SET cwd = ?, last_used = CURRENT_TIMESTAMP
    WHERE user_id = ? AND name = ?
  `).run(cwd, userId, name);
}
