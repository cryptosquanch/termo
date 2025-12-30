import { Context, Bot, InputFile } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';

const MAX_MESSAGE_LENGTH = 3500;  // Safe limit with markdown overhead

/**
 * Centralized safe message sender - NEVER throws "message too long"
 * Auto-truncates, auto-chunks, falls back gracefully
 */
export async function sendSafe(
  ctx: Context,
  text: string,
  options?: {
    parse_mode?: 'Markdown' | 'HTML';
    reply_markup?: unknown;
    asFile?: boolean;  // Force file upload
    filename?: string;
  }
): Promise<void> {
  const { parse_mode, reply_markup, asFile, filename } = options || {};

  // If explicitly requested as file or very long, send as file
  if (asFile || text.length > 10000) {
    await sendAsFile(ctx, text, filename || 'output.txt');
    return;
  }

  // Truncate if needed
  let finalText = text;
  if (text.length > MAX_MESSAGE_LENGTH) {
    finalText = '...(truncated, use /full for complete output)...\n' +
                text.slice(-MAX_MESSAGE_LENGTH);
  }

  try {
    await ctx.reply(finalText, {
      parse_mode,
      reply_markup: reply_markup as never,
    });
  } catch (error) {
    // If still fails, try without markdown
    try {
      await ctx.reply(finalText.slice(-2000));
    } catch {
      // Last resort - send as file
      await sendAsFile(ctx, text, filename || 'output.txt');
    }
  }
}

/**
 * Send text as a file attachment
 */
export async function sendAsFile(
  ctx: Context,
  content: string,
  filename: string
): Promise<void> {
  const tmpDir = os.tmpdir();
  const tempId = randomBytes(8).toString('hex');
  const filePath = path.join(tmpDir, `termo-${tempId}-${filename}`);

  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
    await ctx.replyWithDocument(new InputFile(filePath, filename), {
      caption: `📄 Full output (${content.length} chars, ${content.split('\n').length} lines)`,
    });
  } finally {
    // Cleanup temp file
    try { await fs.promises.unlink(filePath); } catch {}
  }
}

/**
 * Edit a message safely - falls back to new message if fails
 */
export async function editSafe(
  bot: Bot,
  chatId: number,
  messageId: number,
  text: string,
  options?: {
    parse_mode?: 'Markdown' | 'HTML';
    reply_markup?: unknown;
  }
): Promise<boolean> {
  const { parse_mode, reply_markup } = options || {};

  // Truncate if needed
  let finalText = text;
  if (text.length > MAX_MESSAGE_LENGTH) {
    finalText = text.slice(-MAX_MESSAGE_LENGTH) + '\n...(truncated)';
  }

  try {
    await bot.api.editMessageText(chatId, messageId, finalText, {
      parse_mode,
      reply_markup: reply_markup as never,
    });
    return true;
  } catch {
    // Edit failed - try sending new message
    try {
      await bot.api.sendMessage(chatId, finalText.slice(-2000), { parse_mode });
      return false;
    } catch {
      return false;
    }
  }
}

/**
 * Parse Claude Code status from screen content
 */
export function parseClaudeStatus(screen: string): {
  isThinking: boolean;
  isReady: boolean;
  isDone: boolean;
  status: string;
} {
  const lines = screen.split('\n');
  const lastTenLines = lines.slice(-10).join('\n');
  const lastTenLower = lastTenLines.toLowerCase();

  // Check for thinking indicators - ONLY in last 10 lines
  const hasSpinner = /[○◐◓◑]/.test(lastTenLines);
  const hasThinkingText = lastTenLower.includes('thinking') ||
                          lastTenLower.includes('✦ thinking') ||
                          lastTenLines.includes('esc to interrupt');

  const isThinking = hasSpinner || hasThinkingText;

  // Check for ready prompt - look for ">" at start of any line in last 10
  // Claude Code shows: "> " when ready for input
  const hasPrompt = lines.slice(-10).some(line => {
    const trimmed = line.trim();
    return trimmed === '>' || trimmed.startsWith('> ');
  });
  const isReady = hasPrompt && !isThinking;

  // Check for completion indicators
  const isDone = lastTenLower.includes('✓') ||
                 (lastTenLower.includes('done') && !lastTenLower.includes('undo'));

  let status = 'unknown';
  if (isThinking) status = 'thinking';
  else if (isReady) status = 'ready';
  else if (isDone) status = 'done';

  return { isThinking, isReady, isDone, status };
}
