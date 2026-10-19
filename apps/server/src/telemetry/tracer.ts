/**
 * OpenTelemetry setup (F2 — Session tracing). One singleton NodeTracerProvider,
 * registered ONCE and guarded: @google/adk ships its own OTel wiring and would
 * call `trace.setGlobalTracerProvider` on boot — the API silently ignores the
 * second registration, so our provider (initialized before any ADK import in
 * src/index.ts) wins the global slot and ADK's internal LLM spans flow into the
 * SAME capture rather than conflicting.
 *
 * Two processors:
 *   - SimpleSpanProcessor(SpanStore)  → the in-app viewer (memory-only ring buffer)
 *   - BatchSpanProcessor(OTLPTraceExporter) → only when OTEL_EXPORTER_OTLP_ENDPOINT
 *     is set (Jaeger all-in-one :4318, Grafana Tempo, …). The deprecated Jaeger
 *     exporter is skipped — OTLP is the single standard export path.
 *
 * NodeTracerProvider's default context manager (AsyncLocalStorage) lets spans
 * nest correctly across the streaming async-generator chain with zero threading
 * effort: the chat pipe runs inside the /api/chat request lifecycle.
 *
 * CONTENT POLICY — metadata only by default: tool names, argument previews,
 * durations, statuses, model, round numbers, gate decisions. Prompt/response
 * text stays out of traces unless SKYNET_OTEL_CONTENT=1 opts in. Tokens and
 * secrets are never traced (logger.redact() stays the rule).
 */
import { context, Span, SpanStatusCode, trace, Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, SimpleSpanProcessor, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { config } from '../config.js';
import { log } from '../logger.js';
import { SpanStore, TraceQuery, TraceSummary } from './store.js';

const VERSION = '0.1.0';

let provider: NodeTracerProvider | null = null;
let store: SpanStore | null = null;
let tracer: Tracer | null = null;
let otlpActive = false;

export type SpanAttrs = Record<string, string | number | boolean>;

/**
 * Initialize the tracing pipeline exactly once, BEFORE connector boot (so ADK's
 * later wiring merges into this capture). No-op when SKYNET_OTEL=off.
 */
export function initTracing(): void {
  if (provider || tracer) return; // registered already
  if (!config.otel) {
    log.info('telemetry', 'tracing off (SKYNET_OTEL=off) — chat unaffected, viewer/export inactive');
    return;
  }
  try {
    store = new SpanStore();
    // SDK 2.x: span processors go through the constructor config.
    const spanProcessors: SpanProcessor[] = [new SimpleSpanProcessor(store)]; // every span → in-app store immediately
    if (config.otelEndpoint) {
      try {
        // Jaeger-style all-in-one servers accept both bare root and /v1/traces.
        const url = config.otelEndpoint.replace(/\/+$/, '') + '/v1/traces';
        spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url })));
        otlpActive = true;
      } catch (e) {
        log.warn('telemetry', 'OTLP exporter failed to build — in-app store only:', e);
      }
    }
    provider = new NodeTracerProvider({
      resource: defaultResource().merge(
        resourceFromAttributes({
          [ATTR_SERVICE_NAME]: config.otelServiceName,
          [ATTR_SERVICE_VERSION]: VERSION,
          'skynet.engine': config.engine,
          'skynet.model': config.geminiModel,
        }),
      ),
      spanProcessors,
    });
    provider.register(); // guarded globally: a second setGlobalTracerProvider is a silent no-op
    tracer = trace.getTracer('skynet');
    log.info(
      'telemetry',
      otlpActive
        ? `tracing on — OTLP export → ${config.otelEndpoint} (service.name=${config.otelServiceName})`
        : 'tracing on — in-app store only (set OTEL_EXPORTER_OTLP_ENDPOINT to mirror traces into Jaeger/Grafana)',
    );
  } catch (e) {
    log.warn('telemetry', 'tracing disabled — provider failed to initialize:', e);
    provider = null;
    store = null;
    tracer = null;
  }
}

/** The store behind GET /api/traces (null when tracing is off). */
export function spanStore(): SpanStore | null {
  return store;
}

/** Aggregate for /api/health: otel: { … }. */
export function otelHealth(): {
  enabled: boolean;
  otlp: boolean;
  otlpEndpoint: string;
  service: string;
  content: boolean;
  spans: number;
} {
  return {
    enabled: Boolean(tracer),
    otlp: otlpActive,
    otlpEndpoint: otlpActive ? config.otelEndpoint : '',
    service: config.otelServiceName,
    content: config.otelContent,
    spans: store?.size() ?? 0,
  };
}

export function queryTraces(q: TraceQuery): TraceSummary[] {
  return store?.queryTraces(q) ?? [];
}

// ── span helpers (safe no-ops when tracing is off via the noop global provider)

/** Start a (lazy-activatable) span. `parent` makes the nesting deterministic. */
export function startSpan(name: string, attrs: SpanAttrs = {}, parent?: Span): Span {
  if (!tracer) {
    tracer = trace.getTracer('skynet'); // noop tracer when disabled
  }
  const parentCtx = parent ? trace.setSpan(context.active(), parent) : undefined;
  return tracer.startSpan(name, { attributes: attrs }, parentCtx);
}

/** Run `fn` (async ok) with `span` as the active span — context propagates through awaits. */
export function activate<R>(span: Span, fn: () => R): R {
  return context.with(trace.setSpan(context.active(), span), fn);
}

/** Mark a span failed with the error; call before end(). */
export function recordError(span: Span, e: unknown): void {
  try {
    if (e instanceof Error) span.recordException(e);
    else span.recordException({ name: 'Error', message: String(e) });
    span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
  } catch {
    // telemetry must never break the turn
  }
}

/**
 * Optional prompt/response text (SKYNET_OTEL_CONTENT=1 only), capped and
 * newline-flattened. Returns undefined for the default metadata-only policy.
 */
export function optionalContent(value: unknown, max = 300): string | undefined {
  if (!config.otelContent) return undefined;
  let s = typeof value === 'string' ? value : '';
  try {
    s ||= JSON.stringify(value) ?? '';
  } catch {
    s = String(value);
  }
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat ? (flat.length > max ? `${flat.slice(0, max - 1)}…` : flat) : undefined;
}

/** Convenience re-export for callers that type against Span. */
export type { Span };