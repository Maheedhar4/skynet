/**
 * Wire-shape types shared by all server modules. The frontend mirrors these in
 * apps/web/src/app/models.ts.
 */

// ── Connector status ─────────────────────────────────────────────────────────
export type ConnectorState =
  | 'disconnected'   // no tokens (red)
  | 'awaiting_login' // OAuth redirect open, waiting for the Zepto OTP page (amber)
  | 'connecting'     // OAuth code exchanged, doing MCP handshake (amber)
  | 'connected'      // handshake + tools/list OK (green)
  | 'error';         // had tokens/handshake but something broke (red, w/ reason)

export interface ConnectorStatus {
  state: ConnectorState;
  error?: string;
  toolsCount?: number;
  lastCheckedAt?: string;
  connectedAt?: string;
}

// ── Chat ─────────────────────────────────────────────────────────────────────
export interface ToolChip {
  id: string;
  name: string;
  title: string; // e.g. 🔍 search_products {"query":"amul milk"}
  status: 'running' | 'done' | 'error' | 'paused';
  detail?: string; // short result summary
  gated?: boolean;
}

export interface ConfirmationCard {
  id: string;
  tool: string;
  argsPreview: string;
  summary: string;       // "Zepto wants to place this order (₹542)"
  resolved?: 'confirmed' | 'cancelled';
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatTurn {
  id: string;
  role: ChatRole;
  text: string;
  at: string;
  chips?: ToolChip[];          // inline tool-activity chips
  confirmation?: ConfirmationCard; // attached confirmation card
}

export type EngineId = 'direct' | 'adk';

export interface ChatSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  engine: EngineId;
  turns: ChatTurn[];
  /** genai chat history for the direct engine (restored on boot). */
  directHistory?: unknown[];
  /** ADK pending user-input request, when the ADK engine is paused. */
  adkPending?: { interruptId: string; functionCallName: string; kind: string; message?: string; toolName?: string };
  /** Unresolved confirmation gate (paused turn awaiting YES/no). */
  pendingGate?: PendingGate | null;
  /** Last rupee-style number observed in tool results (₹ card hint). */
  money?: string;
}

export interface PendingGate {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: string;
}

// ── Streaming wire events (newline-delimited JSON from POST /api/chat) ───────
export type WireEvent =
  | { type: 'chat_start'; sessionId: string }
  | { type: 'user'; turn: ChatTurn }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'chip'; turnId: string; chip: ToolChip }
  | { type: 'assistant'; turn: ChatTurn }      // final turn snapshot incl chips
  | { type: 'confirmation'; turnId: string; card: ConfirmationCard }
  | { type: 'note'; turnId: string; text: string } // system-ish inline note
  | { type: 'error'; message: string; hint?: string }
  | { type: 'connectors', status: Record<string, ConnectorStatus> }
  | { type: 'done' };

// ── Tools ────────────────────────────────────────────────────────────────────
export interface ToolDecl {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>; // MCP JSON schema
  gated?: boolean;
}

/** Where tools + tool execution come from (real MCP or a fake for smoke tests). */
export interface ToolSource {
  tools(): Promise<ToolDecl[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
