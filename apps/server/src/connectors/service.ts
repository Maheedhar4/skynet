/**
 * Per-connector runtime: owns the connector's status dot, the OAuth flow and
 * the live MCP connection. Status model (plan §UI):
 *
 *   red    disconnected   — no tokens (or hard error; error has a reason)
 *   amber  awaiting_login — the Zepto OTP page is open / user is logging in
 *   amber  connecting     — code exchanged, MCP handshake in progress
 *   green  connected      — handshake + tools/list succeeded
 */
import { ConnectorDef, CONNECTORS } from './registry.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { TokenStore, PendingFlow, ConnectorStore } from '../data/tokenstore.js';
import { ConnectorStatus, ToolDecl } from '../types.js';
import { OAuthFlow, isExpired, OAuthRefreshError } from '../oauth/flow.js';
import { McpToolSource } from '../mcp/connection.js';

export class ConnectorRuntime {
  status: ConnectorStatus = { state: 'disconnected' };
  mcp: McpToolSource;
  private flow: OAuthFlow;
  private lastSilentReconnect = 0;

  constructor(
    readonly def: ConnectorDef,
    private readonly store: TokenStore,
  ) {
    this.mcp = new McpToolSource(def, store);
    this.flow = new OAuthFlow(def, store);
  }

  snapshot(): ConnectorStatus {
    return { ...this.status };
  }

  setStatus(s: ConnectorStatus): void {
    s.lastCheckedAt = new Date().toISOString();
    this.status = s;
  }

  /** Is a login flow waiting for the user to finish OTP? */
  async pendingFlow(): Promise<PendingFlow | null> {
    const f = await this.store.loadPending(this.def.id);
    if (!f) return null;
    if (isExpired(f)) return null;
    return f;
  }

  async tools(): Promise<ToolDecl[]> {
    return this.mcp.tools();
  }

  /** Start the browser OAuth flow (Plan §2.1–2.2). */
  async startConnect(): Promise<{ authorizeUrl: string; state: string }> {
    const existing = await this.store.load(this.def.id);
    this.setStatus({ state: 'connecting' }); // discovery + registration attempts
    try {
      const flow = await this.maybeRefresh(existing);
      const handle = await this.flow.begin(flow);
      this.setStatus({ state: 'awaiting_login' });
      log.info(this.def.id, 'connect flow started — authorize URL ready', {
        status: 'awaiting_login (amber)',
      });
      return { authorizeUrl: handle.authorizeUrl, state: handle.state };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus({ state: 'error', error: msg });
      throw e;
    }
  }

  /**
   * Complete the flow with a code that arrived on /callback (port 80) — Plan
   * §2.3–2.4. Exchanges PKCE-verifier, stores tokens, does the MCP handshake
   * and turns the dot green.
   */
  async completeConnect(flow: PendingFlow, code: string): Promise<void> {
    this.setStatus({ state: 'connecting' });
    try {
      await this.flow.complete(flow, code);
      const tools = await this.mcp.connect();
      this.setStatus({
        state: 'connected',
        toolsCount: tools.length,
        connectedAt: new Date().toISOString(),
      });
      log.info(this.def.id, `LOGIN COMPLETE — MCP handshake OK`, {
        status: 'connected (green)',
        tools: tools.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus({ state: 'error', error: `Connect failed: ${msg}` });
      throw e;
    }
  }

  /** Dev escape hatch when port 80 isn't bindable (Plan §Key decision). */
  async completeFromPastedUrl(rawUrl: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      throw new Error('That is not a valid URL — paste the full redirect URL from the browser bar.');
    }
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const error = u.searchParams.get('error');
    if (error || !code) {
      throw new Error(`OAuth redirect reported an error: ${error ?? 'no code in the URL'}`);
    }
    if (!state) throw new Error('The pasted URL has no state parameter — cannot correlate the flow.');
    const flow = await this.store.loadPending(this.def.id);
    if (!flow) throw new Error('No pending login flow found — press Connect again first.');
    if (flow.state !== state) {
      throw new Error('state mismatch — the pasted redirect does not belong to the current login.');
    }
    await this.completeConnect(flow, code);
  }

  /** Disconnect = call Zepto /revoke + clear tokens (Plan §2.5). */
  async disconnect(): Promise<void> {
    const existing = await this.store.load(this.def.id);
    try {
      if (existing) await this.flow.revoke(existing);
    } finally {
      await this.mcp.close().catch(() => undefined);
      await this.store.clear(this.def.id);
      this.setStatus({ state: 'disconnected' });
      log.info(this.def.id, 'disconnected (revoked + cleared)');
    }
  }

  /**
   * Boot-time silent reconnect (Plan §2.6 + Step 5): refresh token → MCP
   * handshake → straight to green when the token is still valid.
   */
  async silentReconnect(): Promise<void> {
    const store = await this.store.load(this.def.id);
    if (!store) {
      this.setStatus({ state: 'disconnected' });
      return;
    }
    this.setStatus({ state: 'connecting' });
    try {
      const tools = await this.mcp.connect();
      this.setStatus({
        state: 'connected',
        toolsCount: tools.length,
        connectedAt: new Date().toISOString(),
      });
      log.info(this.def.id, 'silent reconnect OK — status green');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus({ state: 'error', error: `Reconnect failed: ${msg}` });
      log.error(this.def.id, 'silent reconnect failed — status red with reason', msg);
    }
  }

  /** Light-weight health check used by the status endpoint (max once / 15s). */
  async ensureHealthy(): Promise<void> {
    const now = Date.now();
    if (this.status.state === 'connected') {
      this.setStatus(this.status);
      return;
    }
    if (await this.pendingFlow()) {
      // don't stomp the user's in-progress login
      this.setStatus({ ...this.status, state: 'awaiting_login' });
      return;
    }
    const hasTokens = await this.mcp.hasTokens();
    if (!hasTokens) {
      if (this.status.state !== 'disconnected') this.setStatus({ state: 'disconnected' });
      return;
    }
    if (now - this.lastSilentReconnect < 15_000) return;
    this.lastSilentReconnect = now;
    await this.silentReconnect();
  }

  private async maybeRefresh(store: ConnectorStore | null): Promise<ConnectorStore | null> {
    if (!store) return null;
    const { tokens } = store;
    const expiresSoon =
      tokens.expiresIn !== undefined &&
      Date.now() >= tokens.issuedAt + tokens.expiresIn * 1000 - 90_000;
    if (!expiresSoon || !tokens.refreshToken) return store;
    try {
      return await this.flow.refresh(store);
    } catch (e) {
      if (e instanceof OAuthRefreshError) {
        await this.store.clear(this.def.id);
        throw new Error('Refresh token rejected — need a fresh login');
      }
      throw e;
    }
  }
}

export class ConnectorRuntimes {
  private readonly map = new Map<string, ConnectorRuntime>();

  constructor() {
    const store = new TokenStore();
    for (const def of CONNECTORS) {
      this.map.set(def.id, new ConnectorRuntime(def, store));
    }
  }

  all(): ConnectorRuntime[] {
    return [...this.map.values()];
  }

  byId(id: string): ConnectorRuntime | undefined {
    return this.map.get(id);
  }

  async connectAllSilent(): Promise<void> {
    await Promise.all(this.all().map((r) => r.silentReconnect().catch(() => undefined)));
  }

  statusMap(): Record<string, ConnectorStatus> {
    const out: Record<string, ConnectorStatus> = {};
    for (const r of this.all()) out[r.def.id] = r.snapshot();
    return out;
  }
}

export const connectorRuntimes = new ConnectorRuntimes();
export const dataDir = config.dataDir;
