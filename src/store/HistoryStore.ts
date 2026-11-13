// The undo history of each document, next to its annotations:
//   <globalStorage>/highlights/<key>.history.json
// so undo and redo still work after the tab or VS Code was closed. The viewer keeps the history
// while it is open and reports every change; this is the copy on disk it starts from next time.
//
// The file is one of its own (earlier versions never read it and cannot erase it), written
// atomically and coalesced like the annotations. What is read from disk, and every step the
// viewer sends, is checked the way stored annotations are. No `vscode` import, so it is
// unit-testable.
import { promises as fs } from 'node:fs';
import { sanitizeDrawing } from '../shared/drawings';
import {
  MAX_HISTORY_STEPS,
  MAX_STEP_LABEL,
  applyHistoryChange,
  type EditOp,
  type HighlightChanges,
  type HistoryChange,
  type StoredHistory,
  type UndoStep,
} from '../shared/history';
import { MAX_NOTE_LENGTH, isHighlightColor } from '../shared/types';
import { moveFile, removeFile, writeFileAtomic } from './atomicWrite';
import { sanitizeHighlight, sanitizeMarker, type DocumentRef, type StoreLogger } from './HighlightStore';

const HISTORY_SCHEMA_VERSION = 1;
/** The file is kept under this size: the oldest steps go first. */
export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
/** Most operations in one step (deleting everything at once is one step of many operations). */
const MAX_STEP_OPS = 20_000;
const MAX_BATCH_DEPTH = 4;

export interface HistoryStoreOptions {
  dir: string;
  /** The same key the annotations of the document are stored under. */
  keyOf(ref: DocumentRef): string;
  log?: StoreLogger;
  coalesceMs?: number;
  maxBytes?: number;
  /** Called after the file of a document was written, moved or removed. */
  onFilesChanged?: (key: string) => void;
}

interface Entry {
  ref: DocumentRef;
  history: StoredHistory;
  dirty: boolean;
  /** Written by a newer version: not read, and never written by this one. */
  readOnly: boolean;
}

function sanitizeChanges(value: unknown): HighlightChanges | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: HighlightChanges = {};
  if (raw.color !== undefined) {
    if (!isHighlightColor(raw.color)) return undefined;
    out.color = raw.color;
  }
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string') return undefined;
    out.note = raw.note.slice(0, MAX_NOTE_LENGTH);
  }
  return out;
}

function sanitizeOp(value: unknown, budget: { ops: number }, depth = 0): EditOp | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (--budget.ops < 0) return undefined;
  const raw = value as Record<string, unknown>;
  switch (raw.kind) {
    case 'create':
    case 'delete': {
      const highlight = sanitizeHighlight(raw.highlight);
      return highlight ? { kind: raw.kind, highlight } : undefined;
    }
    case 'update': {
      const before = sanitizeChanges(raw.before);
      const after = sanitizeChanges(raw.after);
      if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128 || !before || !after) return undefined;
      return { kind: 'update', id: raw.id, before, after };
    }
    case 'replace': {
      const before = sanitizeHighlight(raw.before);
      const after = sanitizeHighlight(raw.after);
      return before && after && before.id === after.id ? { kind: 'replace', before, after } : undefined;
    }
    case 'marker': {
      const before = raw.before === null ? null : sanitizeMarker(raw.before);
      const after = raw.after === null ? null : sanitizeMarker(raw.after);
      return before !== undefined && after !== undefined ? { kind: 'marker', before, after } : undefined;
    }
    case 'createDrawing':
    case 'deleteDrawing': {
      const drawing = sanitizeDrawing(raw.drawing);
      return drawing ? { kind: raw.kind, drawing } : undefined;
    }
    case 'updateDrawing': {
      const before = sanitizeDrawing(raw.before);
      const after = sanitizeDrawing(raw.after);
      return before && after && before.id === after.id ? { kind: 'updateDrawing', before, after } : undefined;
    }
    case 'batch': {
      if (depth >= MAX_BATCH_DEPTH || !Array.isArray(raw.ops)) return undefined;
      const ops: EditOp[] = [];
      for (const child of raw.ops) {
        const op = sanitizeOp(child, budget, depth + 1);
        // A step is reverted as a whole or not at all: one bad part makes it unusable.
        if (!op) return undefined;
        ops.push(op);
      }
      return { kind: 'batch', ops };
    }
    default:
      return undefined;
  }
}

