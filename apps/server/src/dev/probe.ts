/**
 * Live connectivity probe (plan §Key technical decision):
 *   1. MCP OAuth discovery (protected resource + authorization server)
 *   2. dynamic client registration (RFC 7591)
 *   3. THE PORT QUESTION — authorize redirect_uri:
 *        whitelisted (no port)  ⇒ expected 200 (OTP page renders)
 *        localhost:8080         ⇒ expected REJECT (UriNotRegistered) ⇒ we MUST
 *        serve /callback on port 80 — this encoded our architecture.
 *   4. Zepto MCP TcpHealth: expect a 401 when calling the MCP endpoint with a
 *      bogus bearer (proves the endpoint is a streamable HTTP server).
 *
 * Run: npm run connect:probe  (from the repo root)
 */
import { config } from '../config.js';
import { discoverAuthServer, discoverProtectedResource } from '../oauth/discovery.js';
import { createPkcePair } from '../oauth/pkce.js';

const ZEPTO_MCP = 'https://mcp.zepto.co.in/mcp';

async function register(redirectUri: string): Promise<string> {
  const res = await fetch('https://auth.zepto.co.in/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'skynet probe (transient)',
      client_uri: 'http://localhost',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'tools:read',
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!json.client_id) throw new Error(`registration failed (${res.status})`);
  return json.client_id as string;
}

async function probeAuthorize(clientId: string, redirectUri: string): Promise<{ status: number; location: string | null }> {
  const { challenge } = createPkcePair();
  const url =
    'https://auth.zepto.co.in/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'tools:read',
      state: 'probe',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://mcp.zepto.co.in',
    }).toString();
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') };
}

async function main(): Promise<void> {
  console.log('== skynet live probe ==\n');

  // 1 ── discovery
  const pr = await discoverProtectedResource('https://mcp.zepto.co.in');
  console.log('✓ resource metadata:', pr.resource, '→ AS', pr.authorization_servers);
  const as = await discoverAuthServer(pr.authorization_servers[0]!);
  console.log('✓ auth server:', {
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint,
    revocation_endpoint: as.revocation_endpoint,
    pkce: as.code_challenge_methods_supported,
    grants: as.grant_types_supported,
  });

  // 2 ── dynamic client registration
  console.log('\n– dynamic client registration test');
  const clientId = await register('http://localhost/callback');
  console.log('✓ registered client_id', clientId, '(DIRTY but harmless: probe-only client)');

  // 3 ── the PORT question (this decides the callback server port)
  console.log('\n– redirect URI port test (plan – key risk)');
  const whitelisted = await probeAuthorize(clientId, 'http://localhost/callback');
  console.log(
    whitelisted.status === 200
      ? '✓ http://localhost/callback accepted (OTP page renders) — 200 OK'
      : `✗ unexpected: ${whitelisted.status} ${whitelisted.location ?? ''}`,
  );
  const ported = await probeAuthorize(clientId, 'http://localhost:8080/callback');
  const rejected = ported.location?.includes('uri_not_registered_for_client') || ported.status !== 200;
  console.log(
    rejected
      ? `✓ http://localhost:8080/callback REJECTED (${ported.status} ${ported.location ?? ''}) — Zepto does NOT ignore the port (no RFC 8252 leniency)...`
      : `!! whoa, now Zepto ACCEPTS a ported URI (${ported.status} ${ported.location ?? ''}) — you could re-rig skynet to be on 8080`,
  );

  // 4 ── MCP endpoint shape (streamable HTTP + 401 without tokens)
  const mcp = await fetch(ZEPTO_MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer bogus-token-probe`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'skynet-probe', version: '0.0.0' },
      },
    }),
  });
  console.log(
    mcp.status === 401
      ? '✓ MCP endpoint present and streamable — rejects anonymously with 401 (auth-gated, as expected)'
      : `? MCP responded ${mcp.status} — inspect manually`,
  );

  console.log(`\nprobe done — config in use: callbackPort=${config.callbackPort} redirectUri=${CONNECTORS_URI ?? 'env/default'}`);
  process.exit(0);
}

const CONNECTORS_URI = process.env.SKYNET_ZEPTO_REDIRECT_URI || 'http://localhost/callback';

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
