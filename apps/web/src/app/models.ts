/** Wire-shape types mirroring apps/server/src/types.ts. */

export type ConnectorState = 'disconnected' | 'awaiting_login' | 'connecting' | 'connected' | 'error';

export interface ConnectorStatus {
  state: ConnectorState;
  error?: string;
  toolsCount?: number;
  lastCheckedAt?: string;
  connectedAt?: string;
}

export interface ConnectorDto {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  brandColor: string;
  mcpUrl: string;
  status: ConnectorStatus;
  redirectUri: string;
  pasteFallback: boolean;
  callout: string;
}

export interface ToolChip {
  id: string;
  name: string;
  title: string;
  status: 'running' | 'done' | 'error' | 'paused';
  detail?: string;
  gated?: boolean;
}

export interface ConfirmationCard {
  id: string;
  tool: string;
  argsPreview: string;
  summary: string;
  resolved?: 'confirmed' | 'cancelled';
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatTurn {
  id: string;
  role: ChatRole;
  text: string;
  at: string;
  chips?: ToolChip[];
  confirmation?: ConfirmationCard;
}

export interface SessionDto {
  sessionId: string;
  engine: string;
  turns: ChatTurn[];
  pendingGate: { id: string; tool: string; createdAt: string } | null;
  status: Record<string, ConnectorStatus>;
}

export type WireEvent =
  | { type: 'chat_start'; sessionId: string }
  | { type: 'user'; turn: ChatTurn }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'chip'; turnId: string; chip: ToolChip }
  | { type: 'assistant'; turn: ChatTurn }
  | { type: 'confirmation'; turnId: string; card: ConfirmationCard }
  | { type: 'note'; turnId: string; text: string }
  | { type: 'error'; message: string; hint?: string }
  | { type: 'connectors'; status: Record<string, ConnectorStatus> }
  | { type: 'done' };

// ── F1 clear history ─────────────────────────────────────────────────────────
export type ClearHistoryResult = SessionDto & { ok: boolean; deleted: number };

// ── F2 session tracing ───────────────────────────────────────────────────────
export interface TraceSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  statusMessage?: string;
  sessionId?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceSummary {
  traceId: string;
  name: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  sessionId?: string;
  spans: TraceSpanRecord[];
}

export interface OtelHealth {
  enabled: boolean;
  otlp: boolean;
  otlpEndpoint: string;
  service: string;
  content: boolean;
  spans: number;
}

export interface TracesDto {
  ok: boolean;
  otel: OtelHealth;
  session: string | null;
  traces: TraceSummary[];
}

export function dotColor(state: ConnectorState | undefined): string {
  switch (state) {
    case 'connected':
      return 'var(--green)';
    case 'connecting':
    case 'awaiting_login':
      return 'var(--amber)';
    case 'error':
      return 'var(--red)';
    default:
      return 'var(--muted-bg)';
  }
}

export function statusLabel(s: ConnectorStatus | undefined): string {
  if (!s) return 'not loaded';
  switch (s.state) {
    case 'connected':
      return `connected · ${s.toolsCount ?? '?'} tools`;
    case 'connecting':
      return 'connecting…';
    case 'awaiting_login':
      return 'awaiting login (mobile + OTP)…';
    case 'error':
      return `error — ${s.error ?? 'unknown'}`;
    default:
      return 'disconnected';
  }
}
