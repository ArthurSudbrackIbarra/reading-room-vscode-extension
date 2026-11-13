// Crash-safe file replacement: write a temp file next to the target, fsync it, then rename it
// over the target. A crash at any point leaves either the old or the new file, never a mix.
// This module and export/ are the only places that write files (see test/unit/writeGuard.test.ts).
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, promises as fs, renameSync, rmSync } from 'node:fs';
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

/** Copies a file the same crash-safe way: into a temp file next to the target, then renamed over it. */
export async function copyFileAtomic(source: string, target: string): Promise<void> {
  const dir = dirname(target);
  await ensureDir(dir);
  const temp = join(dir, `${basename(target)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await fs.copyFile(source, temp);
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

/** Moves a file within the storage folder (snapshots follow a renamed document). */
export async function moveFile(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  await renameWithRetry(from, to);
}

/** Moves a file aside (used for corrupt records). */
export async function moveAside(from: string, to: string): Promise<void> {
  await renameWithRetry(from, to);
}

export async function removeFile(path: string): Promise<void> {
  await fs.rm(path, { force: true });
}

/** Sets a file's modification time (the PDF cache uses it as "last used"). */
export async function touchFile(path: string, time: Date = new Date()): Promise<void> {
  await fs.utimes(path, time, time);
}

/**
 * Copies a folder to a place where there is none yet (the data an earlier name of this extension
 * left in its own storage folder). The copy is made under a temporary name and renamed when it is
 * complete, so a crash leaves nothing half-made. The source is never changed. Synchronous on
 * purpose: it runs once, before anything reads the storage. True if a copy was made.
 */
export function copyFolderOnce(source: string, target: string): boolean {
  if (existsSync(target) || !existsSync(source)) return false;
  const temp = `${target}.copy-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    cpSync(source, temp, { recursive: true });
    renameSync(temp, target);
    return true;
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Brings `folder` into the storage folder `target` from the first of `sources` (storage folders
 * of the extension's earlier ids, newest first) that has it. Nothing happens when the target has
 * the folder already. Returns the source it was copied from.
 */
export function copyFolderFromFirst(sources: string[], target: string, folder: string): string | undefined {
  for (const source of sources) {
    if (copyFolderOnce(join(source, folder), join(target, folder))) return source;
  }
  return undefined;
}
