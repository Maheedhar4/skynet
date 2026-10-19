/**
 * Token store: one file per connector under the skynet data dir, written with
 * 0600. Never enters the repo; refresh tokens are used silently only here.
 */
import { config } from '../config.js';
import { ensureDir, joinSecure, readJson, removeFile, writeJsonSecure } from './files.js';

export interface StoredRegistration {
  clientId: string;
  clientSecret?: string;
  registrationAccessToken?: string;
  registrationClientUri?: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope?: string;
  /** epoch ms when the access token was obtained */
  issuedAt: number;
  /** lifetime seconds from the AS, if it sent them */
  expiresIn?: number;
}

export interface ConnectorStore {
  connectorId: string;
  resource: string;
  redirectUri: string;
  registration: StoredRegistration;
  tokens: StoredTokens;
}

/** One OAuth "pending" flow (awaiting the user's OTP login). */
export interface PendingFlow {
  connectorId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  /** Dynamic client registration captured at flow start. The tokens file
   * gains a registration only after a successful exchange, so without this a
   * first-ever login would reach the token endpoint with no client_id. */
  registration?: StoredRegistration;
  createdAt: number;
}

export class TokenStore {
  constructor(private readonly dir = config.dataDir) {}

  private pathFor(connectorId: string): string {
    return joinSecure(this.dir, `${connectorId}.tokens.json`);
  }

  private pendingPath(connectorId: string): string {
    return joinSecure(this.dir, `${connectorId}.pending.json`);
  }

  async load(connectorId: string): Promise<ConnectorStore | null> {
    return readJson<ConnectorStore>(this.pathFor(connectorId));
  }

  async save(store: ConnectorStore): Promise<void> {
    await ensureDir(this.dir);
    await writeJsonSecure(this.pathFor(store.connectorId), store);
  }

  async clear(connectorId: string): Promise<void> {
    await removeFile(this.pathFor(connectorId));
    await removeFile(this.pendingPath(connectorId));
  }

  async savePending(flow: PendingFlow): Promise<void> {
    await ensureDir(this.dir);
    await writeJsonSecure(this.pendingPath(flow.connectorId), flow);
  }

  async loadPending(connectorId: string): Promise<PendingFlow | null> {
    return readJson<PendingFlow>(this.pendingPath(connectorId));
  }

  async clearPending(connectorId: string): Promise<void> {
    await removeFile(this.pendingPath(connectorId));
  }

  async isFresh(store: ConnectorStore, skewMs = 90_000): Promise<boolean> {
    const { tokens } = store;
    if (!tokens.expiresIn) return false; // unknown lifetime → let MCP decide
    const expiresAt = tokens.issuedAt + tokens.expiresIn * 1000;
    return Date.now() < expiresAt - skewMs;
  }
}
