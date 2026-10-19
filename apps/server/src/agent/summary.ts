/** Small shared summaries for tool results (chips + gate cards). */
export function summarizeToolResult(result: unknown): string {
  try {
    const s = JSON.stringify(result);
    if (!s) return '';
    const flat = s.replace(/\s+/g, ' ');
    return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
  } catch {
    return '';
  }
}

export function serializeJson(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const s = JSON.stringify(value);
    if (s && s.length > 20_000) return { truncated: `${s.slice(0, 20_000)}…` };
    return value;
  } catch {
    return { error: 'unserializable tool result' };
  }
}
