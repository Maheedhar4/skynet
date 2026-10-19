/** Small ndjson writer over an express response (the chat stream). */
import type { Response } from 'express';
import { WireEvent } from '../types.js';

export class Ndjson {
  private closed = false;

  constructor(private readonly res: Response) {
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    res.setHeader('connection', 'keep-alive');
    res.on('close', () => {
      this.closed = true;
    });
  }

  write(event: WireEvent): void {
    if (this.closed || this.res.writableEnded) return;
    try {
      this.res.write(`${JSON.stringify(event)}\n`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ('flush' in (this.res as unknown as Record<string, any>)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.res as unknown as { flush?: () => void }).flush?.();
      }
    } catch {
      this.closed = true;
    }
  }

  get open(): boolean {
    return !this.closed && !this.res.writableEnded;
  }
}

export function parseSidCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'skynet.sid') {
      const v = decodeURIComponent(rest.join('='));
      return /^[a-f0-9]{16,64}$/.test(v) ? v : null;
    }
  }
  return null;
}
