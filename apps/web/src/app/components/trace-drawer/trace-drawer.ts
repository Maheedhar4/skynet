import { Component, inject } from '@angular/core';
import { TraceSpanRecord, TraceSummary } from '../../models';
import { TracesService } from '../../services/traces.service';

/**
 * F2 in-app trace viewer: a collapsible right-side drawer. Lists recent
 * traces for the session newest-first; expanding one reveals the waterfall —
 * span name, duration bar (positioned by start offset), status color and the
 * metadata attributes. Zero external infrastructure required; with
 * OTEL_EXPORTER_OTLP_ENDPOINT set the same traces land in Jaeger/Tempo too.
 */
@Component({
  selector: 'sk-trace-drawer',
  imports: [],
  templateUrl: './trace-drawer.html',
  styleUrl: './trace-drawer.css',
})
export class TraceDrawer {
  readonly ts = inject(TracesService);

  statusColor(status: TraceSpanRecord['status']): string {
    return status === 'error' ? 'var(--red)' : 'var(--green)';
  }

  spanCount(t: TraceSummary): number {
    return t.spans.length;
  }

  /** Depth in the parent→child tree (bounded for deep chains). */
  depth(spans: TraceSpanRecord[], s: TraceSpanRecord): number {
    let depth = 0;
    let cur = s;
    while (cur.parentSpanId) {
      const parent = spans.find((x) => x.spanId === cur.parentSpanId);
      if (!parent) break;
      cur = parent;
      depth++;
      if (depth >= 8) break;
    }
    return depth;
  }

  /** % of the trace start where this span begins (waterfall left edge). */
  offset(spans: TraceSpanRecord[], t: TraceSummary, s: TraceSpanRecord): number {
    const start = Math.min(...spans.map((x) => x.startedAt));
    const total = Math.max(t.durationMs, 1);
    return Math.max(0, Math.min(100, ((s.startedAt - start) / total) * 100));
  }

  /** % width of the span's bar relative to the trace total. */
  width(spans: TraceSpanRecord[], t: TraceSummary, s: TraceSpanRecord): number {
    const total = Math.max(t.durationMs, 1);
    return Math.max(1.5, Math.min(100, (s.durationMs / total) * 100));
  }

  clock(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  fmtMs(v: number): string {
    if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`;
    if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
    return `${Math.round(v)}ms`;
  }

  /** Attribute list, minus skynet's own session key (it titles the trace). */
  attrs(s: TraceSpanRecord): string[] {
    return Object.entries(s.attributes ?? {})
      .filter(([k]) => k !== 'skynet.session')
      .map(([k, v]) => `${k}=${String(v)}`);
  }

  rootAttrs(t: TraceSummary): string {
    const root = t.spans.find((x) => x.parentSpanId === null);
    if (!root) return '';
    const out = Object.entries(root.attributes)
      .filter(([k]) => k !== 'skynet.session')
      .map(([k, v]) => `${k}=${String(v)}`);
    if (root.statusMessage) out.push(root.statusMessage);
    return out.join(' · ');
  }
}
