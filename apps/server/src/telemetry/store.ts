/**
 * In-memory span store (F2) — a custom SpanExporter that appends every
 * finished span into a bounded ring buffer as plain records. This feeds the
 * in-app trace viewer (GET /api/traces) — zero external infrastructure.
 *
 * Memory-only by design: traces reset on server restart (fine for a local
 * dev tool). A JSONL sink can be added later as a non-breaking follow-up.
 *
 * Content policy stays here too: only span names, ids, timings, statuses and
 * (sanitized) attributes are kept. ReadableSpan attributes we did not set
 * ourselves (e.g. ADK's own LLM spans) pass through as-is, which is fine —
 * instrumentation never writes prompt text unless SKYNET_OTEL_CONTENT=1 was
 * honored upstream; tokens/secrets are never traced (redact() rule).
 */
import { SpanStatusCode } from '@opentelemetry/api';
import type { HrTime } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';

/** Ring-buffer ceiling — a long Zepto session fits comfortably. */
const MAX_SPANS = 2000;

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** epoch ms */
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  statusMessage?: string;
  /** session id when known (skynet.session attribute) — viewer groups by it */
  sessionId?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceSummary {
  traceId: string;
  name: string; // root span name
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  sessionId?: string;
  spans: SpanRecord[]; // flattened, chronological
}

export interface TraceQuery {
  /** only traces whose root carries this session id */
  session?: string;
  /** max traces returned (newest first) */
  limit?: number;
}

/** Attribute keys we reserve for skynet's own span fields. */
export const ATTR = {
  session: 'skynet.session',
  engine: 'skynet.engine',
  model: 'skynet.model',
  mode: 'skynet.mode',
  gateApproved: 'skynet.gate.approved',
  gateTool: 'skynet.gate.tool',
  round: 'skynet.round',
  connector: 'skynet.connector',
  tool: 'skynet.tool',
  toolCount: 'skynet.tools.count',
  connectorDown: 'skynet.tools.connectorDown',
  ok: 'skynet.ok',
  durationMs: 'skynet.duration_ms',
} as const;

function attrValue(v: unknown): string | number | boolean | undefined {
  switch (typeof v) {
    case 'string':
    case 'number':
    case 'boolean':
      return v;
    case 'object':
      if (Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) {
        return v.join(',');
      }
      return undefined;
    default:
      return undefined;
  }
}

/** HrTime [seconds, nanoseconds] → epoch ms (as float ms). */
function hrToMs(t: HrTime): number {
  return t[0] * 1000 + t[1] / 1e6;
}

export class SpanStore implements SpanExporter {
  private readonly buffer: SpanRecord[] = [];

  export(
    spans: readonly ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    for (const s of spans) this.append(s);
    resultCallback({ code: 0 });
  }

  append(span: ReadableSpan): void {
    const status = span.status.code;
    const attributes: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(span.attributes)) {
      const val = attrValue(v);
      if (val !== undefined) attributes[k] = val;
    }
    this.buffer.push({
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId ?? null,
      name: span.name,
      startedAt: hrToMs(span.startTime),
      durationMs: hrToMs(span.duration),
      status: status === SpanStatusCode.ERROR ? 'error' : 'ok',
      statusMessage: span.status.message ?? undefined,
      sessionId: typeof attributes[ATTR.session] === 'string' ? String(attributes[ATTR.session]) : undefined,
      attributes,
    });
    const over = this.buffer.length - MAX_SPANS;
    if (over > 0) this.buffer.splice(0, over); // drop the OLDEST spans
  }

  /**
   * Latest traces, grouped by traceId, newest first, spans chronological.
   *
   * The session filter matches the trace ROOT's `skynet.session` attribute
   * (the http span carries it) — per-span filtering would wrongly exclude
   * nested spans that correctly belong to the same trace but don't repeat the
   * attribute.
   */
  queryTraces(q: TraceQuery = {}): TraceSummary[] {
    const byTrace = new Map<string, SpanRecord[]>();
    for (const s of this.buffer) {
      const list = byTrace.get(s.traceId);
      if (list) list.push(s);
      else byTrace.set(s.traceId, [s]);
    }
    const traces: TraceSummary[] = [];
    for (const [traceId, spans] of byTrace) {
      spans.sort((a, b) => a.startedAt - b.startedAt);
      const root = spans.find((s) => s.parentSpanId === null) ?? spans[0];
      const sessionId = root.sessionId ?? spans.find((s) => s.sessionId)?.sessionId;
      if (q.session && sessionId !== q.session) continue;
      traces.push({
        traceId,
        name: root.name,
        startedAt: spans[0].startedAt,
        durationMs: Math.max(...spans.map((s) => s.durationMs), root.startedAt + root.durationMs - spans[0].startedAt),
        status: spans.some((s) => s.status === 'error') ? 'error' : 'ok',
        sessionId,
        spans,
      });
    }
    traces.sort((a, b) => b.startedAt - a.startedAt || (b.startedAt + b.durationMs) - (a.startedAt + a.durationMs));
    return traces.slice(0, Math.max(1, Math.min(q.limit ?? 50, 200)));
  }

  size(): number {
    return this.buffer.length;
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
