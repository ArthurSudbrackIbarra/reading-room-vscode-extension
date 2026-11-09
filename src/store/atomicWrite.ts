// Crash-safe file replacement: write a temp file next to the target, fsync it, then rename it
// over the target. A crash at any point leaves either the old or the new file, never a mix.
// This module and export/ are the only places that write files (see test/unit/writeGuard.test.ts).
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AtomicWriteHooks {
  /** Test hook: called after the temp file is written and synced, before the rename. */
  beforeRename?(tempPath: string): Promise<void> | void;
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFileAtomic(target: string, data: string | Uint8Array, hooks: AtomicWriteHooks = {}): Promise<void> {
  const dir = dirname(target);
  await ensureDir(dir);
  const temp = join(dir, `${basename(target)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const handle = await fs.open(temp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await hooks.beforeRename?.(temp);
    await renameWithRetry(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Windows antivirus and indexers briefly lock files; retry the rename with backoff. */
export async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts || !RETRYABLE.has(code)) throw err;
      await sleep(20 * 2 ** attempt);
    }
  }
}

/** Moves a file aside (used for corrupt records). */
export async function moveAside(from: string, to: string): Promise<void> {
  await renameWithRetry(from, to);
}

export async function removeFile(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}
