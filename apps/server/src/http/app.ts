/**
 * The one express app (Plan §1–3). It listens TWICE: the API port (dev 8080)
 * and the OAuth redirect callback port (dev 4180). Zepto validates the
 * redirect_uri exact-match against the client's registered URIs (no RFC 8252
 * port leniency — but it registers ported URIs fine), so whatever URI is
 * configured must be served on exactly that port.
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import { config, webDistDir } from '../config.js';
import { connectorRuntimes } from '../connectors/service.js';
import { CONNECTORS } from '../connectors/registry.js';
import { ChatService } from '../agent/chat-service.js';
import { log } from '../logger.js';
import { isGatedToolName } from '../agent/gate.js';
import { toDto } from './dto.js';
import { Ndjson } from './ndjson.js';
import { readSid, sidFrom } from './sid.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { activate, otelHealth, queryTraces, startSpan } from '../telemetry/tracer.js';
import { ATTR } from '../telemetry/store.js';
import type { ChatSession, ConnectorStatus } from '../types.js';

export interface AppDeps {
  chat: ChatService;
  callback: { ok: boolean; error?: string };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '1mb' }));

  // ── F2 tracing: one `http.<route>` span per /api call ────────────────────────
  // The chat pipe becomes the trace ROOT for a turn: no deliberate parent is
  // needed — /api/chat is where the turn's trace begins. The Node SDK's default
  // async-hooks context manager keeps the span active across every await in the
  // ndjson pipeline, so agent./llm./mcp. spans nest automatically.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      next();
      return;
    }
    const route = apiRouteFor(req.path);
    const t0 = Date.now();
    const sid = readSid(req);
    const span = startSpan(`http.${route}`, {
      'http.method': req.method,
      'http.route': route,
      ...(sid ? { [ATTR.session]: sid } : {}),
    });
    activate(span, () => next());
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.setAttribute('skynet.duration_ms', Date.now() - t0);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
      span.end();
    });
  });

  // ── diagnostics ────────────────────────────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    const c0 = CONNECTORS[0];
    res.json({
      ok: true,
      app: 'skynet',
      engine: config.engine,
      model: config.geminiModel,
      geminiKey: Boolean(config.geminiApiKey),
      apiPort: config.apiPort,
      callbackPort: config.callbackPort,
      callbackServer: deps.callback.ok ? 'ok' : `unavailable (${deps.callback.error ?? ''})`.trim(),
      webOrigin: config.webOrigin,
      pasteFallback: config.pasteFallback,
      dataDir: config.dataDir,
      redirectUri: c0?.redirectUri,
      connectors: connectorRuntimes.statusMap(),
      otel: otelHealth(),
    });
  });

  // ── connectors (Plan §1–2) ─────────────────────────────────────────────────
  app.get('/api/connectors', async (_req, res) => {
    // probe statuses so amber/red dots + reasons are fresh (fast, best effort)
    await Promise.all(connectorRuntimes.all().map((r) => r.ensureHealthy().catch(() => undefined)));
    res.json(connectorRuntimes.all().map((r) => toDto(r, config.pasteFallback)));
  });

  app.post('/api/connectors/:id/connect', async (req, res) => {
    const r = connectorRuntimes.byId(req.params.id);
    if (!r) {
      res.status(404).json({ error: `unknown connector ${req.params.id}` });
      return;
    }
    try {
      const { authorizeUrl, state } = await r.startConnect();
      res.json({ authorizeUrl, state, redirectUri: r.def.redirectUri });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: msg });
    }
  });

  app.post('/api/connectors/:id/disconnect', async (req, res) => {
    const r = connectorRuntimes.byId(req.params.id);
    if (!r) {
      res.status(404).json({ error: `unknown connector ${req.params.id}` });
      return;
    }
    try {
      await r.disconnect();
      res.json({ ok: true, status: r.snapshot() });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Escape hatch when the callback port can't be bound/reached (Plan: no dead end either way).
  app.post('/api/connectors/:id/paste-callback', async (req, res) => {
    const r = connectorRuntimes.byId(req.params.id);
    if (!r) {
      res.status(404).json({ error: `unknown connector ${req.params.id}` });
      return;
    }
    try {
      const url = String((req.body as { url?: string } | undefined)?.url ?? '');
      await r.completeFromPastedUrl(url);
      res.json({ ok: true, status: r.snapshot() });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/connectors/:id/tools', async (req, res) => {
    const r = connectorRuntimes.byId(req.params.id);
    if (!r) {
      res.status(404).json({ error: `unknown connector ${req.params.id}` });
      return;
    }
    try {
      const tools = await r.tools();
      res.json(
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          gated: isGatedToolName(t.name, r.def.gateRe),
        })),
      );
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── sessions ───────────────────────────────────────────────────────────────
  app.get('/api/session', async (req, res) => {
    const sid = sidFrom(req, res);
    const s = await deps.chat.get(sid);
    res.json(sessionDto(s));
  });

  app.post('/api/session/new', async (req, res) => {
    const sid = sidFrom(req, res);
    const s = await deps.chat.startNew(sid);
    res.json(sessionDto(s));
  });

  // F1 — destroy every transcript + index and land on a fresh session.
  app.post('/api/session/clear', async (req, res) => {
    const sid = sidFrom(req, res);
    const { deleted, session } = await deps.chat.clearHistory(sid);
    res.json({ ok: true, deleted, ...sessionDto(session) });
  });

  // ── F2 trace viewer feed: traces grouped by traceId, newest first ───────────
  app.get('/api/traces', async (req, res) => {
    const sid = readSid(req); // default scope: the current browser session
    const session = typeof req.query.session === 'string' && req.query.session ? req.query.session : sid ?? undefined;
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10) || 50;
    const otel = otelHealth();
    if (!otel.enabled) {
      res.json({ ok: true, otel, session: session ?? null, traces: [] });
      return;
    }
    res.json({ ok: true, otel, session: session ?? null, traces: queryTraces({ session, limit }) });
  });

  // ── chat streaming (Plan §1): POST → x-ndjson wire events ─────────────────
  app.post('/api/chat', async (req, res) => {
    const sid = sidFrom(req, res);
    const raw = (req.body as { message?: unknown } | undefined)?.message;
    const message = typeof raw === 'string' ? raw.slice(0, 4000) : '';
    const nd = new Ndjson(res);
    if (!message.trim()) {
      nd.write({ type: 'error', message: 'Empty message.' });
      nd.write({ type: 'done' });
      res.end();
      return;
    }
    try {
      for await (const ev of deps.chat.process(sid, message)) {
        nd.write(ev);
      }
    } catch (e) {
      log.error('http', 'chat pipeline failed:', e);
      nd.write({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      nd.write({ type: 'done' });
    } finally {
      res.end();
    }
  });

  // ── the OAuth redirect callback (Plan §2.3) — served on BOTH listeners ─────
  app.get('/callback', async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const errDesc = q.error_description ?? q.error;
    const code = q.code;
    const state = q.state;
    if (errDesc || !code || !state) {
      await redirectConnect(res, {
        ok: false,
        reason: errDesc ?? 'missing code/state in the redirect',
      });
      return;
    }
    try {
      // The state parameter selects the pending flow of the right connector
      // (we don't keep a RAM map of states — file-backed and restart-safe).
      let matched: string | null = null;
      for (const r of connectorRuntimes.all()) {
        const pending = await r.pendingFlow();
        if (pending && pending.state === state) {
          matched = r.def.id;
          await r.completeConnect(pending, code);
          break;
        }
      }
      if (matched) {
        await redirectConnect(res, { ok: true, connector: matched });
      } else {
        await redirectConnect(res, {
          ok: false,
          reason: 'unknown or expired login state — press Connect again',
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await redirectConnect(res, { ok: false, reason: msg });
    }
  });

  // ── static Angular build (single-origin deploy) ────────────────────────────
  const dist = webDistDir();
  if (dist) {
    app.use(express.static(dist));
    app.use((req: Request, res: Response, next) => {
      if (req.method !== 'GET') {
        next();
        return;
      }
      res.sendFile(`${dist}/index.html`, (e) => {
        if (e) next();
      });
    });
  }

  return app;
}

function sessionDto(s: ChatSession): Record<string, unknown> {
  return {
    sessionId: s.id,
    engine: s.engine,
    turns: s.turns,
    pendingGate: s.pendingGate
      ? { id: s.pendingGate.id, tool: s.pendingGate.tool, createdAt: s.pendingGate.createdAt }
      : null,
    status: connectorRuntimes.statusMap(),
  };
}

/** Canonical, id-free route label for span names (`/api/connectors/:id/connect`). */
function apiRouteFor(path: string): string {
  if (path === '/api/health' || path === '/api/traces' || path === '/api/chat') return path;
  if (path === '/api/session' || path === '/api/session/new' || path === '/api/session/clear') return path;
  if (path === '/api/connectors') return path;
  if (path.startsWith('/api/connectors')) {
    const m = /^\/api\/connectors\/[^/]+\/(connect|disconnect|paste-callback|tools)$/.exec(path);
    return m ? `/api/connectors/:id/${m[1]}` : '/api/connectors/:id';
  }
  return path.replace(/\/[a-f0-9]{8,}/g, '/:id'); // fallback: mask hex-ish ids
}

async function redirectConnect(
  res: Response,
  opts: { ok: boolean; connector?: string; reason?: string },
): Promise<void> {
  const target = new URL(config.webOrigin);
  const sp = new URLSearchParams();
  sp.set('connect', opts.ok ? 'ok' : 'error');
  if (opts.connector) sp.set('connector', opts.connector);
  if (opts.reason) sp.set('reason', opts.reason);
  target.search = sp.toString();
  log.info('oauth', `widget redirect → ${target.toString()}`);
  res.redirect(302, target.toString());
}

export type { ConnectorStatus };