/** A step as it may be stored: checked like stored annotations, on a copy. Undefined if it is not one. */
export function sanitizeStep(value: unknown): UndoStep | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.label !== 'string') return undefined;
  let copy: unknown;
  try {
    copy = structuredClone(raw.op);
  } catch {
    return undefined;
  }
  const op = sanitizeOp(copy, { ops: MAX_STEP_OPS });
  if (!op) return undefined;
  return { op, label: raw.label.replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_LABEL) || 'Change' };
}

/**
 * A change of the history as the viewer reports it. Undefined if it is not one (a step that does
 * not pass the checks: the stored history is cleared then, see `HistoryStore.change`).
 */
export function sanitizeHistoryChange(value: unknown): HistoryChange | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'undo' || raw.kind === 'redo' || raw.kind === 'clear') return { kind: raw.kind };
  if (raw.kind !== 'push') return undefined;
  const step = sanitizeStep(raw.step);
  return step ? { kind: 'push', step } : undefined;
}

/**
 * Reads a history file's content. Steps that do not pass the checks end the list on their side:
 * what was done before a broken step cannot be undone past it, and what was undone after one
 * cannot be redone past it.
 */
export function sanitizeHistoryFile(value: unknown): StoredHistory {
  const out: StoredHistory = { done: [], undone: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  const steps = (list: unknown): UndoStep[] => {
    if (!Array.isArray(list)) return [];
    const kept: UndoStep[] = [];
    // Newest last: a broken step makes everything older than it unreachable.
    for (let i = list.length - 1; i >= 0 && kept.length < MAX_HISTORY_STEPS; i--) {
      const step = sanitizeStep(list[i]);
      if (!step) break;
      kept.unshift(step);
    }
    return kept;
  };
  out.done = steps(raw.done);
  out.undone = steps(raw.undone);
  return out;
}

/** The file's text, cut to `maxBytes` by dropping the oldest steps (what was undone goes last). */
export function historyFileText(ref: DocumentRef, history: StoredHistory, maxBytes = MAX_HISTORY_BYTES): string | undefined {
  if (history.done.length === 0 && history.undone.length === 0) return undefined;
  const done = history.done.map((step) => JSON.stringify(step));
  const undone = history.undone.map((step) => JSON.stringify(step));
  const size = (list: string[]) => list.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8') + 1, 0);
  let total = size(done) + size(undone);
  // The viewer keeps these steps while it is open; next time the history starts after them.
  while (total > maxBytes && done.length > 0) total -= Buffer.byteLength(done.shift() ?? '', 'utf8') + 1;
  while (total > maxBytes && undone.length > 0) total -= Buffer.byteLength(undone.shift() ?? '', 'utf8') + 1;
  if (done.length === 0 && undone.length === 0) return undefined;
  const head = JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, uri: ref.uri, fsPath: ref.fsPath, updatedAt: new Date().toISOString() });
  return `${head.slice(0, -1)},"done":[${done.join(',')}],"undone":[${undone.join(',')}]}\n`;
}

export class HistoryStore {
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly log?: StoreLogger;
  private readonly coalesceMs: number;

  constructor(private readonly options: HistoryStoreOptions) {
    this.log = options.log;
    this.coalesceMs = options.coalesceMs ?? 300;
  }

  pathOf(key: string): string {
    return `${this.options.dir}/${key}.history.json`;
  }

  /** The history of a document as it is stored (a copy the caller may keep). Empty if there is none. */
  async get(ref: DocumentRef): Promise<StoredHistory> {
    return structuredClone((await this.entry(ref)).history);
  }

  private async entry(ref: DocumentRef): Promise<Entry> {
    const key = this.options.keyOf(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      const loaded = await this.read(key);
      entry = this.entries.get(key) ?? { ref, history: loaded.history, dirty: false, readOnly: loaded.readOnly };
      this.entries.set(key, entry);
    }
    entry.ref = ref;
    return entry;
  }

