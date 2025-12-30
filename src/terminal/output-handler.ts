// Telegram message limits
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const CODE_BLOCK_OVERHEAD = 8; // "```\n" + "\n```"
const TRUNCATION_NOTICE_LENGTH = 30;

// ANSI escape code regex
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

export function formatOutput(
  output: string,
  truncated: boolean
): string[] {
  // Strip ANSI escape codes
  let cleaned = stripAnsi(output).trim();

  // Handle empty output
  if (!cleaned) {
    return ['```\n(no output)\n```'];
  }

  // Add truncation notice if needed
  if (truncated) {
    cleaned = '[...output truncated...]\n\n' + cleaned;
  }

  // Calculate max chunk size for content inside code block
  const maxChunkSize =
    TELEGRAM_MAX_MESSAGE_LENGTH - CODE_BLOCK_OVERHEAD - TRUNCATION_NOTICE_LENGTH;

  // Split into chunks that fit Telegram's limit
  const chunks: string[] = [];
  let remaining = cleaned;

  while (remaining.length > 0) {
    let chunk: string;

    if (remaining.length <= maxChunkSize) {
      chunk = remaining;
      remaining = '';
    } else {
      // Try to break at a newline for readability
      let breakPoint = remaining.lastIndexOf('\n', maxChunkSize);

      // If no good newline found, break at max size
      if (breakPoint < maxChunkSize * 0.5) {
        breakPoint = maxChunkSize;
      }

      chunk = remaining.slice(0, breakPoint);
      remaining = remaining.slice(breakPoint).trimStart();
    }

    chunks.push(chunk);
  }

  // Wrap each chunk in code blocks
  return chunks.map((chunk, index) => {
    const prefix = chunks.length > 1 ? `[${index + 1}/${chunks.length}]\n` : '';
    return `${prefix}\`\`\`\n${chunk}\n\`\`\``;
  });
}

export function formatError(error: string): string {
  const cleaned = stripAnsi(error).trim();
  return `\`\`\`\n${cleaned}\n\`\`\``;
}

export function formatSessionInfo(
  name: string,
  cwd: string,
  isActive: boolean
): string {
  const marker = isActive ? ' [active]' : '';
  // Shorten home directory for display
  const displayCwd = cwd.replace(process.env.HOME || '', '~');
  return `${name}${marker}\n   ${displayCwd}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function escapeMarkdown(text: string): string {
  // Escape special markdown characters
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

export function shortenPath(path: string, maxLength = 40): string {
  const home = process.env.HOME || '';
  let shortened = path.replace(home, '~');

  if (shortened.length <= maxLength) {
    return shortened;
  }

  // Keep the last part of the path
  const parts = shortened.split('/');
  while (parts.length > 2 && shortened.length > maxLength) {
    parts.splice(1, 1, '...');
    shortened = parts.join('/');
  }

  return shortened;
}
