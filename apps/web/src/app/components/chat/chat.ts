import { Component, ElementRef, effect, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChatApiService } from '../../services/chat.service';
import { ConnectorsService } from '../../services/connectors.service';
import { ChatTurn, ToolChip } from '../../models';

@Component({
  selector: 'sk-chat',
  imports: [FormsModule],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
})
export class Chat {
  readonly chat = inject(ChatApiService);
  readonly connectors = inject(ConnectorsService);

  readonly draft = signal('');
  readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');

  constructor() {
    afterNextRender(() => this.scrollDown());
    effect(() => {
      this.chat.turns().length;
      this.chat.streaming();
      setTimeout(() => this.scrollDown(), 60);
    });
  }

  send(): void {
    const text = this.draft().trim();
    if (!text) return;
    this.draft.set('');
    setTimeout(() => this.scrollDown(), 30);
    void this.chat.send(text);
    setTimeout(() => this.scrollDown(), 120);
  }

  keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  chipIcon(chip: ToolChip): string {
    switch (chip.status) {
      case 'running':
        return '◌';
      case 'done':
        return '✓';
      case 'error':
        return '✗';
      case 'paused':
        return '⏸';
    }
  }

  chipClass(chip: ToolChip): string {
    return `chip chip-${chip.status}`;
  }

  autosize(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }

  /** Minimal, safe markdown-ish rendering: escape, then **bold** / `code`. */
  fmt(text: string): string {
    const esc = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return esc
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  scrollDown(): void {
    const el = this.scroller().nativeElement;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }
}
