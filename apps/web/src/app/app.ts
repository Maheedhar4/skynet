import { Component, afterNextRender, effect, inject } from '@angular/core';
import { Chat } from './components/chat/chat';
import { ConnectorSheet } from './components/connector-sheet/connector-sheet';
import { TraceDrawer } from './components/trace-drawer/trace-drawer';
import { ConnectorsService } from './services/connectors.service';
import { ChatApiService } from './services/chat.service';
import { TracesService } from './services/traces.service';
import { dotColor } from './models';

@Component({
  selector: 'app-root',
  imports: [Chat, ConnectorSheet, TraceDrawer],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly cs = inject(ConnectorsService);
  readonly chat = inject(ChatApiService);
  readonly traces = inject(TracesService);

  constructor() {
    // the trace drawer always views the current chat session's traces
    effect(() => this.traces.setSession(this.chat.sessionId()));

    afterNextRender(() => {
      void this.cs.load();
      void this.chat.loadSession();
      void this.cs.handleConnectReturn();
      window.setInterval(() => void this.cs.load(), 15_000);
    });
  }

  /** F1 — start a brand-new session (old transcript file stays on disk). */
  newChat(): void {
    void this.chat.newSession();
  }

  /** F1 — wipe every transcript + the index. Irreversible → confirm() gate. */
  confirmClear(): void {
    if (this.chat.streaming() || this.chat.clearing()) return;
    if (!window.confirm('Clear chat history? This deletes EVERY stored transcript (all sessions) permanently — connectors stay logged in.')) {
      return;
    }
    void this.chat.clearHistory();
  }

  toggleTraces(): void {
    this.traces.toggle();
  }

  dotFor(id: string): string {
    const c = this.cs.connectors().find((x) => x.id === id);
    return dotColor(c?.status.state);
  }

  stateFor(id: string): string {
    const c = this.cs.connectors().find((x) => x.id === id);
    return c?.status.state ?? 'unknown';
  }
}
