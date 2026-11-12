// Per-file annotation and view storage in the extension's global storage folder:
//   <globalStorage>/highlights/<key>.json            highlights, marker, zoom       (format of 0.3)
//   <globalStorage>/highlights/<key>.drawings.json   drawings and text boxes        (format of 0.6)
//   <globalStorage>/highlights/<key>.anchors.json    what annotations are anchored to, and where
//                                                    their content was last found
//   <globalStorage>/highlights/<key>.text-<hash>.gz  the text of versions annotations were last
//                                                    found in (so they can be followed by diff)
// with <key> = sha256(normalized path).
//
// Earlier versions rebuild the files they know from the fields they know, so everything newer
// lives in files they never read: they cannot erase it, and their files keep their format. A file
// from a newer version than this one is opened read-only instead of being treated as corrupt.
//
// All files are written atomically, through one serialized and coalesced queue per document.
// No `vscode` import, so it is unit-testable.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { posix, win32 } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sanitizeAnchor, sanitizeState, type AnchorState, type TextAnchor } from '../anchoring/anchor';
import { sanitizeBinding, type DrawingBinding } from '../anchoring/binding';
import { TEXT_MODEL_VERSION } from '../anchoring/textModel';
import { sanitizeDrawing, type Drawing } from '../shared/drawings';
import { MAX_NOTE_LENGTH, isHighlightColor, isReadingMarker, isZoomValue, type Highlight, type ReadingMarker, type StoredRecord, type ViewState } from '../shared/types';
import { ensureDir, moveAside, moveFile, removeFile, writeFileAtomic, type AtomicWriteHooks } from './atomicWrite';

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
  /** Called when a document's data was written by a newer version: it is shown, and changes are not stored. */
  onReadOnly?: (ref: DocumentRef) => void;
}

interface Mtimes {
  record?: number;
  drawings?: number;
  anchors?: number;
}

interface Entry {
  ref: DocumentRef;
  record: StoredRecord;
  /** mtimes of the files as last read or written by us; used to merge changes from other windows. */
  mtimes: Mtimes;
  /**
   * What we last wrote to the drawings and anchors files, without their time stamp: a change that
   * touches neither (the zoom, a note, a color) does not write them again.
   */
  written?: { drawings?: string; anchors?: string };
  deletedIds: Set<string>;
  deletedDrawingIds: Set<string>;
  /** When the reader last placed or removed the marker here; a marker another window made later wins. */
  markerActedAt?: string;
  dirty: boolean;
  /** Written by a newer version: never written by this one. */
  readOnly: boolean;
  /** Files moved aside by an older version whose data was taken back in; removed once it is written. */
  recovered: string[];
}

const SCHEMA_VERSION = 1;
const DRAWINGS_SCHEMA_VERSION = 1;
const ANCHORS_SCHEMA_VERSION = 1;
/** Most text snapshots kept per document, and their total size on disk (compressed). */
export const MAX_SNAPSHOTS = 12;
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
/** Texts longer than this are not kept (anchoring falls back to searching). */
export const MAX_SNAPSHOT_CHARS = 8_000_000;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

/**
 * Cleans a highlight in place (defaults, note length, anchor). Fields this version does not know
 * stay on the object. Returns undefined if it is not a highlight.
 */
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
  const anchor = sanitizeAnchor(h.anchor);
  if (anchor) h.anchor = anchor;
  else delete h.anchor;
  const state = h.state === undefined ? undefined : sanitizeState(h.state);
  if (state) h.state = state;
  else delete h.state;
  return h;
}

const MARKER_FIELDS = new Set(['pageIndex', 'y', 'selector', 'createdAt', 'anchor', 'rel', 'state']);

/** Validates a reading marker and returns a clean copy, or undefined if it is not usable. Unknown fields are kept. */
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
  const anchor = sanitizeAnchor(value.anchor);
  if (anchor) marker.anchor = anchor;
  const rel = value.rel as { pages?: unknown; dy?: unknown } | undefined;
  if (anchor && rel && Number.isInteger(rel.pages) && typeof rel.dy === 'number' && Number.isFinite(rel.dy)) {
    marker.rel = { pages: Math.max(0, Math.min(100_000, rel.pages as number)), dy: Math.max(-1e5, Math.min(1e5, rel.dy)) };
  }
  const state = value.state === undefined ? undefined : sanitizeState(value.state);
  if (state) marker.state = state;
  for (const [key, extra] of Object.entries(value as unknown as Record<string, unknown>)) {
    if (!MARKER_FIELDS.has(key) && extra !== undefined) (marker as unknown as Record<string, unknown>)[key] = extra;
  }
  return marker;
}

