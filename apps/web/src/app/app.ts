import { Component, afterNextRender, inject } from '@angular/core';
import { Chat } from './components/chat/chat';
import { ConnectorSheet } from './components/connector-sheet/connector-sheet';
import { ConnectorsService } from './services/connectors.service';
import { ChatApiService } from './services/chat.service';
import { dotColor } from './models';

@Component({
  selector: 'app-root',
  imports: [Chat, ConnectorSheet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly cs = inject(ConnectorsService);
  readonly chat = inject(ChatApiService);

  constructor() {
    afterNextRender(() => {
      void this.cs.load();
      void this.chat.loadSession();
      void this.cs.handleConnectReturn();
      window.setInterval(() => void this.cs.load(), 15_000);
    });
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
