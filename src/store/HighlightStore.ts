// Per-file highlight and view storage in the extension's global storage folder:
//   <globalStorage>/highlights/<sha256(normalized path)>.json
// Writes are atomic, serialized per file and coalesced. No `vscode` import, so it is unit-testable.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import {
  MAX_NOTE_LENGTH,
  isHighlightColor,
  isReadingMarker,
  isZoomValue,
  type Highlight,
  type ReadingMarker,
  type StoredRecord,
  type ViewState,
} from '../shared/types';
import { ensureDir, moveAside, removeFile, writeFileAtomic, type AtomicWriteHooks } from './atomicWrite';

export interface DocumentRef {
  /** `uri.toString()` */
  uri: string;
  scheme: string;
  /** `uri.fsPath` for file URIs. */
  fsPath?: string;
}

export interface StoreLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface StoreOptions {
  dir: string;
  platform?: NodeJS.Platform;
  log?: StoreLogger;
  coalesceMs?: number;
  writeHooks?: AtomicWriteHooks;
  /** Called when a corrupt record had to be moved aside. */
  onCorrupt?: (ref: DocumentRef, movedTo: string) => void;
}

interface Entry {
  ref: DocumentRef;
  record: StoredRecord;
  /** mtime of the file as last read or written by us; used to merge changes from other windows. */
  diskMtimeMs?: number;
  deletedIds: Set<string>;
  /** The reading marker was set or removed here since the last read, so ours wins over other windows. */
  markerChanged: boolean;
  dirty: boolean;
}

const SCHEMA_VERSION = 1;
const silentLog: StoreLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function normalizeKeyPath(ref: DocumentRef, platform: NodeJS.Platform = process.platform): string {
  if (ref.scheme === 'file' && ref.fsPath) {
    const pathApi = platform === 'win32' ? win32 : posix;
    let normalized = pathApi.normalize(ref.fsPath);
    if (normalized.length > 1 && (normalized.endsWith('/') || normalized.endsWith('\\'))) normalized = normalized.slice(0, -1);
    return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
  }
  return ref.uri;
}

export function recordKey(ref: DocumentRef, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(normalizeKeyPath(ref, platform), 'utf8').digest('hex');
}

export function emptyRecord(ref: DocumentRef): StoredRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    uri: ref.uri,
    fsPath: ref.fsPath,
    view: {},
    highlights: [],
    updatedAt: new Date().toISOString(),
  };
}

function isValidHighlight(value: unknown): value is Highlight {
  if (!value || typeof value !== 'object') return false;
  const h = value as Partial<Highlight>;
  const selector = h.target?.selector;
  return (
    typeof h.id === 'string' &&
    isHighlightColor(h.color) &&
    Array.isArray(selector) &&
    selector[0]?.type === 'TextQuoteSelector' &&
    typeof selector[0].exact === 'string' &&
    selector[0].exact.length > 0
  );
}

/** Cleans a highlight in place (defaults, note length). Returns undefined if it is not a highlight. */
export function sanitizeHighlight(value: unknown): Highlight | undefined {
  if (!isValidHighlight(value)) return undefined;
  const h = value;
  h.status = h.status === 'orphaned' ? 'orphaned' : 'anchored';
  const pos = h.target.selector[1];
  if (!pos || pos.type !== 'TextPositionSelector') {
    h.target.selector[1] = { type: 'TextPositionSelector', start: -1, end: -1 };
  }
  h.target.hints ??= { pages: [] };
  h.target.hints.pages ??= [];
  h.createdAt ??= new Date(0).toISOString();
  h.updatedAt ??= h.createdAt;
  h.target.selector[0].prefix ??= '';
  h.target.selector[0].suffix ??= '';
  if (typeof h.note === 'string' && h.note.trim()) h.note = h.note.slice(0, MAX_NOTE_LENGTH);
  else delete h.note;
  return h;
}

