import { getDatabase } from './database.js';

export interface TokenUsage {
  id: number;
  user_id: number;
  session_date: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  created_at: string;
}

export interface UsageSummary {
  today: TokenUsage | null;
  thisWeek: { input_tokens: number; output_tokens: number; estimated_cost: number };
  thisMonth: { input_tokens: number; output_tokens: number; estimated_cost: number };
  allTime: { input_tokens: number; output_tokens: number; estimated_cost: number };
}

/**
 * Record token usage for today (upserts)
 */
export function recordUsage(
  userId: number,
  inputTokens: number,
  outputTokens: number,
  estimatedCost: number
): void {
  const db = getDatabase();
  const today = new Date().toISOString().split('T')[0];

  db.prepare(`
    INSERT INTO token_usage (user_id, session_date, input_tokens, output_tokens, estimated_cost)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, session_date) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      estimated_cost = estimated_cost + excluded.estimated_cost
  `).run(userId, today, inputTokens, outputTokens, estimatedCost);
}

/**
 * Get today's usage
 */
export function getTodayUsage(userId: number): TokenUsage | null {
  const db = getDatabase();
  const today = new Date().toISOString().split('T')[0];

  return db.prepare(`
    SELECT * FROM token_usage
    WHERE user_id = ? AND session_date = ?
  `).get(userId, today) as TokenUsage | null;
}

/**
 * Get usage summary (today, this week, this month, all time)
 */
