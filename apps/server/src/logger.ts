const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

function stamp(): string {
  return dim(new Date().toISOString().slice(11, 19));
}

function line(kind: string, scope: string, msg: unknown, extra?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(stamp(), kind, dim(`[${scope}]`), msg);
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log('       ', typeof extra === 'string' ? extra : JSON.stringify(extra));
  }
}

export const log = {
  info: (scope: string, msg: unknown, extra?: unknown) => line(green(bold('●')), scope, msg, extra),
  warn: (scope: string, msg: unknown, extra?: unknown) => line(amber(bold('▲')), scope, msg, extra),
  error: (scope: string, msg: unknown, extra?: unknown) => line(red(bold('✖')), scope, msg, extra),
  event: (scope: string, msg: unknown, extra?: unknown) => line(dim('→'), scope, msg, extra),
};

/** Redact secrets for anything that may carry tokens. */
export function redact(s: string, keep = 4): string {
  if (!s) return '';
  if (s.length <= keep) return '***';
  return `${s.slice(0, keep)}… (${s.length} chars)`;
}
