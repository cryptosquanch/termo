import { loadConfig } from './config.js';
import { initDatabase, closeDatabase } from './storage/database.js';
import { createBot } from './bot/index.js';
import { TerminalExecutor } from './terminal/executor.js';
import { CommandNotifier } from './notifications/notifier.js';
import { stopMiddlewareCleanup } from './bot/middleware.js';

async function main() {
  console.log('[Termo] Starting...');

  // Load configuration
  const config = loadConfig();
  console.log(`[Termo] Allowed users: ${config.allowedUserIds.join(', ')}`);

  // Initialize database
  initDatabase(config.databasePath);
  console.log(`[Termo] Database initialized at ${config.databasePath}`);

  // Create components (proper dependency injection - no circular dep)
  const executor = new TerminalExecutor();
  const notifier = new CommandNotifier(config.longRunningThreshold);
  const bot = createBot(config, executor, notifier);

  // Now set the bot reference and start
  notifier.setBot(bot);
  notifier.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Termo] Received ${signal}, shutting down...`);

    stopMiddlewareCleanup();
    notifier.stop();
    executor.abortAll();
    await bot.stop();
    closeDatabase();

    console.log('[Termo] Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start bot
  console.log('[Termo] Connecting to Telegram...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`[Termo] Bot started as @${botInfo.username}`);
      console.log('[Termo] Ready! Send /start to your bot to begin.');
    },
  });
}

main().catch((error) => {
  console.error('[Termo] Fatal error:', error);
  process.exit(1);
});
