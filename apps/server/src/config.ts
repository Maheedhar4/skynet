import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dotenv from 'dotenv';

// dotenv: load the repo-root .env (the server may run from a workspace dir).
const repoRoot = repoRootDir();
dotenv.config({ path: path.join(repoRoot, '.env') });

/**
 * Walk up from this module's directory until we hit the monorepo root
 * (recognised by the `apps/web` workspace marker). Works for both runs:
 *   - tsx straight from source  (…/apps/server/src → up 3)
 *   - compiled tsc output       (…/apps/server/dist → up 2)
 */
function repoRootDir(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'apps', 'web', 'package.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break; // filesystem root — stop
    d = up;
  }
  return process.cwd();
}

function int(v: string | undefined, dflt: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : dflt;
}
function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
  return p;
}

export const REPO_ROOT = repoRoot;

/** Resolve the built Angular app, if it exists, for one-origin serving. */
export function webDistDir(): string | null {
  const candidates = [
    path.join(repoRoot, 'apps/web/dist/skynet-web/browser'),
    path.join(repoRoot, 'apps/web/dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

export const config = {
  repoRoot,
  /** Main HTTP API port. */
  apiPort: int(process.env.SKYNET_API_PORT, 8080),
  /**
   * Port for the OAuth redirect callback. Zepto whitelists only
   * `http://localhost/callback` and `http://localhost` (exact match, NO ports
   * — verified live), so this must be 80 unless you registered a custom URI.
   */
  callbackPort: int(process.env.SKYNET_CALLBACK_PORT, 80),
  /** Where the browser is sent after the OAuth backend handled /callback. */
  webOrigin: process.env.SKYNET_WEB_ORIGIN ?? 'http://localhost:4200',
  /** Token + chat-history storage (files are written with 0600 perms). */
  dataDir: expandHome(process.env.SKYNET_DATA_DIR ?? '~/.skynet'),
  /** Gemini model (free-tier friendly default). */
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  /** Chat agent engine: 'direct' (default) or 'adk' (auto falls back). */
  engine: (process.env.SKYNET_ENGINE === 'adk' ? 'adk' : 'direct') as 'direct' | 'adk',
  /** Escape hatch when port 80 can't be bound: paste the redirect URL manually. */
  pasteFallback: bool(process.env.SKYNET_ALLOW_PASTE_FALLBACK, true),
  /** Optional override of the gated-tools regex (tool names needing YES). */
  confirmToolRe: process.env.SKYNET_CONFIRM_TOOL_RE ?? '',
  /** Explicitly disable the order-confirmation gate (NOT recommended). */
  ungated: bool(process.env.SKYNET_UNGATED, false),
};
