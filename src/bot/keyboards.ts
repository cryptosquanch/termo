import { InlineKeyboard } from 'grammy';
import { TerminalSession } from '../terminal/session-manager.js';
import { PinnedProject } from '../storage/pins.js';

// Main quick actions menu - User-friendly design
export function getQuickActionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📌 Projects', 'action:projects')
    .text('🔍 Search', 'action:search')
    .row()
    .text('📜 History', 'action:history')
    .text('📁 Sessions', 'action:sessions')
    .row()
    .text('🖥️ Screen', 'action:screen')
    .text('⚡ Kill', 'action:kill');
}

// Shell commands keyboard - for power users
export function getShellCommandsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('pwd', 'cmd:pwd')
    .text('ls -la', 'cmd:ls -la')
    .text('git status', 'cmd:git status')
    .row()
    .text('◀️ Back', 'action:menu');
}

// Session switcher keyboard
export function getSessionsKeyboard(
  sessions: TerminalSession[],
  activeSessionName: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Add each session as a button
  sessions.forEach((session, index) => {
    const marker = session.name === activeSessionName ? ' ' : '';
    keyboard.text(`${marker}${session.name}`, `switch:${session.name}`);

    // 2 sessions per row
    if (index % 2 === 1) {
      keyboard.row();
    }
  });

  // New session button
  if (sessions.length % 2 === 1) {
    keyboard.text('+ New', 'action:new_session');
  } else {
    keyboard.row().text('+ New Session', 'action:new_session');
  }

  keyboard.row().text('Back', 'action:menu');

  return keyboard;
}

// History keyboard with recent commands
export function getHistoryKeyboard(commands: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  commands.slice(0, 5).forEach((cmd) => {
    // Truncate long commands for button display
    const displayCmd = cmd.length > 25 ? cmd.slice(0, 22) + '...' : cmd;
    keyboard.text(displayCmd, `history:${cmd}`).row();
  });

  keyboard.text('Back', 'action:menu');

  return keyboard;
}

// Confirmation keyboard for dangerous commands
export function getConfirmationKeyboard(command: string): InlineKeyboard {
  // Encode command in callback data (limited to 64 bytes)
  const encodedCmd = Buffer.from(command).toString('base64').slice(0, 50);

  return new InlineKeyboard()
    .text('Yes, run it', `confirm:${encodedCmd}`)
    .text('Cancel', 'action:cancel');
}

// Active command keyboard (shows while command is running)
export function getRunningKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Kill Command', 'action:kill');
}

// Close session confirmation
export function getCloseSessionKeyboard(sessionName: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('Yes, close it', `close_confirm:${sessionName}`)
    .text('Cancel', 'action:cancel');
}

// Help keyboard
export function getHelpKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Quick Actions', 'action:menu')
    .text('Sessions', 'action:sessions')
    .row()
    .text('History', 'action:history');
}

// Git-specific quick actions
export function getGitKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('status', 'cmd:git status')
    .text('log --oneline', 'cmd:git log --oneline -10')
    .row()
    .text('diff', 'cmd:git diff')
    .text('branch', 'cmd:git branch')
    .row()
    .text('Back', 'action:menu');
}

// ─────────────────────────────────────────────────────────────────────────────
// Breadcrumb Navigation - Always show current path with quick nav
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate breadcrumb navigation keyboard
 * Shows: 📍 ~/path/to/dir  [⬆️ Up] [🏠 Home] [📌 Pin]
 */
export function getBreadcrumbKeyboard(cwd: string, pins?: PinnedProject[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const home = process.env.HOME || '/Users';

  // Shorten path for display (replace home with ~)
  const displayPath = cwd.replace(home, '~');

  // Check if we're at home or root
  const isHome = cwd === home;
  const isRoot = cwd === '/';

  // Navigation row
  if (!isRoot && !isHome) {
    keyboard.text('⬆️ Up', 'nav:up');
  }
  if (!isHome) {
    keyboard.text('🏠 Home', 'nav:home');
  }
  keyboard.text('📌 Pin', 'action:pin_prompt');

  // Quick access to pinned projects (if any and not already there)
  if (pins && pins.length > 0) {
    keyboard.row();
    const quickPins = pins.slice(0, 3);
    quickPins.forEach(pin => {
      const isHere = pin.path === cwd;
      const icon = isHere ? '📂' : '📁';
      const name = pin.name.length > 8 ? pin.name.slice(0, 7) + '…' : pin.name;
      keyboard.text(`${icon}${name}`, `project:${pin.name}`);
    });
  }

  return keyboard;
}

/**
 * Format breadcrumb display text
 * Returns: "📍 ~/projects/termo/src"
 */
export function formatBreadcrumb(cwd: string): string {
  const home = process.env.HOME || '/Users';
  const displayPath = cwd.replace(home, '~');

  // Truncate if too long
  if (displayPath.length > 40) {
    const parts = displayPath.split('/');
    if (parts.length > 4) {
      return `📍 ${parts[0]}/…/${parts.slice(-2).join('/')}`;
    }
  }

  return `📍 ${displayPath}`;
}

// Pinned projects keyboard
export function getProjectsKeyboard(pins: PinnedProject[], currentDir?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (pins.length === 0) {
    // Show helpful empty state
    keyboard.text('📍 Pin this folder', 'action:pin_prompt').row();
  } else {
    // Show all pinned projects
    pins.forEach((pin, index) => {
      keyboard.text(`📌 ${pin.name}`, `project:${pin.name}`);
      if (index % 2 === 1) keyboard.row();
    });
    if (pins.length % 2 === 1) keyboard.row();
    keyboard.text('📍 Pin current', 'action:pin_prompt');
  }

  keyboard.row().text('◀️ Back', 'action:menu');
  return keyboard;
}

// Search prompt keyboard
export function getSearchKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔍 Type /search <query>', 'action:menu')
    .row()
    .text('◀️ Back', 'action:menu');
}

