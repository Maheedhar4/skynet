import { Injectable, signal, computed } from '@angular/core';
import { OtelHealth, TraceSummary, TracesDto } from '../models';

/**
 * F2 trace drawer state + the /api/traces client: recent traces for the
 * current browser session (server falls back to the cookie sid), newest
 * first, spans flattened to waterfall rows. Manual refresh + an optional 5s
 * poll while the drawer is open.
 */
@Injectable({ providedIn: 'root' })
export class TracesService {
  readonly open = signal(false);
  readonly loading = signal(false);
  readonly traces = signal<TraceSummary[]>([]);
  readonly otel = signal<OtelHealth | null>(null);
  /** traceIds expanded in the drawer */
  readonly expanded = signal<Set<string>>(new Set());
  readonly lastFetch = signal<number | null>(null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sid: string | null = null;

  readonly count = computed(() => this.traces().length);
  readonly enabled = computed(() => this.otel()?.enabled ?? false);

  /** The session-scope the drawer views (set by the App on open/turns). */
  setSession(sid: string | null): void {
    this.sid = sid;
  }

  toggle(): void {
    this.open() ? this.close() : this.openDrawer();
  }

  async openDrawer(): Promise<void> {
    this.open.set(true);
    await this.refresh();
    this.startPoll();
  }

  close(): void {
    this.open.set(false);
    this.stopPoll();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const params = new URLSearchParams();
      if (this.sid) params.set('session', this.sid);
      params.set('limit', '50');
      const res = await fetch(`/api/traces?${params.toString()}`);
      if (!res.ok) return;
      const body = (await res.json()) as TracesDto;
      this.traces.set(body.traces ?? []);
      this.otel.set(body.otel ?? null);
      this.lastFetch.set(Date.now());
    } catch {
      // drawer shows the stale list; no dead end
    } finally {
      this.loading.set(false);
    }
  }

  toggleTrace(traceId: string): void {
    this.expanded.update((all) => {
      const copy = new Set(all);
      copy.has(traceId) ? copy.delete(traceId) : copy.add(traceId);
      return copy;
    });
  }

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.open() && !this.loading()) void this.refresh();
    }, 5000);
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
