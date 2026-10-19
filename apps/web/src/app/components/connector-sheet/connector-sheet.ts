import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConnectorsService } from '../../services/connectors.service';
import { ConnectorDto, dotColor, statusLabel } from '../../models';

@Component({
  selector: 'sk-connector-sheet',
  imports: [FormsModule],
  templateUrl: './connector-sheet.html',
  styleUrl: './connector-sheet.css',
})
export class ConnectorSheet {
  readonly cs = inject(ConnectorsService);

  readonly pasteUrl = signal('');
  readonly pasteId = signal<string | null>(null);

  dotFor(c: ConnectorDto): string {
    return dotColor(c.status.state);
  }

  statusLine(c: ConnectorDto): string {
    return statusLabel(c.status);
  }

  lastChecked(c: ConnectorDto): string {
    const at = c.status.lastCheckedAt ?? c.status.connectedAt;
    if (!at) return 'not checked yet';
    const d = new Date(at);
    const diff = Math.round((Date.now() - d.getTime()) / 1000);
    if (diff < 90) return `checked ${diff}s ago`;
    return `checked ${Math.round(diff / 60)}m ago`;
  }

  openConnect(c: ConnectorDto): void {
    void this.cs.connect(c.id);
  }

  disconnect(c: ConnectorDto): void {
    void this.cs.disconnect(c.id);
  }

  startPaste(c: ConnectorDto): void {
    this.pasteId.set(c.id);
    this.pasteUrl.set('');
  }

  cancelPaste(): void {
    this.pasteId.set(null);
  }

  submitPaste(c: ConnectorDto): void {
    const url = this.pasteUrl().trim();
    if (!url) return;
    void this.cs.pasteCallback(c.id, url);
    this.pasteId.set(null);
  }

  close(): void {
    this.pasteId.set(null);
    this.cs.sheetOpen.set(false);
  }
}