/** Validates a reading marker and returns a clean copy, or undefined if it is not usable. */
export function sanitizeMarker(value: unknown): ReadingMarker | undefined {
  if (!isReadingMarker(value)) return undefined;
  const marker: ReadingMarker = {
    pageIndex: value.pageIndex,
    y: Math.min(1, Math.max(0, value.y)),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  };
  if (value.selector) {
    const [quote, position] = value.selector;
    marker.selector = [
      { type: 'TextQuoteSelector', exact: quote.exact, prefix: quote.prefix ?? '', suffix: quote.suffix ?? '' },
      { type: 'TextPositionSelector', start: Number(position.start) || 0, end: Number(position.end) || 0 },
    ];
  }
  return marker;
}

/** True when a record holds anything worth keeping a file for. */
export function hasData(record: StoredRecord): boolean {
  return record.highlights.length > 0 || record.view.zoom !== undefined || record.marker !== undefined;
}

/** Validates a parsed JSON record and fills in defaults. Throws if it is not a record at all. */
export function sanitizeRecord(raw: unknown, ref: DocumentRef): StoredRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a record object');
  const r = raw as Partial<StoredRecord>;
  if (r.schemaVersion !== undefined && r.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`record schema ${r.schemaVersion} is newer than this extension supports`);
  }
  const view: ViewState = {};
  if (r.view && isZoomValue(r.view.zoom)) view.zoom = r.view.zoom;
  const highlights = Array.isArray(r.highlights)
    ? r.highlights.map(sanitizeHighlight).filter((h): h is Highlight => h !== undefined)
    : [];
  const marker = sanitizeMarker(r.marker);
  return {
    schemaVersion: SCHEMA_VERSION,
    uri: typeof r.uri === 'string' ? r.uri : ref.uri,
    fsPath: typeof r.fsPath === 'string' ? r.fsPath : ref.fsPath,
    view,
    highlights,
    ...(marker ? { marker } : {}),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
  };
}

function mergeHighlights(ours: Highlight[], theirs: Highlight[], deletedIds: Set<string>): Highlight[] {
  const byId = new Map<string, Highlight>();
  for (const h of theirs) if (!deletedIds.has(h.id)) byId.set(h.id, h);
  for (const h of ours) {
    const other = byId.get(h.id);
    if (!other || h.updatedAt >= other.updatedAt) byId.set(h.id, h);
  }
  return [...byId.values()];
}

export class HighlightStore {
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly platform: NodeJS.Platform;
  private readonly log: StoreLogger;
  private readonly coalesceMs: number;

  constructor(private readonly options: StoreOptions) {
    this.platform = options.platform ?? process.platform;
    this.log = options.log ?? silentLog;
    this.coalesceMs = options.coalesceMs ?? 200;
  }

  get directory(): string {
    return this.options.dir;
  }

  keyOf(ref: DocumentRef): string {
    return recordKey(ref, this.platform);
  }

  pathOf(key: string): string {
    return `${this.options.dir}/${key}.json`;
  }

  /** Loads the record for a document (cached). A document without highlights gets an empty, unsaved record. */
  async get(ref: DocumentRef): Promise<StoredRecord> {
    return (await this.entry(ref)).record;
  }

  /** Re-reads the record from disk, dropping the in-memory copy (pending writes are flushed first). */
  async reload(ref: DocumentRef): Promise<StoredRecord> {
    const key = this.keyOf(ref);
    await this.flushKey(key);
    this.entries.delete(key);
    return this.get(ref);
  }

