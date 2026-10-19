/**
 * Per-connector MCP client over the official SDK's Streamable HTTP transport.
 * - auth via `Authorization: Bearer` on every request (bearer_methods_supported
 *   verified live: ['header'])
 * - silent reconnect: refresh token on 401/expiry, reconnect lazily when dropped
 * - tools/list + tools/call
 *
 * Retry policy is deliberately conservative: a tool call is retried at most
 * once, and ONLY on `UnauthorizedError` (thrown before the request is
 * forwarded, so it cannot double-execute an order). Any other error surfaces.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ConnectorDef } from '../connectors/registry.js';
import { log, redact } from '../logger.js';
import { ToolDecl, ToolSource } from '../types.js';
import { ConnectorStore, TokenStore } from '../data/tokenstore.js';
import { OAuthFlow, OAuthRefreshError } from '../oauth/flow.js';

export const CLIENT_INFO = { name: 'skynet', version: '0.1.0' };

export class McpToolSource implements ToolSource {
  private client: Client | null = null;
  private toolCache: ToolDecl[] = [];
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly def: ConnectorDef,
    private readonly tokenStore: TokenStore,
  ) {}

  get connectorId(): string {
    return this.def.id;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async hasTokens(): Promise<boolean> {
    return Boolean(await this.tokenStore.load(this.def.id));
  }

  async ensureTokens(): Promise<ConnectorStore> {
    const store = await this.tokenStore.load(this.def.id);
    if (!store) throw new Error('Not connected: no tokens stored. Run the connect flow first.');
    return store;
  }

  /** An access token that is (best-effort) not expired; refreshes silently. */
  private async freshAccessToken(): Promise<string> {
    let store = await this.ensureTokens();
    const flow = new OAuthFlow(this.def, this.tokenStore);
    const freshEnough =
      store.tokens.expiresIn === undefined ||
      Date.now() < store.tokens.issuedAt + store.tokens.expiresIn * 1000 - 90_000;
    if (!freshEnough) {
      try {
        store = await flow.refresh(store);
      } catch (e) {
        if (e instanceof OAuthRefreshError) {
          // Refresh token rejected → the user must redo the connect flow.
          await this.tokenStore.clear(this.def.id);
          throw new Error(`Session expired — reconnect required (${e.message})`);
        }
        throw e;
      }
    }
    return store.tokens.accessToken;
  }

  /** Connect + tools/list. Reuses a live connection when it still works. */
  async connect(): Promise<ToolDecl[]> {
    if (this.client) return this.toolCache;
    if (this.connecting) {
      await this.connecting;
      return this.toolCache;
    }
    this.connecting = this.doConnect().catch((e) => {
      throw e;
    });
    try {
      await this.connecting;
      return this.toolCache;
    } finally {
      this.connecting = null;
    }
  }

  private async doConnect(): Promise<void> {
    const accessToken = await this.freshAccessToken();
    const options: StreamableHTTPClientTransportOptions = {
      requestInit: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json, text/event-stream',
        },
      },
      reconnectionOptions: {
        maxRetries: 1,
        initialReconnectionDelay: 250,
        maxReconnectionDelay: 250,
        reconnectionDelayGrowFactor: 1,
      },
    };
    const transport = new StreamableHTTPClientTransport(new URL(this.def.mcpUrl), options);

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport);
      const res = await client.listTools();
      this.client = client;
      this.toolCache = (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
      log.info(this.connectorId, 'MCP handshake + tools/list OK', {
        url: this.def.mcpUrl,
        tools: this.toolCache.length,
      });
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
  }

  async listTools(): Promise<ToolDecl[]> {
    if (this.client) {
      try {
        return await this.refreshTools();
      } catch {
        // fall through to reconnect
      }
    }
    return this.connect();
  }

  private async refreshTools(): Promise<ToolDecl[]> {
    const res = await this.client!.listTools();
    this.toolCache = (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
    return this.toolCache;
  }

  // ── ToolSource ─────────────────────────────────────────────────────────────
  async tools(): Promise<ToolDecl[]> {
    if (this.toolCache.length) return this.toolCache;
    return this.connect();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) await this.connect();
    try {
      const res = await this.execute(name, args);
      return res;
    } catch (e: unknown) {
      if (e instanceof UnauthorizedError) {
        // 401 → refresh silently + reconnect + retry exactly once
        log.warn(this.connectorId, 'got 401 from MCP — refreshing token and retrying once');
        await this.close().catch(() => undefined);
        await this.freshAccessToken();
        await this.connect();
        return this.execute(name, args);
      }
      // Connection may have dropped; reconnect for the NEXT call, but do not
      // blindly retry this one (placing orders must not double-fire).
      await this.close().catch(() => undefined);
      throw e;
    }
  }

  private async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.client!.callTool({ name, arguments: args });
    return res;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) {
      await c.close().catch(() => undefined);
      log.event(this.connectorId, 'MCP connection closed');
    }
  }
}
