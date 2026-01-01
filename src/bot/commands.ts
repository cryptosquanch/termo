import { Bot, Context, InlineKeyboard } from 'grammy';
import { randomBytes } from 'crypto';
import { Config } from '../config.js';
import { TerminalExecutor } from '../terminal/executor.js';
import {
  createSession,
  getActiveSession,
  listActiveSessions,
  closeSession,
  getOrCreateDefaultSession,
  restoreSessionsFromDb,
  updateCwd,
  TerminalSession,
} from '../terminal/session-manager.js';
import {
  validateCommand,
  isInteractiveCommand,
  getInteractiveWarning,
  validateFilePath,
} from '../terminal/sanitizer.js';
import { formatOutput, formatDuration, shortenPath } from '../terminal/output-handler.js';
import { addHistoryEntry, getRecentHistory } from '../storage/history.js';
import { CommandNotifier } from '../notifications/notifier.js';
import {
  getQuickActionsKeyboard,
  getSessionsKeyboard,
  getHistoryKeyboard,
  getConfirmationKeyboard,
  getRunningKeyboard,
  getCloseSessionKeyboard,
  getHelpKeyboard,
  getProjectsKeyboard,
  getSearchKeyboard,
  getSmartRepliesKeyboard,
  getClaudeThinkingKeyboard,
  getClaudeDoneKeyboard,
  getClaudeDoneWithProjectsKeyboard,
  getQuickProjectsBar,
  getMainMenuKeyboard,
  getContextWarningKeyboard,
  getBookmarksKeyboard,
  getBookmarkViewKeyboard,
  getUsageKeyboard,
  getBreadcrumbKeyboard,
  formatBreadcrumb,
} from './keyboards.js';
import {
  addBookmark,
  getBookmarks,
  getBookmark,
  searchBookmarks,
  deleteBookmark,
  getBookmarkCount,
} from '../storage/bookmarks.js';
import {
  getUsageSummary,
  formatTokenCount,
  formatCost,
  updateContextFromScreen,
  resetContext,
  getContextState,
  formatContextReport,
  formatContextCompact,
  getContextWarning,
} from '../storage/usage.js';
import { addPin, removePin, getPins, getPin } from '../storage/pins.js';
import { searchHistory } from '../storage/history.js';
import {
  isTmuxSessionActive,
  createTmuxSession,
  sendToTmux,
  sendEnterToTmux,
  sendCtrlC,
  capturePane,
  capturePaneSinceLast,
  clearScrollback,
  listTmuxSessions,
  getUserTmuxSession,
  setUserTmuxSession,
  clearUserTmuxSession,
  isUserInTmuxMode,
  killTmuxSession,
  getTmuxCwd,
} from '../terminal/tmux-bridge.js';
import { sendSafe, sendAsFile, editSafe, parseClaudeStatus } from './safe-sender.js';
import { copyToClipboard, notifyTaskComplete, transcribeAudio, isWhisperAvailable } from '../utils/system.js';
import { setShortcut, getShortcut, getShortcuts, deleteShortcut } from '../storage/shortcuts.js';
import { setProjectMemory, getProjectMemory, getProjectMemories, deleteProjectMemory, getProjectContext } from '../storage/project-memory.js';
import { getUserSettings, setVoiceInput, setVoiceOutput, setCurrentProject, getCurrentProject } from '../storage/settings.js';

// Auto-refresh configuration
const AUTO_REFRESH_INTERVAL = 3000; // Check every 3 seconds (for detection)
const UI_UPDATE_INTERVAL = 8000; // Update UI every 8 seconds (less flashing)
const AUTO_REFRESH_TIMEOUT = 600000; // Stop after 10 minutes (Claude can take a while)
const STABLE_COUNT_THRESHOLD = 5; // Stop if screen unchanged for 5 checks (~15 sec stable)
const FORCE_DONE_STABLE_COUNT = 8; // Force done after 8 stable checks (~24 sec) even if "thinking"
const MIN_CHANGE_LINES = 2; // Only update if at least 2 lines changed

// Track active session per user
const userActiveSessions = new Map<number, string>();
// Track last screen content for detecting changes
const userLastScreen = new Map<number, string>();
// Track active auto-refresh timers
const userAutoRefresh = new Map<number, NodeJS.Timeout>();
// Track last command for smart retry
const userLastCommand = new Map<number, string>();
// Track last activity time per user for cleanup
const userLastActivity = new Map<number, number>();

// Memory cleanup - remove stale entries after 1 hour of inactivity
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const MAX_INACTIVE_TIME = 60 * 60 * 1000; // 1 hour

function updateUserActivity(userId: number): void {
  userLastActivity.set(userId, Date.now());
}

function cleanupStaleUsers(): void {
  const now = Date.now();
  for (const [userId, lastActive] of userLastActivity) {
    if (now - lastActive > MAX_INACTIVE_TIME) {
      clearUserTmuxSession(userId);  // Clear tmux session tracking
      userLastScreen.delete(userId);
      userLastCommand.delete(userId);
      userLastActivity.delete(userId);
      userActiveSessions.delete(userId);
      pendingConfirmations.delete(userId);
      // Stop any running auto-refresh
      const timer = userAutoRefresh.get(userId);
      if (timer) {
        clearInterval(timer);
        userAutoRefresh.delete(userId);
      }
      console.log(`[Cleanup] Removed stale data for user ${userId}`);
    }
  }
}

// Start cleanup interval
setInterval(cleanupStaleUsers, CLEANUP_INTERVAL);

function getActiveSessionName(userId: number): string {
  return userActiveSessions.get(userId) || 'default';
}

function setActiveSessionName(userId: number, name: string): void {
  userActiveSessions.set(userId, name);
}

// Use tmux-bridge for tmux mode tracking
function isInTmuxMode(userId: number): boolean {
  return isUserInTmuxMode(userId);
}

function setTmuxMode(userId: number, enabled: boolean, sessionName?: string): void {
  if (enabled && sessionName) {
    setUserTmuxSession(userId, sessionName);
  } else if (!enabled) {
    clearUserTmuxSession(userId);
  }
}

// Get current user's tmux session name
function getCurrentTmuxSession(userId: number): string | null {
  return getUserTmuxSession(userId);
}

function stopAutoRefresh(userId: number): void {
  const timer = userAutoRefresh.get(userId);
  if (timer) {
    clearInterval(timer);
    userAutoRefresh.delete(userId);
  }
}

async function startAutoRefresh(
  userId: number,
  chatId: number,
  bot: Bot,
  initialScreen: string,
  thinkingMessageId?: number,
  userMessage?: string  // User's message - to find where response starts
): Promise<void> {
  // Stop any existing auto-refresh for this user
  stopAutoRefresh(userId);

  // Get user's current tmux session
  const tmuxSession = getCurrentTmuxSession(userId);
  if (!tmuxSession) {
    console.error(`[AutoRefresh] No tmux session for user ${userId}`);
    return;
  }

  let lastScreen = initialScreen;
  const messageToFind = userMessage || '';  // Find this to isolate response
  let stableCount = 0;
  const startTime = Date.now();
  let lastUiUpdate = 0; // Track last UI update time
  let lastMessageId: number | undefined = thinkingMessageId;
  let notifiedComplete = false;
  let hasShownFirstScreen = !thinkingMessageId; // If no thinking msg, show screens immediately
  let tipIndex = 0;

  // Tips to show while waiting (rotates every UI update)
  const waitingTips = [
    '💡 Send screenshots - Termo reads them with OCR!',
    '💡 Type "ultrathink" for deeper thinking',
    '💡 Use /pins to jump between projects',
    '🛋️ Coding from bed? Living the dream.',
    '☕ Good things take time...',
    '🧠 Deep thinking in progress...',
    '📱 Phone in hand, world in your code.',
    '🚀 Building something awesome?',
    '💡 Tap ⭐ Save to bookmark responses',
    '🦥 Maximum productivity, minimum movement.',
    '✨ Claude is working hard for you',
    '💡 /usage shows your token costs',
  ];

  const timer = setInterval(async () => {
    try {
      // Check timeout
      if (Date.now() - startTime > AUTO_REFRESH_TIMEOUT) {
        stopAutoRefresh(userId);
        // Send timeout notification with current screen
        if (!notifiedComplete) {
          const timeoutScreen = await capturePane(tmuxSession);
          await bot.api.sendMessage(
            chatId,
            '⏰ *Auto-refresh stopped* (10 min timeout)\n\n```\n' + (timeoutScreen || '(empty)') + '\n```',
            { parse_mode: 'Markdown' }
          );
        }
        return;
      }

      // Check if still in tmux mode
      if (!isInTmuxMode(userId)) {
        stopAutoRefresh(userId);
        return;
      }

      // Capture current screen
      const currentScreen = await capturePane(tmuxSession);

      // Check if screen changed significantly
      const lastLines = lastScreen.split('\n');
      const currentLines = currentScreen.split('\n');
      const changedLines = Math.abs(currentLines.length - lastLines.length) +
        currentLines.filter((line, i) => lastLines[i] !== line).length;

      // Check if Claude is still thinking - SIMPLE and RELIABLE
      const lastTenLines = currentScreen.split('\n').slice(-10);
      const lastTenText = lastTenLines.join('\n');

      // Claude is READY if we see the ">" prompt
      const hasPrompt = lastTenLines.some(line => {
        const t = line.trim();
        return t === '>' || t === '> ' || t.startsWith('> ');
      });

      // Claude is THINKING if we see active indicators
      const hasSpinner = /[○◐◓◑]/.test(lastTenText);
      const hasEscHint = lastTenText.includes('esc to interrupt');

      // Simple logic: if prompt visible AND no active thinking indicators = DONE
      const stillThinking = !hasPrompt || hasSpinner || hasEscHint;


      // Track if screen is stable (unchanged) even while "thinking"
      const screenUnchanged = currentScreen === lastScreen || changedLines < MIN_CHANGE_LINES;
      if (screenUnchanged) {
        stableCount++;
      } else {
        stableCount = 0;
      }

      // Force done if screen hasn't changed for a long time (detection might be wrong)
      const forceDone = stableCount >= FORCE_DONE_STABLE_COUNT;

      if (stillThinking && !forceDone) {
        // Claude is still working
        lastScreen = currentScreen;

        // Send typing indicator to show activity (doesn't cause flashing)
        try {
          await bot.api.sendChatAction(chatId, 'typing');
        } catch {}

        // Only update UI message every UI_UPDATE_INTERVAL (reduces flashing)
        const now = Date.now();
        if (lastMessageId && (now - lastUiUpdate) >= UI_UPDATE_INTERVAL) {
          lastUiUpdate = now;
          const elapsed = Math.floor((now - startTime) / 1000);

          // Format elapsed time nicely
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

          // Extract Claude's response preview (cleaned)
          let preview = '';
          if (messageToFind) {
            const lines = currentScreen.split('\n');
            let startIndex = 0;
            // Find where user's message was (response comes after)
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(messageToFind.slice(0, 30))) {
                startIndex = i + 1;
                break;
              }
            }
            if (startIndex > 0) {
              // Get Claude's response and clean it
              let responseLines = lines.slice(startIndex);
              // Clean terminal UI noise
              responseLines = responseLines.filter(line => {
                if (line.includes('───────')) return false;
                if (line.match(/^>\s*$/)) return false;
                if (line.includes('esc to interrupt')) return false;
                if (line.includes('Context left until')) return false;
                if (line.includes('shift+tab')) return false;
                if (line.includes('bypass permissions')) return false;
                if (line.match(/^\s*✦\s*(Thinking|Reading|Writing)/)) return false;
                return true;
              });
              const cleaned = responseLines.join('\n').trim();
              if (cleaned.length > 30) {
                // Show last 600 chars of response
                preview = cleaned.length > 600
                  ? '...' + cleaned.slice(-600)
                  : cleaned;
              }
            }
          }

          // Build message: header + preview (or tip if no preview yet)
          let messageText = `🧠 *Claude is writing...* (${timeStr})`;
          if (preview) {
            // Escape markdown special chars in preview to avoid parse errors
            const safePreview = preview
              .replace(/`{3,}/g, '```')  // normalize code fences
              .slice(0, 800);  // hard limit
            messageText += `\n\n\`\`\`\n${safePreview}\n\`\`\`\n_...writing..._`;
          } else {
            // No response yet, show tip
            const tip = waitingTips[tipIndex % waitingTips.length];
            tipIndex++;
            messageText += `\n\n${tip}`;
          }

          try {
            await bot.api.editMessageText(
              chatId,
              lastMessageId,
              messageText,
              {
                parse_mode: 'Markdown',
                reply_markup: getClaudeThinkingKeyboard(),
              }
            );
          } catch {
            // Edit failed - might be markdown parse error, try plain
            try {
              await bot.api.editMessageText(
                chatId,
                lastMessageId,
                `🧠 Claude is writing... (${timeStr})\n\n${preview || waitingTips[tipIndex % waitingTips.length]}`,
                { reply_markup: getClaudeThinkingKeyboard() }
              );
            } catch {}
          }
        }
        return;
      }

      // Claude is not thinking (or forceDone triggered) - update screen tracking
      lastScreen = currentScreen;
      userLastScreen.set(userId, currentScreen);

      // Check if stable enough to show "Done!"
      if (stableCount >= STABLE_COUNT_THRESHOLD && !notifiedComplete) {
        // Claude is done - show final screen
        notifiedComplete = true;
        stopAutoRefresh(userId);

        // Play notification sound if task took more than 10 seconds
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed >= 10) {
          notifyTaskComplete(`Claude finished (${elapsed}s)`);
        }

        // Extract only the NEW content (after user's message)
        let responseContent = currentScreen || '(empty)';
        if (messageToFind) {
          const lines = responseContent.split('\n');
          // Find the line containing user's message
          let startIndex = 0;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(messageToFind.slice(0, 30))) {  // Match first 30 chars
              startIndex = i + 1;  // Start AFTER the user's message line
              break;
            }
          }
          if (startIndex > 0) {
            responseContent = lines.slice(startIndex).join('\n').trim() || '(empty)';
          }
        }

        // Clean up terminal UI noise
        responseContent = cleanTerminalOutput(responseContent);

        // Update context meter from screen output
        updateContextFromScreen(userId, currentScreen);

        // Check for context-low warning and notify user
        const contextState = getContextState(userId);
        let contextWarning = '';
        if (contextState) {
          const warning = getContextWarning(contextState.percentage);
          if (warning) {
            contextWarning = '\n\n' + warning;
          }
        }

        // Replace thinking message with final screen + Done
        // Handle long outputs by chunking (NO truncation - send full response)
        const chunks = splitScreenContent(responseContent || '(empty)');

        if (chunks.length === 1 && lastMessageId && !hasShownFirstScreen) {
          // Short output - edit existing message
          try {
            // Get pins for quick project switcher
            const pins = getPins(userId);
            const currentProject = getCurrentProject(userId) ?? undefined;

            await bot.api.editMessageText(
              chatId,
              lastMessageId,
              '✅ *Done!*\n\n```\n' + chunks[0] + '\n```',
              {
                parse_mode: 'Markdown',
                reply_markup: getClaudeDoneWithProjectsKeyboard(currentScreen, pins, currentProject),
              }
            );
            hasShownFirstScreen = true;
            return;
          } catch {
            // Edit failed, send new message
          }
        }

        // Long output or edit failed - send chunks
        // Delete thinking message first
        if (lastMessageId) {
          try { await bot.api.deleteMessage(chatId, lastMessageId); } catch {}
        }

        await bot.api.sendMessage(chatId, '✅ *Done!*', { parse_mode: 'Markdown' });

        // Get pins for quick project switcher
        const pins = getPins(userId);
        const currentProject = getCurrentProject(userId) ?? undefined;

        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          await bot.api.sendMessage(
            chatId,
            '```\n' + chunks[i] + '\n```' + (chunks.length > 1 ? ` _(${i + 1}/${chunks.length})_` : ''),
            {
              parse_mode: 'Markdown',
              ...(isLast ? { reply_markup: getClaudeDoneWithProjectsKeyboard(currentScreen, pins, currentProject) } : {}),
            }
          );
        }
        hasShownFirstScreen = true;
      }

    } catch (error) {
      // Stop on error
      stopAutoRefresh(userId);
    }
  }, AUTO_REFRESH_INTERVAL);

  userAutoRefresh.set(userId, timer);
}