// Smart reply suggestions based on context
export function getSmartRepliesKeyboard(context: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Detect context and suggest relevant commands
  if (context.includes('error') || context.includes('Error') || context.includes('failed')) {
    keyboard.text('🔄 Retry', 'smart:retry').text('📋 Show logs', 'cmd:tail -50 logs/*.log').row();
  }

  if (context.includes('git') || context.includes('branch') || context.includes('commit')) {
    keyboard.text('git diff', 'cmd:git diff').text('git log', 'cmd:git log --oneline -5').row();
  }

  if (context.includes('npm') || context.includes('node') || context.includes('package')) {
    keyboard.text('npm install', 'cmd:npm install').text('npm run build', 'cmd:npm run build').row();
  }

  if (context.includes('test') || context.includes('spec')) {
    keyboard.text('Run tests', 'cmd:npm test').text('Coverage', 'cmd:npm run coverage').row();
  }

  // Always show refresh and menu
  keyboard.text('🔄 Refresh', 'action:screen').text('📋 Menu', 'action:menu');

  return keyboard;
}

// Claude thinking notification keyboard
export function getClaudeThinkingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('⏹️ Cancel', 'action:ctrlc')
    .text('🔄 Refresh', 'action:screen');
}

// Claude done notification keyboard - smart actions based on response
export function getClaudeDoneKeyboard(context: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Top row: Most common actions
  keyboard
    .text('📋 Copy', 'action:copy')
    .text('⭐ Save', 'action:bookmark')
    .text('📄 Full', 'action:full');

  // Middle row: Context-aware suggestions
  keyboard.row();

  // Detect if response suggests more work needed
  const lowerCtx = context.toLowerCase();
  const hasError = lowerCtx.includes('error') || lowerCtx.includes('failed') || lowerCtx.includes('exception');
  const isQuestion = context.includes('?') || lowerCtx.includes('would you like') || lowerCtx.includes('should i');
  const hasCode = context.includes('```') || lowerCtx.includes('function') || lowerCtx.includes('const ');

  if (hasError) {
    keyboard.text('🔧 Fix this', 'smart:fix');
  } else if (isQuestion) {
    keyboard.text('✅ Yes', 'smart:yes').text('❌ No', 'smart:no');
  } else if (hasCode) {
    keyboard.text('▶️ Run it', 'smart:run');
  } else {
    keyboard.text('➡️ Continue', 'smart:continue');
  }

  keyboard.text('🧠 Ultrathink', 'smart:ultrathink');

  // Bottom row: Utils
  keyboard.row()
    .text('💰 Usage', 'smart:usage')
    .text('📋 Menu', 'action:menu');

  return keyboard;
}

// Main menu keyboard - shows current mode and all actions
export function getMainMenuKeyboard(isClaudeMode: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Mode indicator at top
  if (isClaudeMode) {
    keyboard.text('🟢 Claude Mode Active', 'action:noop').row();
    keyboard
      .text('📄 Full Output', 'action:full')
      .text('🔄 Refresh', 'action:screen')
      .row()
      .text('⏹️ Ctrl+C', 'action:ctrlc')
      .text('🔄 Reset Context', 'action:reset')
      .row()
      .text('👋 Detach', 'action:detach');
  } else {
    keyboard.text('⚪ Normal Mode', 'action:noop').row();
    keyboard.text('🔌 Attach to Claude', 'action:attach').row();
  }

  // Common actions
  keyboard.row()
    .text('📌 Projects', 'action:projects')
    .text('📁 Sessions', 'action:sessions')
    .row()
    .text('📜 History', 'action:history')
    .text('🔍 Search', 'action:search');

  return keyboard;
}

