/**
 * OFFLINE smoke test of the chat pipeline heart (no API key, no network):
 * a fake genai chat + fake MCP tool source drive the DirectEngine through
 *   1. plain text turn           (no tools)
 *   2. ungated tool execution    (search → cart flow narration)
 *   3. THE GATE: a gated tool (place_order) PAUSES the turn with a card;
 *      "YES" approves and executes it + narrates; "no" declines safely.
 * Run: npm run smoke (from apps/server) — asserts on transcript/turn states.
 */
import * as assert from 'node:assert/strict';
import { DirectEngine, ChatLike } from '../agent/direct-engine.js';
import { SYSTEM_INSTRUCTION } from '../agent/instruction.js';
import { SessionStore } from '../data/sessionstore.js';
import { config } from '../config.js';
import { ChatService } from '../agent/chat-service.js';
import { RuntimeHandle } from '../agent/engine-types.js';
import { ToolChip } from '../types.js';
import { connectorById } from '../connectors/registry.js';

/* ── a scripted genai Chat stub ────────────────────────────────────────────── */
class ScriptedChat implements ChatLike {
  history: Array<{ parts: { text?: string; functionCall?: unknown; functionResponse?: unknown }[]; role?: string }> = [];
  private queue: Array<Run> = [];
  getHistory = () => this.history as never;

  pushScript(rounds: Run[]): this {
    this.queue.push(...rounds);
    return this;
  }

  async sendMessageStream({ message }: { message: unknown }): Promise<AsyncIterable<StreamChunk>> {
    const replay = this.queue.shift();
    if (!replay) throw new Error('script exhausted');
    this.history.push({
      role: replay.role ?? 'user',
      parts: typeof message === 'string' ? [{ text: message }] : JSON.parse(JSON.stringify(message)),
    });
    this.history.push({
      role: 'model',
      parts: ((replay.text ? [{ text: replay.text }] : []) as never[]).concat(
        (replay.calls ?? []).map((c) => ({ functionCall: c })) as never[],
      ),
    });
    let mutableRef = replay;
    void mutableRef;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          candidates: [
            {
              content: {
                parts: (replay.text ? [{ text: replay.text }] : []).concat(
                  (replay.calls ?? []).map((c) => ({ functionCall: c })) as never,
                ),
              },
            },
          ],
          functionCalls: replay.calls ?? [],
        };
      },
    };
  }
}

interface Run {
  text?: string;
  calls?: { id?: string; name: string; args?: Record<string, unknown> }[];
  role?: string;
}
interface StreamChunk {
  candidates?: { content?: { parts?: Array<{ text?: string }> } }[];
  functionCalls?: { id?: string; name: string; args?: Record<string, unknown> }[];
}

/* ── fake MCP tool source ──────────────────────────────────────────────────── */
const calls: Array<{ name: string; args: unknown }> = [];
const fakeMcp: {
  tools(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown>; gated?: boolean }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
} = {
  tools: async () => [
    { name: 'search_products', description: 'Search products', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'view_cart', description: 'View cart', inputSchema: { type: 'object', properties: {} } },
    { name: 'place_order', description: 'Place order', inputSchema: { type: 'object', properties: {} } },
  ],
  callTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'search_products') return { results: [{ name: 'Amul milk 1L', price: '₹68' }, { name: 'Nestle a+ 1L', price: '₹72' }] };
    if (name === 'view_cart') return { items: [{ name: 'Amul milk 1L', price: '₹68', total: 542 }] };
    if (name === 'place_order') return { order_id: 'Z-1001', total: '₹542', eta: '9 minutes' };
    throw new Error(`unexpected ${name}`);
  },
};

/* ── engine wiring via the real ChatService (same code path as prod) ──────── */
const runtime: RuntimeHandle = {
  def: connectorById('zepto')!,
  mcp: fakeMcp as never,
  snapshot: () => ({ state: 'connected' }),
};

const services = () => {
  const enginesCache = new Map<string, DirectEngine>();
  return {
    makeService(): ChatService {
      // one shared DirectEngine instance, its chats keyed per test session
      const engine = new DirectEngine({ ai: 'fake' as never, model: 'fake-model' });
      return new ChatService(
        'direct',
        () => runtime,
        () => ['zepto'],
        () => ({}),
      );
    },
  };
};

