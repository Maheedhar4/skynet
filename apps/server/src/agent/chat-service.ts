/**
 * Chat orchestrator (Plan §3–4): owns sessions and turns, delegates the model
 * work to the selected engine, and — critically — enforces the order-
 * confirmation gate between turns.
 *
 * Gate semantics (non-negotiable in v1 because Zepto MCP orders are real
 * orders): search / cart view / order history run immediately. When the engine
 * requests an order/checkout tool, the turn PAUSES with a confirmation card.
 * The user's next chat message answers it:
 *    YES-like reply → the tool executes NOW and its result feeds the model
 *    anything else  → the tool does NOT run; the model is told it was declined
 * The UI's Confirm/Cancel buttons simply send "yes"/"no" through this path.
 */
import { ChatSession, ChatTurn, ConfirmationCard, WireEvent, ConnectorStatus } from '../types.js';
import { SessionStore } from '../data/sessionstore.js';
import { ensureDir, joinSecure, readJson, writeJsonSecure } from '../data/files.js';
import { config } from '../config.js';
import { createId } from '../oauth/pkce.js';
import { log } from '../logger.js';
import { amountHint } from './gate.js';
import { PreparedTool, prepareTools } from './tools.js';
import { AgentStep, Engine, RuntimeHandle } from './engine-types.js';
import { DirectEngine } from './direct-engine.js';
import { summarizeToolResult } from './summary.js';
import { ZeroKeyError } from './genai.js';
import { createAdkEngine } from './adk-engine.js';
const YES_RE =
  /^\s*(?:y(?:ea?h?)?|yes(?:\s*please)?|confirm(?:ed)?|ok(?:ay)?|do it|go ahead|proceed|approve(?:d)?|sure|continue|place (?:it|the order))\b/i;
const DECLINED: unknown = { status: 'declined', reason: 'user did not confirm — tool was not executed' };

interface SidIndex {
  [sid: string]: { sessionId: string };
}

export class ChatService {
  private readonly store = new SessionStore();
  private readonly historyDir = joinSecure(config.dataDir, 'history');
  private readonly indexFile = joinSecure(this.historyDir, 'index.json');
  private readonly sessions = new Map<string, ChatSession>(); // web sid → live session
  private index: SidIndex = {};
  private indexLoaded = false;
  private enginesRef?: { direct: Engine | null; adk: Engine | null };

  constructor(
    private readonly engineId: 'direct' | 'adk',
    private readonly runtimeFor: (id: string) => RuntimeHandle | undefined,
    private readonly runtimeIds: () => string[],
    private readonly onStatus: () => Record<string, ConnectorStatus>,
  ) {}

  // ── engine acquisition (lazy + resilient, Plan §4 guarantee) ────────────────
  private async acquireEngines(): Promise<{ direct: Engine | null; adk: Engine | null }> {
    if (this.enginesRef) return this.enginesRef;
    let direct: Engine | null = null;
    let adk: Engine | null = null;
    try {
      direct = new DirectEngine({
        ai: (await import('./genai.js')).genaiFactory(),
        model: config.geminiModel,
      });
    } catch (e) {
      if (!(e instanceof ZeroKeyError)) log.error('chat', 'direct engine failed to start', e);
      throw e;
    }
    if (this.engineId === 'adk') {
      try {
        adk = await createAdkEngine();
      } catch (e) {
        // The plan's fallback guarantee: ADK TS immaturity never breaks the app.
        log.warn('chat', 'ADK engine unavailable — falling back to the direct engine:', e instanceof Error ? e.message : e);
      }
    }
    this.enginesRef = { direct, adk };
    return this.enginesRef;
  }

  // ── session plumbing ────────────────────────────────────────────────────────
  private async ensureIndex(): Promise<void> {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    await ensureDir(this.historyDir);
    this.index = (await readJson<SidIndex>(this.indexFile)) ?? {};
  }

  private async writeIndex(): Promise<void> {
    await writeJsonSecure(this.indexFile, this.index);
  }

  private async persist(s: ChatSession): Promise<void> {
    try {
      await this.store.save(s);
    } catch (e) {
      log.warn('chat', 'could not persist session (continuing):', e);
    }
  }

