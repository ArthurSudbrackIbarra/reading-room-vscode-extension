// Per-file annotation and view storage in the extension's global storage folder:
//   <globalStorage>/highlights/<sha256(normalized path)>.json           highlights, marker, zoom
//   <globalStorage>/highlights/<sha256(normalized path)>.drawings.json  drawings
// Drawings live in their own file because 0.4.x rebuilds records from the fields it knows and
// would erase them; it never reads the companion file. Both files are written atomically, through
// one serialized and coalesced queue per document. No `vscode` import, so it is unit-testable.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import { sanitizeDrawing, type Drawing } from '../shared/drawings';
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
  /** Called when a corrupt record (or drawings file) had to be moved aside. */
  onCorrupt?: (ref: DocumentRef, movedTo: string) => void;
  /** Called when stored pen strokes had more points than allowed and were simplified to fit. */
  onSimplified?: (ref: DocumentRef, count: number) => void;
}

interface Entry {
  ref: DocumentRef;
  record: StoredRecord;
  /** mtime of the record file as last read or written by us; used to merge changes from other windows. */
  diskMtimeMs?: number;
  /** The same for the drawings file. */
  drawingsMtimeMs?: number;
  deletedIds: Set<string>;
  deletedDrawingIds: Set<string>;
  /** The reading marker was set or removed here since the last read, so ours wins over other windows. */
  markerChanged: boolean;
  dirty: boolean;
}

const SCHEMA_VERSION = 1;
const DRAWINGS_SCHEMA_VERSION = 1;
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
    drawings: [],
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

/** True when a record holds anything worth keeping files for (drawings included, so the record and its drawings stay together). */
export function hasData(record: StoredRecord): boolean {
  return record.highlights.length > 0 || record.view.zoom !== undefined || record.marker !== undefined || record.drawings.length > 0;
}

/**
 * Validates a parsed record file and fills in defaults. Throws if it is not a record at all.
 * Drawings are not part of the record file; they are read from the companion file.
 */
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
    drawings: [],
  };
}

interface DrawingsFile {
  schemaVersion: number;
  uri?: string;
  fsPath?: string;
  drawings: Drawing[];
  updatedAt?: string;
}

/**
 * Validates a parsed drawings file. Throws if it is not one (or is from a newer version); drops
 * invalid drawings and repeated ids. `onSimplified` counts strokes that were simplified to fit.
 */
export function sanitizeDrawingsFile(raw: unknown, onSimplified?: () => void): DrawingsFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a drawings object');
  const r = raw as Partial<Record<keyof DrawingsFile, unknown>>;
  if (typeof r.schemaVersion === 'number' && r.schemaVersion > DRAWINGS_SCHEMA_VERSION) {
    throw new Error(`drawings schema ${r.schemaVersion} is newer than this extension supports`);
  }
  const seen = new Set<string>();
  const drawings: Drawing[] = [];
  for (const value of Array.isArray(r.drawings) ? r.drawings : []) {
    const drawing = sanitizeDrawing(value, () => onSimplified?.());
    if (!drawing || seen.has(drawing.id)) continue;
    seen.add(drawing.id);
    drawings.push(drawing);
  }
  return {
    schemaVersion: DRAWINGS_SCHEMA_VERSION,
    uri: typeof r.uri === 'string' ? r.uri : undefined,
    fsPath: typeof r.fsPath === 'string' ? r.fsPath : undefined,
    drawings,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
  };
}

