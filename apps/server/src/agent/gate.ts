import { config } from '../config.js';

/**
 * Order-confirmation gate policy.
 *
 * Search / cart view / order history run directly (plan §3). Tools whose names
 * indicate ORDER PLACEMENT or CHECKOUT are gated: the backend pauses the agent
 * and the tool fires only after the user confirms in chat. This is the
 * non-negotiable v1 safety net because Zepto MCP orders are real orders.
 */

const DOC_NAMES = /(?:history|list|search|view|get|find|track|status|catalog|lookup)/i;

/**
 * Default heuristic when SKYNET_CONFIRM_TOOL_RE is not set: treat verbs used
 * for placing/submitting/paying orders as gated; treat read-only names as open
 * even when they mention orders ("get_order_history" stays ungated).
 */
const DEFAULT_ORDER_VERBS = /^(place|create|submit|finalize|make|complete|confirm|checkout|pay|buy|purchase|book|schedule|process)([_\-]|$)/i;

export function isGatedToolName(name: string, connectorRe?: RegExp | null): boolean {
  if (config.ungated) return false;
  // The registry already built `gateRe` from SKYNET_CONFIRM_TOOL_RE when set.
  if (connectorRe) return connectorRe.test(name);
  if (DOC_NAMES.test(name)) return false;
  if (/checkout/i.test(name)) return true;
  return DEFAULT_ORDER_VERBS.test(name);
}

/** Best-effort money hint out of tool args (totals/amounts), for the card. */
export function amountHint(args: Record<string, unknown>): string | undefined {
  const keys = ['total', 'amount', 'price', 'grand_total', 'cart_total', 'order_total', 'payable'];
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) return toRupees(v);
    if (typeof v === 'string' && /^\s*(?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d+)?\s*$/i.test(v)) {
      return v.trim().startsWith('₹') ? v.trim() : `₹${v.trim()}`;
    }
  }
  // Deep-search for a total-like number as a fallback.
  const stack: unknown[] = [args];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) stack.push(...cur);
    else if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
        if (typeof v === 'number' && /total|amount|price/i.test(k)) return toRupees(v);
        else if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return undefined;
}

function toRupees(n: number): string {
  const fixed = Number.isInteger(n) ? n.toString() : n.toFixed(2);
  return `₹${fixed}`;
}

export function previewArgs(args: Record<string, unknown>, max = 140): string {
  let s = '';
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function gateUpdatedNote(): string {
  return config.ungated
    ? '⚠️ Order-confirmation gate is DISABLED (SKYNET_UNGATED=1) — tools execute without approval.'
    : '';
}
