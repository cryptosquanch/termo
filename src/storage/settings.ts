import { getDatabase } from './database.js';

export interface UserSettings {
  user_id: number;
  voice_input_enabled: boolean;
  voice_output_enabled: boolean;
  current_project: string | null;
  updated_at: string;
}

/**
 * Get user settings (creates defaults if not exists)
 */
export function getUserSettings(userId: number): UserSettings {
  const db = getDatabase();

  // Ensure row exists
  db.prepare(`
    INSERT OR IGNORE INTO user_settings (user_id)
    VALUES (?)
  `).run(userId);

  const row = db.prepare(`
    SELECT * FROM user_settings WHERE user_id = ?
  `).get(userId) as any;

  return {
    user_id: row.user_id,
    voice_input_enabled: row.voice_input_enabled === 1,
    voice_output_enabled: row.voice_output_enabled === 1,
    current_project: row.current_project,
    updated_at: row.updated_at,
  };
}

/**
 * Update voice input setting
 */
export function setVoiceInput(userId: number, enabled: boolean): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO user_settings (user_id, voice_input_enabled)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      voice_input_enabled = excluded.voice_input_enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, enabled ? 1 : 0);
}

/**
 * Update voice output setting
 */
export function setVoiceOutput(userId: number, enabled: boolean): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO user_settings (user_id, voice_output_enabled)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      voice_output_enabled = excluded.voice_output_enabled,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, enabled ? 1 : 0);
}

/**
 * Update current project
 */
export function setCurrentProject(userId: number, projectName: string | null): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO user_settings (user_id, current_project)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      current_project = excluded.current_project,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, projectName);
}

/**
 * Get current project name
 */
export function getCurrentProject(userId: number): string | null {
  const settings = getUserSettings(userId);
  return settings.current_project;
}