/** Merges two versions of a list by id: the newer change wins, ids deleted here stay deleted. */
function mergeById<T extends { id: string; updatedAt: string }>(ours: T[], theirs: T[], deletedIds: Set<string>): T[] {
  const byId = new Map<string, T>();
  for (const item of theirs) if (!deletedIds.has(item.id)) byId.set(item.id, item);
  for (const item of ours) {
    const other = byId.get(item.id);
    if (!other || item.updatedAt >= other.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** The record file's content: everything but the drawings. */
function recordFileText(record: StoredRecord): string {
  const { drawings: _drawings, ...rest } = record;
  return `${JSON.stringify(rest, null, 1)}\n`;
}

function drawingsFileText(record: StoredRecord): string {
  const file: DrawingsFile = {
    schemaVersion: DRAWINGS_SCHEMA_VERSION,
    uri: record.uri,
    fsPath: record.fsPath,
    drawings: record.drawings,
    updatedAt: record.updatedAt,
  };
  return `${JSON.stringify(file)}\n`;
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

  drawingsPathOf(key: string): string {
    return `${this.options.dir}/${key}.drawings.json`;
  }

  /** Loads the record for a document (cached). A document without annotations gets an empty, unsaved record. */
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
        drawingsMtimeMs: loaded.drawingsMtimeMs,
        deletedIds: new Set(),
        deletedDrawingIds: new Set(),
        markerChanged: false,
        dirty: false,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async readFromDisk(key: string, ref: DocumentRef): Promise<{ record: StoredRecord; mtimeMs?: number; drawingsMtimeMs?: number }> {
    const record = await this.readRecordFile(key, ref);
    const drawings = await this.readDrawingsFile(key, ref);
    const result = record?.record ?? emptyRecord(ref);
    result.drawings = drawings?.drawings ?? [];
    return { record: result, mtimeMs: record?.mtimeMs, drawingsMtimeMs: drawings?.mtimeMs };
  }

  private async readRecordFile(key: string, ref: DocumentRef): Promise<{ record: StoredRecord; mtimeMs: number } | undefined> {
    const file = this.pathOf(key);
    const read = await this.readText(file);
    if (!read) return undefined;
    try {
      return { record: sanitizeRecord(JSON.parse(read.text), ref), mtimeMs: read.mtimeMs };
    } catch (err) {
      await this.moveCorrupt(file, `${this.options.dir}/${key}.corrupt-${Date.now()}.json`, ref, 'Highlight data', err);
      return undefined;
    }
  }

  private async readDrawingsFile(key: string, ref: DocumentRef): Promise<{ drawings: Drawing[]; mtimeMs: number } | undefined> {
    const file = this.drawingsPathOf(key);
    const read = await this.readText(file);
    if (!read) return undefined;
    try {
      let simplified = 0;
      const parsed = sanitizeDrawingsFile(JSON.parse(read.text), () => simplified++);
      if (simplified > 0) {
        this.log.warn(`${simplified} stored drawing(s) of ${ref.uri} had more points than allowed and were simplified to fit`);
        this.options.onSimplified?.(ref, simplified);
      }
      return { drawings: parsed.drawings, mtimeMs: read.mtimeMs };
    } catch (err) {
      await this.moveCorrupt(file, `${this.options.dir}/${key}.drawings.corrupt-${Date.now()}.json`, ref, 'Drawings', err);
      return undefined;
    }
  }

  private async readText(file: string): Promise<{ text: string; mtimeMs: number } | undefined> {
    try {
      const text = await fs.readFile(file, 'utf8');
      const mtimeMs = (await fs.stat(file)).mtimeMs;
      return { text, mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async moveCorrupt(file: string, movedTo: string, ref: DocumentRef, what: string, err: unknown): Promise<void> {
    this.log.error(`${what} for ${ref.uri} is unreadable (${String(err)}); moved it to ${movedTo}`);
    await moveAside(file, movedTo).catch((moveErr: unknown) => this.log.error(`Could not move the corrupt file: ${String(moveErr)}`));
    this.options.onCorrupt?.(ref, movedTo);
  }

  /** Applies a change and schedules a coalesced write. */
  async update(ref: DocumentRef, mutate: (record: StoredRecord) => void): Promise<StoredRecord> {
    const entry = await this.entry(ref);
    const before = new Set(entry.record.highlights.map((h) => h.id));
    const drawingsBefore = new Set(entry.record.drawings.map((d) => d.id));
    const markerBefore = JSON.stringify(entry.record.marker ?? null);
    mutate(entry.record);
    const after = new Set(entry.record.highlights.map((h) => h.id));
    for (const id of before) if (!after.has(id)) entry.deletedIds.add(id);
    // A highlight brought back (undo of a delete) must survive the next merge with other windows.
    for (const id of after) if (!before.has(id)) entry.deletedIds.delete(id);
    const drawingsAfter = new Set(entry.record.drawings.map((d) => d.id));
    for (const id of drawingsBefore) if (!drawingsAfter.has(id)) entry.deletedDrawingIds.add(id);
    for (const id of drawingsAfter) if (!drawingsBefore.has(id)) entry.deletedDrawingIds.delete(id);
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
    const drawingsFile = this.drawingsPathOf(key);
    try {
      // Another VS Code window may have written these files since we read them: merge, don't clobber.
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && stat.mtimeMs !== entry.diskMtimeMs) {
        try {
          const theirs = sanitizeRecord(JSON.parse(await fs.readFile(file, 'utf8')), entry.ref);
          entry.record.highlights = mergeById(entry.record.highlights, theirs.highlights, entry.deletedIds);
          if (!entry.markerChanged) {
            if (theirs.marker) entry.record.marker = theirs.marker;
            else delete entry.record.marker;
          }
        } catch {
          // Unreadable on disk: ours wins.
        }
      }
      const drawingsStat = await fs.stat(drawingsFile).catch(() => undefined);
      if (drawingsStat && drawingsStat.mtimeMs !== entry.drawingsMtimeMs) {
        try {
          const theirs = sanitizeDrawingsFile(JSON.parse(await fs.readFile(drawingsFile, 'utf8')));
          entry.record.drawings = mergeById(entry.record.drawings, theirs.drawings, entry.deletedDrawingIds);
        } catch {
          // Unreadable on disk: ours wins.
        }
      }
      if (!hasData(entry.record)) {
        await removeFile(drawingsFile);
        await removeFile(file);
        entry.diskMtimeMs = undefined;
        entry.drawingsMtimeMs = undefined;
        return;
      }
      // Drawings first: when the record is on disk, its drawings are too.
      if (entry.record.drawings.length > 0) {
        await writeFileAtomic(drawingsFile, drawingsFileText(entry.record), this.options.writeHooks);
        entry.drawingsMtimeMs = (await fs.stat(drawingsFile)).mtimeMs;
      } else if (drawingsStat) {
        await removeFile(drawingsFile);
        entry.drawingsMtimeMs = undefined;
      }
      await writeFileAtomic(file, recordFileText(entry.record), this.options.writeHooks);
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

  /** Moves a document's annotations to a new path (file rename or move). Returns false if there was nothing to move. */
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
      const existingDrawings = new Set(record.drawings.map((d) => d.id));
      record.drawings = [...record.drawings, ...moved.drawings.filter((d) => !existingDrawings.has(d.id))];
      record.view = targetHadData ? { ...moved.view, ...record.view } : { ...moved.view };
      if (moved.marker && !record.marker) record.marker = structuredClone(moved.marker);
    });
    await this.flushKey(toKey);
    await this.enqueue(fromKey, async () => {
      await removeFile(this.drawingsPathOf(fromKey));
      await removeFile(this.pathOf(fromKey));
    });
    this.entries.delete(fromKey);
    this.log.info(`Moved highlight data from ${from.uri} to ${to.uri}`);
    return true;
  }

  /**
   * Lists all stored records (reads every file; used for folder renames and "Reattach"). Drawings
   * whose record file is gone (0.4.x deletes a record it thinks is empty) are listed too.
   */
  async list(): Promise<{ key: string; record: StoredRecord }[]> {
    await this.flush();
    let names: string[];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return [];
    }
    const keys = new Set<string>();
    for (const name of names) {
      const match = /^([0-9a-f]{64})(\.drawings)?\.json$/.exec(name);
      if (match) keys.add(match[1]);
    }
    const out: { key: string; record: StoredRecord }[] = [];
    for (const key of keys) {
      const cached = this.entries.get(key);
      if (cached) {
        out.push({ key, record: cached.record });
        continue;
      }
      const record = await this.readListed(key);
      if (record) out.push({ key, record });
    }
    return out;
  }

  /** Reads a record and its drawings for `list()`; unreadable files are skipped (they are handled when opened). */
  private async readListed(key: string): Promise<StoredRecord | undefined> {
    let record: StoredRecord | undefined;
    try {
      const read = await this.readText(this.pathOf(key));
      if (read) {
        const parsed = JSON.parse(read.text) as StoredRecord;
        record = sanitizeRecord(parsed, { uri: parsed.uri, scheme: 'unknown', fsPath: parsed.fsPath });
      }
    } catch {
      // Skip.
    }
    try {
      const read = await this.readText(this.drawingsPathOf(key));
      if (read) {
        const drawings = sanitizeDrawingsFile(JSON.parse(read.text));
        if (!record && drawings.uri) {
          record = { ...emptyRecord({ uri: drawings.uri, scheme: 'unknown', fsPath: drawings.fsPath }), updatedAt: drawings.updatedAt ?? new Date(0).toISOString() };
        }
        if (record) record.drawings = drawings.drawings;
      }
    } catch {
      // Skip.
    }
    return record;
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

  /** Copies the highlights and drawings of another record into this document (used by "Reattach"). */
  async mergeInto(source: StoredRecord, target: DocumentRef): Promise<{ highlights: number; drawings: number }> {
    let highlights = 0;
    let drawings = 0;
    await this.update(target, (record) => {
      const existing = new Set(record.highlights.map((h) => h.id));
      for (const h of source.highlights) {
        if (existing.has(h.id)) continue;
        record.highlights.push(structuredClone(h));
        highlights++;
      }
      const existingDrawings = new Set(record.drawings.map((d) => d.id));
      for (const d of source.drawings) {
        if (existingDrawings.has(d.id)) continue;
        record.drawings.push(structuredClone(d));
        drawings++;
      }
      if (record.view.zoom === undefined && source.view.zoom !== undefined) record.view.zoom = source.view.zoom;
    });
    return { highlights, drawings };
  }

  /** Deletes the stored files of a record found through `list()`. */
  async deleteKey(key: string): Promise<void> {
    this.entries.delete(key);
    await this.enqueue(key, async () => {
      await removeFile(this.drawingsPathOf(key));
      await removeFile(this.pathOf(key));
    });
  }

  async ensureDirectory(): Promise<void> {
    await ensureDir(this.options.dir);
  }
}