  private async load(sid: string): Promise<ChatSession> {
    const live = this.sessions.get(sid);
    if (live) return live;
    await this.ensureIndex();
    const rec = this.index[sid];
    let session = rec ? await this.store.load(rec.sessionId) : null;
    if (!session) {
      session = SessionStore.newSession(this.engineId);
      this.index[sid] = { sessionId: session.id };
      await this.writeIndex();
    } else if (session.pendingGate) {
      // Gates are answered by the engine that created them (ids are
      // engine-specific). If the persisted gate came from a different engine
      // than the one we would run now, discard it and tell the truth.
      const wouldRunAdk = this.wouldRunAdk();
      if (session.engine !== (wouldRunAdk ? 'adk' : 'direct')) {
        session.pendingGate = null;
        session.adkPending = undefined;
        session.turns.push({
          id: createId(),
          role: 'system',
          text: '⏸ A confirmation was pending from the previous turn, but the agent engine changed — please ask again.',
          at: new Date().toISOString(),
        });
      }
    }
    this.sessions.set(sid, session);
    return session;
  }

  private wouldRunAdk(): boolean {
    return this.engineId === 'adk' && Boolean(this.enginesRef?.adk);
  }

  async get(sid: string): Promise<ChatSession> {
    return this.load(sid);
  }

  async startNew(sid: string): Promise<ChatSession> {
    const fresh = SessionStore.newSession(this.engineId);
    const current = this.sessions.get(sid);
    if (current) void current; // old file stays on disk for history
    this.sessions.set(sid, fresh);
    this.engineFor(sid)?.forget(sid);
    await this.ensureIndex();
    this.index[sid] = { sessionId: fresh.id };
    await this.writeIndex();
    await this.persist(fresh);
    return { ...fresh, pendingGate: null };
  }

  private engineFor(sid: string): Engine | null {
    void sid;
    const e = this.enginesRef;
    if (!e) return null;
    return this.engineId === 'adk' ? e.adk ?? e.direct : e.direct;
  }

  // ── main entry: process one chat message, yielding wire events ─────────────
  async *process(sid: string, text: string): AsyncGenerator<WireEvent> {
    const session = await this.load(sid);
    yield { type: 'chat_start', sessionId: session.id };
    yield { type: 'connectors', status: this.onStatus() };

    const userTurn: ChatTurn = { id: createId(), role: 'user', text, at: new Date().toISOString() };
    session.turns.push(userTurn);
    yield { type: 'user', turn: { ...userTurn } };
    await this.persist(session);

    if (session.pendingGate) {
      yield* this.run(sid, session, 'gate', text);
    } else {
      yield* this.run(sid, session, 'turn', text);
    }
    yield { type: 'done' };
  }

  // ── assistant turn window ───────────────────────────────────────────────────
  private async *run(
    sid: string,
    session: ChatSession,
    mode: 'turn' | 'gate',
    text: string,
  ): AsyncGenerator<WireEvent> {
    const assistant: ChatTurn = {
      id: createId(),
      role: 'assistant',
      text: '',
      at: new Date().toISOString(),
      chips: [],
    };
    session.turns.push(assistant);

    const runtime = this.chooseRuntime();
    const vendorName = runtime?.def.name ?? 'Zepto';
    let tools: PreparedTool[] = [];
    let connectorDown = false;
    if (runtime) {
      try {
        tools = await prepareTools(runtime.mcp, runtime.def);
        connectorDown = tools.length === 0 && runtime.snapshot().state !== 'connected';
      } catch {
        connectorDown = true;
      }
    }
    if (connectorDown) {
      const state = runtime?.snapshot();
      assistant.text = `⚠️ I can't reach ${vendorName} right now${
        state?.error ? ` — ${state.error}` : ''
      }. Reconnect it via “Connect to Quick Commerce MCPs” and try again.`;
      yield { type: 'delta', turnId: assistant.id, text: assistant.text };
      yield { type: 'connectors', status: this.onStatus() };
      await this.persist(session);
      yield { type: 'assistant', turn: { ...assistant, chips: [] } };
      return;
    }

    let usedEngine: Engine | null = null;
    try {
      const engines = await this.acquireEngines();
      if (!engines.direct) throw new ZeroKeyError();
      usedEngine = this.engineId === 'adk' ? engines.adk ?? engines.direct : engines.direct;
      if (this.engineId === 'adk' && !engines.adk) {
        yield { type: 'note', turnId: assistant.id, text: 'ADK engine unavailable — using the direct engine. (SKYNET_ENGINE=direct silences this note.)' };
      }

      const stepSource: AsyncGenerator<AgentStep> =
        mode === 'gate'
          ? this.gateFlow(sid, session, text, usedEngine, engines.adk === usedEngine, tools, runtime)
          : usedEngine.runTurn({ sid, session, userText: text, tools, runtime });

      const absorb = makeAbsorber(session, assistant, vendorName);
      for await (const step of stepSource) {
        for (const we of absorb(step)) yield we;
      }
    } catch (e) {
      if (e instanceof ZeroKeyError) {
        const msg = 'GEMINI_API_KEY is missing — add it to .env (Google AI Studio free tier) and restart skynet.';
        assistant.text = `${assistant.text}${assistant.text ? ' ' : ''}⚙️ ${msg}`;
        yield { type: 'delta', turnId: assistant.id, text: `⚙️ ${msg}` };
        yield { type: 'error', message: msg, hint: 'config' };
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        log.error('chat', 'engine step failed:', msg);
        assistant.text = `${assistant.text}${assistant.text ? ' ' : ''}⚙️ ${msg}`;
        yield { type: 'delta', turnId: assistant.id, text: `⚙️ ${msg}` };
        yield { type: 'error', message: msg };
      }
    }

    if (usedEngine) {
      try {
        usedEngine.save(sid, session);
      } catch (e) {
        log.warn('chat', 'engine save failed:', e);
      }
    }
    await this.persist(session);
    yield { type: 'assistant', turn: { ...assistant, chips: [...(assistant.chips ?? [])] } };
  }

