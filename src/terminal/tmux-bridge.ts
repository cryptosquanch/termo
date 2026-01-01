import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const execPromise = promisify(execCallback);

// Default session name (can be overridden via env)
const DEFAULT_SESSION = process.env.TMUX_SESSION || 'termo-main';

// Per-user tmux session tracking
const userSessions = new Map<number, string>();

// ─────────────────────────────────────────────────────────────────────────────
// Session Name Validation & Sanitization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate session name to prevent command injection
 */
function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name) && name.length <= 50;
}

/**
 * Get sanitized session name or throw
 */
function sanitizeSessionName(name: string): string {
  if (!isValidSessionName(name)) {
    throw new Error('Session name must only contain letters, numbers, dash, and underscore (max 50 chars)');
  }
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-User Session Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the tmux session a user is currently attached to
 */
export function getUserTmuxSession(userId: number): string | null {
  return userSessions.get(userId) || null;
}

/**
 * Set which tmux session a user is attached to
 */
export function setUserTmuxSession(userId: number, sessionName: string): void {
  const sanitized = sanitizeSessionName(sessionName);
  userSessions.set(userId, sanitized);
}

/**
 * Clear user's tmux session (detach)
 */
export function clearUserTmuxSession(userId: number): void {
  userSessions.delete(userId);
}

/**
 * Check if user is in tmux mode
 */
export function isUserInTmuxMode(userId: number): boolean {
  return userSessions.has(userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tmux Session Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all available tmux sessions
 */
export async function listTmuxSessions(): Promise<Array<{ name: string; windows: number; created: string; attached: boolean }>> {
  try {
    const { stdout } = await execPromise(
      `tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}" 2>/dev/null`
    );

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, created, attached] = line.split('|');
      return {
        name,
        windows: parseInt(windows, 10),
        created: new Date(parseInt(created, 10) * 1000).toLocaleString(),
        attached: attached === '1',
      };
    });
  } catch {
    return [];
  }
}

/**
 * Check if a specific tmux session exists
 */
export async function isTmuxSessionActive(sessionName?: string): Promise<boolean> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  try {
    await execPromise(`tmux has-session -t ${session} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new tmux session
 */
export async function createTmuxSession(sessionName?: string): Promise<boolean> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  try {
    // Create detached tmux session with reasonable size
    await execPromise(`tmux new-session -d -s ${session} -x 120 -y 30`);
    return true;
  } catch (error) {
    console.error(`Failed to create tmux session '${session}':`, error);
    return false;
  }
}

/**
 * Send text to a tmux session
 */
export async function sendToTmux(text: string, sessionName?: string): Promise<void> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;

  // Properly escape ALL shell special characters to prevent injection
  const escaped = text
    .replace(/\\/g, '\\\\')    // Backslashes first
    .replace(/"/g, '\\"')       // Double quotes
    .replace(/\$/g, '\\$')      // Dollar signs (variable expansion)
    .replace(/`/g, '\\`')       // Backticks (command substitution)
    .replace(/!/g, '\\!')       // History expansion
    .replace(/%/g, '%%')        // Percent signs (tmux format strings)
    .replace(/\n/g, '\\n');     // Newlines

  await execPromise(`tmux send-keys -t ${session} "${escaped}"`);
}

/**
 * Send Enter key to a tmux session
 */
export async function sendEnterToTmux(sessionName?: string): Promise<void> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  await execPromise(`tmux send-keys -t ${session} Enter`);
}

/**
 * Send Ctrl+C to a tmux session
 */
export async function sendCtrlC(sessionName?: string): Promise<void> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  await execPromise(`tmux send-keys -t ${session} C-c`);
}

/**
 * Clear scrollback history of a tmux session
 */
export async function clearScrollback(sessionName?: string): Promise<void> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  try {
    await execPromise(`tmux clear-history -t ${session}`);
  } catch {
    // Ignore errors
  }
}

/**
 * Capture pane content from a tmux session
 */
export async function capturePane(sessionName?: string): Promise<string> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  try {
    // Capture last 500 lines - enough for long Claude responses
    const { stdout } = await execPromise(
      `tmux capture-pane -t ${session} -p -S -500`
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Capture new pane content since last check
 */
export async function capturePaneSinceLast(
  lastLineCount: number,
  sessionName?: string
): Promise<{ content: string; lineCount: number }> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  try {
    const { stdout } = await execPromise(
      `tmux capture-pane -t ${session} -p`
    );
    const lines = stdout.split('\n');
    const currentLineCount = lines.length;

    if (currentLineCount > lastLineCount) {
      // Return only new lines
      const newLines = lines.slice(lastLineCount);
      return {
        content: newLines.join('\n').trim(),
        lineCount: currentLineCount,
      };
    }

    return { content: '', lineCount: currentLineCount };
  } catch {
    return { content: '', lineCount: lastLineCount };
  }
}

/**
 * Get current working directory of a tmux session
 */
export async function getTmuxCwd(sessionName?: string): Promise<string | null> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  try {
    const { stdout } = await execPromise(
      `tmux display-message -t ${session} -p "#{pane_current_path}"`
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get session name (for backwards compatibility)
 */
export async function getSessionName(): Promise<string> {
  return DEFAULT_SESSION;
}

/**
 * Kill a tmux session
 */
export async function killTmuxSession(sessionName?: string): Promise<void> {
  const session = sessionName ? sanitizeSessionName(sessionName) : DEFAULT_SESSION;
  try {
    await execPromise(`tmux kill-session -t ${session}`);
  } catch {
    // Session might not exist
  }
}

/**
 * Rename a tmux session
 */
export async function renameTmuxSession(oldName: string, newName: string): Promise<boolean> {
  const oldSession = sanitizeSessionName(oldName);
  const newSession = sanitizeSessionName(newName);
  try {
    await execPromise(`tmux rename-session -t ${oldSession} ${newSession}`);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// User-Aware Wrappers (use user's current session)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send text to user's current tmux session
 */
export async function sendToUserTmux(userId: number, text: string): Promise<void> {
  const session = getUserTmuxSession(userId);
  if (!session) throw new Error('User not attached to any tmux session');
  return sendToTmux(text, session);
}

/**
 * Send Enter to user's current tmux session
 */
export async function sendEnterToUserTmux(userId: number): Promise<void> {
  const session = getUserTmuxSession(userId);
  if (!session) throw new Error('User not attached to any tmux session');
  return sendEnterToTmux(session);
}

/**
 * Send Ctrl+C to user's current tmux session
 */
export async function sendCtrlCToUserTmux(userId: number): Promise<void> {
  const session = getUserTmuxSession(userId);
  if (!session) throw new Error('User not attached to any tmux session');
  return sendCtrlC(session);
}

/**
 * Capture pane from user's current tmux session
 */
export async function capturePaneForUser(userId: number): Promise<string> {
  const session = getUserTmuxSession(userId);
  if (!session) throw new Error('User not attached to any tmux session');
  return capturePane(session);
}

/**
 * Clear scrollback for user's current tmux session
 */
export async function clearScrollbackForUser(userId: number): Promise<void> {
  const session = getUserTmuxSession(userId);
  if (!session) throw new Error('User not attached to any tmux session');
  return clearScrollback(session);
}
