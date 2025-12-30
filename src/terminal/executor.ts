import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { TerminalSession, updateCwd } from './session-manager.js';
import { existsSync } from 'fs';

export interface ExecutionResult {
  output: string;
  exitCode: number;
  duration: number;
  truncated: boolean;
  newCwd?: string;
}

export interface ExecuteOptions {
  shell: string;
  timeout: number;
  maxOutput: number;
}

export class TerminalExecutor extends EventEmitter {
  private runningProcesses = new Map<string, ChildProcess>();

  async runCommand(
    session: TerminalSession,
    command: string,
    options: ExecuteOptions
  ): Promise<ExecutionResult> {
    const sessionKey = `${session.userId}:${session.name}`;
    const startTime = Date.now();

    // Kill any existing process in this session
    this.abort(session);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;

      // Detect cd commands to track directory changes
      const cdMatch = command.match(/^\s*cd\s+(.+?)\s*$/);
      let newCwd: string | undefined;

      // Wrap command to capture pwd after execution for cd commands
      const wrappedCommand = cdMatch
        ? `${command} && pwd`
        : command;

      const proc = spawn(options.shell, ['-c', wrappedCommand], {
        cwd: session.cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          HOME: process.env.HOME || '',
          PATH: process.env.PATH || '',
        },
      });

      this.runningProcesses.set(sessionKey, proc);
      session.isRunning = true;

      // Collect stdout
      proc.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        this.emit('data', { session, data: text });

        // Safety limit
        if (stdout.length > options.maxOutput * 2) {
          stdout = stdout.slice(-options.maxOutput);
        }
      });

      // Collect stderr
      proc.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        this.emit('data', { session, data: text });

        if (stderr.length > options.maxOutput * 2) {
          stderr = stderr.slice(-options.maxOutput);
        }
      });

      // Handle process exit
      proc.on('close', (exitCode) => {
        if (resolved) return;
        resolved = true;

        const duration = Date.now() - startTime;
        let output = stdout + (stderr ? `\n${stderr}` : '');
        const truncated = output.length > options.maxOutput;
        output = output.slice(-options.maxOutput);

        // If it was a cd command, extract the new cwd from output
        if (cdMatch && exitCode === 0) {
          const lines = output.trim().split('\n');
          const lastLine = lines[lines.length - 1]?.trim();
          if (lastLine && existsSync(lastLine)) {
            newCwd = lastLine;
            output = lines.slice(0, -1).join('\n');
            updateCwd(session.userId, session.name, newCwd);
            session.cwd = newCwd;
          }
        }

        this.runningProcesses.delete(sessionKey);
        session.isRunning = false;

        resolve({
          output,
          exitCode: exitCode ?? 1,
          duration,
          truncated,
          newCwd,
        });
      });

      proc.on('error', (error) => {
        if (resolved) return;
        resolved = true;

        this.runningProcesses.delete(sessionKey);
        session.isRunning = false;

        resolve({
          output: `Error: ${error.message}`,
          exitCode: 1,
          duration: Date.now() - startTime,
          truncated: false,
        });
      });

      // Timeout handling
      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;

        proc.kill('SIGKILL');
        this.runningProcesses.delete(sessionKey);
        session.isRunning = false;

        const duration = Date.now() - startTime;
        resolve({
          output: stdout.slice(-options.maxOutput) +
            `\n\n[Command timed out after ${Math.round(duration / 1000)}s]`,
          exitCode: 124,
          duration,
          truncated: true,
        });
      }, options.timeout);

      proc.on('close', () => {
        clearTimeout(timeoutId);
      });
    });
  }

  abort(session: TerminalSession): boolean {
    const sessionKey = `${session.userId}:${session.name}`;
    const proc = this.runningProcesses.get(sessionKey);

    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 1000);

      this.runningProcesses.delete(sessionKey);
      session.isRunning = false;
      return true;
    }
    return false;
  }

  isRunning(session: TerminalSession): boolean {
    const sessionKey = `${session.userId}:${session.name}`;
    return this.runningProcesses.has(sessionKey);
  }

  abortAll(): void {
    for (const [key, proc] of this.runningProcesses) {
      proc.kill('SIGTERM');
    }
    this.runningProcesses.clear();
  }
}
