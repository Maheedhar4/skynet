/**
 * The OAuth flow engine for a connector (Plan §2):
 *   1. fetch resource metadata → discover the authorization server
 *   2. dynamic client registration (RFC 7591) — done once, persisted
 *   3. PKCE (S256) authorize URL → the user logs in with mobile + OTP
 *   4. /callback (or paste-fallback) → exchange code → store tokens (0600)
 *   5. refresh silently later; revoke + clear on disconnect
 */
import { ConnectorDef } from '../connectors/registry.js';
import { log, redact } from '../logger.js';
import { TokenStore, ConnectorStore, PendingFlow, StoredRegistration, StoredTokens } from '../data/tokenstore.js';
import { AuthServerMeta, discoverAuthServer, discoverProtectedResource } from './discovery.js';
import { createPkcePair, createState, qs } from './pkce.js';

export interface FlowHandle {
  authorizeUrl: string;
  state: string;
  clientAlreadyRegistered: boolean;
}

const PENDING_TTL_MS = 15 * 60 * 1000; // OTP flows shouldn't outlive 15 min

function postForm(url: string, params: Record<string, string>): Promise<{ status: number; json: any }> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) }));
}

export class OAuthFlow {
  constructor(
    private readonly def: ConnectorDef,
    private readonly store: TokenStore,
  ) {}

  private async serverMeta(): Promise<{ as: AuthServerMeta }> {
    const pr = await discoverProtectedResource(new URL(this.def.mcpUrl).origin);
    const authServer = pr.authorization_servers[0];
    if (!authServer) throw new Error(`No authorization server found for ${this.def.mcpUrl}`);
    const as = await discoverAuthServer(authServer);
    return { as };
  }

  // ── begin ──────────────────────────────────────────────────────────────────
  async begin(existing: ConnectorStore | null): Promise<FlowHandle> {
    const { as } = await this.serverMeta();
    if (!as.authorization_endpoint) {
      throw new Error('Authorization server metadata does not expose an authorization endpoint');
    }

    let registration: StoredRegistration;
    let wasRegistered = true;
    if (existing?.registration?.clientId) {
      registration = existing.registration;
    } else if (as.registration_endpoint) {
      registration = await this.registerClient(as);
      wasRegistered = false;
    } else {
      throw new Error('Authorization server does not support dynamic client registration');
    }

    const { verifier, challenge } = createPkcePair();
    const state = createState();

    const flow: PendingFlow = {
      connectorId: this.def.id,
      state,
      verifier,
      redirectUri: this.def.redirectUri,
      createdAt: Date.now(),
    };
    await this.store.savePending(flow);

    const authorizeUrl =
      `${as.authorization_endpoint}?` +
      qs({
        response_type: 'code',
        client_id: registration.clientId,
        redirect_uri: this.def.redirectUri,
        scope: this.def.scopes.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: this.def.resource,
      });

    return { authorizeUrl, state, clientAlreadyRegistered: wasRegistered };
  }

  private async registerClient(as: AuthServerMeta): Promise<StoredRegistration> {
    const body = {
      client_name: 'skynet (local chat)',
      client_uri: 'http://localhost',
      redirect_uris: [this.def.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: this.def.scopes.join(' '),
    };
    const res = await fetch(as.registration_endpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.client_id) {
      throw new Error(`Dynamic client registration failed (${res.status}): ${json.error ?? JSON.stringify(json).slice(0, 200)}`);
    }
    log.info('oauth', `registered client for ${this.def.id}`, {
      clientId: json.client_id,
      redirectUris: json.redirect_uris,
      authMethod: json.token_endpoint_auth_method,
    });
    const reg: StoredRegistration = {
      clientId: json.client_id,
      clientSecret: json.client_secret,
      registrationAccessToken: json.registration_access_token,
      registrationClientUri: json.registration_client_uri,
      clientName: json.client_name ?? body.client_name,
      redirectUris: json.redirect_uris ?? body.redirect_uris,
      tokenEndpointAuthMethod: json.token_endpoint_auth_method ?? 'none',
    };
    return reg;
  }

  // ── code → tokens ──────────────────────────────────────────────────────────
  async complete(flow: PendingFlow, code: string): Promise<StoredTokens> {
    const { as } = await this.serverMeta();
    const existing = await this.store.load(this.def.id);
    const reg: StoredRegistration =
      existing?.registration ??
      ({
        clientId: '',
        clientName: 'skynet (local chat)',
        redirectUris: [flow.redirectUri],
        tokenEndpointAuthMethod: 'none',
      } as StoredRegistration);

    const { status, json } = await postForm(as.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
      client_id: reg.clientId,
      ...(reg.clientSecret ? { client_secret: reg.clientSecret } : {}),
      resource: this.def.resource,
    });

    if (status !== 200 || !json.access_token) {
      throw new Error(
        `Token exchange failed (${status}): ${json.error ?? ''} ${json.error_description ?? JSON.stringify(json).slice(0, 200)}`,
      );
    }

    const tokens: StoredTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? '',
      tokenType: json.token_type ?? 'Bearer',
      scope: json.scope,
      issuedAt: Date.now(),
      expiresIn: json.expires_in,
    };
    log.info('oauth', `tokens stored for ${this.def.id}`, {
      access: redact(tokens.accessToken),
      refresh: tokens.refreshToken ? 'present' : 'MISSING',
      expiresIn: tokens.expiresIn,
      scope: tokens.scope,
    });

    // Persist registration + tokens with the redirect URI that was actually used.
    await this.store.save({
      connectorId: this.def.id,
      resource: this.def.resource,
      redirectUri: flow.redirectUri,
      registration: { ...reg },
      tokens,
    });
    await this.store.clearPending(this.def.id);
    return tokens;
  }

  async refresh(existing: ConnectorStore): Promise<ConnectorStore> {
    const { as } = await this.serverMeta();
    const rt = existing.tokens.refreshToken;
    if (!rt) throw new Error('No refresh token stored');
    const { status, json } = await postForm(as.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: existing.registration.clientId,
      ...(existing.registration.clientSecret ? { client_secret: existing.registration.clientSecret } : {}),
      resource: this.def.resource,
    });
    if (status !== 200 || !json.access_token) {
      const err = `${json.error ?? status}: ${json.error_description ?? ''}`.trim();
      throw new OAuthRefreshError(err);
    }
    const tokens: StoredTokens = {
      ...existing.tokens,
      accessToken: json.access_token,
      // Some ASes rotate the refresh token; keep the old one when absent.
      refreshToken: json.refresh_token ?? rt,
      issuedAt: Date.now(),
      expiresIn: json.expires_in ?? existing.tokens.expiresIn,
      scope: json.scope ?? existing.tokens.scope,
    };
    const fresh: ConnectorStore = { ...existing, tokens };
    await this.store.save(fresh);
    log.info('oauth', `(tokens refreshed via refresh_token)`);
    return fresh;
  }

  async revoke(existing: ConnectorStore): Promise<void> {
    const { as } = await this.serverMeta().catch(() => ({ as: undefined as unknown as AuthServerMeta }));
    if (as?.revocation_endpoint) {
      await fetch(as.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          token: existing.tokens.accessToken,
          client_id: existing.registration.clientId,
        }).toString(),
      }).catch((e) => log.warn('oauth', `revoke call failed (continuing with local clear): ${e}`));
    }
    await this.store.clear(this.def.id);
  }
}

export class OAuthRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthRefreshError';
  }
}

export function isExpired(flow: PendingFlow, now = Date.now()): boolean {
  return now - flow.createdAt > PENDING_TTL_MS;
}
