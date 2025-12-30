import { getDatabase } from './database.js';

export interface HistoryEntry {
  id: number;
  user_id: number;
  session_name: string;
  command: string;
  cwd: string;
  exit_code: number | null;
  duration: number;
  created_at: string;
}

// Sanitize sensitive data from commands before storing
function sanitizeCommand(command: string): string {
  return command
    // MySQL/PostgreSQL passwords: -p followed by password
    .replace(/(-p)\S+/g, '$1***')
    // curl/wget with user:pass
    .replace(/(-u\s+\w+:)\S+/g, '$1***')
    .replace(/(\/\/\w+:)\S+(@)/g, '$1***$2')
    // Environment variables with sensitive names
    .replace(/([A-Z_]*(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)[A-Z_]*=)\S+/gi, '$1***')
    // Bearer tokens
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    // API keys that look like keys (long alphanumeric strings after = or :)
    .replace(/((?:api[_-]?key|apikey)\s*[=:]\s*)\S{20,}/gi, '$1***');
}

export function addHistoryEntry(
  userId: number,
  sessionName: string,
  command: string,
  cwd: string,
  exitCode: number | null,
  duration: number
): void {
  const db = getDatabase();
  const sanitizedCommand = sanitizeCommand(command);
  db.prepare(`
    INSERT INTO command_history (user_id, session_name, command, cwd, exit_code, duration)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, sessionName, sanitizedCommand, cwd, exitCode, duration);
}

export function getRecentHistory(
  userId: number,
  sessionName: string,
  limit = 20
): HistoryEntry[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM command_history
    WHERE user_id = ? AND session_name = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, sessionName, limit) as HistoryEntry[];
}

export function getAllHistory(userId: number, limit = 50): HistoryEntry[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM command_history
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as HistoryEntry[];
}

export function searchHistory(
  userId: number,
  pattern: string,
  limit = 20
): HistoryEntry[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT * FROM command_history
    WHERE user_id = ? AND command LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, `%${pattern}%`, limit) as HistoryEntry[];
}

export function clearSessionHistory(userId: number, sessionName: string): number {
  const db = getDatabase();
  const result = db.prepare(`
    DELETE FROM command_history
    WHERE user_id = ? AND session_name = ?
  `).run(userId, sessionName);
  return result.changes;
}
