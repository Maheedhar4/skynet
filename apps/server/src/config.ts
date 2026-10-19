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
/** Explicit port in a URI, or undefined for port-less URIs. */
function portOf(uri: string): number | undefined {
  try {
    const p = new URL(uri).port;
    return p ? Number.parseInt(p, 10) : undefined;
  } catch {
    return undefined;
  }
}

// ── redirect URI bootstrap (needed before `config`, which exposes both) ──────
// Zepto validates redirect_uri exact-match against the client's registered
// URIs (no RFC 8252 port leniency at authorize), but it REGISTERS ported URIs
// happily (verified live 2026-10). So the default lives on an unprivileged
// port derived from SKYNET_CALLBACK_PORT — root-free, Apache keeps :80.
const redirectEnv = process.env.SKYNET_ZEPTO_REDIRECT_URI?.trim() ?? '';
const defaultCallbackPort = int(
  process.env.SKYNET_CALLBACK_PORT,
  redirectEnv ? portOf(redirectEnv) ?? 80 : 4180,
);
const defaultRedirectUri =
  redirectEnv === '' ? `http://localhost:${defaultCallbackPort}/callback` : redirectEnv;
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
   * Port for the OAuth redirect callback listener. The registered redirect
   * URI must character-match what Zepto registered for the client, so the
   * port here and the URI below must agree — the URI derives from this port
   * by default. Default 4180 keeps the whole connect flow unprivileged
   * (verified live: Zepto /register accepts ported URIs; /authorize validates
   * exact-match against them).
   */
  callbackPort: defaultCallbackPort,
  /**
   * Override with SKYNET_ZEPTO_REDIRECT_URI; otherwise derived from the
   * callback port. A port-less override (e.g. http://localhost/callback)
   * implies the privileged port-80 listener (see README).
   */
  zeptoRedirectUri: defaultRedirectUri,
  /** Where the browser is sent after the OAuth backend handled /callback. */
  webOrigin: process.env.SKYNET_WEB_ORIGIN ?? 'http://localhost:4200',
  /** Token + chat-history storage (files are written with 0600 perms). */
  dataDir: expandHome(process.env.SKYNET_DATA_DIR ?? '~/.skynet'),
  /** Gemini model (free-tier friendly default). */
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  /** Chat agent engine: 'direct' (default) or 'adk' (auto falls back). */
  engine: (process.env.SKYNET_ENGINE === 'adk' ? 'adk' : 'direct') as 'direct' | 'adk',
  /** Escape hatch when the callback port can't be bound: paste the redirect URL manually. */
  pasteFallback: bool(process.env.SKYNET_ALLOW_PASTE_FALLBACK, true),
  /** Optional override of the gated-tools regex (tool names needing YES). */
  confirmToolRe: process.env.SKYNET_CONFIRM_TOOL_RE ?? '',
  /** Explicitly disable the order-confirmation gate (NOT recommended). */
  ungated: bool(process.env.SKYNET_UNGATED, false),
  // ── Session tracing (F2, OpenTelemetry) ───────────────────────────────────
  /**
   * Master switch for the tracing pipeline — the in-app span store included.
   * Off loses nothing but the trace viewer / OTLP export.
   */
  otel: bool(process.env.SKYNET_OTEL, true),
  /** OTLP/HTTP endpoint (Jaeger all-in-one :4318, Grafana Tempo, …) or unset. */
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ?? '',
  /** Overridable service.name resource attribute. */
  otelServiceName: process.env.SKYNET_OTEL_SERVICE?.trim() ?? 'skynet-server',
  /**
   * Privacy valve: when true, LLM prompt/response text snippets *may* be
   * embedded in spans. Metadata-only by default; tokens are never traced.
   */
  otelContent: bool(process.env.SKYNET_OTEL_CONTENT, false),
};