export function getUsageSummary(userId: number): UsageSummary {
  const db = getDatabase();
  const today = new Date().toISOString().split('T')[0];

  // Calculate date ranges
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const weekStartStr = weekStart.toISOString().split('T')[0];
  const monthStartStr = monthStart.toISOString().split('T')[0];

  // Today's usage
  const todayUsage = db.prepare(`
    SELECT * FROM token_usage
    WHERE user_id = ? AND session_date = ?
  `).get(userId, today) as TokenUsage | null;

  // This week's usage
  const weekUsage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(estimated_cost), 0) as estimated_cost
    FROM token_usage
    WHERE user_id = ? AND session_date >= ?
  `).get(userId, weekStartStr) as { input_tokens: number; output_tokens: number; estimated_cost: number };

  // This month's usage
  const monthUsage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(estimated_cost), 0) as estimated_cost
    FROM token_usage
    WHERE user_id = ? AND session_date >= ?
  `).get(userId, monthStartStr) as { input_tokens: number; output_tokens: number; estimated_cost: number };

  // All time usage
  const allTimeUsage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(estimated_cost), 0) as estimated_cost
    FROM token_usage
    WHERE user_id = ?
  `).get(userId) as { input_tokens: number; output_tokens: number; estimated_cost: number };

  return {
    today: todayUsage,
    thisWeek: weekUsage,
    thisMonth: monthUsage,
    allTime: allTimeUsage,
  };
}

/**
 * Parse token usage from Claude's /cost output
 * Returns null if parsing fails
 */
export function parseClaudeCostOutput(output: string): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
} | null {
  try {
    // Try to find token counts (various formats Claude might use)
    const inputMatch = output.match(/input[:\s]+([0-9,]+)/i);
    const outputMatch = output.match(/output[:\s]+([0-9,]+)/i);
    const totalMatch = output.match(/total[:\s]+([0-9,]+)/i);
    const costMatch = output.match(/\$([0-9.]+)/);

    const parseNum = (s: string) => parseInt(s.replace(/,/g, ''), 10);

    return {
      inputTokens: inputMatch ? parseNum(inputMatch[1]) : 0,
      outputTokens: outputMatch ? parseNum(outputMatch[1]) : 0,
      totalTokens: totalMatch ? parseNum(totalMatch[1]) : 0,
      cost: costMatch ? parseFloat(costMatch[1]) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Format token count for display (e.g., 1234567 -> "1.2M")
 */
export function formatTokenCount(count: number): string {
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1) + 'M';
  } else if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'K';
  }
  return count.toString();
}

/**
 * Format cost for display (e.g., 0.0234 -> "$0.02")
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return '<$0.01';
  }
  return '$' + cost.toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Meter - Track and visualize Claude's context window usage
// ─────────────────────────────────────────────────────────────────────────────

interface ContextState {
  percentage: number;      // 0-100, percentage of context used
  lastUpdated: number;     // timestamp
  sessionStart: number;    // when this session started
  tokensUsed: number;      // estimated tokens in current context
}

// In-memory context tracking per user
const contextStates = new Map<number, ContextState>();

// Claude's approximate context window
const CLAUDE_MAX_CONTEXT = 200000;

/**
 * Update context percentage from Claude's output
 */
export function updateContextFromScreen(userId: number, screen: string): number | null {
  // Try to parse context percentage from Claude's output
  const patterns = [
    /context.*?(\d+(?:\.\d+)?)%/i,
    /(\d+(?:\.\d+)?)%.*context/i,
    /using\s+(\d+(?:\.\d+)?)%/i,
  ];

  for (const pattern of patterns) {
    const match = screen.match(pattern);
    if (match) {
      const percent = parseFloat(match[1]);
      if (percent >= 0 && percent <= 100) {
        updateContextState(userId, percent);
        return percent;
      }
    }
  }
  return null;
}

/**
 * Update context state directly
 */
export function updateContextState(userId: number, percentage: number, tokens?: number): void {
  const existing = contextStates.get(userId);
  contextStates.set(userId, {
    percentage: Math.min(100, Math.max(0, percentage)),
    lastUpdated: Date.now(),
    sessionStart: existing?.sessionStart || Date.now(),
    tokensUsed: tokens || Math.round((percentage / 100) * CLAUDE_MAX_CONTEXT),
  });
}

/**
 * Estimate context usage from token counts
 */
export function estimateContext(userId: number, inputTokens: number, outputTokens: number): void {
  const existing = contextStates.get(userId);
  const currentTokens = (existing?.tokensUsed || 0) + inputTokens + outputTokens;
  const percentage = Math.min(100, (currentTokens / CLAUDE_MAX_CONTEXT) * 100);
  updateContextState(userId, percentage, currentTokens);
}

/**
 * Reset context (new session started)
 */
export function resetContext(userId: number): void {
  contextStates.delete(userId);
}

/**
 * Get current context state
 */
export function getContextState(userId: number): ContextState | null {
  return contextStates.get(userId) || null;
}

/**
 * Generate visual context meter
 * Returns: "▓▓▓▓▓▓▓░░░ 72%"
 */
export function formatContextMeter(percentage: number): string {
  const filled = Math.round((percentage / 100) * 10);
  const empty = 10 - filled;
  const bar = '▓'.repeat(filled) + '░'.repeat(empty);
  return `${bar} ${Math.round(percentage)}%`;
}

/**
 * Generate compact context indicator for keyboards
 * Returns: "🟢 72%" or "🟡 85%" or "🔴 95%"
 */
export function formatContextCompact(percentage: number): string {
  let icon: string;
  if (percentage < 70) {
    icon = '🟢';
  } else if (percentage < 85) {
    icon = '🟡';
  } else {
    icon = '🔴';
  }
  return `${icon} ${Math.round(percentage)}%`;
}

/**
 * Get context warning message if needed
 */
export function getContextWarning(percentage: number): string | null {
  if (percentage >= 95) {
    return '🔴 *Context almost full!* Run /reset to start fresh.';
  } else if (percentage >= 85) {
    return '🟠 *Context getting low.* Consider /reset soon.';
  } else if (percentage >= 70) {
    return '🟡 *Context usage: ' + Math.round(percentage) + '%*';
  }
  return null;
}

/**
 * Format full context report
 */
export function formatContextReport(userId: number): string {
  const state = getContextState(userId);
  if (!state) {
    return '📊 *Context Meter*\n\n' +
      formatContextMeter(0) + '\n\n' +
      '_No context data yet. Start chatting with Claude!_';
  }

  const percent = state.percentage;
  const tokens = formatTokenCount(state.tokensUsed);
  const maxTokens = formatTokenCount(CLAUDE_MAX_CONTEXT);
  const sessionDuration = formatSessionDuration(Date.now() - state.sessionStart);
  const lastUpdate = formatLastUpdate(Date.now() - state.lastUpdated);

  let status: string;
  if (percent < 50) {
    status = '✅ Plenty of room';
  } else if (percent < 70) {
    status = '🟢 Good';
  } else if (percent < 85) {
    status = '🟡 Getting full';
  } else if (percent < 95) {
    status = '🟠 Running low';
  } else {
    status = '🔴 Almost full!';
  }

  return '📊 *Context Meter*\n\n' +
    formatContextMeter(percent) + '\n\n' +
    `*Tokens:* ${tokens} / ${maxTokens}\n` +
    `*Status:* ${status}\n` +
    `*Session:* ${sessionDuration}\n` +
    `*Updated:* ${lastUpdate}`;
}

function formatSessionDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatLastUpdate(ms: number): string {
  if (ms < 5000) return 'just now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}
