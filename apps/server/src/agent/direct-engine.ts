/**
 * Direct engine — the DEFAULT chat brain (Plan §4): a hand-rolled function
 * calling loop over @google/genai chats. Streams text deltas as they come,
 * runs ungated MCP tools inline through the official MCP SDK client, and
 * PAUSES the turn the instant a gated tool (order / checkout) is requested.
 * The tool fires only after the user answers in chat; the result (or the
 * declined marker) is then injected as the matching functionResponse and the
 * model narrates the outcome.
 */
import { Content, GoogleGenAI } from '@google/genai';
import { SYSTEM_INSTRUCTION } from './instruction.js';
import { PreparedTool, toolMap } from './tools.js';
import { ChatSession, ToolSource } from '../types.js';
import { AgentStep, Engine } from './engine-types.js';
import { summarizeToolResult, serializeJson } from './summary.js';
import { createId } from '../oauth/pkce.js';
import { config } from '../config.js';
import { optionalContent, recordError, startSpan } from '../telemetry/tracer.js';
import { ATTR } from '../telemetry/store.js';

const MAX_MODEL_ROUNDS = 12;

export interface ChatLike {
  getHistory(curated?: boolean): Content[];
  sendMessageStream(params: { message: unknown; config?: unknown }): Promise<AsyncIterable<Chunk>>;
}
export interface Chunk {
  candidates?: { content?: { parts?: PartView[] } }[];
  functionCalls?: FunctionCallView[];
}
export interface FunctionCallView {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}
export interface PartView {
  text?: string;
  thought?: boolean;
  functionCall?: FunctionCallView;
  functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
}

export class DirectEngine implements Engine {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly systemInstruction: string;
  private chats = new Map<string, ChatLike>();

  constructor(opts: { ai: GoogleGenAI; model: string; systemInstruction?: string }) {
    this.ai = opts.ai;
    this.model = opts.model;
    this.systemInstruction = opts.systemInstruction ?? SYSTEM_INSTRUCTION;
  }

  // ── Engine contract ────────────────────────────────────────────────────────
  reset(sid: string, history: Content[], tools: PreparedTool[]): void {
    const chat = (this.ai as unknown as {
      chats: { create(p: { model: string; config: unknown; history: Content[] }): ChatLike };
    }).chats.create({ model: this.model, config: this.configFor(tools), history: sanitizeHistory(history) });
    this.chats.set(sid, chat);
  }

  forget(sid: string): void {
    this.chats.delete(sid);
  }

  forgetAll(): void {
    this.chats.clear();
  }

  save(sid: string, sess: ChatSession): void {
    const chat = this.chats.get(sid);
    if (!chat) return;
    try {
      const history = chat.getHistory(false) as unknown[];
      sess.directHistory =
        history.length > 120 ? (chat.getHistory(true) as unknown[]).slice(-120) : history;
    } catch {
      // best effort — persistence must never break a turn
    }
  }

  async *runTurn(o: {
    sid: string;
    session: ChatSession;
    userText: string;
    tools: PreparedTool[];
    runtime?: { def: unknown; mcp: ToolSource; snapshot(): unknown; accessToken?(): Promise<string> };
    traceParent?: import('@opentelemetry/api').Span;
  }): AsyncGenerator<AgentStep> {
    const chat = this.chatFor(o.sid, o.session, o.tools);
    const toolSource: ToolSource = o.runtime?.mcp ?? emptyToolSource();
    yield* this.loop(chat, o.userText, o.tools, toolSource, o.traceParent);
  }

