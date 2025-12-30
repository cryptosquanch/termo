import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

dotenvConfig();

export interface Config {
  // Telegram
  botToken: string;
  allowedUserIds: number[];

  // Terminal
  defaultShell: string;
  commandTimeout: number;
  maxOutputLength: number;

  // Storage
  databasePath: string;

  // Notifications
  longRunningThreshold: number;

  // Paths
  projectRoot: string;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function parseUserIds(input: string): number[] {
  return input
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
}

export function loadConfig(): Config {
  const projectRoot = resolve(__dirname, '..');

  const botToken = getEnvOrThrow('TELEGRAM_BOT_TOKEN');
  const userIdsRaw = getEnvOrThrow('ALLOWED_USER_IDS');
  const allowedUserIds = parseUserIds(userIdsRaw);

  if (allowedUserIds.length === 0) {
    throw new Error('ALLOWED_USER_IDS must contain at least one valid user ID');
  }

  return {
    botToken,
    allowedUserIds,
    defaultShell: getEnvOrDefault('DEFAULT_SHELL', '/bin/zsh'),
    commandTimeout: parseInt(getEnvOrDefault('COMMAND_TIMEOUT', '300000'), 10),
    maxOutputLength: parseInt(getEnvOrDefault('MAX_OUTPUT_LENGTH', '4000'), 10),
    databasePath: resolve(projectRoot, 'data', 'termo.db'),
    longRunningThreshold: parseInt(getEnvOrDefault('LONG_RUNNING_THRESHOLD', '10000'), 10),
    projectRoot,
  };
}