// Pending confirmations
const pendingConfirmations = new Map<number, string>();

// Telegram has 4096 char limit - split long messages
const TELEGRAM_MAX_LENGTH = 4000; // Leave some margin

// Clean up terminal UI noise from Claude output
function cleanTerminalOutput(content: string): string {
  const lines = content.split('\n');
  const cleanedLines: string[] = [];

  for (const line of lines) {
    // Skip terminal UI elements
    if (line.includes('────────────────')) continue;  // Separator lines
    if (line.match(/^>\s*$/)) continue;  // Empty prompt line
    if (line.includes('bypass permissions')) continue;  // Claude Code UI
    if (line.includes('Context left until')) continue;  // Context indicator
    if (line.includes('shift+tab to cycle')) continue;  // Keyboard hints
    if (line.includes('esc to interrupt')) continue;  // Thinking indicator
    if (line.match(/^>\s+.*↵\s*send$/)) continue;  // Input line with send indicator

    cleanedLines.push(line);
  }

  // Trim empty lines from start and end
  while (cleanedLines.length > 0 && cleanedLines[0].trim() === '') {
    cleanedLines.shift();
  }
  while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() === '') {
    cleanedLines.pop();
  }

  return cleanedLines.join('\n');
}

function splitScreenContent(screen: string): string[] {
  if (screen.length <= TELEGRAM_MAX_LENGTH - 20) {
    return [screen];
  }

  // Split by lines to avoid cutting mid-line
  const lines = screen.split('\n');
  const chunks: string[] = [];
  let currentChunk = '';

  for (const line of lines) {
    if ((currentChunk + '\n' + line).length > TELEGRAM_MAX_LENGTH - 20) {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      currentChunk = line;
    } else {
      currentChunk = currentChunk ? currentChunk + '\n' + line : line;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export function setupBot(
  bot: Bot,
  config: Config,
  executor: TerminalExecutor,
  notifier: CommandNotifier
): void {
  // /start command
  bot.command('start', async (ctx) => {
    const userId = ctx.from!.id;

    // Restore sessions from database
    restoreSessionsFromDb(userId);

    // Ensure default session exists
    getOrCreateDefaultSession(userId);
    setActiveSessionName(userId, 'default');

    await ctx.reply(
      '*Welcome to Termo!*\n\n' +
      'Your Mac terminal, in your pocket.\n\n' +
      '*Modes:*\n' +
      '- Normal: Type commands, get results\n' +
      '- Claude Mode: /attach - Interactive Claude Code session\n\n' +
      '*Quick start:*\n' +
      '- Just type any command to run it\n' +
      '- /attach - Claude Code interactive mode\n' +
      '- /help for all commands\n\n' +
      `Active session: \`default\``,
      {
        parse_mode: 'Markdown',
        reply_markup: getQuickActionsKeyboard(),
      }
    );
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      '*Termo Commands*\n\n' +
      '*Claude Mode (Interactive):*\n' +
      '/attach - Start Claude Code session\n' +
      '/detach - Exit Claude Mode\n' +
      '/screen - Show terminal screen\n' +
      '/full - Download full output as file\n' +
      '/status - Check Claude\'s status\n' +
      '/ctrlc - Send Ctrl+C\n' +
      '/reset - Clear Claude context\n\n' +
      '*📌 Projects:*\n' +
      '/pins - List pinned projects\n' +
      '/pin `<name>` - Pin current directory\n' +
      '/unpin `<name>` - Remove pin\n\n' +
      '*📁 Sessions:*\n' +
      '/sessions - List all sessions\n' +
      '/new `<name>` - Create new session\n' +
      '/switch `<name>` - Switch to session\n\n' +
      '*🧭 Navigation:*\n' +
      '/nav - Show current path with navigation\n' +
      '/pwd - Show current directory\n\n' +
      '*🔍 Search & History:*\n' +
      '/search `<query>` - Search history\n' +
      '/history - Recent commands\n\n' +
      '*⭐ Bookmarks & Usage:*\n' +
      '/bookmarks - Saved Claude responses\n' +
      '/usage - Token usage dashboard\n' +
      '/export - Export conversation as markdown\n\n' +
      '*🎤 Voice:*\n' +
      '/voice - Toggle voice responses\n\n' +
      '*⚡ Shortcuts:*\n' +
      '/alias `<name>` `<command>` - Create shortcut\n' +
      '/aliases - List shortcuts\n' +
      '/unalias `<name>` - Remove shortcut\n\n' +
      '*🧠 Project Memory:*\n' +
      '/remember `<key>` `<value>` - Save project info\n' +
      '/memories - List project memories\n' +
      '/forget `<key>` - Remove memory\n\n' +
      '_Any text you send = shell command (or Claude message in Claude Mode)_',
      {
        parse_mode: 'Markdown',
        reply_markup: getHelpKeyboard(),
      }
    );
  });

  // /menu command - Interactive main menu with mode awareness
  bot.command('menu', async (ctx) => {
    const userId = ctx.from!.id;
    const inClaudeMode = isInTmuxMode(userId);

    const modeText = inClaudeMode
      ? '🟢 *Claude Mode* - Messages go to Claude'
      : '⚪ *Normal Mode* - Commands run directly';

    await ctx.reply(
      `*Termo Menu*\n\n${modeText}`,
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(inClaudeMode),
      }
    );
  });

  // /attach command - Claude Mode (interactive Claude Code session)
  // Usage: /attach [session-name]  - attach to specific session
  //        /attach                 - show session picker or attach to default
  bot.command('attach', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1);
    const requestedSession = args[0]?.trim();

    // If already attached, show current session
    const currentSession = getCurrentTmuxSession(userId);
    if (currentSession && !requestedSession) {
      await ctx.reply(
        `Already attached to \`${currentSession}\`\n\nUse /detach first, or /attach <name> to switch.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // List available sessions
    const sessions = await listTmuxSessions();

    // If no session specified, show picker (if multiple sessions exist)
    if (!requestedSession && sessions.length > 1) {
      const keyboard = new InlineKeyboard();
      sessions.forEach((s, i) => {
        const icon = s.attached ? '🟢' : '⚪';
        keyboard.text(`${icon} ${s.name}`, `tmux:attach:${s.name}`);
        if (i % 2 === 1) keyboard.row();
      });
      keyboard.row().text('➕ New Session', 'tmux:new');

      await ctx.reply(
        '*📺 Select Tmux Session*\n\n' +
        sessions.map(s => {
          const icon = s.attached ? '🟢' : '⚪';
          return `${icon} \`${s.name}\` (${s.windows} window${s.windows > 1 ? 's' : ''})`;
        }).join('\n'),
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
      return;
    }

    // Determine session name to attach to
    const sessionName = requestedSession || (sessions.length > 0 ? sessions[0].name : 'termo-main');

    // Check if session exists, create if not
    const isActive = await isTmuxSessionActive(sessionName);
    if (!isActive) {
      await ctx.reply(`Creating tmux session \`${sessionName}\`...`, { parse_mode: 'Markdown' });
      const created = await createTmuxSession(sessionName);
      if (!created) {
        await ctx.reply(`Failed to create tmux session \`${sessionName}\`.`, { parse_mode: 'Markdown' });
        return;
      }
    }

    // Attach to the session
    setTmuxMode(userId, true, sessionName);

    // Clear old scrollback to start fresh
    await clearScrollback(sessionName);

    // Get initial screen
    let screen = await capturePane(sessionName);
    userLastScreen.set(userId, screen);

    // Truncate screen to last ~30 lines
    const lines = screen.split('\n');
    if (lines.length > 30) {
      screen = '...\n' + lines.slice(-30).join('\n');
    }
    if (screen.length > 2000) {
      screen = screen.slice(-2000);
    }

    // Get cwd for context
    const cwd = await getTmuxCwd(sessionName);

    await ctx.reply(
      `🟢 *Claude Mode Active* (\`${sessionName}\`)\n` +
      (cwd ? `📁 ${cwd}\n\n` : '\n') +
      '*Quick tips:*\n' +
      '• Send screenshots - OCR extracts text\n' +
      '• Type `ultrathink` for deep thinking\n' +
      '• /pins to switch projects quickly\n\n' +
      '```\n' + (screen || '(empty)') + '\n```',
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenuKeyboard(true),
      }
    );
  });

  // /detach command - Exit Claude Mode
  bot.command('detach', async (ctx) => {
    const userId = ctx.from!.id;

    const currentSession = getCurrentTmuxSession(userId);
    if (!currentSession) {
      await ctx.reply('Not in Claude Mode. Use /attach to enter.');
      return;
    }

    stopAutoRefresh(userId);
    setTmuxMode(userId, false);
    await ctx.reply(
      `👋 Detached from \`${currentSession}\`\n\n` +
      'Back to normal mode - commands run and return results.\n' +
      'Use /attach to re-enter Claude Mode.',
      { parse_mode: 'Markdown', reply_markup: getQuickActionsKeyboard() }
    );
  });

  // /tmux command - Manage tmux sessions
  bot.command('tmux', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.message!.text!.split(' ').slice(1);
    const subcommand = args[0]?.toLowerCase();
    const sessionArg = args[1]?.trim();

    // List sessions (default)
    if (!subcommand || subcommand === 'list' || subcommand === 'ls') {
      const sessions = await listTmuxSessions();
      const currentSession = getCurrentTmuxSession(userId);

      if (sessions.length === 0) {
        await ctx.reply(
          '*No tmux sessions*\n\nUse /attach to create one, or:\n`/tmux new <name>` to create a named session',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const keyboard = new InlineKeyboard();
      sessions.forEach((s, i) => {
        const isCurrent = s.name === currentSession;
        const icon = isCurrent ? '📺' : s.attached ? '🟢' : '⚪';
        keyboard.text(`${icon} ${s.name}`, `tmux:attach:${s.name}`);
        if (i % 2 === 1) keyboard.row();
      });
      if (sessions.length % 2 === 1) keyboard.row();
      keyboard.text('➕ New', 'tmux:new').text('🗑️ Kill', 'tmux:kill_menu');

      await ctx.reply(
        '*📺 Tmux Sessions*\n\n' +
        sessions.map(s => {
          const isCurrent = s.name === currentSession;
          const icon = isCurrent ? '📺' : s.attached ? '🟢' : '⚪';
          const marker = isCurrent ? ' ← *you*' : '';
          return `${icon} \`${s.name}\`${marker}\n   Created: ${s.created}`;
        }).join('\n\n'),
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
      return;
    }

    // Create new session
    if (subcommand === 'new' || subcommand === 'create') {
      if (!sessionArg) {
        await ctx.reply('Usage: `/tmux new <name>`\n\nExample: `/tmux new work`', { parse_mode: 'Markdown' });
        return;
      }

      // Validate name
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionArg)) {
        await ctx.reply('Session name can only contain letters, numbers, dash, and underscore.');
        return;
      }

      const exists = await isTmuxSessionActive(sessionArg);
      if (exists) {
        await ctx.reply(`Session \`${sessionArg}\` already exists. Use /attach ${sessionArg} to connect.`, { parse_mode: 'Markdown' });
        return;
      }

      const created = await createTmuxSession(sessionArg);
      if (created) {
        await ctx.reply(
          `✅ Created session \`${sessionArg}\`\n\nUse /attach ${sessionArg} to connect.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(`❌ Failed to create session \`${sessionArg}\``, { parse_mode: 'Markdown' });
      }
      return;
    }

    // Kill session
    if (subcommand === 'kill' || subcommand === 'rm' || subcommand === 'delete') {
      if (!sessionArg) {
        await ctx.reply('Usage: `/tmux kill <name>`\n\nExample: `/tmux kill work`', { parse_mode: 'Markdown' });
        return;
      }

      const exists = await isTmuxSessionActive(sessionArg);
      if (!exists) {
        await ctx.reply(`Session \`${sessionArg}\` doesn't exist.`, { parse_mode: 'Markdown' });
        return;
      }

      // If user is attached to this session, detach first
      const currentSession = getCurrentTmuxSession(userId);
      if (currentSession === sessionArg) {
        stopAutoRefresh(userId);
        setTmuxMode(userId, false);
      }

      await killTmuxSession(sessionArg);
      await ctx.reply(`🗑️ Killed session \`${sessionArg}\``, { parse_mode: 'Markdown' });
      return;
    }

    // Unknown subcommand
    await ctx.reply(
      '*Tmux Commands*\n\n' +
      '`/tmux` - List sessions\n' +
      '`/tmux new <name>` - Create session\n' +
      '`/tmux kill <name>` - Kill session\n' +
      '`/attach <name>` - Attach to session',
      { parse_mode: 'Markdown' }
    );
  });

  // /screen command - Show tmux screen
  bot.command('screen', async (ctx) => {
    const userId = ctx.from!.id;
    const session = getCurrentTmuxSession(userId);

    if (!session) {
      await ctx.reply('Not in Claude Mode. Use /attach first.');
      return;
    }

    let screen = await capturePane(session);

    // Truncate to avoid message too long
    if (screen.length > 3000) {
      screen = '...(truncated, use /full for complete)...\n' + screen.slice(-3000);
    }

    await ctx.reply(
      '```\n' + (screen || '(empty)') + '\n```',
      { parse_mode: 'Markdown' }
    );
  });

  // /ctrlc command - Send Ctrl+C
  bot.command('ctrlc', async (ctx) => {
    const userId = ctx.from!.id;
    const session = getCurrentTmuxSession(userId);

    if (!session) {
      await ctx.reply('Not in Claude Mode.');
      return;
    }

    await sendCtrlC(session);
    await ctx.reply('Sent Ctrl+C');

    // Show updated screen
    const screen = await capturePane(session);
    await ctx.reply(
      '```\n' + (screen || '(empty)') + '\n```',
      { parse_mode: 'Markdown' }
    );
  });

  // /reset command - Reset Claude Code context (sends /clear)
  bot.command('reset', async (ctx) => {
    const userId = ctx.from!.id;

    if (!isInTmuxMode(userId)) {
      await ctx.reply('Not in Claude Mode. Use /attach first.');
      return;
    }

    const session = getCurrentTmuxSession(userId);
    if (!session) {
      await ctx.reply('Not attached to any session. Use /attach first.');
      return;
    }

    await ctx.reply('🔄 Sending /clear to Claude Code...');

    // Send /clear to reset Claude's context
    await sendToTmux('/clear', session);
    await sendEnterToTmux(session);

    // Wait a moment for Claude to process
    await new Promise(resolve => setTimeout(resolve, 3000));

    let screen = await capturePane(session);

    // Truncate to avoid "message too long" error
    const lines = screen.split('\n');
    if (lines.length > 30) {
      screen = '...(truncated)...\n' + lines.slice(-30).join('\n');
    }
    if (screen.length > 2500) {
      screen = screen.slice(-2500);
    }

    await ctx.reply(
      '✅ Claude Code context cleared!\n\n' +
      '```\n' + (screen || '(empty)') + '\n```',
      { parse_mode: 'Markdown' }
    );
  });

  // /full command - Send full screen output as file (no truncation)
  bot.command('full', async (ctx) => {
    const userId = ctx.from!.id;

    if (!isInTmuxMode(userId)) {
      await ctx.reply('Not in Claude Mode. Use /attach first.');
      return;
    }

    const session = getCurrentTmuxSession(userId);
    if (!session) {
      await ctx.reply('Not attached to any session. Use /attach first.');
      return;
    }

    const screen = await capturePane(session);
    if (!screen || screen.trim() === '') {
      await ctx.reply('Screen is empty.');
      return;
    }

    await sendAsFile(ctx, screen, 'claude-output.txt');
  });

  // /status command - Show Claude Code's current status
  bot.command('status', async (ctx) => {
    const userId = ctx.from!.id;

    if (!isInTmuxMode(userId)) {
      await ctx.reply('Not in Claude Mode. Use /attach first.');
      return;
    }

    const session = getCurrentTmuxSession(userId);
    if (!session) {
      await ctx.reply('Not attached to any session. Use /attach first.');
      return;
    }

    const screen = await capturePane(session);
    const { isThinking, isReady, isDone, status } = parseClaudeStatus(screen);

    const statusEmoji = isThinking ? '🔄' : isDone ? '✅' : isReady ? '💬' : '❓';
    const statusText = isThinking ? 'Claude is thinking...' :
                       isDone ? 'Task completed' :
                       isReady ? 'Ready for input' :
                       'Unknown state';

    // Get last few lines for context
    const lastLines = screen.split('\n').slice(-5).join('\n');

    await ctx.reply(
      `${statusEmoji} *Status:* ${statusText}\n\n` +
      `*Last lines:*\n\`\`\`\n${lastLines}\n\`\`\``,
      { parse_mode: 'Markdown' }
    );
  });

  // /sessions command
  bot.command('sessions', async (ctx) => {
    const userId = ctx.from!.id;
    const sessions = listActiveSessions(userId);
    const activeName = getActiveSessionName(userId);

    if (sessions.length === 0) {
      getOrCreateDefaultSession(userId);
      setActiveSessionName(userId, 'default');
    }

    const sessionList = sessions.map((s) => {
      const marker = s.name === activeName ? '' : '  ';
      const status = s.isRunning ? ' (running)' : '';
      return `${marker} \`${s.name}\`${status}\n   ${shortenPath(s.cwd)}`;
    }).join('\n\n');

    await ctx.reply(
      '*Terminal Sessions*\n\n' +
      (sessionList || 'No sessions yet.') +
      '\n\n_Tap a session to switch_',
      {
        parse_mode: 'Markdown',
        reply_markup: getSessionsKeyboard(sessions, activeName),
      }
    );
  });

  // /new command
  bot.command('new', async (ctx) => {
    const userId = ctx.from!.id;
    const name = ctx.match?.trim();

    if (!name) {
      await ctx.reply('Please provide a session name:\n`/new work`', { parse_mode: 'Markdown' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      await ctx.reply('Session name can only contain letters, numbers, - and _');
      return;
    }

    try {
      const session = createSession(userId, name);
      setActiveSessionName(userId, name);
      await ctx.reply(
        `Created session \`${name}\`\nDirectory: \`${shortenPath(session.cwd)}\`\n\n_Now active_`,
        { parse_mode: 'Markdown', reply_markup: getQuickActionsKeyboard() }
      );
    } catch {
      await ctx.reply(`Session '${name}' already exists. Use /switch ${name}`);
    }
  });

  // /switch command
  bot.command('switch', async (ctx) => {
    const userId = ctx.from!.id;
    const name = ctx.match?.trim();

    if (!name) {
      const sessions = listActiveSessions(userId);
      const activeName = getActiveSessionName(userId);
      await ctx.reply('*Switch to session:*\n_Tap to select_', {
        parse_mode: 'Markdown',
        reply_markup: getSessionsKeyboard(sessions, activeName),
      });
      return;
    }

    const session = getActiveSession(userId, name);
    if (!session) {
      await ctx.reply(`Session '${name}' not found. Use /new ${name} to create it.`);
      return;
    }

    setActiveSessionName(userId, name);
    await ctx.reply(
      `Switched to \`${name}\`\nDirectory: \`${shortenPath(session.cwd)}\``,
      { parse_mode: 'Markdown', reply_markup: getQuickActionsKeyboard() }
    );
  });

  // /close command
  bot.command('close', async (ctx) => {
    const userId = ctx.from!.id;
    const name = ctx.match?.trim();

    if (!name) {
      await ctx.reply('Please specify session to close: `/close <name>`', { parse_mode: 'Markdown' });
      return;
    }

    if (name === 'default') {
      await ctx.reply("Cannot close the default session.");
      return;
    }

    await ctx.reply(
      `Close session \`${name}\`?\n\n_This will terminate any running commands._`,
      { parse_mode: 'Markdown', reply_markup: getCloseSessionKeyboard(name) }
    );
  });

  // /pwd command - Show current directory with breadcrumb navigation
  bot.command('pwd', async (ctx) => {
    const userId = ctx.from!.id;
    const sessionName = getActiveSessionName(userId);
    const session = getActiveSession(userId, sessionName) || getOrCreateDefaultSession(userId);
    const pins = getPins(userId);

    await ctx.reply(
      `${formatBreadcrumb(session.cwd)}\n_Session: ${session.name}_`,
      {
        parse_mode: 'Markdown',
        reply_markup: getBreadcrumbKeyboard(session.cwd, pins),
      }
    );
  });

  // /nav command - Alias for pwd with breadcrumb navigation
  bot.command('nav', async (ctx) => {
    const userId = ctx.from!.id;
    const sessionName = getActiveSessionName(userId);
    const session = getActiveSession(userId, sessionName) || getOrCreateDefaultSession(userId);
    const pins = getPins(userId);

    await ctx.reply(
      `${formatBreadcrumb(session.cwd)}\n_Session: ${session.name}_`,
      {
        parse_mode: 'Markdown',
        reply_markup: getBreadcrumbKeyboard(session.cwd, pins),
      }
    );
  });

  // /kill command
  bot.command('kill', async (ctx) => {
    const userId = ctx.from!.id;

    // If in tmux mode, send Ctrl+C
    if (isInTmuxMode(userId)) {
      const session = getCurrentTmuxSession(userId);
      if (session) {
        await sendCtrlC(session);
        await ctx.reply(`Sent Ctrl+C to tmux session '${session}'`);
      } else {
        await ctx.reply('Not attached to any tmux session.');
      }
      return;
    }

    const sessionName = getActiveSessionName(userId);
    const session = getActiveSession(userId, sessionName);

    if (!session) {
      await ctx.reply('No active session.');
      return;
    }

    if (executor.abort(session)) {
      await ctx.reply(`Killed running command in \`${sessionName}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('No command is running.');
    }
  });

  // /history command
  bot.command('history', async (ctx) => {
    const userId = ctx.from!.id;
    const sessionName = getActiveSessionName(userId);
    const history = getRecentHistory(userId, sessionName, 10);

    if (history.length === 0) {
      await ctx.reply('No command history yet.');
      return;
    }

    const historyText = history.map((h, i) => {
      const status = h.exit_code === 0 ? '' : '';
      return `${i + 1}. ${status} \`${h.command.slice(0, 40)}\``;
    }).join('\n');

    await ctx.reply(
      `*Recent Commands* (${sessionName})\n\n${historyText}\n\n_Tap to re-run_`,
      { parse_mode: 'Markdown', reply_markup: getHistoryKeyboard(history.map(h => h.command)) }
    );
  });

  // /quick command
  bot.command('quick', async (ctx) => {
    await ctx.reply('Quick Actions', { reply_markup: getQuickActionsKeyboard() });
  });

  // /pin command - Pin current directory as a project
  bot.command('pin', async (ctx) => {
    const userId = ctx.from!.id;
    const name = ctx.match?.trim();

    if (!name) {
      await ctx.reply('Usage: `/pin <name>`\nExample: `/pin myproject`', { parse_mode: 'Markdown' });
      return;
    }

    // Get current directory
    const sessionName = getActiveSessionName(userId);
    const session = getActiveSession(userId, sessionName) || getOrCreateDefaultSession(userId);
    const currentPath = session.cwd;

    addPin(userId, name, currentPath);
    await ctx.reply(
      `📌 Pinned \`${name}\`\n📁 ${shortenPath(currentPath)}\n\nUse /pins to see all projects`,
      { parse_mode: 'Markdown' }
    );
  });

  // /unpin command - Remove a pinned project
  bot.command('unpin', async (ctx) => {
    const userId = ctx.from!.id;
    const name = ctx.match?.trim();

    if (!name) {
      const pins = getPins(userId);
      if (pins.length === 0) {
        await ctx.reply('No pinned projects. Use /pin <name> to pin current directory.');
        return;
      }
      await ctx.reply(
        '*Unpin a project:*\n`/unpin <name>`',
        { parse_mode: 'Markdown', reply_markup: getProjectsKeyboard(pins) }
      );
      return;
    }

    if (removePin(userId, name)) {
      await ctx.reply(`Unpinned \`${name}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`Project '${name}' not found.`);
    }
  });

  // /pins command - List pinned projects
  bot.command('pins', async (ctx) => {
    const userId = ctx.from!.id;
    const pins = getPins(userId);

    if (pins.length === 0) {
      await ctx.reply(
        '*No pinned projects*\n\nPin the current directory:\n`/pin <name>`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const pinList = pins.map(p => `📌 \`${p.name}\` → ${shortenPath(p.path)}`).join('\n');
    await ctx.reply(
      `*Pinned Projects*\n\n${pinList}\n\n_Tap to switch_`,
      { parse_mode: 'Markdown', reply_markup: getProjectsKeyboard(pins) }
    );
  });

  // /search command - Search command history
  bot.command('search', async (ctx) => {
    const userId = ctx.from!.id;
    const query = ctx.match?.trim();

    if (!query) {
      await ctx.reply('Usage: `/search <query>`\nExample: `/search git`', { parse_mode: 'Markdown' });
      return;
    }

    const results = searchHistory(userId, query, 10);

    if (results.length === 0) {
      await ctx.reply(`No results for "${query}"`);
      return;
    }

    const resultList = results.map((r, i) => {
      const status = r.exit_code === 0 ? '✓' : '✗';
      return `${i + 1}. ${status} \`${r.command.slice(0, 40)}\``;
    }).join('\n');

    await ctx.reply(
      `*Search: "${query}"*\n\n${resultList}\n\n_Tap to re-run_`,
      { parse_mode: 'Markdown', reply_markup: getHistoryKeyboard(results.map(r => r.command)) }
    );
  });

  // /bookmarks command - List saved Claude responses
  bot.command('bookmarks', async (ctx) => {
    const userId = ctx.from!.id;
    const query = ctx.match?.trim();

    // If query provided, search bookmarks
    if (query) {
      const results = searchBookmarks(userId, query);
      if (results.length === 0) {
        await ctx.reply(`No bookmarks matching "${query}"`);
        return;
      }
      const resultList = results.map((b, i) =>
        `${i + 1}. ⭐ *${b.title}*\n   _${new Date(b.created_at).toLocaleDateString()}_`
      ).join('\n\n');
      await ctx.reply(
        `*Search: "${query}"*\n\n${resultList}`,
        { parse_mode: 'Markdown', reply_markup: getBookmarksKeyboard(results) }
      );
      return;
    }

    const bookmarks = getBookmarks(userId);
    const count = getBookmarkCount(userId);

    if (bookmarks.length === 0) {
      await ctx.reply(
        '*No bookmarks yet*\n\n' +
        'When Claude finishes, tap ⭐ Save to bookmark the response.\n\n' +
        '_Bookmarks are stored locally on your Mac._',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const bookmarkList = bookmarks.slice(0, 5).map((b, i) =>
      `${i + 1}. ⭐ *${b.title.slice(0, 40)}${b.title.length > 40 ? '...' : ''}*\n   _${new Date(b.created_at).toLocaleDateString()}_`
    ).join('\n\n');

    await ctx.reply(
      `*Your Bookmarks* (${count} total)\n\n${bookmarkList}\n\n_Tap to view_`,
      { parse_mode: 'Markdown', reply_markup: getBookmarksKeyboard(bookmarks) }
    );
  });

  // /usage command - Show token usage dashboard
  bot.command('usage', async (ctx) => {
    const userId = ctx.from!.id;
    const summary = getUsageSummary(userId);

    const todayTokens = summary.today
      ? formatTokenCount(summary.today.input_tokens + summary.today.output_tokens)
      : '0';
    const todayCost = summary.today ? formatCost(summary.today.estimated_cost) : '$0';

    const weekTokens = formatTokenCount(summary.thisWeek.input_tokens + summary.thisWeek.output_tokens);
    const weekCost = formatCost(summary.thisWeek.estimated_cost);

    const monthTokens = formatTokenCount(summary.thisMonth.input_tokens + summary.thisMonth.output_tokens);
    const monthCost = formatCost(summary.thisMonth.estimated_cost);

    await ctx.reply(
      '*💰 Token Usage Dashboard*\n\n' +
      `*Today*\n` +
      `├ Tokens: ${todayTokens}\n` +
      `└ Cost: ${todayCost}\n\n` +
      `*This Week*\n` +
      `├ Tokens: ${weekTokens}\n` +
      `└ Cost: ${weekCost}\n\n` +
      `*This Month*\n` +
      `├ Tokens: ${monthTokens}\n` +
      `└ Cost: ${monthCost}\n\n` +
      '_Tap 📊 Details for Claude\'s breakdown_',
      { parse_mode: 'Markdown', reply_markup: getUsageKeyboard() }
    );
  });

  // /context command - Show context meter
  bot.command('context', async (ctx) => {
    const userId = ctx.from!.id;
    const report = formatContextReport(userId);

    await ctx.reply(report, {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard()
        .text('🔄 Refresh', 'action:context_refresh')
        .text('🗑️ Reset', 'action:reset')
        .row()
        .text('◀️ Back', 'action:menu'),
    });
  });

  // /export command - Export conversation as markdown
  bot.command('export', async (ctx) => {
    const userId = ctx.from!.id;

    if (!isInTmuxMode(userId)) {
      await ctx.reply('Not in Claude Mode. Use /attach first.');
      return;
    }

    const session = getCurrentTmuxSession(userId);
    if (!session) {
      await ctx.reply('Not attached to any session. Use /attach first.');
      return;
    }

    const screen = await capturePane(session);
    if (!screen || screen.trim() === '') {
      await ctx.reply('Nothing to export.');
      return;
    }

    // Format as markdown
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const markdown = `# Claude Conversation Export\n\n` +
      `**Exported:** ${new Date().toLocaleString()}\n\n` +
      `---\n\n` +
      `\`\`\`\n${screen}\n\`\`\`\n`;

    await sendAsFile(ctx, markdown, `claude-export-${timestamp}.md`);
  });

  // /view command - View file with syntax highlighting
  bot.command('view', async (ctx) => {
    const userId = ctx.from!.id;
    const filepath = ctx.match?.trim();

    if (!filepath) {
      await ctx.reply(
        '*View a file*\n\n' +
        'Usage: `/view <filepath>`\n\n' +
        'Examples:\n' +
        '`/view src/index.ts`\n' +
        '`/view package.json`\n' +
        '`/view README.md`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Detect language from extension for syntax highlighting
    const ext = filepath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
      cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', cs: 'csharp',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
      md: 'markdown', html: 'html', css: 'css', scss: 'scss',
      sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
      sql: 'sql', graphql: 'graphql', prisma: 'prisma',
      dockerfile: 'dockerfile', makefile: 'makefile',
    };
    const lang = langMap[ext] || '';

    if (isInTmuxMode(userId)) {
      // In Claude mode - use cat command via tmux
      const session = getCurrentTmuxSession(userId);
      if (!session) {
        await ctx.reply('Not attached to any session. Use /attach first.');
        return;
      }
      const safeFilepath = filepath.replace(/'/g, "'\\''");
      await sendToTmux(`cat '${safeFilepath}'`, session);
      await sendEnterToTmux(session);
      await new Promise(r => setTimeout(r, 500));

      const screen = await capturePane(session);
      const lines = screen.split('\n');

      // Find the cat output (between command and next prompt)
      let startIdx = lines.findIndex(l => l.includes(`cat '${safeFilepath}'`) || l.includes(`cat ${filepath}`));
      if (startIdx === -1) startIdx = 0;
      else startIdx++;

      let endIdx = lines.length;
      for (let i = startIdx; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === '>' || t.startsWith('> ') || t.includes('No such file')) {
          endIdx = i;
          break;
        }
      }

      const content = lines.slice(startIdx, endIdx).join('\n').trim();

      if (!content || content.includes('No such file')) {
        await ctx.reply(`❌ File not found: \`${filepath}\``, { parse_mode: 'Markdown' });
        return;
      }

      // Truncate if too long
      const maxLines = 50;
      const contentLines = content.split('\n');
      const truncated = contentLines.length > maxLines;
      const displayContent = truncated
        ? contentLines.slice(0, maxLines).join('\n') + `\n\n... (${contentLines.length - maxLines} more lines)`
        : content;

      const filename = filepath.split('/').pop() || filepath;
      await ctx.reply(
        `📄 *${filename}*${truncated ? ` _(showing ${maxLines}/${contentLines.length} lines)_` : ''}\n\n` +
        `\`\`\`${lang}\n${displayContent}\n\`\`\``,
        {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('📄 Full file', `viewfull:${filepath}`)
            .text('📋 Copy path', `copypath:${filepath}`),
        }
      );
    } else {
      // Not in Claude mode - use session's cwd
      const sessionName = getActiveSessionName(userId);
      const session = getActiveSession(userId, sessionName);
      const cwd = session?.cwd || process.cwd();

      // Read file directly
      const fullPath = filepath.startsWith('/') ? filepath : `${cwd}/${filepath}`;

      try {
        const { readFileSync, existsSync } = await import('fs');
        if (!existsSync(fullPath)) {
          await ctx.reply(`❌ File not found: \`${filepath}\``, { parse_mode: 'Markdown' });
          return;
        }

        const content = readFileSync(fullPath, 'utf-8');
        const contentLines = content.split('\n');
        const maxLines = 50;
        const truncated = contentLines.length > maxLines;
        const displayContent = truncated
          ? contentLines.slice(0, maxLines).join('\n') + `\n\n... (${contentLines.length - maxLines} more lines)`
          : content;

        const filename = filepath.split('/').pop() || filepath;
        await ctx.reply(
          `📄 *${filename}*${truncated ? ` _(showing ${maxLines}/${contentLines.length} lines)_` : ''}\n\n` +
          `\`\`\`${lang}\n${displayContent}\n\`\`\``,
          {
            parse_mode: 'Markdown',
            reply_markup: new InlineKeyboard()
              .text('📄 Full file', `viewfull:${filepath}`)
              .text('📋 Copy path', `copypath:${filepath}`),
          }
        );
      } catch (error) {
        await ctx.reply(`❌ Error reading file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  });

  // /voice command - Toggle voice output for Claude responses
  bot.command('voice', async (ctx) => {
    const userId = ctx.from!.id;
    const settings = getUserSettings(userId);
    const newState = !settings.voice_output_enabled;
    setVoiceOutput(userId, newState);

    const whisperAvailable = await isWhisperAvailable();
    const statusIcon = newState ? '🔊' : '🔇';

    await ctx.reply(
      `${statusIcon} *Voice output ${newState ? 'enabled' : 'disabled'}*\n\n` +
      (newState
        ? 'Claude responses will be converted to audio.\n\n' +
          `_Whisper status: ${whisperAvailable ? '✅ Available' : '⚠️ Not installed'}_`
        : 'Text-only mode activated.'),
      { parse_mode: 'Markdown' }
    );
  });

  // /alias command - Create custom shortcut
  bot.command('alias', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.match?.trim();

    if (!args) {
      await ctx.reply(
        '*Create a shortcut*\n\n' +
        'Usage: `/alias <name> <command>`\n\n' +
        'Examples:\n' +
        '`/alias gs git status`\n' +
        '`/alias ll ls -la`\n' +
        '`/alias dc docker-compose up -d`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const [name, ...cmdParts] = args.split(' ');
    const command = cmdParts.join(' ');

    if (!name || !command) {
      await ctx.reply('Usage: `/alias <name> <command>`', { parse_mode: 'Markdown' });
      return;
    }

    // Validate name
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      await ctx.reply('Alias name can only contain letters, numbers, - and _');
      return;
    }

    setShortcut(userId, name, command);
    await ctx.reply(
      `✅ *Alias created*\n\n\`${name}\` → \`${command}\`\n\n_Type \`!${name}\` to run_`,
      { parse_mode: 'Markdown' }
    );
  });

  // /aliases command - List all shortcuts
  bot.command('aliases', async (ctx) => {
    const userId = ctx.from!.id;
    const shortcuts = getShortcuts(userId);

    if (shortcuts.length === 0) {
      await ctx.reply(
        '*No aliases yet*\n\n' +
        'Create one with `/alias <name> <command>`\n\n' +
        'Example: `/alias gs git status`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const aliasList = shortcuts.map(s =>
      `\`${s.name}\` → \`${s.command.slice(0, 40)}${s.command.length > 40 ? '...' : ''}\``
    ).join('\n');

    await ctx.reply(
      `*Your Aliases* (${shortcuts.length})\n\n${aliasList}\n\n_Type \`!name\` to run_`,
      { parse_mode: 'Markdown' }
    );
  });

  // /unalias command - Remove shortcut
  bot.command('unalias', async (ctx) => {
    const userId = ctx.from!.id;
    const name = ctx.match?.trim();

    if (!name) {
      await ctx.reply('Usage: `/unalias <name>`', { parse_mode: 'Markdown' });
      return;
    }

    if (deleteShortcut(userId, name)) {
      await ctx.reply(`Removed alias \`${name}\``, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`Alias \`${name}\` not found`, { parse_mode: 'Markdown' });
    }
  });

  // /remember command - Save project memory
  bot.command('remember', async (ctx) => {
    const userId = ctx.from!.id;
    const args = ctx.match?.trim();

    // Get current project from pin or cwd
    const sessionName = getActiveSessionName(userId);
    const session = getActiveSession(userId, sessionName);
    const currentProject = getCurrentProject(userId) || session?.cwd.split('/').pop() || 'default';

    if (!args) {
      await ctx.reply(
        `*Remember project info*\n\n` +
        `Current project: \`${currentProject}\`\n\n` +
        'Usage: `/remember <key> <value>`\n\n' +
        'Examples:\n' +
        '`/remember stack Node.js + PostgreSQL`\n' +
        '`/remember deploy vercel --prod`\n' +
        '`/remember test npm run test:e2e`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const [key, ...valueParts] = args.split(' ');
    const value = valueParts.join(' ');

    if (!key || !value) {
      await ctx.reply('Usage: `/remember <key> <value>`', { parse_mode: 'Markdown' });
      return;
    }

    setProjectMemory(userId, currentProject, key, value);
    await ctx.reply(
      `🧠 *Remembered for "${currentProject}"*\n\n` +
      `\`${key}\`: ${value}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /memories command - List project memories
  bot.command('memories', async (ctx) => {
    const userId = ctx.from!.id;

    // Get current project
    const sessionName = getActiveSessionName(userId);
    const session = getActiveSession(userId, sessionName);
    const currentProject = getCurrentProject(userId) || session?.cwd.split('/').pop() || 'default';

    const memories = getProjectMemories(userId, currentProject);

    if (memories.length === 0) {
      await ctx.reply(
        `*No memories for "${currentProject}"*\n\n` +
        'Save project info with `/remember <key> <value>`\n\n' +
        'Examples:\n' +
        '• `/remember stack React + Supabase`\n' +
        '• `/remember deploy npm run build && vercel`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const memoryList = memories.map(m => `• \`${m.key}\`: ${m.value}`).join('\n');

    await ctx.reply(
      `🧠 *Memories for "${currentProject}"*\n\n${memoryList}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /forget command - Remove project memory
  bot.command('forget', async (ctx) => {
    const userId = ctx.from!.id;
    const key = ctx.match?.trim();

    if (!key) {
      await ctx.reply('Usage: `/forget <key>`', { parse_mode: 'Markdown' });
      return;
    }

    // Get current project
    const sessionName = getActiveSessionName(userId);
    const session = getActiveSession(userId, sessionName);
    const currentProject = getCurrentProject(userId) || session?.cwd.split('/').pop() || 'default';

    if (deleteProjectMemory(userId, currentProject, key)) {
      await ctx.reply(`Forgot \`${key}\` from "${currentProject}"`, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(`Memory \`${key}\` not found in "${currentProject}"`, { parse_mode: 'Markdown' });
    }
  });

  // Handle callback queries (button presses)
  bot.on('callback_query:data', async (ctx) => {
    const userId = ctx.from!.id;
    const data = ctx.callbackQuery.data;

    // Track activity for memory cleanup
    updateUserActivity(userId);

    await ctx.answerCallbackQuery();

    if (data.startsWith('cmd:')) {
      const command = data.slice(4);

      // If in tmux mode, send to tmux
      if (isInTmuxMode(userId)) {
        const session = getCurrentTmuxSession(userId);
        if (!session) {
          await ctx.reply('Not attached to any session.');
          return;
        }
        stopAutoRefresh(userId);
        await sendToTmux(command, session);
        await sendEnterToTmux(session);
        await new Promise(r => setTimeout(r, 800));
        const screen = await capturePane(session);
        await ctx.reply('```\n' + (screen || '(empty)') + '\n```', { parse_mode: 'Markdown' });
        userLastScreen.set(userId, screen);
        startAutoRefresh(userId, ctx.chat!.id, bot, screen);
        return;
      }

      await executeCommand(ctx, userId, command, config, executor, notifier);
      return;
    }

    if (data.startsWith('switch:')) {
      const name = data.slice(7);
      const session = getActiveSession(userId, name);
      if (session) {
        setActiveSessionName(userId, name);
        await ctx.editMessageText(
          `Switched to \`${name}\`\nDirectory: \`${shortenPath(session.cwd)}\``,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Breadcrumb Navigation Handlers
    // ─────────────────────────────────────────────────────────────────────────
    if (data.startsWith('nav:')) {
      const action = data.slice(4);
      const sessionName = getActiveSessionName(userId);
      const session = getActiveSession(userId, sessionName) || getOrCreateDefaultSession(userId);
      const pins = getPins(userId);
      const home = process.env.HOME || '/Users';

      let newCwd = session.cwd;

      switch (action) {
        case 'up': {
          // Go up one directory
          const parts = session.cwd.split('/');
          if (parts.length > 2) {
            parts.pop();
            newCwd = parts.join('/') || '/';
          }
          break;
        }
        case 'home': {
          newCwd = home;
          break;
        }
      }

      if (newCwd !== session.cwd) {
        // Update session cwd (this updates both memory and DB)
        updateCwd(userId, sessionName, newCwd);

        // Show updated breadcrumb
        await ctx.editMessageText(
          `${formatBreadcrumb(newCwd)}\n_Session: ${session.name}_`,
          {
            parse_mode: 'Markdown',
            reply_markup: getBreadcrumbKeyboard(newCwd, pins),
          }
        );
      }
      return;
    }

    if (data.startsWith('history:')) {
      const command = data.slice(8);
      // If it's a slash command, tell user to type it instead
      if (command.startsWith('/')) {
        await ctx.answerCallbackQuery(`Type: ${command}`);
        return;
      }
      await executeCommand(ctx, userId, command, config, executor, notifier);
      return;
    }

    if (data.startsWith('confirm:')) {
      const encoded = data.slice(8);
      const command = Buffer.from(encoded, 'base64').toString();

      // SECURITY: Verify command matches what we stored (prevent callback tampering)
      const pending = pendingConfirmations.get(userId);
      if (!pending || pending !== command) {
        await ctx.answerCallbackQuery({ text: 'Invalid or expired confirmation' });
        return;
      }

      pendingConfirmations.delete(userId);
      await executeCommand(ctx, userId, command, config, executor, notifier, true);
      return;
    }

    if (data.startsWith('close_confirm:')) {
      const name = data.slice(14);
      const activeName = getActiveSessionName(userId);

      if (closeSession(userId, name)) {
        if (activeName === name) {
          setActiveSessionName(userId, 'default');
          getOrCreateDefaultSession(userId);
        }
        await ctx.editMessageText(`Session \`${name}\` closed.`, { parse_mode: 'Markdown' });
      } else {
        await ctx.editMessageText(`Session '${name}' not found.`);
      }
      return;
    }

    if (data.startsWith('action:')) {
      const action = data.slice(7);

      switch (action) {
        case 'menu':
          await ctx.editMessageText('Quick Actions', { reply_markup: getQuickActionsKeyboard() });
          break;

        case 'sessions': {
          const sessions = listActiveSessions(userId);
          const activeName = getActiveSessionName(userId);
          await ctx.editMessageText('*Terminal Sessions*\n_Tap to switch_', {
            parse_mode: 'Markdown',
            reply_markup: getSessionsKeyboard(sessions, activeName),
          });
          break;
        }

        case 'history': {
          const sessionName = getActiveSessionName(userId);
          const history = getRecentHistory(userId, sessionName, 5);
          if (history.length === 0) {
            await ctx.editMessageText('No command history yet.', { reply_markup: getQuickActionsKeyboard() });
          } else {
            await ctx.editMessageText('*Recent Commands*\n_Tap to re-run_', {
              parse_mode: 'Markdown',
              reply_markup: getHistoryKeyboard(history.map(h => h.command)),
            });
          }
          break;
        }

        case 'kill': {
          if (isInTmuxMode(userId)) {
            const tmuxSession = getCurrentTmuxSession(userId);
            if (tmuxSession) {
              await sendCtrlC(tmuxSession);
              await ctx.editMessageText(`Sent Ctrl+C to '${tmuxSession}'`);
            } else {
              await ctx.editMessageText('Not attached to any tmux session.');
            }
            return;
          }
          const sessionName = getActiveSessionName(userId);
          const session = getActiveSession(userId, sessionName);
          if (session && executor.abort(session)) {
            await ctx.editMessageText('Command killed.');
          } else {
            await ctx.editMessageText('No command running.');
          }
          break;
        }

        case 'new_session':
          await ctx.editMessageText('Create a new session:\n`/new <name>`\n\nExample: `/new work`', { parse_mode: 'Markdown' });
          break;

        case 'cancel':
          pendingConfirmations.delete(userId);
          await ctx.editMessageText('Cancelled.');
          break;

        case 'projects': {
          const pins = getPins(userId);
          await ctx.editMessageText('*📌 Pinned Projects*\n_Tap to switch_', {
            parse_mode: 'Markdown',
            reply_markup: getProjectsKeyboard(pins),
          });
          break;
        }

        case 'search':
          await ctx.editMessageText(
            '*🔍 Search History*\n\nType `/search <query>` to find commands\n\nExample: `/search git`',
            { parse_mode: 'Markdown', reply_markup: getSearchKeyboard() }
          );
          break;

        case 'screen': {
          const tmuxSession = getCurrentTmuxSession(userId);
          if (!tmuxSession) {
            await ctx.editMessageText('Not attached to any session.');
            break;
          }
          const screen = await capturePane(tmuxSession);
          await ctx.editMessageText(
            '```\n' + (screen || '(empty)') + '\n```',
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'ctrlc': {
          const tmuxSession = getCurrentTmuxSession(userId);
          if (!tmuxSession) {
            await ctx.editMessageText('Not attached to any session.');
            break;
          }
          await sendCtrlC(tmuxSession);
          // Stop any auto-refresh
          stopAutoRefresh(userId);
          try {
            await ctx.editMessageText('⏹️ Sent Ctrl+C');
          } catch {
            // Message might have been deleted
            await ctx.reply('⏹️ Sent Ctrl+C');
          }
          // Show current screen
          const ctrlcScreen = await capturePane(tmuxSession);
          await bot.api.sendMessage(ctx.chat!.id,
            '```\n' + (ctrlcScreen || '(empty)') + '\n```',
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'pin_current':
        case 'pin_prompt':
          await ctx.editMessageText(
            '*📍 Pin current folder*\n\nType `/pin <name>` to save it\n\nExample: `/pin work`',
            { parse_mode: 'Markdown' }
          );
          break;

        case 'attach': {
          // Show session picker via button
          const sessions = await listTmuxSessions();
          if (sessions.length === 0) {
            await ctx.editMessageText(
              '*No tmux sessions*\n\n' +
              'Create one with `/attach <name>` or use `/tmux new <name>`',
              { parse_mode: 'Markdown' }
            );
          } else {
            const keyboard = new InlineKeyboard();
            sessions.forEach((s) => {
              const marker = s.attached ? ' 🟢' : '';
              keyboard.text(`${s.name}${marker}`, `tmux:attach:${s.name}`).row();
            });
            keyboard.text('+ New Session', 'tmux:new').row();
            keyboard.text('◀️ Back', 'action:menu');
            await ctx.editMessageText(
              '*📺 Tmux Sessions*\n_Tap to attach_',
              { parse_mode: 'Markdown', reply_markup: keyboard }
            );
          }
          break;
        }

        case 'detach': {
          const currentSession = getCurrentTmuxSession(userId);
          stopAutoRefresh(userId);
          setTmuxMode(userId, false);
          await ctx.editMessageText(
            `👋 Detached from '${currentSession || 'session'}'.\n\nBack to normal mode.`,
            { reply_markup: getMainMenuKeyboard(false) }
          );
          break;
        }

        case 'reset': {
          if (!isInTmuxMode(userId)) {
            await ctx.reply('Not in Claude Mode. Use /attach first.');
            return;
          }
          const tmuxSession = getCurrentTmuxSession(userId);
          if (!tmuxSession) {
            await ctx.reply('Not attached to any session.');
            return;
          }
          await ctx.editMessageText('🔄 Resetting Claude context...');
          await sendToTmux('/clear', tmuxSession);
          await sendEnterToTmux(tmuxSession);
          await new Promise(resolve => setTimeout(resolve, 3000));
          // Reset context meter
          resetContext(userId);
          let resetScreen = await capturePane(tmuxSession);
          if (resetScreen.length > 2000) {
            resetScreen = resetScreen.slice(-2000);
          }
          await bot.api.sendMessage(ctx.chat!.id,
            '✅ Context cleared!\n\n```\n' + (resetScreen || '(empty)') + '\n```',
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'context_refresh': {
          const report = formatContextReport(userId);
          await ctx.editMessageText(report, {
            parse_mode: 'Markdown',
            reply_markup: new InlineKeyboard()
              .text('🔄 Refresh', 'action:context_refresh')
              .text('🗑️ Reset', 'action:reset')
              .row()
              .text('◀️ Back', 'action:menu'),
          });
          break;
        }

        case 'full': {
          if (!isInTmuxMode(userId)) {
            await ctx.reply('Not in Claude Mode. Use /attach first.');
            return;
          }
          const tmuxSession = getCurrentTmuxSession(userId);
          if (!tmuxSession) {
            await ctx.reply('Not attached to any session.');
            return;
          }
          const fullScreen = await capturePane(tmuxSession);
          if (!fullScreen || fullScreen.trim() === '') {
            await ctx.reply('Screen is empty.');
            return;
          }
          await sendAsFile(ctx, fullScreen, 'claude-output.txt');
          break;
        }

        case 'copy': {
          if (!isInTmuxMode(userId)) {
            await ctx.answerCallbackQuery({ text: 'Not in Claude Mode' });
            return;
          }
          const tmuxSession = getCurrentTmuxSession(userId);
          if (!tmuxSession) {
            await ctx.answerCallbackQuery({ text: 'Not attached to any session' });
            return;
          }
          const copyScreen = await capturePane(tmuxSession);
          if (!copyScreen || copyScreen.trim() === '') {
            await ctx.answerCallbackQuery({ text: 'Nothing to copy' });
            return;
          }
          const success = await copyToClipboard(copyScreen);
          if (success) {
            await ctx.answerCallbackQuery({ text: '📋 Copied to Mac clipboard!' });
          } else {
            await ctx.answerCallbackQuery({ text: 'Failed to copy' });
          }
          break;
        }

        case 'bookmark': {
          if (!isInTmuxMode(userId)) {
            await ctx.answerCallbackQuery({ text: 'Not in Claude Mode' });
            return;
          }
          const tmuxSession = getCurrentTmuxSession(userId);
          if (!tmuxSession) {
            await ctx.answerCallbackQuery({ text: 'Not attached to any session' });
            return;
          }
          const bookmarkScreen = await capturePane(tmuxSession);
          if (!bookmarkScreen || bookmarkScreen.trim() === '') {
            await ctx.answerCallbackQuery({ text: 'Nothing to bookmark' });
            return;
          }
          // Generate title from first non-empty line or timestamp
          const lines = bookmarkScreen.split('\n').filter(l => l.trim());
          let title = lines[0]?.slice(0, 50) || `Bookmark ${new Date().toLocaleTimeString()}`;
          // Clean up title
          title = title.replace(/[`*_\[\]]/g, '').trim();
          if (title.length < 3) {
            title = `Claude response - ${new Date().toLocaleTimeString()}`;
          }

          const bookmarkId = addBookmark(userId, title, bookmarkScreen);
          await ctx.answerCallbackQuery({ text: `⭐ Saved! (ID: ${bookmarkId})` });
          break;
        }

        case 'bookmarks': {
          const bookmarks = getBookmarks(userId);
          const count = getBookmarkCount(userId);
          if (bookmarks.length === 0) {
            await ctx.editMessageText(
              '*No bookmarks yet*\n\nTap ⭐ Save when Claude finishes to bookmark.',
              { parse_mode: 'Markdown' }
            );
          } else {
            await ctx.editMessageText(
              `*Your Bookmarks* (${count} total)\n\n_Tap to view_`,
              { parse_mode: 'Markdown', reply_markup: getBookmarksKeyboard(bookmarks) }
            );
          }
          break;
        }

        case 'search_bookmarks':
          await ctx.editMessageText(
            '*🔍 Search Bookmarks*\n\nType `/bookmarks <query>` to search\n\nExample: `/bookmarks auth`',
            { parse_mode: 'Markdown' }
          );
          break;

        case 'usage_refresh': {
          const summary = getUsageSummary(userId);
          const todayTokens = summary.today
            ? formatTokenCount(summary.today.input_tokens + summary.today.output_tokens)
            : '0';
          const todayCost = summary.today ? formatCost(summary.today.estimated_cost) : '$0';
          const weekTokens = formatTokenCount(summary.thisWeek.input_tokens + summary.thisWeek.output_tokens);
          const weekCost = formatCost(summary.thisWeek.estimated_cost);

          await ctx.editMessageText(
            '*💰 Token Usage*\n\n' +
            `*Today:* ${todayTokens} (${todayCost})\n` +
            `*This Week:* ${weekTokens} (${weekCost})`,
            { parse_mode: 'Markdown', reply_markup: getUsageKeyboard() }
          );
          break;
        }

        case 'noop':
          // Do nothing - just acknowledge
          await ctx.answerCallbackQuery();
          break;
      }
      return;
    }

    // Handle smart reply actions (Claude done buttons)
    if (data.startsWith('smart:')) {
      const action = data.slice(6);

      if (!isInTmuxMode(userId)) {
        await ctx.reply('Not in terminal mode. Use /attach first.');
        return;
      }

      let response = '';
      let thinkingText = '';
      switch (action) {
        case 'ultrathink':
          response = 'ultrathink';
          thinkingText = '🧠 *Ultrathink mode activated...*';
          break;
        case 'usage':
          response = '/cost';
          thinkingText = '💰 *Checking usage...*';
          break;
        case 'fix':
          response = 'Please fix the error above';
          thinkingText = '🔧 *Asking Claude to fix...*';
          break;
        case 'yes':
          response = 'Yes';
          thinkingText = '✅ *Confirming...*';
          break;
        case 'no':
          response = 'No';
          thinkingText = '❌ *Declining...*';
          break;
        case 'run':
          response = 'Run the code you just showed';
          thinkingText = '▶️ *Running code...*';
          break;
        case 'continue':
          response = '';  // Just press Enter
          thinkingText = '➡️ *Continuing...*';
          break;
        case 'retry': {
          const lastCmd = userLastCommand.get(userId);
          if (lastCmd) {
            response = lastCmd;
            thinkingText = '🔄 *Retrying...*';
          } else {
            await ctx.answerCallbackQuery({ text: 'No previous command to retry' });
            return;
          }
          break;
        }
        default:
          return;
      }

      const tmuxSession = getCurrentTmuxSession(userId);
      if (!tmuxSession) {
        await ctx.reply('Not attached to any session.');
        return;
      }

      // Show thinking indicator
      const thinkingMsg = await ctx.reply(thinkingText, {
        parse_mode: 'Markdown',
        reply_markup: getClaudeThinkingKeyboard(),
      });

      // Send to tmux (or just Enter for continue)
      if (response) {
        await sendToTmux(response, tmuxSession);
      }
      await sendEnterToTmux(tmuxSession);
      await new Promise(r => setTimeout(r, 500));

      const screen = await capturePane(tmuxSession);
      userLastScreen.set(userId, screen);
      startAutoRefresh(userId, ctx.chat!.id, bot, screen, thinkingMsg.message_id, response || '');
      return;
    }

    // Handle bookmark actions (view, copy, delete)
    if (data.startsWith('bookmark:')) {
      const parts = data.split(':');
      const action = parts[1];
      const bookmarkId = parseInt(parts[2], 10);

      if (isNaN(bookmarkId)) {
        await ctx.answerCallbackQuery({ text: 'Invalid bookmark' });
        return;
      }

      switch (action) {
        case 'view': {
          const bookmark = getBookmark(userId, bookmarkId);
          if (!bookmark) {
            await ctx.answerCallbackQuery({ text: 'Bookmark not found' });
            return;
          }
          // Show bookmark content (truncated for Telegram)
          let content = bookmark.content;
          if (content.length > 2500) {
            content = content.slice(0, 2500) + '\n...(truncated)';
          }
          await ctx.editMessageText(
            `⭐ *${bookmark.title}*\n` +
            `_${new Date(bookmark.created_at).toLocaleString()}_\n\n` +
            `\`\`\`\n${content}\n\`\`\``,
            {
              parse_mode: 'Markdown',
              reply_markup: getBookmarkViewKeyboard(bookmarkId),
            }
          );
          break;
        }

        case 'copy': {
          const bookmark = getBookmark(userId, bookmarkId);
          if (!bookmark) {
            await ctx.answerCallbackQuery({ text: 'Bookmark not found' });
            return;
          }
          const success = await copyToClipboard(bookmark.content);
          if (success) {
            await ctx.answerCallbackQuery({ text: '📋 Copied to Mac clipboard!' });
          } else {
            await ctx.answerCallbackQuery({ text: 'Failed to copy' });
          }
          break;
        }

        case 'delete': {
          const deleted = deleteBookmark(userId, bookmarkId);
          if (deleted) {
            await ctx.answerCallbackQuery({ text: '🗑️ Bookmark deleted' });
            // Show updated bookmarks list
            const bookmarks = getBookmarks(userId);
            const count = getBookmarkCount(userId);
            if (bookmarks.length === 0) {
              await ctx.editMessageText(
                '*No bookmarks yet*\n\nTap ⭐ Save when Claude finishes to bookmark.',
                { parse_mode: 'Markdown' }
              );
            } else {
              await ctx.editMessageText(
                `*Your Bookmarks* (${count} total)\n\n_Tap to view_`,
                { parse_mode: 'Markdown', reply_markup: getBookmarksKeyboard(bookmarks) }
              );
            }
          } else {
            await ctx.answerCallbackQuery({ text: 'Bookmark not found' });
          }
          break;
        }
      }
      return;
    }

    // Handle file viewer actions (viewfull, copypath)
    if (data.startsWith('viewfull:')) {
      const filepath = data.slice(9);

      // Validate file path for security
      const pathValidation = validateFilePath(filepath);
      if (!pathValidation.allowed) {
        await ctx.answerCallbackQuery({
          text: `🚫 ${pathValidation.reason}`,
          show_alert: true,
        });
        return;
      }

      try {
        // Direct file read - path already validated
        const fs = await import('fs/promises');
        const content = await fs.readFile(pathValidation.resolvedPath!, 'utf-8');

        // Detect language for syntax highlighting
        const ext = filepath.split('.').pop()?.toLowerCase() || '';
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
          c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
          swift: 'swift', kt: 'kotlin', scala: 'scala', sh: 'bash',
          json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
          md: 'markdown', html: 'html', css: 'css', scss: 'scss',
          sql: 'sql', graphql: 'graphql', xml: 'xml',
        };
        const lang = langMap[ext] || '';

        // Split into chunks for Telegram's 4096 char limit
        const maxChunk = 3800;
        const chunks: string[] = [];
        let remaining = content;

        while (remaining.length > 0) {
          if (remaining.length <= maxChunk) {
            chunks.push(remaining);
            break;
          }
          // Try to break at a newline
          let breakPoint = remaining.lastIndexOf('\n', maxChunk);
          if (breakPoint < maxChunk / 2) breakPoint = maxChunk;
          chunks.push(remaining.slice(0, breakPoint));
          remaining = remaining.slice(breakPoint);
        }

        // Send first chunk as edit, rest as new messages
        const fileName = filepath.split('/').pop();
        await ctx.editMessageText(
          `📄 *${fileName}* (1/${chunks.length})\n\`\`\`${lang}\n${chunks[0]}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );

        // Send remaining chunks
        for (let i = 1; i < chunks.length; i++) {
          await ctx.reply(
            `📄 *${fileName}* (${i + 1}/${chunks.length})\n\`\`\`${lang}\n${chunks[i]}\n\`\`\``,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (error) {
        await ctx.editMessageText(`❌ Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return;
    }

    if (data.startsWith('copypath:')) {
      const filepath = data.slice(9);
      const success = await copyToClipboard(filepath);
      if (success) {
        await ctx.answerCallbackQuery({ text: '📋 Path copied to Mac clipboard!' });
      } else {
        await ctx.answerCallbackQuery({ text: 'Failed to copy path' });
      }
      return;
    }

    // Handle tmux session actions
    if (data.startsWith('tmux:')) {
      const parts = data.split(':');
      const action = parts[1];

      if (action === 'attach') {
        const sessionName = parts[2];
        if (!sessionName) {
          await ctx.answerCallbackQuery({ text: 'Invalid session' });
          return;
        }

        // Check if session exists
        const exists = await isTmuxSessionActive(sessionName);
        if (!exists) {
          await ctx.answerCallbackQuery({ text: `Session '${sessionName}' not found` });
          return;
        }

        // Attach to session
        setTmuxMode(userId, true, sessionName);
        await clearScrollback(sessionName);

        let screen = await capturePane(sessionName);
        userLastScreen.set(userId, screen);

        if (screen.length > 2000) {
          screen = screen.slice(-2000);
        }

        const cwd = await getTmuxCwd(sessionName);

        await ctx.editMessageText(
          `🟢 *Attached to* \`${sessionName}\`\n` +
          (cwd ? `📁 ${cwd}\n\n` : '\n') +
          '```\n' + (screen || '(empty)') + '\n```',
          { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard(true) }
        );
        return;
      }

      if (action === 'new') {
        await ctx.editMessageText(
          '*Create New Session*\n\nType `/tmux new <name>`\n\nExample: `/tmux new work`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (action === 'kill_menu') {
        const sessions = await listTmuxSessions();
        if (sessions.length === 0) {
          await ctx.answerCallbackQuery({ text: 'No sessions to kill' });
          return;
        }

        const keyboard = new InlineKeyboard();
        sessions.forEach((s, i) => {
          keyboard.text(`🗑️ ${s.name}`, `tmux:kill:${s.name}`);
          if (i % 2 === 1) keyboard.row();
        });
        keyboard.row().text('◀️ Back', 'action:tmux_list');

        await ctx.editMessageText(
          '*🗑️ Kill Session*\n\nSelect a session to kill:',
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        return;
      }

      if (action === 'kill') {
        const sessionName = parts[2];
        if (!sessionName) {
          await ctx.answerCallbackQuery({ text: 'Invalid session' });
          return;
        }

        // Detach if user is attached to this session
        const currentSession = getCurrentTmuxSession(userId);
        if (currentSession === sessionName) {
          stopAutoRefresh(userId);
          setTmuxMode(userId, false);
        }

        await killTmuxSession(sessionName);
        await ctx.answerCallbackQuery({ text: `Killed ${sessionName}` });

        // Refresh session list
        const sessions = await listTmuxSessions();
        if (sessions.length === 0) {
          await ctx.editMessageText(
            '*No tmux sessions*\n\nUse /attach to create one.',
            { parse_mode: 'Markdown' }
          );
        } else {
          const keyboard = new InlineKeyboard();
          sessions.forEach((s, i) => {
            const icon = s.attached ? '🟢' : '⚪';
            keyboard.text(`${icon} ${s.name}`, `tmux:attach:${s.name}`);
            if (i % 2 === 1) keyboard.row();
          });
          keyboard.row().text('➕ New', 'tmux:new').text('🗑️ Kill', 'tmux:kill_menu');

          await ctx.editMessageText(
            '*📺 Tmux Sessions*\n\n' +
            sessions.map(s => {
              const icon = s.attached ? '🟢' : '⚪';
              return `${icon} \`${s.name}\``;
            }).join('\n'),
            { parse_mode: 'Markdown', reply_markup: keyboard }
          );
        }
        return;
      }

      return;
    }

    // Handle project switching
    if (data.startsWith('project:')) {
      const name = data.slice(8);
      const pin = getPin(userId, name);
      const session = getCurrentTmuxSession(userId);

      if (!pin) {
        await ctx.editMessageText(`Project '${name}' not found.`);
        return;
      }

      // Set current project for memory tracking
      setCurrentProject(userId, name);

      // Change to the pinned directory - escape single quotes for shell safety
      const escapedPath = pin.path.replace(/'/g, "'\\''");
      const cdCommand = `cd '${escapedPath}'`;

      if (session) {
        await sendToTmux(cdCommand, session);
        await sendEnterToTmux(session);
        await new Promise(r => setTimeout(r, 300));

        // Load project context if available
        const context = getProjectContext(userId, name);
        let contextMsg = '';
        if (context) {
          contextMsg = `\n\n_🧠 Project has ${getProjectMemories(userId, name).length} memories_`;
        }

        let screen = await capturePane(session);
        if (screen.length > 2000) {
          screen = screen.slice(-2000);
        }

        await ctx.editMessageText(
          `📌 Switched to \`${name}\`${contextMsg}\n\n\`\`\`\n${screen || '(empty)'}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      } else {
        // In normal mode, update session cwd
        const sessionName = getActiveSessionName(userId);
        const session = getActiveSession(userId, sessionName);
        if (session) {
          session.cwd = pin.path;
        }
        await ctx.editMessageText(
          `📌 Switched to \`${name}\`\n📁 ${shortenPath(pin.path)}`,
          { parse_mode: 'Markdown', reply_markup: getQuickActionsKeyboard() }
        );
      }
      return;
    }
  });

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from!.id;
    const text = ctx.message.text.trim();

    // Track activity for memory cleanup
    updateUserActivity(userId);

    // Termo's own commands are handled by Grammy's command handlers
    // Other slash commands (like Claude's /ultrathink) should be sent to tmux
    const termoCommands = [
      '/start', '/help', '/attach', '/detach', '/screen', '/ctrlc',
      '/sessions', '/new', '/switch', '/close', '/pwd', '/kill',
      '/history', '/quick', '/pin', '/unpin', '/pins', '/search',
      '/menu', '/reset', '/full', '/status', '/bookmarks', '/usage', '/export',
      '/voice', '/alias', '/aliases', '/unalias', '/remember', '/memories', '/forget',
      '/view', '/context', '/tmux'
    ];

    const isTermoCommand = termoCommands.some(cmd =>
      text === cmd || text.startsWith(cmd + ' ')
    );

    if (isTermoCommand) {
      return; // Let Grammy's command handlers deal with it
    }

    // Check for alias expansion (!alias_name)
    if (text.startsWith('!')) {
      const aliasName = text.slice(1).split(' ')[0];
      const shortcut = getShortcut(userId, aliasName);
      if (shortcut) {
        // Replace alias with actual command
        const extraArgs = text.slice(1 + aliasName.length).trim();
        const expandedCommand = extraArgs
          ? `${shortcut.command} ${extraArgs}`
          : shortcut.command;

        // Execute the expanded command (fall through to normal flow)
        await ctx.reply(`⚡ \`!${aliasName}\` → \`${expandedCommand}\``, { parse_mode: 'Markdown' });

        // Continue with expanded command
        userLastCommand.set(userId, expandedCommand);

        if (isInTmuxMode(userId)) {
          const session = getCurrentTmuxSession(userId);
          if (!session) {
            await ctx.reply('Not attached to any session. Use /attach first.');
            return;
          }
          stopAutoRefresh(userId);
          await clearScrollback(session);
          const thinkingMsg = await ctx.reply('⏳ Running alias...', {
            reply_markup: getClaudeThinkingKeyboard(),
          });
          await sendToTmux(expandedCommand, session);
          await sendEnterToTmux(session);
          await new Promise(r => setTimeout(r, 500));
          const screen = await capturePane(session);
          userLastScreen.set(userId, screen);
          startAutoRefresh(userId, ctx.chat!.id, bot, screen, thinkingMsg.message_id, expandedCommand);
          return;
        }

        // Normal mode - execute expanded command
        await executeCommand(ctx, userId, expandedCommand, config, executor, notifier);
        return;
      }
    }

    // Track last command for retry
    userLastCommand.set(userId, text);

    // If in tmux mode, send to tmux
    if (isInTmuxMode(userId)) {
      const session = getCurrentTmuxSession(userId);
      if (!session) {
        await ctx.reply('Not attached to any session. Use /attach first.');
        return;
      }

      // Stop any existing auto-refresh
      stopAutoRefresh(userId);

      // Clear old scrollback to prevent "ghosts from the grave"
      await clearScrollback(session);

      // Show thinking message - stays visible until Claude is done
      const thinkingMsg = await ctx.reply('⏳ Sending to Claude...', {
        reply_markup: getClaudeThinkingKeyboard(),
      });

      await sendToTmux(text, session);
      await sendEnterToTmux(session);

      // Add to history so search works for Claude messages too
      const sessionName = getActiveSessionName(userId);
      addHistoryEntry(userId, sessionName, text, 'claude', null, 0);

      // Wait a bit for command to register
      await new Promise(r => setTimeout(r, 500));

      // Get initial screen (after message sent)
      const screen = await capturePane(session);
      userLastScreen.set(userId, screen);

      // Start auto-refresh - pass user's message to find where response starts
      startAutoRefresh(userId, ctx.chat!.id, bot, screen, thinkingMsg.message_id, text);
      return;
    }

    // Normal mode - execute command
    await executeCommand(ctx, userId, text, config, executor, notifier);
  });

  // Handle photo messages - OCR text extraction
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from!.id;
    const caption = ctx.message.caption || '';

    // Get the largest photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];

    try {
      // Show processing message
      const processingMsg = await ctx.reply('🔍 Extracting text from image...');

      // Get file info
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

      // Download image
      const tempId = randomBytes(8).toString('hex');
      const tempPath = `/tmp/termo_ocr_${tempId}.jpg`;

      const response = await fetch(fileUrl);
      const buffer = await response.arrayBuffer();
      const { writeFileSync, unlinkSync, existsSync } = await import('fs');
      const nodeBuffer = Buffer.from(buffer);
      console.log(`[OCR] Downloaded ${nodeBuffer.length} bytes`);
      writeFileSync(tempPath, nodeBuffer);

      // Verify file was written
      if (!existsSync(tempPath)) {
        console.error('[OCR] File not created:', tempPath);
        throw new Error('Failed to save image');
      }
      console.log(`[OCR] Saved to ${tempPath}`);

      // Setup exec helper
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Preprocess image for better OCR (invert colors, grayscale, increase contrast)
      const processedPath = tempPath.replace('.jpg', '_processed.png');
      try {
        // Try common ImageMagick paths
        const convertPaths = [
          '/opt/homebrew/bin/convert',  // Homebrew on Apple Silicon
          '/usr/local/bin/convert',     // Homebrew on Intel
          'convert'                      // System PATH
        ];

        let convertPath = 'convert';
        for (const p of convertPaths) {
          try {
            await execAsync(`${p} --version`);
            convertPath = p;
            break;
          } catch {}
        }

        await execAsync(`${convertPath} "${tempPath}" -negate -colorspace Gray -contrast-stretch 0 "${processedPath}"`);
        console.log('[OCR] Preprocessed image for better OCR');
      } catch {
        // If preprocessing fails, use original
        console.log('[OCR] Preprocessing failed, using original');
      }
      const ocrInputPath = existsSync(processedPath) ? processedPath : tempPath;

      // Run OCR with Tesseract

      let ocrText = '';
      try {
        // Try common tesseract paths (homebrew ARM, homebrew Intel, system)
        const tesseractPaths = [
          '/opt/homebrew/bin/tesseract',  // Homebrew on Apple Silicon
          '/usr/local/bin/tesseract',     // Homebrew on Intel
          'tesseract'                      // System PATH
        ];

        let tesseractPath = 'tesseract';
        for (const p of tesseractPaths) {
          try {
            await execAsync(`${p} --version`);
            tesseractPath = p;
            break;
          } catch {}
        }

        // Use stdin instead of file path (works around leptonica path issues)
        // Options: --oem 1 = LSTM neural net, --psm 6 = uniform text block (better for screenshots)
        const { stdout } = await execAsync(`cat "${ocrInputPath}" | ${tesseractPath} stdin stdout --oem 1 --psm 6 -l eng`);
        ocrText = stdout.trim();
        console.log(`[OCR] Extracted ${ocrText.length} chars:`);
        console.log(`[OCR] "${ocrText.slice(0, 200)}"`);
      } catch (ocrError: any) {
        // Log the actual error for debugging
        console.error('[OCR] Error:', ocrError.message || ocrError);

        // Tesseract not installed or failed
        try { await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id); } catch {}
        await ctx.reply(
          '❌ *OCR not available*\n\n' +
          'Install Tesseract to extract text from images:\n' +
          '`brew install tesseract`\n\n' +
          '_Or describe the image to Claude instead!_',
          { parse_mode: 'Markdown' }
        );
        try { unlinkSync(tempPath); } catch {}
        try { unlinkSync(processedPath); } catch {}
        return;
      }

      // Clean up temp files
      try { unlinkSync(tempPath); } catch {}
      try { unlinkSync(processedPath); } catch {}

      // Delete processing message
      try { await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id); } catch {}

      if (!ocrText) {
        await ctx.reply(
          '📸 *No text found in image*\n\n' +
          '_Try sending an image with visible text, or describe it to Claude._',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Prepare message with extracted text
      const messageToSend = caption
        ? `${caption}\n\nExtracted text from image:\n${ocrText}`
        : `Here's text I extracted from a screenshot:\n${ocrText}`;

      if (isInTmuxMode(userId)) {
        const session = getCurrentTmuxSession(userId);
        if (!session) {
          await ctx.reply('Not attached to any session. Use /attach first.');
          return;
        }
        // Clear old scrollback to prevent "ghosts from the grave"
        await clearScrollback(session);

        // Send to Claude via tmux
        await sendToTmux(messageToSend, session);
        await sendEnterToTmux(session);

        await new Promise(r => setTimeout(r, 1000));
        let screen = await capturePane(session);

        // Truncate screen to avoid message too long
        const screenLines = screen.split('\n');
        if (screenLines.length > 30) {
          screen = '...(truncated)...\n' + screenLines.slice(-30).join('\n');
        }
        if (screen.length > 2000) {
          screen = screen.slice(-2000);
        }

        await ctx.reply(
          `📸 *Sent to Claude*\n\n\`\`\`\n${screen || '(empty)'}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );

        userLastScreen.set(userId, screen);
        userLastCommand.set(userId, messageToSend);
        startAutoRefresh(userId, ctx.chat!.id, bot, screen);
      } else {
        // Not in Claude Mode - just show extracted text
        await ctx.reply(
          `📸 *Text extracted from image:*\n\n` +
          `\`\`\`\n${ocrText.slice(0, 1000)}${ocrText.length > 1000 ? '...' : ''}\n\`\`\`\n\n` +
          (caption ? `Caption: "${caption}"\n\n` : '') +
          `_Use /attach to send this to Claude_`,
          { parse_mode: 'Markdown' }
        );
      }

    } catch (error) {
      // Log full error internally but don't expose to user (CWE-209)
      console.error('[Termo] OCR error:', error);
      await ctx.reply('❌ Failed to process image. Please try again.');
    }
  });

  // Handle voice messages - Use Whisper for transcription
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from!.id;
    const voice = ctx.message.voice;

    // Check if Telegram has transcribed this voice message (Premium feature)
    const transcription = (ctx.message as any).voice?.transcription;
    let text = transcription?.trim() || '';

    // If no Telegram transcription, try Whisper
    if (!text) {
      const whisperAvailable = await isWhisperAvailable();
      if (!whisperAvailable) {
        // No transcription available - guide user
        await ctx.reply(
          `🎤 *Voice message received* (${voice.duration}s)\n\n` +
          `*To enable voice input:*\n` +
          `• Install Whisper: \`brew install openai-whisper\`\n` +
          `• Or set OPENAI_API_KEY for cloud Whisper\n` +
          `• Or get Telegram Premium for auto-transcription\n\n` +
          `_You can also type or use your phone's speech-to-text keyboard_`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Download voice file
      const processingMsg = await ctx.reply('🎤 Transcribing voice message...');

      try {
        const file = await ctx.api.getFile(voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

        const timestamp = Date.now();
        const tempPath = `/tmp/termo_voice_${timestamp}.ogg`;

        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        const { writeFileSync, unlinkSync } = await import('fs');
        writeFileSync(tempPath, Buffer.from(buffer));

        // Transcribe with Whisper
        const transcribed = await transcribeAudio(tempPath);

        // Cleanup
        try { unlinkSync(tempPath); } catch {}

        // Delete processing message
        try { await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id); } catch {}

        if (!transcribed) {
          await ctx.reply('❌ Could not transcribe voice message. Please try again or type your message.');
          return;
        }

        text = transcribed;
      } catch (error) {
        console.error('[Voice] Transcription error:', error);
        try { await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id); } catch {}
        await ctx.reply('❌ Failed to process voice message. Please try again.');
        return;
      }
    }

    // We have transcribed text - process it
    if (isInTmuxMode(userId)) {
      const session = getCurrentTmuxSession(userId);
      if (!session) {
        await ctx.reply('Not attached to any session. Use /attach first.');
        return;
      }
      stopAutoRefresh(userId);
      await clearScrollback(session);

      const thinkingMsg = await ctx.reply(
        `🎤 *Voice → Claude:*\n_"${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"_`,
        {
          parse_mode: 'Markdown',
          reply_markup: getClaudeThinkingKeyboard(),
        }
      );

      await sendToTmux(text, session);
      await sendEnterToTmux(session);

      // Add to history
      const sessionName = getActiveSessionName(userId);
      addHistoryEntry(userId, sessionName, `🎤 ${text}`, 'claude', null, 0);

      await new Promise(r => setTimeout(r, 500));
      const screen = await capturePane(session);
      userLastScreen.set(userId, screen);
      userLastCommand.set(userId, text);
      startAutoRefresh(userId, ctx.chat!.id, bot, screen, thinkingMsg.message_id, text);
    } else {
      // Not in Claude mode - show transcription
      await ctx.reply(
        `🎤 *Voice transcription:*\n\n"${text}"\n\n_Use /attach to send to Claude_`,
        { parse_mode: 'Markdown' }
      );
    }
  });
}

async function executeCommand(
  ctx: Context,
  userId: number,
  command: string,
  config: Config,
  executor: TerminalExecutor,
  notifier: CommandNotifier,
  skipValidation = false
): Promise<void> {
  const sessionName = getActiveSessionName(userId);
  let session = getActiveSession(userId, sessionName);

  if (!session) {
    session = getOrCreateDefaultSession(userId);
    setActiveSessionName(userId, 'default');
  }

  if (!skipValidation) {
    const validation = validateCommand(command);

    if (!validation.allowed) {
      await ctx.reply(` Command blocked: ${validation.reason}`);
      return;
    }

    if (validation.requiresConfirmation) {
      pendingConfirmations.set(userId, command);
      await ctx.reply(
        `*Confirmation required*\n\n\`${command}\`\n\n${validation.reason}`,
        { parse_mode: 'Markdown', reply_markup: getConfirmationKeyboard(command) }
      );
      return;
    }
  }

  const interactiveWarning = getInteractiveWarning(command);
  if (interactiveWarning) {
    await ctx.reply(` ${interactiveWarning}`);
  }

  const statusMsg = await ctx.reply(
    ` Running in \`${sessionName}\`...\n\`${command.slice(0, 50)}\``,
    { parse_mode: 'Markdown', reply_markup: getRunningKeyboard() }
  );

  const commandId = `${userId}:${sessionName}:${Date.now()}`;
  notifier.registerCommand(commandId, command, ctx.chat!.id, sessionName);

  try {
    const result = await executor.runCommand(session, command, {
      shell: config.defaultShell,
      timeout: config.commandTimeout,
      maxOutput: config.maxOutputLength,
    });

    addHistoryEntry(userId, sessionName, command, session.cwd, result.exitCode, result.duration);
    await notifier.completeCommand(commandId, result.exitCode, result.duration);

    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}

    const chunks = formatOutput(result.output, result.truncated);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'Markdown' });
    }

    if (result.newCwd) {
      await ctx.reply(`Directory: \`${shortenPath(result.newCwd)}\``, { parse_mode: 'Markdown' });
    }

    if (result.exitCode !== 0) {
      await ctx.reply(` Exit code: ${result.exitCode} (${formatDuration(result.duration)})`);
    }

  } catch (error) {
    notifier.cancelCommand(commandId);

    try {
      await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id);
    } catch {}

    const errorMessage = error instanceof Error ? error.message : String(error);
    await ctx.reply(` Error: ${errorMessage}`);
  }
}