  private async read(key: string): Promise<{ history: StoredHistory; readOnly: boolean }> {
    const empty = (): StoredHistory => ({ done: [], undone: [] });
    let text: string;
    try {
      text = await fs.readFile(this.pathOf(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn(`The undo history ${this.pathOf(key)} could not be read: ${String(err)}`);
      return { history: empty(), readOnly: false };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Not worth keeping aside: the annotations themselves are in their own files.
      this.log?.warn(`The undo history ${this.pathOf(key)} is not valid JSON: starting an empty one`);
      return { history: empty(), readOnly: false };
    }
    const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (typeof version === 'number' && version > HISTORY_SCHEMA_VERSION) {
      this.log?.warn(`The undo history ${this.pathOf(key)} was written by a newer version: it is left as it is`);
      return { history: empty(), readOnly: true };
    }
    return { history: sanitizeHistoryFile(json), readOnly: false };
  }

  /**
   * Applies a change the viewer reported and schedules a write. A change that does not pass the
   * checks (`undefined`) clears the history: the copy here would no longer match the viewer's.
   */
  async change(ref: DocumentRef, change: HistoryChange | undefined): Promise<void> {
    const entry = await this.entry(ref);
    if (entry.readOnly) return;
    if (!change) this.log?.warn(`A step of the undo history of ${ref.uri} was not valid: the stored history starts again`);
    applyHistoryChange(entry.history, change ?? { kind: 'clear' });
    entry.dirty = true;
    this.schedule(this.options.keyOf(ref));
  }

  private schedule(key: string): void {
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.flushKey(key).catch((err: unknown) => this.log?.error(`Saving the undo history failed: ${String(err)}`));
    }, this.coalesceMs);
    this.timers.set(key, timer);
  }

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
    return this.enqueue(key, async () => {
      const entry = this.entries.get(key);
      if (!entry || !entry.dirty || entry.readOnly) return;
      entry.dirty = false;
      try {
        const text = historyFileText(entry.ref, entry.history, this.options.maxBytes);
        if (text === undefined) await removeFile(this.pathOf(key));
        else await writeFileAtomic(this.pathOf(key), text);
        this.options.onFilesChanged?.(key);
      } catch (err) {
        entry.dirty = true;
        throw err;
      }
    });
  }

  /** Writes every pending change now. */
  async flush(): Promise<void> {
    const keys = new Set([...this.timers.keys(), ...[...this.entries].filter(([, e]) => e.dirty).map(([k]) => k)]);
    await Promise.all([...keys].map((key) => this.flushKey(key)));
    await Promise.all([...this.queues.values()]);
  }

  /** Forgets the cached history of a document whose viewer closed. */
  evict(ref: DocumentRef): void {
    const key = this.options.keyOf(ref);
    const entry = this.entries.get(key);
    if (entry && !entry.dirty && !this.timers.has(key)) this.entries.delete(key);
  }

  /**
   * The document was renamed or moved: its history follows it, unless the new path has one
   * already (then the one that was moved is dropped: its steps belong to other annotations).
   */
  async migrate(from: DocumentRef, to: DocumentRef): Promise<void> {
    const fromKey = this.options.keyOf(from);
    const toKey = this.options.keyOf(to);
    if (fromKey === toKey) return;
    await this.flushKey(fromKey);
    await this.flushKey(toKey);
    await this.enqueue(fromKey, async () => {
      const exists = async (file: string) => (await fs.stat(file).catch(() => undefined)) !== undefined;
      if (!(await exists(this.pathOf(fromKey)))) return;
      if (await exists(this.pathOf(toKey))) await removeFile(this.pathOf(fromKey));
      else await moveFile(this.pathOf(fromKey), this.pathOf(toKey));
      this.options.onFilesChanged?.(fromKey);
      this.options.onFilesChanged?.(toKey);
    });
    this.entries.delete(fromKey);
    this.entries.delete(toKey);
  }
}