/** What the reader placed: the marker without what the viewer derives. */
function markerIntent(marker: ReadingMarker | undefined): string {
  return marker ? JSON.stringify([marker.pageIndex, marker.y, marker.selector ?? null, marker.createdAt]) : 'null';
}

/** True when a record holds anything worth keeping files for (drawings included, so the record and its drawings stay together). */
export function hasData(record: StoredRecord): boolean {
  return record.highlights.length > 0 || record.view.zoom !== undefined || record.marker !== undefined || record.drawings.length > 0;
}

const RECORD_FIELDS = new Set(['schemaVersion', 'uri', 'fsPath', 'view', 'highlights', 'marker', 'updatedAt', 'drawings', 'pages', 'extra']);

/** Whether a parsed file was written with a newer format than this version knows. */
export function isNewerSchema(raw: unknown, supported = SCHEMA_VERSION): boolean {
  return isObject(raw) && typeof raw.schemaVersion === 'number' && raw.schemaVersion > supported;
}

/**
 * Validates a parsed record file and fills in defaults. Throws if it is not a record at all.
 * A record of a newer format is read as far as this version understands it (the store opens it
 * read-only). Drawings and anchors are not part of the record file; they come from their own files.
 */
export function sanitizeRecord(raw: unknown, ref: DocumentRef): StoredRecord {
  if (!isObject(raw)) throw new Error('not a record object');
  const r = raw as Partial<StoredRecord>;
  const view: ViewState = {};
  if (r.view && isZoomValue(r.view.zoom)) view.zoom = r.view.zoom;
  const highlights = Array.isArray(r.highlights) ? r.highlights.map(sanitizeHighlight).filter((h): h is Highlight => h !== undefined) : [];
  const marker = sanitizeMarker(r.marker);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!RECORD_FIELDS.has(key) && value !== undefined) extra[key] = value;
  return {
    schemaVersion: SCHEMA_VERSION,
    uri: typeof r.uri === 'string' ? r.uri : ref.uri,
    fsPath: typeof r.fsPath === 'string' ? r.fsPath : ref.fsPath,
    view,
    highlights,
    ...(marker ? { marker } : {}),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    drawings: [],
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
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
 * Validates a parsed drawings file. Throws if it is not one; drops invalid drawings and repeated
 * ids. `onSimplified` counts strokes that were simplified to fit.
 */
export function sanitizeDrawingsFile(raw: unknown, onSimplified?: () => void): DrawingsFile {
  if (!isObject(raw)) throw new Error('not a drawings object');
  const r = raw as Partial<Record<keyof DrawingsFile, unknown>>;
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

/** What the anchors file holds, per annotation. */
interface AnchorsFile {
  highlights: Map<string, { anchor?: TextAnchor; state?: AnchorState }>;
  marker?: { for: string; anchor?: TextAnchor; rel?: { pages: number; dy: number }; state?: AnchorState };
  drawings: Map<string, { binding?: DrawingBinding; states?: (AnchorState | undefined)[] }>;
  pages?: string[];
}

/** Validates a parsed anchors file. Throws if it is not one. Everything doubtful is dropped: it can be derived again. */
export function sanitizeAnchorsFile(raw: unknown): AnchorsFile {
  if (!isObject(raw)) throw new Error('not an anchors object');
  const out: AnchorsFile = { highlights: new Map(), drawings: new Map() };
  // Positions made with another way of reading the text are not positions in this one.
  const sameModel = raw.textModelVersion === TEXT_MODEL_VERSION;
  if (isObject(raw.highlights)) {
    for (const [id, value] of Object.entries(raw.highlights)) {
      if (!isObject(value)) continue;
      const anchor = sanitizeAnchor(value.anchor);
      const state = sameModel && value.state !== undefined ? sanitizeState(value.state) : undefined;
      if (anchor || state) out.highlights.set(id, { ...(anchor ? { anchor } : {}), ...(state ? { state } : {}) });
    }
  }
  if (isObject(raw.marker) && typeof raw.marker.for === 'string') {
    const marker = sanitizeMarker({
      pageIndex: 0,
      y: 0,
      createdAt: raw.marker.for,
      anchor: raw.marker.anchor,
      rel: raw.marker.rel,
      state: sameModel ? raw.marker.state : undefined,
    });
    if (marker && (marker.anchor || marker.state)) {
      out.marker = {
        for: raw.marker.for,
        ...(marker.anchor ? { anchor: marker.anchor } : {}),
        ...(marker.rel ? { rel: marker.rel } : {}),
        ...(marker.state ? { state: marker.state } : {}),
      };
    }
  }
  if (isObject(raw.drawings)) {
    for (const [id, value] of Object.entries(raw.drawings)) {
      if (!isObject(value)) continue;
      const binding = sanitizeBinding(value.binding);
      if (!binding) continue;
      const states = sameModel && Array.isArray(value.states) ? value.states.slice(0, 2).map((s) => sanitizeState(s)) : undefined;
      out.drawings.set(id, { binding, ...(states ? { states } : {}) });
    }
  }
  if (Array.isArray(raw.pages)) out.pages = raw.pages.filter((p): p is string => typeof p === 'string' && p.length <= 200).slice(0, 100_000);
  return out;
}

/** Puts what the anchors file holds onto the annotations of a record. */
function joinAnchors(record: StoredRecord, anchors: AnchorsFile): void {
  for (const h of record.highlights) {
    const entry = anchors.highlights.get(h.id);
    if (entry?.anchor && entry.anchor.exact === h.target.selector[0].exact) {
      h.anchor = entry.anchor;
      if (entry.state) h.state = entry.state;
    }
  }
  if (record.marker && anchors.marker && anchors.marker.for === record.marker.createdAt) {
    if (anchors.marker.anchor) record.marker.anchor = anchors.marker.anchor;
    if (anchors.marker.rel) record.marker.rel = anchors.marker.rel;
    if (anchors.marker.state) record.marker.state = anchors.marker.state;
  }
  for (const d of record.drawings) {
    const entry = anchors.drawings.get(d.id);
    if (!entry?.binding) continue;
    d.binding = entry.binding;
    if (entry.states) d.anchorStates = entry.states;
  }
  if (anchors.pages) record.pages = anchors.pages;
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

/** The record file's content: the format earlier versions read, without drawings and anchors. */
function recordFileText(record: StoredRecord): string {
  const { drawings: _drawings, pages: _pages, extra, ...rest } = record;
  const file = {
    ...(extra ?? {}),
    ...rest,
    highlights: record.highlights.map(({ anchor: _anchor, state: _state, ...h }) => h),
    ...(record.marker ? { marker: (({ anchor: _anchor, rel: _rel, state: _state, ...m }) => m)(record.marker) } : {}),
  };
  return `${JSON.stringify(file, null, 1)}\n`;
}

function drawingsFileText(record: StoredRecord): string {
  const file: DrawingsFile = {
    schemaVersion: DRAWINGS_SCHEMA_VERSION,
    uri: record.uri,
    fsPath: record.fsPath,
    drawings: record.drawings.map(({ binding: _binding, anchorStates: _states, ...d }) => d as Drawing),
    updatedAt: record.updatedAt,
  };
  return `${JSON.stringify(file)}\n`;
}

/** The anchors file's content, or undefined when there is nothing to keep in it. */
function anchorsFileText(record: StoredRecord): string | undefined {
  const highlights: Record<string, unknown> = {};
  for (const h of record.highlights) if (h.anchor) highlights[h.id] = { anchor: h.anchor, ...(h.state ? { state: h.state } : {}) };
  const drawings: Record<string, unknown> = {};
  for (const d of record.drawings) if (d.binding) drawings[d.id] = { binding: d.binding, ...(d.anchorStates ? { states: d.anchorStates } : {}) };
  const m = record.marker;
  const marker =
    m && (m.anchor || m.state)
      ? { for: m.createdAt, ...(m.anchor ? { anchor: m.anchor } : {}), ...(m.rel ? { rel: m.rel } : {}), ...(m.state ? { state: m.state } : {}) }
      : undefined;
  if (Object.keys(highlights).length === 0 && Object.keys(drawings).length === 0 && !marker && !record.pages?.length) return undefined;
  return `${JSON.stringify({
    schemaVersion: ANCHORS_SCHEMA_VERSION,
    textModelVersion: TEXT_MODEL_VERSION,
    uri: record.uri,
    fsPath: record.fsPath,
    highlights,
    ...(marker ? { marker } : {}),
    drawings,
    ...(record.pages?.length ? { pages: record.pages } : {}),
    updatedAt: record.updatedAt,
  })}\n`;
}

/** A drawings or anchors file's text without its last field, the time it was written. */
function withoutStamp(text: string): string {
  const at = text.lastIndexOf(',"updatedAt":"');
  return at < 0 ? text : text.slice(0, at);
}

/** The text versions the annotations of a record were last found in. */
export function referencedHashes(record: StoredRecord): Set<string> {
  const out = new Set<string>();
  const add = (state: AnchorState | undefined) => {
    if (state?.found?.hash) out.add(state.found.hash);
  };
  for (const h of record.highlights) add(h.state);
  add(record.marker?.state);
  for (const d of record.drawings) for (const s of d.anchorStates ?? []) add(s);
  return out;
}

const HASH = /^[0-9a-f]{6,64}$/;

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

  anchorsPathOf(key: string): string {
    return `${this.options.dir}/${key}.anchors.json`;
  }

  snapshotPathOf(key: string, hash: string): string {
    return `${this.options.dir}/${key}.text-${hash}.gz`;
  }

  /** Loads the record for a document (cached). A document without annotations gets an empty, unsaved record. */
  async get(ref: DocumentRef): Promise<StoredRecord> {
    return (await this.entry(ref)).record;
  }

  /** Whether the document's data was written by a newer version (it is shown; changes are not stored). */
  async isReadOnly(ref: DocumentRef): Promise<boolean> {
    return (await this.entry(ref)).readOnly;
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
      const loaded = await this.readFromDisk(key, ref, true);
      entry = this.entries.get(key) ?? {
        ref,
        record: loaded.record,
        mtimes: loaded.mtimes,
        deletedIds: new Set(),
        deletedDrawingIds: new Set(),
        dirty: loaded.recovered.length > 0,
        readOnly: loaded.readOnly,
        recovered: loaded.recovered,
      };
      this.entries.set(key, entry);
      if (entry.dirty) this.schedule(key);
    }
    return entry;
  }

  /**
   * Reads the three files of a document into one record. With `repair`, unreadable files are
   * moved aside and data an older version moved aside is taken back in.
   */
  private async readFromDisk(key: string, ref: DocumentRef, repair: boolean): Promise<{ record: StoredRecord; mtimes: Mtimes; readOnly: boolean; recovered: string[] }> {
    const mtimes: Mtimes = {};
    let readOnly = false;
    const recovered: string[] = [];
    let record: StoredRecord | undefined;

    const main = await this.readJson(this.pathOf(key));
    if (main) {
      try {
        record = sanitizeRecord(main.json, ref);
        if (isNewerSchema(main.json)) readOnly = true;
        mtimes.record = main.mtimeMs;
      } catch (err) {
        if (!repair) throw err;
        await this.moveCorrupt(this.pathOf(key), `${this.options.dir}/${key}.corrupt-${Date.now()}.json`, ref, 'Highlight data', err);
      }
    } else if (main === null && repair) {
      await this.moveCorrupt(this.pathOf(key), `${this.options.dir}/${key}.corrupt-${Date.now()}.json`, ref, 'Highlight data', 'not valid JSON');
    }
    const result = record ?? emptyRecord(ref);

    const drawn = await this.readJson(this.drawingsPathOf(key));
    if (drawn) {
      try {
        let simplified = 0;
        const parsed = sanitizeDrawingsFile(drawn.json, () => simplified++);
        if (isNewerSchema(drawn.json, DRAWINGS_SCHEMA_VERSION)) readOnly = true;
        if (simplified > 0 && repair) {
          this.log.warn(`${simplified} stored drawing(s) of ${ref.uri} had more points than allowed and were simplified to fit`);
          this.options.onSimplified?.(ref, simplified);
        }
        result.drawings = parsed.drawings;
        mtimes.drawings = drawn.mtimeMs;
      } catch (err) {
        if (!repair) throw err;
        await this.moveCorrupt(this.drawingsPathOf(key), `${this.options.dir}/${key}.drawings.corrupt-${Date.now()}.json`, ref, 'Drawings', err);
      }
    } else if (drawn === null && repair) {
      await this.moveCorrupt(this.drawingsPathOf(key), `${this.options.dir}/${key}.drawings.corrupt-${Date.now()}.json`, ref, 'Drawings', 'not valid JSON');
    }

    if (repair) await this.recoverAside(key, ref, result, recovered);

    const anchors = await this.readJson(this.anchorsPathOf(key));
    if (anchors) {
      mtimes.anchors = anchors.mtimeMs;
      if (isNewerSchema(anchors.json, ANCHORS_SCHEMA_VERSION)) {
        // A newer version's anchors: not understood here, and not to be overwritten.
        readOnly = true;
      } else {
        try {
          joinAnchors(result, sanitizeAnchorsFile(anchors.json));
        } catch (err) {
          // Only derived data and wider context: annotations fall back to what the record holds.
          this.log.warn(`Anchors of ${ref.uri} are unreadable (${String(err)}); they will be made again`);
        }
      }
    } else if (anchors === null) {
      this.log.warn(`Anchors of ${ref.uri} are not valid JSON; they will be made again`);
    }
    return { record: result, mtimes, readOnly, recovered };
  }

  /**
   * Takes back data that an older version moved aside as "corrupt" because it was written in a
   * format newer than it knew, and that this version can read. Annotations already in the record
   * are kept as they are.
   */
  private async recoverAside(key: string, ref: DocumentRef, record: StoredRecord, recovered: string[]): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return;
    }
    const aside = names
      .filter((n) => n.startsWith(`${key}.`) && /\.corrupt-\d+\.json$/.test(n))
      .sort()
      .reverse();
    for (const name of aside) {
      const file = `${this.options.dir}/${name}`;
      const read = await this.readJson(file);
      if (!read) continue;
      try {
        if (name.startsWith(`${key}.drawings.`)) {
          if (isNewerSchema(read.json, DRAWINGS_SCHEMA_VERSION)) continue;
          const parsed = sanitizeDrawingsFile(read.json);
          const have = new Set(record.drawings.map((d) => d.id));
          const added = parsed.drawings.filter((d) => !have.has(d.id));
          if (added.length === 0) continue;
          record.drawings.push(...added);
        } else {
          if (isNewerSchema(read.json)) continue;
          const parsed = sanitizeRecord(read.json, ref);
          if (!hasData(parsed)) continue;
          const have = new Set(record.highlights.map((h) => h.id));
          record.highlights.push(...parsed.highlights.filter((h) => !have.has(h.id)));
          if (!record.marker && parsed.marker) record.marker = parsed.marker;
          if (record.view.zoom === undefined && parsed.view.zoom !== undefined) record.view.zoom = parsed.view.zoom;
          if (parsed.extra && !record.extra) record.extra = parsed.extra;
        }
        recovered.push(file);
        this.log.info(`Took back annotations of ${ref.uri} from ${name}, which an older version had moved aside`);
      } catch {
        // Really unreadable: it stays where it is.
      }
    }
  }

  /** Reads and parses a JSON file: undefined if it does not exist, null if it is not JSON. */
  private async readJson(file: string): Promise<{ json: unknown; mtimeMs: number } | undefined | null> {
    let text: string;
    let mtimeMs: number;
    try {
      text = await fs.readFile(file, 'utf8');
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      return { json: JSON.parse(text), mtimeMs };
    } catch {
      return null;
    }
  }

  private async moveCorrupt(file: string, movedTo: string, ref: DocumentRef, what: string, err: unknown): Promise<void> {
    this.log.error(`${what} for ${ref.uri} is unreadable (${String(err)}); moved it to ${movedTo}`);
    await moveAside(file, movedTo).catch((moveErr: unknown) => this.log.error(`Could not move the corrupt file: ${String(moveErr)}`));
    this.options.onCorrupt?.(ref, movedTo);
  }

  /**
   * Applies a change and schedules a coalesced write. Derived data (statuses, positions, states)
   * is changed the same way; only a change of what the reader made counts as theirs when windows
   * merge. On a read-only document nothing is changed. A change that returns `false` changed
   * nothing: no write is scheduled.
   */
  async update(ref: DocumentRef, mutate: (record: StoredRecord) => unknown): Promise<StoredRecord> {
    const entry = await this.entry(ref);
    if (entry.readOnly) {
      this.options.onReadOnly?.(ref);
      return entry.record;
    }
    const before = new Set(entry.record.highlights.map((h) => h.id));
    const drawingsBefore = new Set(entry.record.drawings.map((d) => d.id));
    const markerBefore = markerIntent(entry.record.marker);
    // `false` from the change says that nothing was changed: nothing is written then.
    if (mutate(entry.record) === false) return entry.record;
    const after = new Set(entry.record.highlights.map((h) => h.id));
    for (const id of before) if (!after.has(id)) entry.deletedIds.add(id);
    // A highlight brought back (undo of a delete) must survive the next merge with other windows.
    for (const id of after) if (!before.has(id)) entry.deletedIds.delete(id);
    const drawingsAfter = new Set(entry.record.drawings.map((d) => d.id));
    for (const id of drawingsBefore) if (!drawingsAfter.has(id)) entry.deletedDrawingIds.add(id);
    for (const id of drawingsAfter) if (!drawingsBefore.has(id)) entry.deletedDrawingIds.delete(id);
    // Only placing or removing the marker is the reader's doing; where it was found again is not.
    if (markerIntent(entry.record.marker) !== markerBefore) entry.markerActedAt = new Date().toISOString();
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

  private async mtimeOf(file: string): Promise<number | undefined> {
    return (await fs.stat(file).catch(() => undefined))?.mtimeMs;
  }

  private async writeEntry(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || !entry.dirty || entry.readOnly) return;
    entry.dirty = false;
    const file = this.pathOf(key);
    const drawingsFile = this.drawingsPathOf(key);
    const anchorsFile = this.anchorsPathOf(key);
    try {
      // Another VS Code window may have written these files since we read them: merge, don't clobber.
      const [recordNow, drawingsNow, anchorsNow] = await Promise.all([this.mtimeOf(file), this.mtimeOf(drawingsFile), this.mtimeOf(anchorsFile)]);
      const changed =
        (recordNow !== undefined && recordNow !== entry.mtimes.record) ||
        (drawingsNow !== undefined && drawingsNow !== entry.mtimes.drawings) ||
        (anchorsNow !== undefined && anchorsNow !== entry.mtimes.anchors);
      if (changed) {
        try {
          const theirs = await this.readFromDisk(key, entry.ref, false);
          if (theirs.readOnly) {
            // A newer version took the document over: stop writing.
            entry.readOnly = true;
            this.options.onReadOnly?.(entry.ref);
            return;
          }
          this.merge(entry, theirs.record, { record: recordNow !== entry.mtimes.record, drawings: drawingsNow !== entry.mtimes.drawings });
        } catch {
          // Unreadable on disk: ours wins.
        }
        // What is on disk is no longer what we wrote.
        entry.written = {};
      }
      const written = (entry.written ??= {});
      if (!hasData(entry.record)) {
        await removeFile(anchorsFile);
        await removeFile(drawingsFile);
        await removeFile(file);
        await this.removeSnapshots(key);
        entry.mtimes = {};
        entry.written = {};
      } else {
        // The record last: when it is on disk, its drawings and anchors are too. Those two are
        // written only when what they hold changed (or the file is not there).
        if (entry.record.drawings.length > 0) {
          const text = drawingsFileText(entry.record);
          const body = withoutStamp(text);
          if (drawingsNow === undefined || written.drawings !== body) {
            await writeFileAtomic(drawingsFile, text, this.options.writeHooks);
            entry.mtimes.drawings = await this.mtimeOf(drawingsFile);
            written.drawings = body;
          }
        } else if (drawingsNow !== undefined) {
          await removeFile(drawingsFile);
          entry.mtimes.drawings = undefined;
          written.drawings = undefined;
        }
        const anchors = anchorsFileText(entry.record);
        if (anchors !== undefined) {
          const body = withoutStamp(anchors);
          if (anchorsNow === undefined || written.anchors !== body) {
            await writeFileAtomic(anchorsFile, anchors, this.options.writeHooks);
            entry.mtimes.anchors = await this.mtimeOf(anchorsFile);
            written.anchors = body;
          }
        } else if (anchorsNow !== undefined) {
          await removeFile(anchorsFile);
          entry.mtimes.anchors = undefined;
          written.anchors = undefined;
        }
        await writeFileAtomic(file, recordFileText(entry.record), this.options.writeHooks);
        entry.mtimes.record = await this.mtimeOf(file);
      }
      for (const aside of entry.recovered.splice(0)) await removeFile(aside);
    } catch (err) {
      entry.dirty = true;
      throw err;
    }
  }

  /**
   * Merges what another window wrote into ours. What the reader made wins by its `updatedAt`
   * (a marker: by when it was placed); derived data comes along with the version that wins and
   * never decides anything.
   */
  private merge(entry: Entry, theirs: StoredRecord, changed: { record: boolean; drawings: boolean }): void {
    if (changed.record) {
      entry.record.highlights = mergeById(entry.record.highlights, theirs.highlights, entry.deletedIds);
      const acted = entry.markerActedAt;
      const theirsIsNewer = theirs.marker !== undefined && (acted === undefined || theirs.marker.createdAt > acted);
      if (acted === undefined || theirsIsNewer) {
        if (theirs.marker) {
          // The same marker: keep what we derived for it.
          if (markerIntent(theirs.marker) !== markerIntent(entry.record.marker)) entry.record.marker = theirs.marker;
        } else {
          delete entry.record.marker;
        }
      }
      if (theirs.extra && !entry.record.extra) entry.record.extra = theirs.extra;
    }
    if (changed.drawings) entry.record.drawings = mergeById(entry.record.drawings, theirs.drawings, entry.deletedDrawingIds);
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

  // ---------- Text snapshots ----------

  private async snapshotFiles(key: string): Promise<{ hash: string; file: string; size: number; mtimeMs: number }[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return [];
    }
    const out: { hash: string; file: string; size: number; mtimeMs: number }[] = [];
    for (const name of names) {
      const match = new RegExp(`^${key}\\.text-([0-9a-f]{6,64})\\.gz$`).exec(name);
      if (!match) continue;
      const file = `${this.options.dir}/${name}`;
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat) out.push({ hash: match[1], file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return out;
  }

  /** The text versions kept for a document. */
  async snapshotHashes(ref: DocumentRef): Promise<string[]> {
    return (await this.snapshotFiles(this.keyOf(ref))).map((s) => s.hash);
  }

  /**
   * Keeps the normalized text of a version of a document, compressed, so annotations last found
   * in it can be followed by diff later (also after a restart). Only for documents that have
   * annotations. Returns whether the text is stored.
   */
  async saveSnapshot(ref: DocumentRef, hash: string, text: string): Promise<boolean> {
    if (!HASH.test(hash) || text.length === 0 || text.length > MAX_SNAPSHOT_CHARS) return false;
    const entry = await this.entry(ref);
    if (entry.readOnly || !hasData(entry.record)) return false;
    const key = this.keyOf(ref);
    const file = this.snapshotPathOf(key, hash);
    let stored = false;
    await this.enqueue(key, async () => {
      if ((await this.mtimeOf(file)) === undefined) {
        const bytes = gzipSync(Buffer.from(text, 'utf8'));
        if (bytes.byteLength > MAX_SNAPSHOT_BYTES) return;
        await writeFileAtomic(file, bytes, this.options.writeHooks);
      }
      stored = true;
      await this.pruneSnapshots(key, entry.record, hash);
    });
    return stored;
  }

  /** The text of a kept version, or undefined if it is not kept (or unreadable: then it is dropped). */
  async readSnapshot(ref: DocumentRef, hash: string): Promise<string | undefined> {
    if (!HASH.test(hash)) return undefined;
    const file = this.snapshotPathOf(this.keyOf(ref), hash);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      return undefined;
    }
    try {
      return gunzipSync(bytes).toString('utf8');
    } catch (err) {
      this.log.warn(`A text snapshot of ${ref.uri} is unreadable (${String(err)}); dropped it`);
      await removeFile(file).catch(() => undefined);
      return undefined;
    }
  }

  /** Drops snapshots no annotation points at any more, then the oldest ones over the limits. `keep` always stays. */
  private async pruneSnapshots(key: string, record: StoredRecord, keep?: string): Promise<void> {
    const referenced = referencedHashes(record);
    const files = (await this.snapshotFiles(key)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let count = 0;
    let bytes = 0;
    for (const snapshot of files) {
      const wanted = snapshot.hash === keep || referenced.has(snapshot.hash);
      if (wanted && (snapshot.hash === keep || (count < MAX_SNAPSHOTS && bytes + snapshot.size <= MAX_SNAPSHOT_BYTES))) {
        count++;
        bytes += snapshot.size;
      } else {
        await removeFile(snapshot.file);
      }
    }
  }

  private async removeSnapshots(key: string): Promise<void> {
    for (const snapshot of await this.snapshotFiles(key)) await removeFile(snapshot.file);
  }

  /** Deletes every text snapshot (the setting was turned off). */
  async removeAllSnapshots(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return;
    }
    for (const name of names) if (/^[0-9a-f]{64}\.text-[0-9a-f]{6,64}\.gz$/.test(name)) await removeFile(`${this.options.dir}/${name}`);
  }

  // ---------- Renames, lists, copies ----------

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
    if (source.readOnly || target.readOnly) {
      this.options.onReadOnly?.(source.readOnly ? from : to);
      return false;
    }
    const targetHadData = hasData(target.record);
    const moved = source.record;
    await this.update(to, (record) => {
      const existing = new Set(record.highlights.map((h) => h.id));
      record.highlights = [...record.highlights, ...moved.highlights.filter((h) => !existing.has(h.id))];
      const existingDrawings = new Set(record.drawings.map((d) => d.id));
      record.drawings = [...record.drawings, ...moved.drawings.filter((d) => !existingDrawings.has(d.id))];
      record.view = targetHadData ? { ...moved.view, ...record.view } : { ...moved.view };
      if (moved.marker && !record.marker) record.marker = structuredClone(moved.marker);
      if (!targetHadData && moved.pages) record.pages = [...moved.pages];
      if (moved.extra && !record.extra) record.extra = structuredClone(moved.extra);
    });
    await this.flushKey(toKey);
    // The snapshots follow the file: the same text, so the same hashes.
    for (const snapshot of await this.snapshotFiles(fromKey)) {
      const destination = this.snapshotPathOf(toKey, snapshot.hash);
      if ((await this.mtimeOf(destination)) === undefined) await moveFile(snapshot.file, destination).catch(() => undefined);
    }
    await this.enqueue(fromKey, async () => {
      await removeFile(this.anchorsPathOf(fromKey));
      await removeFile(this.drawingsPathOf(fromKey));
      await removeFile(this.pathOf(fromKey));
      await this.removeSnapshots(fromKey);
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

  /** Reads a record with its drawings and anchors for `list()`; unreadable files are skipped (they are handled when opened). */
  private async readListed(key: string): Promise<StoredRecord | undefined> {
    let record: StoredRecord | undefined;
    try {
      const read = await this.readJson(this.pathOf(key));
      if (read) {
        const parsed = read.json as StoredRecord;
        record = sanitizeRecord(parsed, { uri: parsed.uri, scheme: 'unknown', fsPath: parsed.fsPath });
      }
    } catch {
      // Skip.
    }
    try {
      const read = await this.readJson(this.drawingsPathOf(key));
      if (read) {
        const drawings = sanitizeDrawingsFile(read.json);
        if (!record && drawings.uri) {
          record = { ...emptyRecord({ uri: drawings.uri, scheme: 'unknown', fsPath: drawings.fsPath }), updatedAt: drawings.updatedAt ?? new Date(0).toISOString() };
        }
        if (record) record.drawings = drawings.drawings;
      }
    } catch {
      // Skip.
    }
    try {
      const read = record ? await this.readJson(this.anchorsPathOf(key)) : undefined;
      if (read && record && !isNewerSchema(read.json, ANCHORS_SCHEMA_VERSION)) joinAnchors(record, sanitizeAnchorsFile(read.json));
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
      const ref: DocumentRef = record.fsPath ? { uri: record.uri, scheme: 'file', fsPath: record.fsPath } : { uri: record.uri, scheme: from.scheme };
      const normalized = normalizeKeyPath(ref, this.platform);
      if (!normalized.startsWith(fromPrefix + sep)) continue;
      const original = ref.scheme === 'file' && ref.fsPath ? ref.fsPath : ref.uri;
      const rest = original.slice(fromPrefix.length);
      const base = to.scheme === 'file' && to.fsPath ? to.fsPath : to.uri;
      if (await this.migrate(ref, toRef(base + rest))) moved++;
    }
    return moved;
  }

  /**
   * Copies the highlights and drawings of another record into this document (used by "Reattach").
   * What they are anchored to comes along; where that was found in the other file does not: they
   * are looked for again in this one.
   */
  async mergeInto(source: StoredRecord, target: DocumentRef): Promise<{ highlights: number; drawings: number }> {
    let highlights = 0;
    let drawings = 0;
    await this.update(target, (record) => {
      const existing = new Set(record.highlights.map((h) => h.id));
      for (const h of source.highlights) {
        if (existing.has(h.id)) continue;
        const copy = structuredClone(h);
        delete copy.state;
        record.highlights.push(copy);
        highlights++;
      }
      const existingDrawings = new Set(record.drawings.map((d) => d.id));
      for (const d of source.drawings) {
        if (existingDrawings.has(d.id)) continue;
        const copy = structuredClone(d);
        delete copy.anchorStates;
        record.drawings.push(copy);
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
      await removeFile(this.anchorsPathOf(key));
      await removeFile(this.drawingsPathOf(key));
      await removeFile(this.pathOf(key));
      await this.removeSnapshots(key);
    });
  }

  async ensureDirectory(): Promise<void> {
    await ensureDir(this.options.dir);
  }
}
