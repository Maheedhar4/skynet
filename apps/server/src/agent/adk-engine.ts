/**
 * ADK engine (Plan §4, optional): Google ADK TS agent (Gemini) with the Zepto
 * tools wrapped as FunctionTools. Gated tools use ADK's native HITL
 * confirmation (`requireConfirmation` → `adk_request_confirmation` interrupt):
 * the runner PAUSES, we surface the pause, and the user's YES/no answers the
 * interrupt on the next run — ADK then executes the tool itself.
 *
 * This engine follows the plan's fallback guarantee: it is selected with
 * SKYNET_ENGINE=adk, and the chat-service falls back to the direct engine
 * automatically if ADK fails to load or run.
 */
import { Content } from '@google/genai';
import { config } from '../config.js';
import { SYSTEM_INSTRUCTION } from './instruction.js';
import { PreparedTool } from './tools.js';
import { AgentStep, Engine, RuntimeHandle } from './engine-types.js';
import { createId } from '../oauth/pkce.js';
import { log } from '../logger.js';

const WEB_USER = 'web';

type AdkModule = typeof import('@google/adk');

export async function createAdkEngine(): Promise<Engine> {
  // ADK's Gemini model class resolves the API key from the environment.
  process.env.GOOGLE_API_KEY ??= config.geminiApiKey;
  process.env.GEMINI_API_KEY ??= config.geminiApiKey;
  const adk: AdkModule = await import('@google/adk');

  class AdkEngineImpl implements Engine {
    private readonly runners = new Map<string, { runner: InstanceType<AdkModule['InMemoryRunner']>; sig: string }>();

    reset(sid: string, _history: Content[], _tools: PreparedTool[]): void {
      void _history;
      void _tools;
      this.runners.delete(sid);
    }

    forget(sid: string): void {
      this.runners.delete(sid);
    }

    save(_sid: string, _sess: { directHistory?: unknown[] }): void {
      // ADK keeps its session state with the runner; nothing to export.
    }

    async *runTurn(o: {
      sid: string;
      session: { engine: string; adkPending?: unknown };
      userText: string;
      tools: PreparedTool[];
      runtime?: RuntimeHandle;
    }): AsyncGenerator<AgentStep> {
      const runner = await this.runnerFor(o.sid, o.tools, o.runtime);
      await this.ensureSession(runner, o.sid);
      o.session.engine = 'adk';
      yield* this.pump(runner, o.sid, { role: 'user', parts: [{ text: o.userText }] });
    }

    async *answerPending(o: {
      sid: string;
      session: { engine: string; adkPending?: unknown };
      approved: boolean;
      tools: PreparedTool[];
      runtime?: RuntimeHandle;
    }): AsyncGenerator<AgentStep> {
      const pend = o.session.adkPending as
        | { interruptId: string; functionCallName: string; payload?: unknown }
        | undefined;
      if (!pend) {
        yield { kind: 'note', text: 'Nothing was pending to confirm.' };
        return;
      }
      o.session.adkPending = undefined;
      const response = o.approved
        ? { approved: true }
        : { approved: false, reason: 'user did not confirm — tool was not executed' };
      const message: Content = {
        role: 'user',
        parts: [{ functionResponse: { id: pend.interruptId, name: pend.functionCallName, response } }],
      };
      try {
        const runner = this.runners.get(o.sid)?.runner;
        if (!runner) throw new Error('ADK runner lost after restart');
        yield* this.pump(runner, o.sid, message);
      } catch (e) {
        yield { kind: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    }

    // ── internals ─────────────────────────────────────────────────────────────
    private async runnerFor(
      sid: string,
      tools: PreparedTool[],
      runtime: RuntimeHandle | undefined,
    ): Promise<InstanceType<AdkModule['InMemoryRunner']>> {
      const sig = tools.map((t) => `${t.name}${t.gated ? '!' : ''}`).join(',');
      const cached = this.runners.get(sid);
      if (cached && cached.sig === sig) return cached.runner;
      const fnTools = tools.map((t) =>
        new adk.FunctionTool({
          name: t.name,
          description: t.declaration.description ?? t.name,
          parameters: t.declaration.parameters,
          execute: async (input: unknown) => {
            if (!runtime) throw new Error('no quick-commerce MCP connected');
            const args = (input ?? {}) as Record<string, unknown>;
            const res = await runtime.mcp.callTool(t.name, args);
            return { result: res };
          },
          ...(t.gated ? { requireConfirmation: true } : {}),
        }),
      );
      const agent = new adk.Agent({
        name: 'skynet_agent',
        model: config.geminiModel,
        description: 'Local quick-commerce assistant wired to Zepto MCP tools.',
        instruction: SYSTEM_INSTRUCTION,
        tools: fnTools,
      });
      const runner = new adk.InMemoryRunner({ appName: APP_NAME, agent });
      if (cached) await this.dropSession(cached.runner, sid);
      this.runners.delete(sid);
      this.runners.set(sid, { runner, sig });
      log.event('adk-agent', `ADK agent ready (${fnTools.length} tools, ${tools.filter((t) => t.gated).length} gated)`);
      return runner;
    }

    private async ensureSession(
      runner: InstanceType<AdkModule['InMemoryRunner']>,
      sid: string,
    ): Promise<void> {
      const existing = await runner.sessionService.getSession({
        appName: APP_NAME,
        userId: WEB_USER,
        sessionId: sid,
      });
      if (!existing) {
        await runner.sessionService.createSession({
          appName: APP_NAME,
          userId: WEB_USER,
          sessionId: sid,
        });
      }
    }

    private async dropSession(
      runner: InstanceType<AdkModule['InMemoryRunner']>,
      sid: string,
    ): Promise<void> {
      await runner.sessionService.deleteSession({ appName: APP_NAME, userId: WEB_USER, sessionId: sid })
        .catch(() => undefined);
    }

    /** Drive one ADK invocation, mapping events → engine steps. */
    private async *pump(
      runner: InstanceType<AdkModule['InMemoryRunner']>,
      sid: string,
      newMessage: Content,
    ): AsyncGenerator<AgentStep> {
      // partial deltas accumulate here so the (complete) final event doesn't
      // re-emit the same text.
      let streamed = '';
      const runningById = new Map<string, { name: string; title: string }>();
      const runningByName = new Map<string, string>();

      for await (const ev of runner.runAsync({
        userId: WEB_USER,
        sessionId: sid,
        newMessage,
        runConfig: adk.createRunConfig({ streamingMode: adk.StreamingMode.SSE }),
      })) {
        const author = ev.author ?? '';
        if (author && author !== 'user') {
          // model-side events only
        }

        // framework pause (HITL confirmation etc.)
        if (adk.requiresUserInput(ev)) {
          for (const req of adk.getUserInputRequests(ev)) {
            if (req.kind === 'confirmation') {
              const payload = (req.payload ?? {}) as Record<string, unknown>;
              const callId = toCallId(req.interruptId);
              yield {
                kind: 'pause',
                gate: {
                  id: callId,
                  tool: req.toolName ?? 'gated_tool',
                  args: (payload.args as Record<string, unknown>) ?? {},
                  title: `💸 ${req.toolName ?? 'gated tool'}`,
                },
                adk: {
                  interruptId: req.interruptId,
                  functionCallName: req.functionCallName,
                  kind: req.kind,
                  message: req.message,
                },
              };
            } else {
              log.event('adk-agent', `skip ${req.kind} request (${req.message ?? ''})`);
            }
          }
          continue;
        }

        if (ev.errorCode) {
          yield { kind: 'error', message: `${ev.errorCode}: ${ev.errorMessage ?? ''}`.trim() };
          continue;
        }

        const parts = ev.content?.parts ?? [];
        const finalEvent = adk.isFinalResponse(ev);

        for (const p of parts) {
          if (typeof p.text === 'string' && p.text) {
            if (ev.partial) {
              streamed += p.text;
              yield { kind: 'text_delta', text: p.text };
            } else if (finalEvent) {
              // SSE mode: final carries the full text; emit only the tail
              // beyond what partials already streamed.
              const tail = streamed && p.text.startsWith(streamed) ? p.text.slice(streamed.length) : p.text;
              if (tail) yield { kind: 'text_delta', text: tail };
              streamed = '';
            }
          }
          if (p.functionCall && !p.functionCall.name?.startsWith('adk_')) {
            // running chip: the framework will execute this tool
            const fc = p.functionCall;
            const callId = fc.id ?? createId();
            runningById.set(callId, { name: fc.name ?? 'tool', title: `🧩 ${fc.name ?? 'tool'}` });
            runningByName.set(fc.name ?? 'tool', callId);
            yield {
              kind: 'chip',
              chip: {
                id: callId,
                name: fc.name ?? 'tool',
                title: `🧩 ${fc.name ?? 'tool'}`,
                status: 'running',
              },
            };
          }
          if (p.functionResponse && !p.functionResponse.name?.startsWith('adk_')) {
            const fr2 = p.functionResponse;
            const callId = fr2.id ?? (fr2.name ? runningByName.get(fr2.name) : undefined) ?? '';
            const meta = callId ? runningById.get(callId) : undefined;
            if (!meta) continue;
            yield {
              kind: 'chip',
              chip: {
                id: callId,
                name: fr2.name ?? meta.name,
                title: meta.title,
                status: /error|fail/i.test(JSON.stringify(fr2.response ?? {})) ? 'error' : 'done',
                detail: summarizeShort(fr2.response),
              },
            };
            yield { kind: 'tool_result', name: fr2.name ?? meta.name, result: fr2.response ?? {}, ok: true };
          }
        }
      }
    }
  }

  return new AdkEngineImpl();
}

const APP_NAME = 'skynet';

function toCallId(interruptId: string): string {
  // The interrupt id is opaque; reuse it — uniqueness is what matters.
  return interruptId || createId();
}

function summarizeShort(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    const flat = s.replace(/\s+/g, ' ');
    return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  } catch {
    return '';
  }
}
