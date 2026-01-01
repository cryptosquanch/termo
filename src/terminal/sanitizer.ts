import { resolve, normalize } from 'path';
import { homedir } from 'os';

export interface ValidationResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

// Commands that are completely blocked - too dangerous
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[^\s]*\s+)*\/\s*$/, reason: 'Deleting root directory is blocked' },
  { pattern: /rm\s+-rf\s+\/(?!\w)/, reason: 'rm -rf / is blocked' },
  { pattern: /rm\s+-rf\s+\/\*/, reason: 'rm -rf /* is blocked' },
  { pattern: /mkfs\./, reason: 'Filesystem formatting is blocked' },
  { pattern: /dd\s+if=.*of=\/dev\//, reason: 'Direct disk writes are blocked' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'Fork bombs are blocked' },
  { pattern: /\w+\(\)\s*\{[^}]*\|\s*\w+/, reason: 'Function fork pattern blocked' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Direct device writes are blocked' },
  { pattern: /chmod\s+-R\s+777\s+\//, reason: 'Recursive chmod 777 on root is blocked' },
  { pattern: /chown\s+-R\s+.*\s+\/\s*$/, reason: 'Recursive chown on root is blocked' },
  // Encoding bypass protections
  { pattern: /base64\s+(-d|--decode).*\|\s*(sh|bash|zsh)/, reason: 'Encoded shell execution blocked' },
  { pattern: /\|\s*(sh|bash|zsh)\s*$/, reason: 'Piping to shell is blocked' },
  { pattern: /\|(sh|bash|zsh)\b/, reason: 'Piping to shell is blocked' },
  { pattern: /\beval\s+/, reason: 'eval is blocked' },
  // Remote code execution
  { pattern: /curl\s+[^|]*\|\s*(sh|bash|zsh)/, reason: 'Curl to shell is blocked' },
  { pattern: /wget\s+[^|]*-O-[^|]*\|\s*(sh|bash|zsh)/, reason: 'Wget to shell is blocked' },
];

// Commands that need confirmation before executing
const CONFIRMATION_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /\bsudo\b/, warning: 'This command uses sudo (elevated privileges)' },
  { pattern: /rm\s+-rf?\s/, warning: 'This command will delete files recursively' },
  { pattern: /rm\s+.*-r/, warning: 'This command will delete files recursively' },
  { pattern: /\breboot\b/, warning: 'This will reboot your Mac' },
  { pattern: /\bshutdown\b/, warning: 'This will shut down your Mac' },
  { pattern: /\bhalt\b/, warning: 'This will halt your Mac' },
  { pattern: /killall\s+/, warning: 'This will kill processes' },
  { pattern: /pkill\s+/, warning: 'This will kill processes' },
  { pattern: /launchctl\s+unload/, warning: 'This will unload a launch daemon' },
  { pattern: /diskutil\s+erase/, warning: 'This will erase a disk' },
  { pattern: />\s*\/etc\//, warning: 'This will modify system config files' },
  { pattern: /pip\s+uninstall/, warning: 'This will uninstall Python packages' },
  { pattern: /npm\s+uninstall\s+-g/, warning: 'This will uninstall global npm packages' },
  { pattern: /brew\s+uninstall/, warning: 'This will uninstall Homebrew packages' },
];

// Interactive commands that don't work well in this context
const INTERACTIVE_COMMANDS = [
  'vim', 'vi', 'nvim', 'nano', 'emacs',
  'less', 'more', 'man',
  'ssh', 'telnet', 'ftp',
  'mysql', 'psql', 'mongo', 'redis-cli',
  'python', 'python3', 'node', 'irb', 'ghci',
];

export function validateCommand(command: string): ValidationResult {
  const trimmed = command.trim();

  // Check for dangerous patterns
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        requiresConfirmation: false,
        reason,
      };
    }
  }

  // Check for commands requiring confirmation
  for (const { pattern, warning } of CONFIRMATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: true,
        requiresConfirmation: true,
        reason: warning,
      };
    }
  }

  return {
    allowed: true,
    requiresConfirmation: false,
  };
}

export function isInteractiveCommand(command: string): boolean {
  const firstWord = command.trim().split(/\s+/)[0];
  return INTERACTIVE_COMMANDS.includes(firstWord);
}

export function getInteractiveWarning(command: string): string | null {
  const firstWord = command.trim().split(/\s+/)[0];

  if (['vim', 'vi', 'nvim', 'nano', 'emacs'].includes(firstWord)) {
    return `'${firstWord}' is an interactive editor. Consider using 'cat', 'head', 'tail', or 'sed' instead.`;
  }

  if (['less', 'more', 'man'].includes(firstWord)) {
    return `'${firstWord}' is a pager. The output will be truncated. Consider piping to 'cat' instead.`;
  }

  if (['python', 'python3', 'node', 'irb', 'ghci'].includes(firstWord)) {
    return `'${firstWord}' without arguments starts an interactive REPL. Pass a script file instead.`;
  }

  if (['ssh', 'telnet', 'mysql', 'psql', 'mongo', 'redis-cli'].includes(firstWord)) {
    return `'${firstWord}' is an interactive session. This won't work well via Telegram.`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// File Path Validation - Prevent arbitrary file reads
// ─────────────────────────────────────────────────────────────────────────────

// Sensitive files that should never be read
const BLOCKED_FILE_PATTERNS: RegExp[] = [
  /^\/etc\/shadow$/,
  /^\/etc\/passwd$/,
  /^\/etc\/sudoers/,
  /\.ssh\/.*_rsa$/,       // Private SSH keys
  /\.ssh\/.*_ed25519$/,   // Private SSH keys
  /\.ssh\/.*_dsa$/,       // Private SSH keys
  /\.gnupg\//,            // GPG keys
  /\.aws\/credentials$/,
  /\.netrc$/,
  /\.npmrc$/,             // Often contains tokens
  /\.pypirc$/,
  /\.docker\/config\.json$/,
  /keychain/i,
];

// Allowed directory prefixes (resolved to absolute paths)
const ALLOWED_PREFIXES: string[] = [
  homedir(),              // User's home directory
  '/tmp',                 // Temp files
  '/var/folders',         // macOS temp folders
];

export interface PathValidationResult {
  allowed: boolean;
  reason?: string;
  resolvedPath?: string;
}

/**
 * Validate a file path for safe reading
 * Prevents path traversal and access to sensitive files
 */
export function validateFilePath(filepath: string): PathValidationResult {
  try {
    // Normalize and resolve to absolute path
    const resolved = resolve(normalize(filepath));

    // Check for blocked file patterns
    for (const pattern of BLOCKED_FILE_PATTERNS) {
      if (pattern.test(resolved)) {
        return {
          allowed: false,
          reason: 'Access to this file type is blocked for security',
        };
      }
    }

    // Check if .env file (contains secrets)
    if (/\.env($|\.)/.test(resolved)) {
      return {
        allowed: false,
        reason: 'Access to .env files is blocked (may contain secrets)',
      };
    }

    // Check if path is within allowed directories
    const isAllowed = ALLOWED_PREFIXES.some(prefix =>
      resolved.startsWith(prefix + '/') || resolved === prefix
    );

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `File must be within home directory or /tmp`,
      };
    }

    return {
      allowed: true,
      resolvedPath: resolved,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: 'Invalid file path',
    };
  }
}
