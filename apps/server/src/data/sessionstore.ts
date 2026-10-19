/**
 * Chat session persistence (Plan step 5): one JSON file per browser session
 * under the data dir, 0600. Holds the display transcript (turns incl. tool
 * chips + confirmation cards), the direct-engine genai history, and any
 * pending confirmation gate so a restart mid-flow resumes sanely.
 */
import { config } from '../config.js';
import { ensureDir, joinSecure, readJson, writeJsonSecure } from './files.js';
import { ChatSession } from '../types.js';

export class SessionStore {
  private readonly dir: string;

  constructor(dir = joinSecure(config.dataDir, 'history')) {
    this.dir = dir;
  }

  private path(id: string): string {
    return joinSecure(this.dir, `${id}.json`);
  }

  async load(id: string): Promise<ChatSession | null> {
    return readJson<ChatSession>(this.path(id));
  }

  async save(session: ChatSession): Promise<void> {
    await ensureDir(this.dir);
    session.updatedAt = new Date().toISOString();
    await writeJsonSecure(this.path(session.id), session);
  }

  static newSession(engine: 'direct' | 'adk'): ChatSession {
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 13) + '-' + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    return {
      id,
      createdAt: now,
      updatedAt: now,
      engine,
      turns: [],
      directHistory: [],
      pendingGate: null,
    };
  }
}
