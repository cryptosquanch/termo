import { getDatabase } from './database.js';

export interface PinnedProject {
  id: number;
  name: string;
  path: string;
}

export function addPin(userId: number, name: string, path: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR REPLACE INTO pinned_projects (user_id, name, path)
    VALUES (?, ?, ?)
  `).run(userId, name, path);
}

export function removePin(userId: number, name: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM pinned_projects WHERE user_id = ? AND name = ?
  `).run(userId, name);
  return result.changes > 0;
}

export function getPins(userId: number): PinnedProject[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, name, path FROM pinned_projects
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as PinnedProject[];
}

export function getPin(userId: number, name: string): PinnedProject | undefined {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, name, path FROM pinned_projects
    WHERE user_id = ? AND name = ?
  `).get(userId, name) as PinnedProject | undefined;
}