// Context warning keyboard - shown when Claude's context is low
export function getContextWarningKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Reset Context Now', 'action:reset')
    .text('📄 Save Output First', 'action:full')
    .row()
    .text('⏭️ Continue Anyway', 'action:noop');
}

// Bookmarks list keyboard
export function getBookmarksKeyboard(bookmarks: { id: number; title: string }[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (bookmarks.length === 0) {
    keyboard.text('No bookmarks yet', 'action:noop').row();
  } else {
    bookmarks.slice(0, 8).forEach((bookmark, index) => {
      const title = bookmark.title.length > 25
        ? bookmark.title.slice(0, 22) + '...'
        : bookmark.title;
      keyboard.text(`⭐ ${title}`, `bookmark:view:${bookmark.id}`);
      if (index % 2 === 1) keyboard.row();
    });
    if (bookmarks.length % 2 === 1) keyboard.row();
  }

  keyboard.text('🔍 Search', 'action:search_bookmarks');
  keyboard.row().text('◀️ Back', 'action:menu');

  return keyboard;
}

// Single bookmark view keyboard
export function getBookmarkViewKeyboard(bookmarkId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('📋 Copy', `bookmark:copy:${bookmarkId}`)
    .text('🗑️ Delete', `bookmark:delete:${bookmarkId}`)
    .row()
    .text('◀️ Back to Bookmarks', 'action:bookmarks');
}

// Usage dashboard keyboard
export function getUsageKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Refresh', 'action:usage_refresh')
    .text('📊 Details', 'smart:usage')
    .row()
    .text('◀️ Back', 'action:menu');
}

// Quick project switcher bar - compact, always visible
export function getQuickProjectsBar(
  pins: PinnedProject[],
  currentProject?: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (pins.length === 0) {
    // No pins yet - show helpful prompt
    keyboard.text('📍 Pin a project', 'action:pin_prompt');
    return keyboard;
  }

  // Show up to 4 projects in a single row for quick switching
  const maxShow = 4;
  const toShow = pins.slice(0, maxShow);

  toShow.forEach((pin) => {
    // Use emoji to indicate current project
    const isCurrent = pin.name === currentProject;
    const icon = isCurrent ? '📂' : '📁';
    // Truncate long names
    const name = pin.name.length > 8 ? pin.name.slice(0, 7) + '…' : pin.name;
    keyboard.text(`${icon}${name}`, `project:${pin.name}`);
  });

  // If more than 4, show "more" button
  if (pins.length > maxShow) {
    keyboard.text(`+${pins.length - maxShow}`, 'action:projects');
  }

  return keyboard;
}

// Enhanced Claude done keyboard with quick project bar
export function getClaudeDoneWithProjectsKeyboard(
  context: string,
  pins: PinnedProject[],
  currentProject?: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Top row: Most common actions
  keyboard
    .text('📋 Copy', 'action:copy')
    .text('⭐ Save', 'action:bookmark')
    .text('📄 Full', 'action:full');

  // Middle row: Context-aware suggestions
  keyboard.row();

  const lowerCtx = context.toLowerCase();
  const hasError = lowerCtx.includes('error') || lowerCtx.includes('failed') || lowerCtx.includes('exception');
  const isQuestion = context.includes('?') || lowerCtx.includes('would you like') || lowerCtx.includes('should i');
  const hasCode = context.includes('```') || lowerCtx.includes('function') || lowerCtx.includes('const ');

  if (hasError) {
    keyboard.text('🔧 Fix this', 'smart:fix');
  } else if (isQuestion) {
    keyboard.text('✅ Yes', 'smart:yes').text('❌ No', 'smart:no');
  } else if (hasCode) {
    keyboard.text('▶️ Run it', 'smart:run');
  } else {
    keyboard.text('➡️ Continue', 'smart:continue');
  }

  keyboard.text('🧠 Ultrathink', 'smart:ultrathink');

  // Third row: Utils
  keyboard.row()
    .text('💰 Usage', 'smart:usage')
    .text('📋 Menu', 'action:menu');

  // Bottom row: Quick project switcher (if has pins)
  if (pins.length > 0) {
    keyboard.row();
    const maxShow = 4;
    const toShow = pins.slice(0, maxShow);

    toShow.forEach((pin) => {
      const isCurrent = pin.name === currentProject;
      const icon = isCurrent ? '📂' : '📁';
      const name = pin.name.length > 6 ? pin.name.slice(0, 5) + '…' : pin.name;
      keyboard.text(`${icon}${name}`, `project:${pin.name}`);
    });

    if (pins.length > maxShow) {
      keyboard.text(`+${pins.length - maxShow}`, 'action:projects');
    }
  }

  return keyboard;
}
