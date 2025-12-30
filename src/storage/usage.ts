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