  private chooseRuntime(): RuntimeHandle | undefined {
    const ids = this.runtimeIds();
    for (const id of ids) {
      const r = this.runtimeFor(id);
      if (r && r.snapshot().state === 'connected') return r;
    }
    return ids.length ? this.runtimeFor(ids[0]) : undefined;
  }

  /**
   * Gate answer flow: the user's text decides; the gated tool executes (direct
   * engine) or is delegated to ADK's own confirmation-resume; then the model
   * narrates the outcome.
   */
  private async *gateFlow(
    sid: string,
    session: ChatSession,
    text: string,
    engine: Engine,
    adkActive: boolean,
    tools: PreparedTool[],
    runtime: RuntimeHandle | undefined,
  ): AsyncGenerator<AgentStep> {
    const gate = session.pendingGate;
    if (!gate) return;
    const approved = YES_RE.test(text.trim().slice(0, 48));
    const gateRef = { id: gate.id, tool: gate.tool };
    session.pendingGate = null; // clear FIRST — crash after this leaves no trap

    yield {
      kind: 'note',
      text: approved ? 'Confirmed — running the tool now.' : 'Not confirmed — the tool was not executed, nothing was charged.',
    };

    let executedResult: unknown = undefined; // ADK runs the tool itself
    if (!adkActive) {
      executedResult = DECLINED;
      if (approved) {
        yield {
          kind: 'chip',
          chip: { id: gate.id, name: gate.tool, title: gateTitle(gate.tool, gate.args), status: 'running' },
        };
        let failed = false;
        try {
          const src = runtime?.mcp;
          if (!src) throw new Error('no quick-commerce MCP connected');
          executedResult = await src.callTool(gate.tool, gate.args);
        } catch (e) {
          failed = true;
          executedResult = { error: e instanceof Error ? e.message : String(e) };
        }
        const ok = !failed && !(executedResult as Record<string, unknown>)?.error;
        yield {
          kind: 'chip',
          chip: {
            id: gate.id,
            name: gate.tool,
            title: gateTitle(gate.tool, gate.args),
            status: ok ? 'done' : 'error',
            detail: summarizeToolResult(executedResult),
          },
        };
      }
    }

    yield* engine.answerPending({
      sid,
      session,
      approved,
      gate: gateRef,
      executedResult,
      tools,
      runtime,
    });
  }
}

// ── small pure helpers ────────────────────────────────────────────────────────

export function gateTitle(tool: string, args?: Record<string, unknown>): string {
  let argstr = '';
  try {
    argstr = JSON.stringify(args ?? {});
  } catch {
    argstr = '';
  }
  const argsPart = argstr && argstr !== '{}' ? ` ${argstr}` : '';
  return `💸 ${tool}${argsPart}`.slice(0, 120);
}

function gatePhrase(tool: string): string {
  const n = tool.toLowerCase();
  if (n.includes('checkout')) return 'run checkout';
  return 'place the order';
}

export function gateSummaryCard(vendor: string, tool: string, amount?: string): string {
  return `${vendor} wants to ${gatePhrase(tool)}${amount ? ` (${amount})` : ''}`;
}

function previewArgs(args?: Record<string, unknown>): string {
  try {
    let s = JSON.stringify(args ?? {});
    if (s.length > 160) s = `${s.slice(0, 159)}…`;
    return s;
  } catch {
    return '';
  }
}

