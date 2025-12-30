import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const execPromise = promisify(execCallback);

// Configurable via TMUX_SESSION env var - connect to any existing session!
const TMUX_SESSION_RAW = process.env.TMUX_SESSION || 'termo-main';

// SECURITY: Validate session name to prevent command injection
if (!/^[a-zA-Z0-9_-]+$/.test(TMUX_SESSION_RAW)) {
  throw new Error('TMUX_SESSION must only contain letters, numbers, dash, and underscore');
}
const TMUX_SESSION = TMUX_SESSION_RAW;

export async function isTmuxSessionActive(): Promise<boolean> {
  try {
    await execPromise(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

export async function createTmuxSession(): Promise<boolean> {
  try {
    // Create detached tmux session
    await execPromise(`tmux new-session -d -s ${TMUX_SESSION} -x 120 -y 30`);
    return true;
  } catch (error) {
    console.error('Failed to create tmux session:', error);
    return false;
  }
}

export async function sendToTmux(text: string): Promise<void> {
  // Send keystrokes to tmux session
  // Properly escape ALL shell special characters to prevent injection
  const escaped = text
    .replace(/\\/g, '\\\\')    // Backslashes first
    .replace(/"/g, '\\"')       // Double quotes
    .replace(/\$/g, '\\$')      // Dollar signs (variable expansion)
    .replace(/`/g, '\\`')       // Backticks (command substitution)
    .replace(/!/g, '\\!')       // History expansion
    .replace(/%/g, '%%')        // Percent signs (tmux format strings)
    .replace(/\n/g, '\\n');     // Newlines
  await execPromise(`tmux send-keys -t ${TMUX_SESSION} "${escaped}"`);
}

export async function sendEnterToTmux(): Promise<void> {
  await execPromise(`tmux send-keys -t ${TMUX_SESSION} Enter`);
}

export async function sendCtrlC(): Promise<void> {
  await execPromise(`tmux send-keys -t ${TMUX_SESSION} C-c`);
}

export async function clearScrollback(): Promise<void> {
  try {
    // Clear tmux scrollback history to prevent old content from appearing
    await execPromise(`tmux clear-history -t ${TMUX_SESSION}`);
  } catch {
    // Ignore errors
  }
}

export async function capturePane(): Promise<string> {
  try {
    // Capture last 500 lines - enough for long Claude responses
    // Combined with clearScrollback() before new commands, this prevents old content
    const { stdout } = await execPromise(
      `tmux capture-pane -t ${TMUX_SESSION} -p -S -500`
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function capturePaneSinceLast(lastLineCount: number): Promise<{ content: string; lineCount: number }> {
  try {
    const { stdout } = await execPromise(
      `tmux capture-pane -t ${TMUX_SESSION} -p`
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

export async function getSessionName(): Promise<string> {
  return TMUX_SESSION;
}

export async function killTmuxSession(): Promise<void> {
  try {
    await execPromise(`tmux kill-session -t ${TMUX_SESSION}`);
  } catch {
    // Session might not exist
  }
}
