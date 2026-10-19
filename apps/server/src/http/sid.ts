import * as crypto from 'node:crypto';
import type { Request, Response } from 'express';

/** Parse `skynet.sid` (random hex) or mint a new one. */
export function sidFrom(req: Request, res: Response): string {
  const raw = req.headers.cookie;
  if (raw) {
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === 'skynet.sid') {
        const v = decodeURIComponent(rest.join('='));
        if (/^[a-f0-9]{16,64}$/.test(v)) return v;
      }
    }
  }
  const fresh = crypto.randomBytes(16).toString('hex');
  res.cookie('skynet.sid', fresh, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 180,
  });
  return fresh;
}
