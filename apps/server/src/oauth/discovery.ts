/**
 * RFC 8414/8252 discovery for the Zepto protected resource + authorization
 * server, with a short-lived cache. Shape (verified live 2026-10-19):
 *
 *   /.well-known/oauth-protected-resource →
 *   { authorization_servers: ['https://auth.zepto.co.in'], scopes_supported: [...],
 *     bearer_methods_supported: ['header'], resource: 'https://mcp.zepto.co.in' }
 *
 *   <AS>/.well-known/oauth-authorization-server →
 *   { authorization_endpoint, token_endpoint, registration_endpoint,
 *     revocation_endpoint, code_challenge_methods_supported: ['S256'],
 *     grant_types_supported: ['authorization_code','refresh_token'], ... }
 */
export interface ProtectedResourceMeta {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

export interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error' });
  if (!res.ok) {
    throw new Error(`discovery GET ${url} → ${res.status}`);
  }
  return (await res.json()) as T;
}

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function discoverProtectedResource(resourceBaseUrl: string): Promise<ProtectedResourceMeta> {
  const base = resourceBaseUrl.replace(/\/+$/, '');
  return cached(
    `pr:${base}`,
    () => fetchJson<ProtectedResourceMeta>(`${base}/.well-known/oauth-protected-resource`),
  );
}

export function discoverAuthServer(authorizationServerUrl: string): Promise<AuthServerMeta> {
  const base = authorizationServerUrl.replace(/\/+$/, '');
  return cached(
    `as:${base}`,
    () =>
      fetchJson<AuthServerMeta>(
        `${base}/.well-known/oauth-authorization-server`,
      ).catch(() => fetchJson<AuthServerMeta>(`${base}/.well-known/openid-configuration`)),
  );
}

export const clearDiscoveryCache = (): void => cache.clear();