  /**
   * Answer a paused gate. `approved=true` → inject the EXECUTED result
   * (ChatService ran the tool), `false` → inject a declined marker. The
   * functionResponse id must equal the original functionCall id (the gate id).
   */
  async *answerPending(o: {
    sid: string;
    session: ChatSession;
    approved: boolean;
    gate: { id: string; tool: string };
    executedResult?: unknown;
    tools: PreparedTool[];
    runtime?: { def: unknown; mcp: ToolSource; snapshot(): unknown; accessToken?(): Promise<string> };
    traceParent?: import('@opentelemetry/api').Span;
  }): AsyncGenerator<AgentStep> {
    let chat = this.chat(o.sid);
    if (!chat) {
      this.reset(o.sid, (o.session.directHistory ?? []) as Content[], o.tools);
      chat = this.chat(o.sid)!;
    }
    const payload = o.approved
      ? { status: 'executed_after_user_confirmation', result: serializeJson(o.executedResult) }
      : { status: 'not_executed', reason: 'user did not confirm the tool call' };
    yield* this.loop(
      chat,
      fr(o.gate.id, o.gate.tool, payload),
      o.tools,
      o.runtime?.mcp ?? emptyToolSource(),
      o.traceParent,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────
  chat(sid: string): ChatLike | undefined {
    return this.chats.get(sid);
  }

  private configFor(tools: PreparedTool[]) {
    return {
      systemInstruction: this.systemInstruction,
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => t.declaration) }] } : {}),
    };
  }

  private chatFor(sid: string, session: ChatSession, tools: PreparedTool[]): ChatLike {
    let chat = this.chats.get(sid);
    if (!chat) {
      this.reset(sid, (session.directHistory ?? []) as Content[], tools);
      chat = this.chats.get(sid)!;
    }
    return chat;
  }

  /** The core function-calling stream loop. */
  private async *loop(
    chat: ChatLike,
    firstMessage: unknown,
    tools: PreparedTool[],
    toolSource: ToolSource,
    traceParent?: import('@opentelemetry/api').Span,
  ): AsyncGenerator<AgentStep> {
    const byName = toolMap(tools);
    let message: unknown = firstMessage;

    for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
      const calls: FunctionCallView[] = [];
      let roundText = '';
      const roundSpan = startSpan(
        'llm.round',
        {
          [ATTR.round]: round,
          [ATTR.model]: config.geminiModel,
          [ATTR.engine]: 'direct',
        },
        traceParent,
      );
      try {
        const stream = await chat.sendMessageStream({ message });
        for await (const chunk of stream) {
          // Streamed function calls can land mid-stream; collect while emitting.
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) {
            if (typeof p.text === 'string' && p.text && !p.thought) {
              roundText = `${roundText}${p.text}`;
              yield { kind: 'text_delta', text: p.text };
            }
          }
          if (chunk.functionCalls?.length) calls.push(...chunk.functionCalls);
        }
        message = undefined;

        if (!calls.length) return; // final text already streamed

        for (const fc of calls) {
          const callId = fc.id ?? createId();
          const prepared = byName.get(fc.name ?? '');
          if (!prepared) {
            yield chip(callId, fc.name ?? 'tool', fc.args, 'error', 'unknown tool');
            message = fr(callId, fc.name ?? 'tool', { error: `unknown tool ${fc.name}` });
            continue;
          }
          if (prepared.gated) {
            // ── the confirmation gate — tool does NOT run here ───────────────
            yield chip(callId, fc.name, fc.args, 'paused', undefined, true);
            yield {
              kind: 'pause',
              gate: {
                id: callId,
                tool: fc.name ?? 'tool',
                args: (fc.args ?? {}) as Record<string, unknown>,
                title: chipTitle(fc.name ?? 'tool', fc.args as Record<string, unknown> | undefined),
              },
            };
            return;
          }
          yield chip(callId, fc.name, fc.args, 'running');
          let ok = true;
          let result: unknown;
          const toolName = fc.name ?? 'tool';
          try {
            result = await toolSource.callTool(toolName, (fc.args ?? {}) as Record<string, unknown>, roundSpan);
          } catch (e) {
            ok = false;
            result = { error: e instanceof Error ? e.message : String(e) };
          }
          yield chip(callId, toolName, fc.args, ok ? 'done' : 'error', summarizeToolResult(result), false);
          yield { kind: 'tool_result', name: toolName, result, ok };
          message = fr(callId, toolName, result);
        }
      } catch (e) {
        recordError(roundSpan, e);
        throw e;
      } finally {
        roundSpan.setAttribute('skynet.streamed.text.length', roundText.length);
        roundSpan.setAttribute('skynet.functionCalls.count', calls.length);
        const preview = optionalContent(roundText, 300); // SKYNET_OTEL_CONTENT=1 only
        if (preview !== undefined) roundSpan.setAttribute('skynet.streamed.text', preview);
        roundSpan.end();
      }
    }
    yield { kind: 'error', message: 'Too many tool rounds in a single turn — stopping there.' };
  }
}

type PartListSafe = { parts: PartView[]; role?: 'user' };

/**
 * Guard against restored history that carries no `role` (possible from older
 * builds / the SDK bug above): copy-and-fill so extractCuratedHistory can
 * never see `role === undefined` — functionCall parts belong to the model,
 * everything else (incl. functionResponse) is user-side.
 */
function sanitizeHistory(history: Content[]): Content[] {
  return history.map((c): Content => {
    if (!c || typeof c !== 'object' || c.role) return c;
    const isModel = Array.isArray(c.parts) && c.parts.some((p) => p && 'functionCall' in p && !('functionResponse' in p));
    return { ...c, role: isModel ? 'model' : 'user' } as Content;
  });
}

function emptyToolSource(): ToolSource {
  return {
    tools: async () => [],
    callTool: async () => {
      throw new Error('No connected quick-commerce MCP right now.');
    },
  };
}

function chip(
  id: string,
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  status: 'running' | 'done' | 'error' | 'paused',
  detail?: string,
  gated?: boolean,
): AgentStep & { kind: 'chip' } {
  return {
    kind: 'chip',
    chip: {
      id,
      name: name ?? 'tool',
      title: chipTitle(name ?? 'tool', args),
      status,
      detail,
      gated,
    },
  };
}

function fr(id: string, name: string | undefined, payload: unknown): PartListSafe {
  // `role: 'user'` is REQUIRED: @google/genai stores the message content as-is
  // when a role is absent, and the SDK's own extractCuratedHistory then hides
  // forever on 'role === undefined' entries (infinite loop wedging the event
  // loop, observed live 2026-10). Function responses are user-side content.
  return {
    role: 'user',
    parts: [{ functionResponse: { id, name: name ?? 'tool', response: payload as Record<string, unknown> } }],
  };
}

export function chipTitle(name: string, args: Record<string, unknown> | undefined): string {
  let argstr = '';
  try {
    argstr = JSON.stringify(args ?? {});
  } catch {
    argstr = '';
  }
  const emojis: Array<[RegExp, string]> = [
    [/search|find|catalog|product/i, '🔍'],
    [/cart/i, '🧺'],
    [/address|location|city|pin/i, '📍'],
    [/order_history|history|track|status/i, '📦'],
    [/checkout|pay|place_order|create_order|submit/i, '💸'],
  ];
  const emoji = emojis.find(([re]) => re.test(name))?.[1] ?? '🧩';
  const argsPart = argstr && argstr !== '{}' ? ` ${argstr}` : '';
  return `${emoji} ${name}${argsPart}`.slice(0, 120);
}
