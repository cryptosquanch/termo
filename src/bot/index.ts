import { Bot } from 'grammy';
import { Config } from '../config.js';
import { createAuthMiddleware, createLoggingMiddleware } from './middleware.js';
import { setupBot } from './commands.js';
import { TerminalExecutor } from '../terminal/executor.js';
import { CommandNotifier } from '../notifications/notifier.js';

export function createBot(
  config: Config,
  executor: TerminalExecutor,
  notifier: CommandNotifier
): Bot {
  const bot = new Bot(config.botToken);

  // Middleware chain
  bot.use(createLoggingMiddleware());

  // Pass first allowed user as notification recipient for intrusion alerts
  const ownerUserId = config.allowedUserIds[0];
  bot.use(createAuthMiddleware(config.allowedUserIds, ownerUserId));

  // Setup commands and handlers
  setupBot(bot, config, executor, notifier);

  // Error handling - sanitize to avoid token exposure in logs
  bot.catch((err) => {
    const innerError = err.error as Error | undefined;
    const safeError = {
      message: err.message,
      name: err.name,
      stack: innerError?.stack?.split('\n').slice(0, 5).join('\n'),
    };
    console.error('[Bot] Error:', safeError);
  });

  return bot;
}
