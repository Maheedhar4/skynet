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

/**
 * Safe directory listing: only regular files matching `suffix` (no dotfiles,
 * no directories). Names are used exclusively through joinSecure afterwards,
 * so traversal is impossible even if the dir somehow contains odd entries.
 */
export async function listFiles(dir: string, suffix = '.json'): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return []; // dir missing/not created yet → nothing to clear
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith('.') || !name.endsWith(suffix)) continue;
    const full = joinSecure(dir, name);
    try {
      if ((await fs.promises.lstat(full)).isFile()) out.push(full);
    } catch {
      // vanished between readdir and stat — fine, it is gone anyway
    }
  }
  return out;
}

/** Unlink loop for the safe listing above; returns how many files were deleted. */
export async function removeAll(dir: string, suffix = '.json'): Promise<number> {
  const files = await listFiles(dir, suffix);
  for (const file of files) {
    await fs.promises.rm(file, { force: true });
  }
  return files.length;
}

export function joinSecure(dir: string, name: string): string {
  // Names come from the server itself, but sanitize anyway.
  const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(dir, safe);
}
