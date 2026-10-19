/**
 * skynet server entrypoint (Build order Step 1–5 server side):
 *   1. boot: restore connectors — silent reconnect via refresh tokens → green
 *   2. listen: API port (dev 8080) + OAuth callback port (dev 4180 — plain
 *      unprivileged; the redirect URI registered with Zepto must
 *      character-match the URI served here). If that bind fails, the paste
 *      fallback keeps the flow possible.
 */
import * as http from 'node:http';
import { config } from './config.js';
import { log, redact } from './logger.js';
import { connectorRuntimes, ConnectorRuntime } from './connectors/service.js';
import { CONNECTORS } from './connectors/registry.js';
import { ChatService } from './agent/chat-service.js';
import { createApp } from './http/app.js';
import { initTracing } from './telemetry/tracer.js';
import type { RuntimeHandle } from './agent/engine-types.js';

const SCOPE = 'skynet';

function banner(): void {
  log.info(SCOPE, 'skynet starting', {
    engine: config.engine,
    model: config.geminiModel,
    geminiKey: config.geminiApiKey ? redact(config.geminiApiKey) : '(missing)',
    dataDir: config.dataDir,
    redirectUri: CONNECTORS[0]?.redirectUri,
  });
}

function toHandle(r: ConnectorRuntime): RuntimeHandle {
  return {
    def: r.def,
    mcp: r.mcp,
    snapshot: () => r.snapshot(),
  };
}

function dotFor(state: string, error?: string): string {
  switch (state) {
    case 'connected':
      return '● green — connected';
    case 'connecting':
    case 'awaiting_login':
      return '◐ amber — in progress';
    default:
      return error ? `○ red — ${error}` : '○ red — not connected';
  }
}

async function main(): Promise<void> {
  banner();

  // 0 ── OpenTelemetry (F2): register the global provider BEFORE any engine
  // import — @google/adk's own wiring then merges into this capture instead of
  // fighting over the global slot.
  initTracing();

  const chat = new ChatService(
    config.engine,
    (id: string) => {
      const r = connectorRuntimes.byId(id);
      return r ? toHandle(r) : undefined;
    },
    () => CONNECTORS.map((c) => c.id),
    () => connectorRuntimes.statusMap(),
  );

  // 1 ── silent reconnect (Plan §2.6): refresh tokens + MCP handshake.
  log.info(SCOPE, 'silent reconnect check ...');
  await connectorRuntimes.connectAllSilent();
  for (const r of connectorRuntimes.all()) {
    const s = r.snapshot();
    log.info(SCOPE, `${r.def.name}: ${dotFor(s.state, s.error)}`);
  }

  // 2 ── HTTP: create the app, then listen on both ports.
  const callbackStatus: { ok: boolean; error?: string } = { ok: true };
  const app = createApp({ chat, callback: callbackStatus });

  const apiServer = http.createServer(app);
  apiServer.listen(config.apiPort, () => {
    log.info(SCOPE, `API up → http://localhost:${config.apiPort}`, {
      engine: config.engine,
      geminiKey: Boolean(config.geminiApiKey),
    });
    log.info(SCOPE, `web origin (Angular): ${config.webOrigin}`);
  });
  apiServer.on('error', (e) => crash('api', e));

  const callbackServer = http.createServer(app);
  callbackServer.listen(config.callbackPort);
  callbackServer.on('listening', () => {
    log.info(SCOPE, `OAuth callback server on :${config.callbackPort} → ${CONNECTORS[0]?.redirectUri}`);
  });
  callbackServer.on('error', (e: NodeJS.ErrnoException) => {
    let reason: string;
    if (e.code === 'EACCES') {
      reason = `cannot bind port ${config.callbackPort} (EACCES) — privileged port; pick an unprivileged SKYNET_CALLBACK_PORT (the redirect URI follows the port) or grant OS port rights — see README "The callback port"`;
    } else if (e.code === 'EADDRINUSE') {
      reason = `cannot bind port ${config.callbackPort} (EADDRINUSE) — something else already owns it (e.g. apache2/nginx on :80); free the port, pick another SKYNET_CALLBACK_PORT, or use the paste fallback (connector sheet)`;
    } else {
      reason = `${e.code}: ${e.message}`;
    }
    log.warn(SCOPE, `callback server on :${config.callbackPort} FAILED — ${reason}`);
    callbackStatus.ok = false;
    callbackStatus.error = reason;
    log.warn(SCOPE, 'paste fallback remains available in the connector sheet (no dead end).');
  });
}

function crash(kind: string, e: Error): void {
  log.error(SCOPE, `${kind} listener failed: ${e.message}`);
  process.exit(1);
}

process.on('SIGINT', () => {
  log.info(SCOPE, 'bye');
  process.exit(0);
});

main().catch((e) => {
  log.error(SCOPE, 'fatal boot error', e);
  process.exit(1);
});