  private async entry(ref: DocumentRef): Promise<Entry> {
    const key = this.keyOf(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      const loaded = await this.readFromDisk(key, ref);
      entry = this.entries.get(key) ?? {
        ref,
        record: loaded.record,
        diskMtimeMs: loaded.mtimeMs,
        deletedIds: new Set(),
        markerChanged: false,
        dirty: false,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async readFromDisk(key: string, ref: DocumentRef): Promise<{ record: StoredRecord; mtimeMs?: number }> {
    const file = this.pathOf(key);
    let text: string;
    let mtimeMs: number | undefined;
    try {
      text = await fs.readFile(file, 'utf8');
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { record: emptyRecord(ref) };
      throw err;
    }
    try {
      const record = sanitizeRecord(JSON.parse(text), ref);
      return { record, mtimeMs };
    } catch (err) {
      const movedTo = `${this.options.dir}/${key}.corrupt-${Date.now()}.json`;
      this.log.error(`Highlight data for ${ref.uri} is unreadable (${String(err)}); moved it to ${movedTo}`);
      await moveAside(file, movedTo).catch((moveErr: unknown) => this.log.error(`Could not move the corrupt file: ${String(moveErr)}`));
      this.options.onCorrupt?.(ref, movedTo);
      return { record: emptyRecord(ref) };
    }
  }

  /** Applies a change and schedules a coalesced write. */
  async update(ref: DocumentRef, mutate: (record: StoredRecord) => void): Promise<StoredRecord> {
    const entry = await this.entry(ref);
    const before = new Set(entry.record.highlights.map((h) => h.id));
    const markerBefore = JSON.stringify(entry.record.marker ?? null);
    mutate(entry.record);
    const after = new Set(entry.record.highlights.map((h) => h.id));
    for (const id of before) if (!after.has(id)) entry.deletedIds.add(id);
    // A highlight brought back (undo of a delete) must survive the next merge with other windows.
    for (const id of after) if (!before.has(id)) entry.deletedIds.delete(id);
    if (JSON.stringify(entry.record.marker ?? null) !== markerBefore) entry.markerChanged = true;
    entry.record.updatedAt = new Date().toISOString();
    entry.record.uri = ref.uri;
    entry.record.fsPath = ref.fsPath;
    entry.ref = ref;
    entry.dirty = true;
    this.schedule(this.keyOf(ref));
    return entry.record;
  }

  private schedule(key: string): void {
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.flushKey(key).catch((err: unknown) => this.log.error(`Saving highlight data failed: ${String(err)}`));
    }, this.coalesceMs);
    this.timers.set(key, timer);
  }

  /** Serializes all disk operations for one key. */
  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  private flushKey(key: string): Promise<void> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    return this.enqueue(key, () => this.writeEntry(key));
  }

