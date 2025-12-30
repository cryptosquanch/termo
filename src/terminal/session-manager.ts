import { homedir } from 'os';
import {
  saveSession,
  getSession,
  getAllSessions,
  deleteSession,
  updateSessionCwd,
  SessionRecord,
} from '../storage/sessions.js';

export interface TerminalSession {
  name: string;
  userId: number;
  cwd: string;
  outputBuffer: string;
  isRunning: boolean;
}

const activeSessions = new Map<string, TerminalSession>();

function sessionKey(userId: number, name: string): string {
  return `${userId}:${name}`;
}

export function createSession(userId: number, name: string, cwd?: string): TerminalSession {
  const key = sessionKey(userId, name);

  if (activeSessions.has(key)) {
    throw new Error(`Session '${name}' already exists`);
  }

  const sessionCwd = cwd || homedir();

  const session: TerminalSession = {
    name,
    userId,
    cwd: sessionCwd,
    outputBuffer: '',
    isRunning: false,
  };

  activeSessions.set(key, session);

  // Persist to database
  saveSession(userId, name, sessionCwd);

  return session;
}

export function getActiveSession(userId: number, name: string): TerminalSession | undefined {
  return activeSessions.get(sessionKey(userId, name));
}

export function listActiveSessions(userId: number): TerminalSession[] {
  const sessions: TerminalSession[] = [];
  for (const [key, session] of activeSessions) {
    if (key.startsWith(`${userId}:`)) {
      sessions.push(session);
    }
  }
  return sessions;
}

export function closeSession(userId: number, name: string): boolean {
  const key = sessionKey(userId, name);
  const session = activeSessions.get(key);

  if (!session) {
    return false;
  }

  activeSessions.delete(key);
  deleteSession(userId, name);

  return true;
}

export function updateCwd(userId: number, name: string, newCwd: string): void {
  const session = getActiveSession(userId, name);
  if (session) {
    session.cwd = newCwd;
    updateSessionCwd(userId, name, newCwd);
  }
}

export function restoreSessionsFromDb(userId: number): TerminalSession[] {
  const savedSessions = getAllSessions(userId);
  const restored: TerminalSession[] = [];

  for (const saved of savedSessions) {
    const key = sessionKey(userId, saved.name);

    if (!activeSessions.has(key)) {
      const session: TerminalSession = {
        name: saved.name,
        userId,
        cwd: saved.cwd,
        outputBuffer: '',
        isRunning: false,
      };
      activeSessions.set(key, session);
      restored.push(session);
    }
  }

  return restored;
}

export function getOrCreateDefaultSession(userId: number): TerminalSession {
  const defaultName = 'default';
  let session = getActiveSession(userId, defaultName);

  if (!session) {
    // Try to restore from DB
    const saved = getSession(userId, defaultName);
    if (saved) {
      session = {
        name: defaultName,
        userId,
        cwd: saved.cwd,
        outputBuffer: '',
        isRunning: false,
      };
      activeSessions.set(sessionKey(userId, defaultName), session);
    } else {
      // Create new default session
      session = createSession(userId, defaultName);
    }
  }

  return session;
}

export function getSavedSessions(userId: number): SessionRecord[] {
  return getAllSessions(userId);
}
