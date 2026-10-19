/**
 * Tool preparation shared by both engines:
 *   MCP tools/list  →  Gemini FunctionDeclarations (+ gate classification)
 *
 * The JSON→genai Schema conversion reuses ADK's own `toGeminiSchema` utility
 * (the same code path ADK's MCPToolset uses), so both engines see identical
 * declarations.
 */
import type { FunctionDeclaration } from '@google/genai';
import { Type } from '@google/genai';
import { toGeminiSchema, MCPToolSchema } from '@google/adk/tools/mcp';
import { ConnectorDef } from '../connectors/registry.js';
import { ToolDecl, ToolSource } from '../types.js';
import { isGatedToolName } from './gate.js';

export interface PreparedTool {
  name: string;
  gated: boolean;
  declaration: FunctionDeclaration;
}

const EMPTY_PARAMS: FunctionDeclaration['parameters'] = { type: Type.OBJECT };

export async function prepareTools(source: ToolSource, def?: ConnectorDef): Promise<PreparedTool[]> {
  const list: ToolDecl[] = await source.tools();
  const out: PreparedTool[] = [];
  for (const t of list) {
    if (!t.name) continue;
    let parameters: FunctionDeclaration['parameters'];
    try {
      parameters =
        toGeminiSchema({
          type: 'object',
          properties: (t.inputSchema as MCPToolSchema | undefined)?.properties ?? {},
          required: (t.inputSchema as MCPToolSchema | undefined)?.required ?? [],
        } as MCPToolSchema) ?? EMPTY_PARAMS;
    } catch {
      parameters = EMPTY_PARAMS; // fallback: empty object params are legal
    }
    out.push({
      name: t.name,
      gated: isGatedToolName(t.name, def?.gateRe),
      declaration: {
        name: t.name,
        description: (t.description ?? '').slice(0, 800) || t.name,
        parameters: parameters ?? EMPTY_PARAMS,
      },
    });
  }
  return out;
}

export function toolMap(tools: PreparedTool[]): Map<string, PreparedTool> {
  return new Map(tools.map((t) => [t.name, t]));
}

export { EMPTY_PARAMS as EMPTY_TOOL_PARAMS };