  private async writeEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || !entry.dirty) return;
    entry.dirty = false;
    const file = this.pathOf(key);
    try {
      // Another VS Code window may have written this file since we read it: merge, don't clobber.
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && stat.mtimeMs !== entry.diskMtimeMs) {
        try {
          const theirs = sanitizeRecord(JSON.parse(await fs.readFile(file, 'utf8')), entry.ref);
          entry.record.highlights = mergeHighlights(entry.record.highlights, theirs.highlights, entry.deletedIds);
          if (!entry.markerChanged) {
            if (theirs.marker) entry.record.marker = theirs.marker;
            else delete entry.record.marker;
          }
        } catch {
          // Unreadable on disk: ours wins.
        }
      }
      if (!hasData(entry.record)) {
        await removeFile(file);
        entry.diskMtimeMs = undefined;
        return;
      }
      await writeFileAtomic(file, `${JSON.stringify(entry.record, null, 1)}\n`, this.options.writeHooks);
      entry.diskMtimeMs = (await fs.stat(file)).mtimeMs;
    } catch (err) {
      entry.dirty = true;
      throw err;
    }
  }

  /** Writes every pending change now. */
  async flush(): Promise<void> {
    const keys = new Set([...this.timers.keys(), ...[...this.entries].filter(([, e]) => e.dirty).map(([k]) => k)]);
    await Promise.all([...keys].map((key) => this.flushKey(key)));
    await Promise.all([...this.queues.values()]);
  }

  /** Forgets cached records that are not in `keep` (call when panels close). */
  evict(ref: DocumentRef): void {
    const key = this.keyOf(ref);
    const entry = this.entries.get(key);
    if (entry && !entry.dirty && !this.timers.has(key)) this.entries.delete(key);
  }

  /** Moves a document's record to a new path (file rename or move). Returns false if there was nothing to move. */
  async migrate(from: DocumentRef, to: DocumentRef): Promise<boolean> {
    const fromKey = this.keyOf(from);
    const toKey = this.keyOf(to);
    if (fromKey === toKey) {
      // Same key (e.g. a case-only rename on Windows): just update the stored path.
      const entry = await this.entry(from);
      if (!hasData(entry.record)) return false;
      await this.update(to, () => undefined);
      await this.flushKey(toKey);
      return true;
    }
    await this.flushKey(fromKey);
    const source = await this.entry(from);
    if (!hasData(source.record)) {
      this.entries.delete(fromKey);
      return false;
    }
    const target = await this.entry(to);
    const targetHadData = hasData(target.record);
    const moved = source.record;
    await this.update(to, (record) => {
      const existing = new Set(record.highlights.map((h) => h.id));
      record.highlights = [...record.highlights, ...moved.highlights.filter((h) => !existing.has(h.id))];
      record.view = targetHadData ? { ...moved.view, ...record.view } : { ...moved.view };
      if (moved.marker && !record.marker) record.marker = structuredClone(moved.marker);
    });
    await this.flushKey(toKey);
    await this.enqueue(fromKey, async () => {
      await removeFile(this.pathOf(fromKey));
    });
    this.entries.delete(fromKey);
    this.log.info(`Moved highlight data from ${from.uri} to ${to.uri}`);
    return true;
  }

  /** Lists all stored records (reads every file; used for folder renames and "Reattach"). */
  async list(): Promise<{ key: string; record: StoredRecord }[]> {
    await this.flush();
    let names: string[];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return [];
    }
    const out: { key: string; record: StoredRecord }[] = [];
    for (const name of names) {
      const match = /^([0-9a-f]{64})\.json$/.exec(name);
      if (!match) continue;
      const key = match[1];
      const cached = this.entries.get(key);
      if (cached) {
        out.push({ key, record: cached.record });
        continue;
      }
      try {
        const text = await fs.readFile(`${this.options.dir}/${name}`, 'utf8');
        const parsed = JSON.parse(text) as StoredRecord;
        out.push({ key, record: sanitizeRecord(parsed, { uri: parsed.uri, scheme: 'unknown', fsPath: parsed.fsPath }) });
      } catch {
        // Skip unreadable files here; they are handled when opened.
      }
    }
    return out;
  }

  /**
   * Migrates every record under a renamed folder. `toRef` builds the new reference from the new
   * file-system path (or URI string for non-file schemes).
   */
  async migrateFolder(from: DocumentRef, to: DocumentRef, toRef: (newPath: string) => DocumentRef): Promise<number> {
    const fromPrefix = normalizeKeyPath(from, this.platform);
    const sep = from.scheme === 'file' ? (this.platform === 'win32' ? '\\' : '/') : '/';
    let moved = 0;
    for (const { record } of await this.list()) {
      const ref: DocumentRef = record.fsPath
        ? { uri: record.uri, scheme: 'file', fsPath: record.fsPath }
        : { uri: record.uri, scheme: from.scheme };
      const normalized = normalizeKeyPath(ref, this.platform);
      if (!normalized.startsWith(fromPrefix + sep)) continue;
      const original = ref.scheme === 'file' && ref.fsPath ? ref.fsPath : ref.uri;
      const rest = original.slice(fromPrefix.length);
      const base = to.scheme === 'file' && to.fsPath ? to.fsPath : to.uri;
      if (await this.migrate(ref, toRef(base + rest))) moved++;
    }
    return moved;
  }

  /** Copies the highlights of another record into this document (used by "Reattach Highlights"). */
  async mergeInto(source: StoredRecord, target: DocumentRef): Promise<number> {
    let added = 0;
    await this.update(target, (record) => {
      const existing = new Set(record.highlights.map((h) => h.id));
      for (const h of source.highlights) {
        if (existing.has(h.id)) continue;
        record.highlights.push(structuredClone(h));
        added++;
      }
      if (record.view.zoom === undefined && source.view.zoom !== undefined) record.view.zoom = source.view.zoom;
    });
    return added;
  }

  /** Deletes the stored file of a record found through `list()`. */
  async deleteKey(key: string): Promise<void> {
    this.entries.delete(key);
    await this.enqueue(key, () => removeFile(this.pathOf(key)));
  }

  async ensureDirectory(): Promise<void> {
    await ensureDir(this.options.dir);
  }
}
