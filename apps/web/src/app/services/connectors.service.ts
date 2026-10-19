import { Injectable, inject, signal, computed } from '@angular/core';
import { ConnectorDto, ConnectorStatus, WireEvent } from '../models';

@Injectable({ providedIn: 'root' })
export class ConnectorsService {
  private readonly api = fetch;

  readonly connectors = signal<ConnectorDto[]>([]);
  readonly sheetOpen = signal(false);
  readonly toast = signal<string | null>(null);
  readonly refreshing = signal(false);

  /** The connector whose paste fallback dialog is open. */
  readonly pasteTarget = signal<ConnectorDto | null>(null);

  readonly firstStatus = computed<ConnectorStatus | null>(() => {
    const all = this.connectors();
    return all.length ? all[0].status : null;
  });

  async load(): Promise<ConnectorDto[]> {
    try {
      const res = await fetch('/api/connectors');
      if (!res.ok) return this.connectors();
      const dtos = (await res.json()) as ConnectorDto[];
      this.connectors.set(dtos);
      return dtos;
    } catch {
      return this.connectors();
    }
  }

  startPolling(): void {
    void this.load();
  }

  async connect(id: string): Promise<void> {
    this.toast.set('Opening Zepto login (Indian mobile number + OTP)…');
    try {
      const res = await fetch(`/api/connectors/${id}/connect`, { method: 'POST' });
      const body = (await res.json()) as { authorizeUrl?: string; error?: string };
      if (!res.ok || !body.authorizeUrl) {
        this.toast.set(`Connect failed: ${body.error ?? res.status}`);
        this.toastDebouncedClear();
        return;
      }
      // The browser leaves skynet here; Zepto's OTP page takes over and
      // redirects back to our /callback (on port 80) → regains the UI.
      window.location.href = body.authorizeUrl;
    } catch (e) {
      this.toast.set(`Connect failed: ${e instanceof Error ? e.message : String(e)}`);
      this.toastDebouncedClear();
    }
  }

  async disconnect(id: string): Promise<void> {
    this.toast.set('Disconnecting (revoking tokens at Zepto)…');
    try {
      await fetch(`/api/connectors/${id}/disconnect`, { method: 'POST' });
      await this.load();
      this.toast.set('Disconnected — access revoked and tokens cleared 🟢');
    } catch (e) {
      this.toast.set(`Disconnect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.toastDebouncedClear();
  }

  openPasteFallback(id: string): void {
    const c = this.connectors().find((x) => x.id === id);
    this.pasteTarget.set(c ?? null);
  }

  closePasteFallback(): void {
    this.pasteTarget.set(null);
  }

  async pasteCallback(id: string, url: string): Promise<void> {
    try {
      const res = await fetch(`/api/connectors/${id}/paste-callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        this.closePasteFallback();
        await this.load();
        this.toast.set('Tokens stored — MCP handshake done 🟢');
      } else {
        this.toast.set(`Paste-callback failed: ${body.error ?? res.status}`);
      }
    } catch (e) {
      this.toast.set(`Paste-callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.toastDebouncedClear();
  }

  /** After the OAuth redirect lands back with ?connect=ok|error … */
  async handleConnectReturn(): Promise<void> {
    const sp = new URLSearchParams(window.location.search);
    const connect = sp.get('connect');
    if (!connect) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (connect === 'ok') {
      const who = sp.get('connector') ?? 'connector';
      await this.load();
      this.toast.set(`${who} connected — MCP handshake + tools/list OK 🟢`);
      this.toastDebouncedClear(6000);
    } else {
      const reason = sp.get('reason') ?? 'unknown error';
      await this.load();
      this.toast.set(`Connect failed: ${reason}`);
      this.toastDebouncedClear(9000);
    }
  }

  private toastTimer?: ReturnType<typeof setTimeout>;
  private toastDebouncedClear(ms = 5000): void {
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), ms);
  }
}
