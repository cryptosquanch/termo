import { getDatabase } from './database.js';

export interface ProjectMemory {
  id: number;
  user_id: number;
  project_name: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

/**
 * Set a memory value for a project
 */
export function setProjectMemory(
  userId: number,
  projectName: string,
  key: string,
  value: string
): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO project_memory (user_id, project_name, key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, project_name, key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, projectName, key, value);
}

/**
 * Get a specific memory value
 */
export function getProjectMemory(
  userId: number,
  projectName: string,
  key: string
): string | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT value FROM project_memory
    WHERE user_id = ? AND project_name = ? AND key = ?
  `).get(userId, projectName, key) as { value: string } | undefined;
  return row?.value || null;
}

/**
 * Get all memories for a project
 */
export function getProjectMemories(
  userId: number,
  projectName: string
): ProjectMemory[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM project_memory
    WHERE user_id = ? AND project_name = ?
    ORDER BY key
  `).all(userId, projectName) as ProjectMemory[];
}

/**
 * Delete a project memory
 */
export function deleteProjectMemory(
  userId: number,
  projectName: string,
  key: string
): boolean {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM project_memory
    WHERE user_id = ? AND project_name = ? AND key = ?
  `).run(userId, projectName, key);
  return result.changes > 0;
}

/**
 * Get project context summary (all memories formatted)
 */
export function getProjectContext(userId: number, projectName: string): string {
  const memories = getProjectMemories(userId, projectName);
  if (memories.length === 0) return '';

  const lines = memories.map(m => `- ${m.key}: ${m.value}`);
  return `Project context for "${projectName}":\n${lines.join('\n')}`;
}
