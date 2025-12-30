import { Context, NextFunction } from 'grammy';

// Rate limiting for auth failures - prevent brute force
const authFailures = new Map<number, { count: number; firstFailure: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_FAILURES = 3; // Max 3 attempts per minute
const BLOCK_DURATION = 5 * 60 * 1000; // Block for 5 minutes after limit exceeded

// Periodic cleanup of stale rate limit entries to prevent memory growth
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanupInterval(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [userId, record] of authFailures) {
      if (now - record.firstFailure > BLOCK_DURATION * 2) {
        authFailures.delete(userId);
      }
    }
  }, BLOCK_DURATION);
}

export function stopMiddlewareCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start cleanup on module load
startCleanupInterval();

function isRateLimited(userId: number): boolean {
  const record = authFailures.get(userId);
  if (!record) return false;

  const now = Date.now();

  // Check if still in block period
  if (record.count >= MAX_FAILURES) {
    if (now - record.firstFailure < BLOCK_DURATION) {
      return true;
    }
    // Block expired, reset
    authFailures.delete(userId);
    return false;
  }

  // Check if window expired
  if (now - record.firstFailure > RATE_LIMIT_WINDOW) {
    authFailures.delete(userId);
    return false;
  }

  return false;
}

function recordAuthFailure(userId: number): void {
  const now = Date.now();
  const record = authFailures.get(userId);

  if (!record || now - record.firstFailure > RATE_LIMIT_WINDOW) {
    authFailures.set(userId, { count: 1, firstFailure: now });
  } else {
    record.count++;
  }
}

export function createAuthMiddleware(allowedUserIds: number[], notifyUserId?: number) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;

    if (!userId) {
      console.warn('[Auth] Request with no user ID');
      return;
    }

    if (!allowedUserIds.includes(userId)) {
      // Check rate limit first - silently drop if rate limited
      if (isRateLimited(userId)) {
        console.warn(`[Auth] Rate limited user ${userId} - ignoring`);
        return;
      }

      // Record this failure for rate limiting
      recordAuthFailure(userId);

      // Detailed intruder logging
      const username = ctx.from?.username || 'no_username';
      const firstName = ctx.from?.first_name || 'Unknown';
      const lastName = ctx.from?.last_name || '';
      const fullName = `${firstName} ${lastName}`.trim();
      const attemptedAction = ctx.message?.text?.slice(0, 100) || '[non-text message]';
      const timestamp = new Date().toISOString();
      const record = authFailures.get(userId);
      const attemptNum = record?.count || 1;

      console.warn('');
      console.warn('⚠️  ═══════════════════════════════════════════════════════');
      console.warn(`⚠️  UNAUTHORIZED ACCESS ATTEMPT (#${attemptNum}/${MAX_FAILURES})`);
      console.warn(`⚠️  Time: ${timestamp}`);
      console.warn(`⚠️  User ID: ${userId}`);
      console.warn(`⚠️  Username: @${username}`);
      console.warn(`⚠️  Name: ${fullName}`);
      console.warn(`⚠️  Tried: ${attemptedAction}`);
      if (attemptNum >= MAX_FAILURES) {
        console.warn(`⚠️  STATUS: BLOCKED for 5 minutes`);
      }
      console.warn('⚠️  ═══════════════════════════════════════════════════════');
      console.warn('');

      // Notify the owner about the intrusion attempt
      if (notifyUserId) {
        try {
          const blockStatus = attemptNum >= MAX_FAILURES ? '\n🚫 *Status:* BLOCKED for 5 min' : '';
          await ctx.api.sendMessage(
            notifyUserId,
            `🚨 *Unauthorized Access Attempt* (#${attemptNum})\n\n` +
            `👤 *Who:* ${fullName} (@${username})\n` +
            `🆔 *ID:* \`${userId}\`\n` +
            `💬 *Tried:* \`${attemptedAction.slice(0, 50)}\`\n` +
            `🕐 *When:* ${new Date().toLocaleString()}${blockStatus}`,
            { parse_mode: 'Markdown' }
          );
        } catch {
          // Ignore notification errors
        }
      }

      await ctx.reply(
        '🚫 Access denied. You are not authorized to use this bot.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Log authorized access
    const username = ctx.from?.username || 'unknown';
    console.log(`[Auth] Authorized: ${username} (${userId})`);

    await next();
  };
}

export function createLoggingMiddleware() {
  return async (ctx: Context, next: NextFunction) => {
    const start = Date.now();
    const userId = ctx.from?.id;
    const text = ctx.message?.text?.slice(0, 50) || '[non-text]';

    console.log(`[Request] User ${userId}: ${text}`);

    await next();

    const duration = Date.now() - start;
    console.log(`[Request] Completed in ${duration}ms`);
  };
}