/** ₹ flavor probe for tool results (best-effort; drives the card amount). */
export function moneyFrom(result: unknown): string | undefined {
  const isTotalKey = (k: string): boolean =>
    /(?:^|_)(total|amount|payable|paid)(?:$|_)/i.test(k) ||
    /grand_?total|cart_?total|order_?total|total_?price|total_?amount/i.test(k);
  const isPriceKey = (k: string): boolean => /(?:^|_)price(?:$|_)/i.test(k);

  const candidates: Array<{ key: string | null; value: unknown }> = [];
  const collect = (v: unknown, key: string | null): void => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0.5 && v < 100_000_000) {
      candidates.push({ key, value: v });
      return;
    }
    if (typeof v === 'string') {
      candidates.push({ key, value: v });
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) collect(item, key);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, sub] of Object.entries(v as Record<string, unknown>)) collect(sub, k);
    }
  };
  collect(result, null);
  if (!candidates.length) return undefined;

  const rupees = (v: number) => `₹${v}`;
  const parseMoney = (s: unknown): string | undefined => {
    if (typeof s === 'string') {
      const c = /(?:₹|inr\s?|rs\.?\s?)\s?(\d[\d,]*(?:\.\d+)?)/i.exec(s);
      if (c) {
        const n = Number(c[1].replace(/,/g, ''));
        return n > 0.5 && n < 100_000_000 ? rupees(n) : undefined;
      }
      const k = /(\d[\d,]*(?:\.\d+)?)/.exec(s);
      if (k && /^(?:total|amount|payable|paid|grand)/i.test(s)) return rupees(Number(k[1].replace(/,/g, '')));
      return undefined;
    }
    if (typeof s === 'number') return rupees(s);
    return undefined;
  };

  // priority: total-class keys → free-text ₹ strings → price-class keys
  for (const tier of [isTotalKey, isPriceKey]) {
    const hit = candidates
      .filter((c) => tier(c.key ?? ''))
      .map((c) => parseMoney(c.value))
      .find((x) => x !== undefined);
    if (hit) return hit;
  }
  const fallback = candidates.map((c) => parseMoney(c.value)).find((x) => x !== undefined);
  return fallback;
}

/**
 * Turn an engine step into transcript mutations + wire events.
 * (Deriving the wire events next to the mutation keeps chips/cards atomic.)
 */
export function makeAbsorber(
  session: ChatSession,
  assistant: ChatTurn,
  vendorName: string,
): (s: AgentStep) => WireEvent[] {
  return (s: AgentStep): WireEvent[] => {
    switch (s.kind) {
      case 'text_delta': {
        assistant.text += s.text;
        return [{ type: 'delta', turnId: assistant.id, text: s.text }];
      }
      case 'chip': {
        assistant.chips = assistant.chips ?? [];
        const at = assistant.chips.findIndex((x) => x.id === s.chip.id);
        if (at >= 0) assistant.chips[at] = s.chip;
        else assistant.chips.push(s.chip);
        return [{ type: 'chip', turnId: assistant.id, chip: { ...s.chip } }];
      }
      case 'tool_result': {
        const money = moneyFrom(s.result);
        if (money) session.money = money;
        return [];
      }
      case 'pause': {
        session.pendingGate = {
          id: s.gate.id,
          tool: s.gate.tool,
          args: s.gate.args,
          createdAt: new Date().toISOString(),
        };
        const amount = amountHint(s.gate.args) ?? session.money;
        const summary = gateSummaryCard(vendorName, s.gate.tool, amount);
        const line = `⚠️ ${summary} — reply YES to confirm, or anything else to cancel.`;
        assistant.text = `${assistant.text}${assistant.text ? ' ' : ''}${line}`;
        const card: ConfirmationCard = {
          id: s.gate.id,
          tool: s.gate.tool,
          argsPreview: previewArgs(s.gate.args),
          summary,
        };
        assistant.confirmation = card;
        return [
          { type: 'delta', turnId: assistant.id, text: line },
          { type: 'confirmation', turnId: assistant.id, card: { ...card } },
        ];
      }
      case 'note': {
        assistant.text = `${assistant.text}${assistant.text ? ' ' : ''}(${s.text})`;
        return [{ type: 'note', turnId: assistant.id, text: s.text }];
      }
      case 'error': {
        assistant.text = `${assistant.text}${assistant.text ? ' ' : ''}⚙️ ${s.message}`;
        return [{ type: 'error', message: s.message, hint: s.hint }];
      }
    }
  };
}

export const __test = { YES_RE, moneyFrom, gateSummaryCard, DECLINED };
