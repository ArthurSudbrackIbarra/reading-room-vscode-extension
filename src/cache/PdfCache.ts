// Disk cache of converted PDFs, so reopening a Markdown or text file does not start Chromium again.
//   <globalStorage>/cache/<sha256(document key + theme)>.pdfcache
// One file per document and page theme: a small header (format, source hash, the local files the
// render read and their sizes/times, warnings) followed by the PDF bytes. The file's mtime is its
// "last used" time; entries unused for longer than the retention period are deleted.
// It lives in the extension's global storage, never in the workspace, and is written only through
// store/atomicWrite.ts. No `vscode` import, so it is unit-testable.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { PageTheme } from '../shared/types';
import { removeFile, touchFile, writeFileAtomic, type AtomicWriteHooks } from '../store/atomicWrite';

const MAGIC = 'MPVC';
const FORMAT = 1;
const EXTENSION = '.pdfcache';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Refresh "last used" at most this often, so reading a cached PDF rarely writes. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** A local file the converter read (image, stylesheet); a change to it invalidates the entry. */
export type CacheDependency = { path: string; size: number; mtime: number } | { path: string; missing: true };

export interface CacheLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PdfCacheOptions {
  dir: string;
  log?: CacheLogger;
  now?: () => number;
  writeHooks?: AtomicWriteHooks;
}

interface Header {
  format: number;
  documentKey: string;
  theme: PageTheme;
  sourceHash: string;
  pdfHash: string;
  deps: CacheDependency[];
  warnings: string[];
  createdAt: number;
}

export interface CacheHit {
  pdf: Uint8Array;
  warnings: string[];
}

export interface PruneResult {
  removed: number;
  kept: number;
  bytes: number;
}

/** Stat function supplied by the host: size and mtime of a local file, or undefined if it does not exist. */
export type StatFn = (path: string) => Promise<{ size: number; mtime: number } | undefined>;

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class PdfCache {
  private readonly now: () => number;

  constructor(private readonly options: PdfCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get directory(): string {
    return this.options.dir;
  }

  pathOf(documentKey: string, theme: PageTheme): string {
    return `${this.options.dir}/${sha256(`${documentKey}\n${theme}`)}${EXTENSION}`;
  }

  /** Returns the cached PDF if it was made from the same source and none of its files changed. */
  async get(documentKey: string, theme: PageTheme, sourceHash: string, stat: StatFn): Promise<CacheHit | undefined> {
    const file = this.pathOf(documentKey, theme);
    let bytes: Uint8Array;
    let mtimeMs: number;
    try {
      bytes = new Uint8Array(await fs.readFile(file));
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      return undefined;
    }
    const parsed = this.parse(bytes);
    if (!parsed) {
      await removeFile(file).catch(() => undefined);
      return undefined;
    }
    const { header, pdf } = parsed;
    if (header.documentKey !== documentKey || header.theme !== theme || header.sourceHash !== sourceHash) return undefined;
    if (sha256(pdf) !== header.pdfHash) {
      this.options.log?.warn(`Discarding a damaged cached PDF (${file})`);
      await removeFile(file).catch(() => undefined);
      return undefined;
    }
    for (const dep of header.deps) {
      const current = await stat(dep.path).catch(() => undefined);
      if ('missing' in dep) {
        if (current) return undefined;
      } else if (!current || current.size !== dep.size || Math.abs(current.mtime - dep.mtime) > 1) {
        return undefined;
      }
    }
    if (this.now() - mtimeMs > TOUCH_INTERVAL_MS) await touchFile(file, new Date(this.now())).catch(() => undefined);
    return { pdf, warnings: header.warnings };
  }

  /** Stores a converted PDF, replacing the previous one for the same document and theme. */
  async put(documentKey: string, theme: PageTheme, sourceHash: string, pdf: Uint8Array, deps: CacheDependency[], warnings: string[]): Promise<void> {
    const header: Header = {
      format: FORMAT,
      documentKey,
      theme,
      sourceHash,
      pdfHash: sha256(pdf),
      deps,
      warnings,
      createdAt: this.now(),
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(8 + headerBytes.byteLength + pdf.byteLength);
    out.set(new TextEncoder().encode(MAGIC), 0);
    new DataView(out.buffer).setUint32(4, headerBytes.byteLength, true);
    out.set(headerBytes, 8);
    out.set(pdf, 8 + headerBytes.byteLength);
    await writeFileAtomic(this.pathOf(documentKey, theme), out, this.options.writeHooks);
  }

  /** Forgets a document (both themes), e.g. after "Refresh". */
  async remove(documentKey: string): Promise<void> {
    await Promise.all((['light', 'dark'] as const).map((t) => removeFile(this.pathOf(documentKey, t)).catch(() => undefined)));
  }

  /**
   * Deletes entries not used for `maxAgeDays` (0 deletes everything), then the least recently used
   * ones until the cache is under `maxBytes`. Leftover temp files from interrupted writes go too.
   */
  async prune(maxAgeDays: number, maxBytes: number): Promise<PruneResult> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return { removed: 0, kept: 0, bytes: 0 };
    }
    const now = this.now();
    const entries: { file: string; mtimeMs: number; size: number }[] = [];
    let removed = 0;
    for (const name of names) {
      const file = `${this.options.dir}/${name}`;
      const stat = await fs.stat(file).catch(() => undefined);
      if (!stat?.isFile()) continue;
      const isTemp = name.includes(`${EXTENSION}.tmp-`);
      if (isTemp) {
        if (now - stat.mtimeMs > DAY_MS) {
          await removeFile(file).catch(() => undefined);
          removed++;
        }
        continue;
      }
      if (!name.endsWith(EXTENSION)) continue;
      if (maxAgeDays <= 0 || now - stat.mtimeMs > maxAgeDays * DAY_MS) {
        await removeFile(file).catch(() => undefined);
        removed++;
        continue;
      }
      entries.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    let kept = 0;
    for (const entry of entries) {
      if (bytes + entry.size > maxBytes) {
        await removeFile(entry.file).catch(() => undefined);
        removed++;
        continue;
      }
      bytes += entry.size;
      kept++;
    }
    return { removed, kept, bytes };
  }

  /** Deletes every cached PDF. Returns how many were deleted. */
  async clear(): Promise<number> {
    return (await this.prune(0, 0)).removed;
  }

  private parse(bytes: Uint8Array): { header: Header; pdf: Uint8Array } | undefined {
    if (bytes.byteLength < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) return undefined;
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (8 + length > bytes.byteLength) return undefined;
    try {
      const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as Header;
      if (header.format !== FORMAT || !Array.isArray(header.deps) || !Array.isArray(header.warnings)) return undefined;
      return { header, pdf: bytes.slice(8 + length) };
    } catch {
      return undefined;
    }
  }
}
