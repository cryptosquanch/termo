import { getDatabase } from './database.js';

export interface Shortcut {
  id: number;
  user_id: number;
  name: string;
  command: string;
  created_at: string;
}

/**
 * Add or update a shortcut
 */
export function setShortcut(userId: number, name: string, command: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO shortcuts (user_id, name, command)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      command = excluded.command
  `).run(userId, name.toLowerCase(), command);
}

/**
 * Get a shortcut by name
 */
export function getShortcut(userId: number, name: string): Shortcut | null {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM shortcuts WHERE user_id = ? AND name = ?
  `).get(userId, name.toLowerCase()) as Shortcut | null;
}

/**
 * Get all shortcuts for a user
 */
export function getShortcuts(userId: number): Shortcut[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM shortcuts WHERE user_id = ? ORDER BY name
  `).all(userId) as Shortcut[];
}

/**
 * Delete a shortcut
 */
export function deleteShortcut(userId: number, name: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM shortcuts WHERE user_id = ? AND name = ?
  `).run(userId, name.toLowerCase());
  return result.changes > 0;
}
