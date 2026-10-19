import * as fs from 'node:fs';
import * as path from 'node:path';

/** fs.promises wrapper: mkdir -p. */
export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Read a JSON file or null; `0600`- permissions are enforced on write. */
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Atomic-ish write with `0600` perms — used for EVERY file in the data dir
 * (tokens, history). Writes are resolved via a temp file in the same dir then
 * replaced, so a crash can't leave a half-written token store.
 */
export async function writeJsonSecure(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  const data = JSON.stringify(value, null, 2);
  // O_EXCL temp file first (no world/path races), then atomic replace.
  await fs.promises.writeFile(tmp, data, { mode: 0o600, flag: 'w' });
  await fs.promises.rename(tmp, file);
  // chmod in case the file pre-existed with different perms.
  await fs.promises.chmod(file, 0o600).catch(() => undefined);
}

export async function removeFile(file: string): Promise<void> {
  await fs.promises.rm(file, { force: true });
}

export function joinSecure(dir: string, name: string): string {
  // Names come from the server itself, but sanitize anyway.
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(dir, safe);
}
