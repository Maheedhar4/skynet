import { config } from '../config.js';

/**
 * Config-driven connector registry. Zepto ships in v1; adding Blinkit /
 * Instamart later is a matter of appending an entry — they are remote hosted
 * MCP servers too.
 */
export interface ConnectorDef {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  brandColor: string;
  /** MCP streamable-HTTP endpoint (remote hosted server). */
  mcpUrl: string;
  /** RFC 8707 resource indicator (the protected resource). */
  resource: string;
  /** OAuth scopes to request. */
  scopes: string[];
  /** The redirect URI we will register with the AS. Zepto whitelists only
   * `http://localhost` and `http://localhost/callback` — exact match, NO PORT
   * (verified live 2026-10). Default binds the callback server on port 80. */
  redirectUri: string;
  /** Tool names that match this need the order-confirmation gate. Empty regex → none. */
  gateRe?: RegExp;
  /** Whether to request checkout/order scopes at all in v1 (kept for parity with plan). */
  realMoneyWarning: string;
}

function envRegex(): RegExp | undefined {
  const raw = config.confirmToolRe.trim();
  if (!raw) return undefined;
  try {
    return new RegExp(raw, 'i');
  } catch {
    return undefined;
  }
}

const ZEPTO_BASE = 'https://mcp.zepto.co.in';
const ZEPTO_AUTH = 'https://auth.zepto.co.in';

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'zepto',
    name: 'Zepto',
    emoji: '🛒',
    tagline: 'Quick-commerce · groceries & essentials in ~10 min',
    brandColor: '#d97757',
    mcpUrl: `${ZEPTO_BASE}/mcp`,
    resource: ZEPTO_BASE,
    redirectUri: process.env.SKYNET_ZEPTO_REDIRECT_URI?.trim() || 'http://localhost/callback',
    scopes: [
      'tools:read',
      'tools:write',
      'dev.ucp.shopping.cart:manage',
      'dev.ucp.shopping.catalog.search:read',
      'dev.ucp.shopping.catalog.lookup:read',
      'dev.ucp.common.location.search:read',
      'dev.ucp.common.location.lookup:read',
      'dev.ucp.shopping.order:manage',
      'dev.ucp.shopping.checkout:manage',
    ],
    gateRe: envRegex(),
    realMoneyWarning:
      'Orders placed through the Zepto MCP are real Zepto orders — real money, real delivery.',
  },
];

export function connectorById(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
