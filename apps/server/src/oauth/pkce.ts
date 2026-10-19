import * as crypto from 'node:crypto';

/** PKCE S256 + random state, base64url encoded per RFC 7636. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(64).toString('base64url'); // 86 chars → valid
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function createId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/** urlstring with only safe params — keeps the authorize URL tidy. */
export function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}
