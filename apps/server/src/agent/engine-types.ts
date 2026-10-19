/**
 * Engine contract shared by the direct (genai loop) and ADK engines. Both
 * yield AgentStep streams that the chat-service renders into turns, wire
 * events, chips and confirmation cards.
 */
import { Content } from '@google/genai';
import { ChatSession, ToolChip, ToolSource } from '../types.js';
import { PreparedTool } from './tools.js';
import { ConnectorDef } from '../connectors/registry.js';

export type AgentStep =
  | { kind: 'text_delta'; text: string }
  | { kind: 'chip'; chip: ToolChip }
  | {
      kind: 'pause';
      gate: { id: string; tool: string; args: Record<string, unknown>; title: string };
      /** ADK-shaped resume info (present when the pause came from the ADK engine). */
      adk?: { interruptId: string; functionCallName: string; kind: string; message?: string };
      summary?: string;
    }
  | { kind: 'tool_result'; name: string; result: unknown; ok: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'error'; message: string; hint?: string };

/** What an engine needs from the connectors layer to reach tools. */
export interface RuntimeHandle {
  def: ConnectorDef;
  mcp: ToolSource;
  snapshot(): { state: string; error?: string; toolsCount?: number };
  /** ADK needs the raw token to build its own MCP transport. */
  accessToken?(): Promise<string>;
}

export interface Engine {
  runTurn(o: {
    sid: string;
    session: ChatSession;
    userText: string;
    tools: PreparedTool[];
    runtime?: RuntimeHandle;
  }): AsyncGenerator<AgentStep>;
  /**
   * Answer a paused gate.
   * - direct engine: ChatService already executed (or declined) the gated
   *   tool; `executedResult` carries that result (or a declined marker).
   * - ADK engine: `executedResult` is undefined; ADK executes the tool itself
   *   on approval through its own FunctionTool wrapper.
   */
  answerPending(o: {
    sid: string;
    session: ChatSession;
    approved: boolean;
    gate: { id: string; tool: string };
    executedResult?: unknown;
    tools: PreparedTool[];
    runtime?: RuntimeHandle;
  }): AsyncGenerator<AgentStep>;
  reset(sid: string, history: Content[], tools: PreparedTool[]): void;
  save(sid: string, sess: ChatSession): void;
  forget(sid: string): void;
}
