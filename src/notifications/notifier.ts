import { Bot } from 'grammy';
import { formatDuration } from '../terminal/output-handler.js';

interface RunningCommand {
  command: string;
  chatId: number;
  startTime: number;
  notified: boolean;
  sessionName: string;
}

export class CommandNotifier {
  private runningCommands = new Map<string, RunningCommand>();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private bot: Bot | null = null;

  constructor(private longRunningThreshold: number = 10000) {}

  /**
   * Set the bot instance (allows late binding to break circular dependency)
   */
  setBot(bot: Bot): void {
    this.bot = bot;
  }

  start(): void {
    // Check every 5 seconds for long-running commands
    this.checkInterval = setInterval(() => {
      this.checkLongRunning();
    }, 5000);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  registerCommand(
    commandId: string,
    command: string,
    chatId: number,
    sessionName: string
  ): void {
    this.runningCommands.set(commandId, {
      command,
      chatId,
      startTime: Date.now(),
      notified: false,
      sessionName,
    });
  }

  async completeCommand(
    commandId: string,
    exitCode: number,
    duration: number
  ): Promise<void> {
    const cmd = this.runningCommands.get(commandId);

    if (cmd && cmd.notified && this.bot) {
      // Only send completion notice if we previously notified about long-running
      const status = exitCode === 0 ? 'completed' : `failed (exit ${exitCode})`;
      const emoji = exitCode === 0 ? '' : '';

      try {
        await this.bot.api.sendMessage(
          cmd.chatId,
          `${emoji} Command ${status} after ${formatDuration(duration)}:\n` +
          `\`${this.truncateCommand(cmd.command)}\`\n` +
          `Session: ${cmd.sessionName}`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('[Notifier] Failed to send completion notification:', error);
      }
    }

    this.runningCommands.delete(commandId);
  }

  cancelCommand(commandId: string): void {
    this.runningCommands.delete(commandId);
  }

  private async checkLongRunning(): Promise<void> {
    if (!this.bot) return;  // Bot not yet set

    const now = Date.now();

    for (const [id, cmd] of this.runningCommands) {
      if (!cmd.notified && now - cmd.startTime > this.longRunningThreshold) {
        cmd.notified = true;

        try {
          await this.bot.api.sendMessage(
            cmd.chatId,
            ` Command is still running (${formatDuration(now - cmd.startTime)}):\n` +
            `\`${this.truncateCommand(cmd.command)}\`\n\n` +
            `Session: ${cmd.sessionName}\n` +
            `I'll notify you when it completes.`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          console.error('[Notifier] Failed to send long-running notification:', error);
        }
      }
    }
  }

  private truncateCommand(command: string, maxLength = 50): string {
    if (command.length <= maxLength) {
      return command;
    }
    return command.slice(0, maxLength - 3) + '...';
  }
}
