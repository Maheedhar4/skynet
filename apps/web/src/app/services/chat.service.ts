import { Injectable, signal, computed } from '@angular/core';
import {
  ChatTurn,
  ConfirmationCard,
  SessionDto,
  ToolChip,
  WireEvent,
} from '../models';

/**
 * Streaming chat client: POST /api/chat consumed as newline-delimited JSON
 * over a ReadableStream (the plan's "SSE / ReadableStream" channel).
 */
@Injectable({ providedIn: 'root' })
export class ChatApiService {
  readonly turns = signal<ChatTurn[]>([]);
  readonly streaming = signal(false);
  readonly sessionError = signal<string | null>(null);
  readonly pendingGateId = signal<string | null>(null);
  readonly sessionId = signal<string | null>(null);

  /** Coalesced delta flushing keeps re-renders cheap on fast streams. */
  private deltas = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  readonly lastAssistant = computed<ChatTurn | null>(() => {
    const all = this.turns();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].role === 'assistant') return all[i];
    }
    return null;
  });

  async loadSession(): Promise<void> {
    try {
      const res = await fetch('/api/session');
      const s = (await res.json()) as SessionDto;
      this.turns.set(s.turns ?? []);
      this.sessionId.set(s.sessionId);
      this.pendingGateId.set(s.pendingGate?.id ?? null);
    } catch (e) {
      this.sessionError.set(e instanceof Error ? e.message : 'failed to load chat');
    }
  }

  async newSession(): Promise<void> {
    try {
      const res = await fetch('/api/session/new', { method: 'POST' });
      const s = (await res.json()) as SessionDto;
      this.turns.set(s.turns ?? []);
      this.sessionId.set(s.sessionId);
      this.pendingGateId.set(s.pendingGate?.id ?? null);
      this.sessionError.set(null);
    } catch (e) {
      this.sessionError.set(e instanceof Error ? e.message : 'failed to start a new chat');
    }
  }

  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.streaming()) return;
    this.sessionError.set(null);
    this.streaming.set(true);

    const userTurn: ChatTurn = {
      id: `local-${Date.now()}`,
      role: 'user',
      text: message,
      at: new Date().toISOString(),
    };
    this.turns.update((all) => [...all, userTurn]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => '');
        this.sessionError.set(err || `chat request failed (${res.status})`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          this.absorb(JSON.parse(line) as WireEvent);
        }
      }
    } catch (e) {
      this.sessionError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.flushDeltas();
      this.streaming.set(false);
    }
  }

  /** YES / Cancel buttons — same chat-path consent as typing the reply. */
  answerGate(approved: boolean): void {
    void this.send(approved ? 'yes' : 'no');
  }

  private absorb(ev: WireEvent): void {
    switch (ev.type) {
      case 'chat_start':
        this.sessionId.set(ev.sessionId);
        break;
      case 'user': {
        // Server echo after our optimistic insert — de-dup by text+order.
        this.turns.update((all) => {
          const localIdx = all.findIndex((t) => t.id.startsWith('local-'));
          if (localIdx >= 0) {
            const copy = [...all];
            copy[localIdx] = { ...ev.turn, chips: copy[localIdx].chips };
            return copy;
          }
          return [...all, { ...ev.turn }];
        });
        break;
      }
      case 'delta': {
        const { turnId, text } = ev;
        const had = this.deltas.get(turnId) ?? '';
        this.deltas.set(turnId, had + text);
        this.scheduleFlush();
        break;
      }
      case 'chip': {
        this.pushChip(ev.turnId, ev.chip);
        break;
      }
      case 'confirmation': {
        this.withTurn(ev.turnId, (t) => ({
          ...t,
          confirmation: ev.card as ConfirmationCard,
          text: `${t.text}`,
        }));
        break;
      }
      case 'note': {
        this.withTurn(ev.turnId, (t) => ({ ...t, text: `${t.text}${t.text ? ' ' : ''}(${ev.text})` }));
        break;
      }
      case 'assistant': {
        this.replaceTurn(ev.turn);
        break;
      }
      case 'error': {
        this.sessionError.set(ev.message);
        break;
      }
      case 'connectors':
      case 'done':
        break;
    }
  }

  private pushChip(turnId: string, chip: ToolChip): void {
    this.withTurn(turnId, (t) => {
      const chips = [...(t.chips ?? [])];
      const at = chips.findIndex((c) => c.id === chip.id);
      if (at >= 0) chips[at] = chip;
      else chips.push(chip);
      return { ...t, chips };
    });
  }

  private withTurn(turnId: string, fn: (t: ChatTurn) => ChatTurn): void {
    this.turns.update((all) => {
      const at = all.findIndex((t) => t.id === turnId);
      if (at < 0) {
        const fresh: ChatTurn = {
          id: turnId,
          role: 'assistant',
          text: '',
          at: new Date().toISOString(),
        };
        return [...all, fn(fresh)];
      }
      const copy = [...all];
      copy[at] = fn(copy[at]);
      return copy;
    });
  }

  private replaceTurn(turn: ChatTurn): void {
    this.deltas.delete(turn.id); // the snapshot is authoritative now
    this.withTurn(turn.id, () => ({ ...turn }));
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushDeltas();
    }, 50);
  }

  private flushDeltas(): void {
    if (!this.deltas.size) return;
    const batches = [...this.deltas.entries()];
    this.deltas.clear();
    for (const [turnId, text] of batches) {
      this.withTurn(turnId, (t) => ({ ...t, text: `${t.text}${text}` }));
    }
  }
}
