// A second copy of the annotations, outside VS Code's own storage.
//
// VS Code deletes an extension's storage folder when the extension is uninstalled, and with it
// everything the reader highlighted, wrote and drew. So every file of the annotations folder
// (annotations, anchors, text snapshots, undo history) is also kept in a folder VS Code does not
// know about. When the extension starts with an empty annotations folder (a new install), they
// are brought back from there (see `copyFolderFromFirst` in the activation code).
//
// The backup follows the storage folder file by file: what is written there is copied here, what
// is removed there is removed here. It is never read while the extension runs, and a failure here
// never gets in the way of the storage itself. No `vscode` import, so it is unit-testable.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { copyFileAtomic, removeFile } from './atomicWrite';
import type { StoreLogger } from './HighlightStore';

/** The folder of the annotations, in the storage folder and in the backup. */
export const ANNOTATIONS_FOLDER = 'highlights';

/**
 * Where the backup is on this machine: the place for application data of the platform, in a
 * folder of the extension's own. `env` and `home` are passed in so this is testable.
 */
export function backupRoot(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Reading Room', 'backup');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Reading Room', 'backup');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'reading-room', 'backup');
}

/** Files that are being written (temporary names of atomic writes) are not copied. */
function isStored(name: string): boolean {
  return !name.includes('.tmp-') && !name.includes('.copy-');
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && isStored(entry.name)).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Copies a file unless the copy is there already: the same size, and not older than the file. */
async function copyIfChanged(source: string, target: string): Promise<boolean> {
  const from = await fs.stat(source).catch(() => undefined);
  // Gone in the meantime: the next change of its document removes the copy.
  if (!from) return false;
  const to = await fs.stat(target).catch(() => undefined);
  if (to && to.size === from.size && to.mtimeMs >= from.mtimeMs) return false;
  try {
    await copyFileAtomic(source, target);
  } catch (err) {
    // Removed or moved while it was copied (a rename moves files): the change that did it is reported next.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !(await fs.stat(source).catch(() => undefined))) return false;
    throw err;
  }
  return true;
}

export interface BackupOptions {
  /** The annotations folder of the storage folder. */
  source: string;
  /** The annotations folder of the backup. */
  target: string;
  log?: StoreLogger;
  /** How long changes of a document are collected before they are copied. */
  delayMs?: number;
  /** False while the reader has the backup turned off: nothing is copied then. */
  enabled?: () => boolean;
}

export class Backup {
  private readonly pending = new Set<string>();
  /** Documents whose files could not be copied: tried again with the next change. */
  private readonly failed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** One line in the log per run of failures, not one per file. */
  private failing = false;

  constructor(private readonly options: BackupOptions) {}

  get directory(): string {
    return this.options.target;
  }

  private get enabled(): boolean {
    return this.options.enabled?.() ?? true;
  }

  /**
   * Copies what the backup does not have yet, or has an older version of (the first start with a
   * backup, or changes made while it was turned off or could not be written). Nothing is removed
   * here: only a change of a document removes its files (see `changed`). Returns how many files
   * were copied.
   */
  prime(): Promise<number> {
    let copied = 0;
    return this.run(async () => {
      if (!this.enabled) return;
      for (const name of await names(this.options.source)) {
        if (await copyIfChanged(join(this.options.source, name), join(this.options.target, name))) copied++;
      }
    }).then(() => copied);
  }

  /** The files of a document changed (every one of them starts with its key): the backup follows shortly. */
  changed(key: string): void {
    if (!this.enabled) return;
    this.pending.add(key);
    for (const again of this.failed) this.pending.add(again);
    this.failed.clear();
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.syncPending();
    }, this.options.delayMs ?? 1000);
  }

  private syncPending(): Promise<void> {
    const keys = [...this.pending];
    this.pending.clear();
    return this.run(async () => {
      // One document that cannot be copied does not keep the others from being copied.
      let failure: unknown;
      for (const key of keys) {
        try {
          await this.syncKey(key);
        } catch (err) {
          failure ??= err;
          this.failed.add(key);
        }
      }
      if (failure !== undefined) throw failure;
    });
  }

  /** Makes the backup's files of a document the same as the storage folder's. */
  private async syncKey(key: string): Promise<void> {
    const prefix = `${key}.`;
    const here = (await names(this.options.source)).filter((name) => name.startsWith(prefix));
    const there = (await names(this.options.target)).filter((name) => name.startsWith(prefix));
    for (const name of here) await copyIfChanged(join(this.options.source, name), join(this.options.target, name));
    // A file that went away while this ran is removed by the change that took it away.
    const kept = new Set(here);
    for (const name of there) if (!kept.has(name)) await removeFile(join(this.options.target, name));
  }

  /** One thing at a time, and never an error to the caller: the backup must not break anything. */
  private run(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        await task();
        if (this.failing) this.options.log?.info(`The backup in ${this.options.target} is written again`);
        this.failing = false;
      } catch (err) {
        if (!this.failing) this.options.log?.warn(`The backup in ${this.options.target} could not be written: ${err instanceof Error ? err.message : String(err)}`);
        this.failing = true;
      }
    });
    return this.queue;
  }

  /** Copies every pending change now. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size > 0) await this.syncPending();
    await this.queue;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