/* ── THE TEST ─────────────────────────────────────────────────────────────── */
async function main(): Promise<void> {
  config.dataDir = '/tmp/opencode/skynet-smoke';
  // the smoke runs fully offline: the genai client is never contacted because
  // the scripted chat replaces the engine's chat map after acquisition.
  config.geminiApiKey = 'smoke-FAKE-key';
  const { makeService } = services();
  const svc = makeService();
  const sid = 'testsession00deadbeefcafe00';
  const session = await svc.get(sid);

  // Prepare tool decls through the real path (ADK schema util).
  const { prepareTools } = await import('../agent/tools.js');
  const tools = await prepareTools(fakeMcp as never, connectorById('zepto')!);
  assert.equal(tools.length, 3, 'tool decls built');
  assert.ok(tools.find((t) => t.name === 'place_order')?.gated, 'place_order is gated');
  assert.ok(!tools.find((t) => t.name === 'search_products')?.gated, 'search is ungated');
  assert.ok(!tools.find((t) => t.name === 'view_cart')?.gated, 'view_cart is ungated');

  // Install a scripted chat under the known sid BEFORE processing.
  const chat = new ScriptedChat();
  const engines = (svc as unknown as { engineRef: unknown }) ?? null;
  void engines;
  // reach into the lazily-built engine via one process() run — instead we
  // pre-seed through the same acquire path the service uses:
  const svcPrivate = svc as unknown as { acquireEngines(): Promise<{ direct: DirectEngine }> };
  const { direct } = await svcPrivate.acquireEngines();
  (direct as unknown as { chats: Map<string, ChatLike> }).chats.set(sid, chat);

  chat.pushScript([
    { text: 'Let me check the store. ', calls: [{ id: 'call-1', name: 'search_products', args: { query: 'amul milk' } }] },
    { text: 'Amul milk 1L is ₹68. Want me to add it to the cart?' },
  ]);
  const evs1: Wire[] = [];
  for await (const e of svc.process(sid, 'find amul milk')) evs1.push(e);
  const finalChips1 = (session.turns.at(-1)?.chips ?? []) as ToolChip[];
  assert.equal(finalChips1.length, 1, 'one tool chip (settled)');
  assert.equal(finalChips1[0].name, 'search_products');
  assert.equal(finalChips1[0].status, 'done');
  assert.ok(textsOf(evs1).some((t) => t.includes('₹68')), 'price streamed through');
  assert.ok(session.turns.at(-1)?.text.includes('₹68'), 'assistant text ran from the tool result');

  chat.pushScript([
    { calls: [{ id: 'call-cart', name: 'view_cart', args: {} }] },
    { text: 'Your cart has Amul milk 1L — ₹542 total. Shall I place the order?' },
  ]);
  for await (const e of svc.process(sid, 'show my cart')) void e;

  // ── the gate ──
  chat.pushScript([{ calls: [{ id: 'call-gate', name: 'place_order', args: { confirm: true } }] }]);
  const evs3: Wire[] = [];
  for await (const e of svc.process(sid, 'place the order')) evs3.push(e);
  const confirmEv = evs3.find((e) => e.type === 'confirmation') as
    | { card: { tool: string; summary: string } }
    | undefined;
  assert.ok(confirmEv, 'a pause with confirmation card');
  assert.equal(confirmEv.card.tool, 'place_order');
  assert.ok(String(confirmEv.card.summary).includes('₹542'), 'card carries the ₹ hint from the earlier tool result');
  assert.equal(calls.filter((c) => c.name === 'place_order').length, 0, 'NOT executed before approval');
  assert.ok(textsOf(evs3).some((t) => t.includes('reply YES')), 'the yes-line instruction is in the chat');

  chat.pushScript([{ text: 'Order placed! id Z-1001, ₹542, ~9 minutes.' }]);
  const evs4: Wire[] = [];
  for await (const e of svc.process(sid, 'yes')) evs4.push(e);
  assert.equal(calls.filter((c) => c.name === 'place_order').length, 1, 'executed once after YES');
  assert.ok(textsOf(evs4).some((t) => t.includes('Z-1001')), 'the result narrated');

  // ── decline path ──
  chat.pushScript([{ calls: [{ id: 'call-gate-2', name: 'place_order', args: {} }] }]);
  for await (const e of svc.process(sid, 'order again')) void e;
  chat.pushScript([{ text: 'Understood — I will not place the order.' }]);
  const evs6: Wire[] = [];
  for await (const e of svc.process(sid, 'no way')) evs6.push(e);
  assert.equal(calls.filter((c) => c.name === 'place_order').length, 1, 'still executed only once overall');
  assert.ok(textsOf(evs6).some((t) => t.toLowerCase().includes('will not place')), 'decline narrated');

  console.log('\n✅ smoke passed — direct engine + gate behave per plan');
  process.exit(0);
}

type Wire = { type: string; [key: string]: unknown };

function textsOf(evs: Wire[]): string[] {
  return evs.filter((e) => typeof e.text === 'string').map((e) => e.text as string);
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
