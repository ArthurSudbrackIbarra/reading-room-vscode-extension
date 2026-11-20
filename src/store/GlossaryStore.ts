// The glossary of each document, next to its annotations:
//   <globalStorage>/highlights/<key>.glossary.json
// Every document has its own (the same acronym can mean two things in two documents). All of
// them together are the record of every term the reader defined: `list()` reads them, and a
// document can take terms over from the others.
//
// The file is one of its own (earlier versions never read it and cannot erase it), written
// atomically and coalesced like the annotations, and merged with what another VS Code window
// wrote meanwhile. Its name starts with the document's key, so the backup copies it with the
// annotations, and a new install gets it back with them. What is read from disk, and every term a
// viewer sends, is checked the way stored annotations are. No `vscode` import, so it is
// unit-testable.
import { promises as fs } from 'node:fs';
import { MAX_TERMS, sanitizeTerm, sanitizeTerms, termKey, uniqueKeys, type GlossaryTerm } from '../shared/glossary';
import { moveAside, removeFile, writeFileAtomic } from './atomicWrite';
import { normalizeKeyPath, type DocumentRef, type StoreLogger } from './HighlightStore';

const GLOSSARY_SCHEMA_VERSION = 1;
const FILE_NAME = /^([0-9a-f]{64})\.glossary\.json$/;

export interface GlossaryStoreOptions {
  dir: string;
  /** The same key the annotations of the document are stored under. */
  keyOf(ref: DocumentRef): string;
  platform?: NodeJS.Platform;
  log?: StoreLogger;
  coalesceMs?: number;
  /** Called after the file of a document was written, moved aside or removed (the backup follows). */
  onFilesChanged?: (key: string) => void;
}

/** The glossary of one document as `list()` gives it. */
export interface ListedGlossary {
  key: string;
  /** The document it belongs to, as it was when the glossary was last written. */
  uri: string;
  fsPath?: string;
  terms: GlossaryTerm[];
}

interface Entry {
  ref: DocumentRef;
  terms: GlossaryTerm[];
  dirty: boolean;
  /** Written by a newer version: shown as far as it can be read, and never written by this one. */
  readOnly: boolean;
  /** The file's modification time as last read or written here (undefined: there was no file). */
  mtime?: number;
  /** Terms deleted here since the file was last read: another window's copy does not bring them back. */
  deletedIds: Set<string>;
  /** The terms the file had when it was last read or written here. One of them that the file lost since was deleted by another window. */
  synced: Set<string>;
  /** Terms stored here since then: these stay whatever the file has lost. */
  touched: Set<string>;
}

interface FileContent {
  uri?: string;
  fsPath?: string;
  terms: GlossaryTerm[];
  readOnly: boolean;
}

/** Reads a glossary file's content. A file of a newer version is not interpreted. */
export function sanitizeGlossaryFile(value: unknown): FileContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { terms: [], readOnly: false };
  const raw = value as Record<string, unknown>;
  const uri = typeof raw.uri === 'string' ? raw.uri : undefined;
  const fsPath = typeof raw.fsPath === 'string' ? raw.fsPath : undefined;
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > GLOSSARY_SCHEMA_VERSION) return { uri, fsPath, terms: [], readOnly: true };
  return { uri, fsPath, terms: sanitizeTerms(raw.terms), readOnly: false };
}

/** The file's text, or undefined when there is nothing to keep (the file is removed then). */
export function glossaryFileText(ref: DocumentRef, terms: GlossaryTerm[]): string | undefined {
  if (terms.length === 0) return undefined;
  return `${JSON.stringify({ schemaVersion: GLOSSARY_SCHEMA_VERSION, uri: ref.uri, fsPath: ref.fsPath, updatedAt: new Date().toISOString(), terms }, null, 1)}\n`;
}

/**
 * Puts terms into a list: a term with an id the list has takes that one's place (keeping when it
 * was made), and one whose key another term of the list has replaces that one (a document has one
 * definition per term). Returns how many could not be added because the list is full.
 */
export function putTerms(list: GlossaryTerm[], incoming: readonly GlossaryTerm[]): number {
  let refused = 0;
  for (const term of incoming) {
    const key = termKey(term.term);
    const index = list.findIndex((t) => t.id === term.id);
    const sameKey = list.findIndex((t) => t.id !== term.id && termKey(t.term) === key);
    if (index >= 0) {
      list[index] = { ...term, createdAt: list[index].createdAt };
      if (sameKey >= 0) list.splice(sameKey, 1);
    } else if (sameKey >= 0) {
      list[sameKey] = term;
    } else if (list.length >= MAX_TERMS) {
      refused++;
    } else {
      list.push(term);
    }
  }
  return refused;
}

export class GlossaryStore {
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly log?: StoreLogger;
  private readonly coalesceMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: GlossaryStoreOptions) {
    this.log = options.log;
    this.coalesceMs = options.coalesceMs ?? 300;
    this.platform = options.platform ?? process.platform;
  }

  pathOf(key: string): string {
    return `${this.options.dir}/${key}.glossary.json`;
  }

  /** The terms of a document as they are stored (a copy the caller may keep). Empty if it has none. */
  async get(ref: DocumentRef): Promise<GlossaryTerm[]> {
    return structuredClone((await this.entry(ref)).terms);
  }

  /** Whether the glossary was written by a newer version (changes are not stored then). */
  async isReadOnly(ref: DocumentRef): Promise<boolean> {
    return (await this.entry(ref)).readOnly;
  }

  /** Reads the glossary from disk again (pending changes are written first): another window, or a rename, may have changed it. */
  async reload(ref: DocumentRef): Promise<GlossaryTerm[]> {
    const key = this.options.keyOf(ref);
    await this.flushKey(key);
    this.entries.delete(key);
    return this.get(ref);
  }

  private async entry(ref: DocumentRef): Promise<Entry> {
    const key = this.options.keyOf(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      const loaded = await this.read(key);
      entry = this.entries.get(key) ?? {
        ref,
        terms: loaded.terms,
        dirty: false,
        readOnly: loaded.readOnly,
        mtime: loaded.mtime,
        deletedIds: new Set(),
        synced: new Set(loaded.terms.map((t) => t.id)),
        touched: new Set(),
      };
      this.entries.set(key, entry);
    }
    entry.ref = ref;
    return entry;
  }

  private async mtimeOf(file: string): Promise<number | undefined> {
    return (await fs.stat(file).catch(() => undefined))?.mtimeMs;
  }

  /** Reads the file of a document. One that is not valid JSON is kept under another name: it holds what the reader wrote. */
  private async read(key: string): Promise<FileContent & { mtime?: number }> {
    const file = this.pathOf(key);
    let text: string;
    let mtime: number | undefined;
    try {
      mtime = await this.mtimeOf(file);
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log?.warn(`The glossary ${file} could not be read: ${String(err)}`);
      return { terms: [], readOnly: false };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      const aside = `${this.options.dir}/${key}.glossary.unreadable-${Date.now()}.json`;
      this.log?.warn(`The glossary ${file} is not valid JSON: it is kept as ${aside}, and an empty one is started`);
      await moveAside(file, aside).catch((err: unknown) => this.log?.error(`Could not move the unreadable glossary: ${String(err)}`));
      this.options.onFilesChanged?.(key);
      return { terms: [], readOnly: false };
    }
    const content = sanitizeGlossaryFile(json);
    if (content.readOnly) this.log?.warn(`The glossary ${file} was written by a newer version: it is left as it is`);
    return { ...content, mtime };
  }

  /**
   * Stores new terms and new versions of terms (see `putTerms`). Returns how many were refused
   * because the document already has as many terms as it can have.
   */
  async save(ref: DocumentRef, terms: readonly GlossaryTerm[]): Promise<number> {
    const entry = await this.entry(ref);
    if (entry.readOnly || terms.length === 0) return 0;
    for (const term of terms) {
      entry.deletedIds.delete(term.id);
      entry.touched.add(term.id);
    }
    const before = entry.terms.map((t) => t.id);
    // Stamped here: of two windows that changed a term, the one that did it last is the one that stays.
    const now = new Date().toISOString();
    const refused = putTerms(
      entry.terms,
      terms.map((term) => ({ ...term, updatedAt: now })),
    );
    // A term that gave way to another with its key is gone for other windows too.
    const kept = new Set(entry.terms.map((t) => t.id));
    for (const id of before) if (!kept.has(id)) entry.deletedIds.add(id);
    entry.dirty = true;
    this.schedule(this.options.keyOf(ref));
    return refused;
  }

  /** Deletes terms by id. Returns how many there were. */
  async removeTerms(ref: DocumentRef, ids: readonly string[]): Promise<number> {
    const entry = await this.entry(ref);
    if (entry.readOnly) return 0;
    const gone = new Set(ids);
    const kept = entry.terms.filter((t) => !gone.has(t.id));
    const removed = entry.terms.length - kept.length;
    for (const id of gone) entry.deletedIds.add(id);
    if (removed === 0) return 0;
    entry.terms = kept;
    entry.dirty = true;
    this.schedule(this.options.keyOf(ref));
    return removed;
  }

  /**
   * Copies terms into a document's glossary: those whose key it does not have yet (its own
   * definitions stay). Returns how many were added.
   */
  async mergeInto(terms: readonly GlossaryTerm[], target: DocumentRef): Promise<number> {
    const entry = await this.entry(target);
    if (entry.readOnly) return 0;
    const keys = new Set(entry.terms.map((t) => termKey(t.term)));
    const ids = new Set(entry.terms.map((t) => t.id));
    let added = 0;
    for (const raw of terms) {
      const term = sanitizeTerm(structuredClone(raw));
      if (!term || keys.has(termKey(term.term)) || ids.has(term.id) || entry.terms.length >= MAX_TERMS) continue;
      keys.add(termKey(term.term));
      ids.add(term.id);
      entry.deletedIds.delete(term.id);
      entry.touched.add(term.id);
      entry.terms.push(term);
      added++;
    }
    if (added > 0) {
      entry.dirty = true;
      this.schedule(this.options.keyOf(target));
    }
    return added;
  }

  private schedule(key: string): void {
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.flushKey(key).catch((err: unknown) => this.log?.error(`Saving the glossary failed: ${String(err)}`));
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

  /**
   * What another window did to the file since it was last read here is taken in before it is
   * written: its new terms come in, of two versions of a term the one changed last stays, a term
   * it deleted goes (unless it was stored here since), and a term deleted here stays deleted.
   */
  private async mergeFromDisk(key: string, entry: Entry): Promise<void> {
    const file = this.pathOf(key);
    const mtime = await this.mtimeOf(file);
    if (mtime === entry.mtime) return;
    let theirs: FileContent = { terms: [], readOnly: false };
    // (No file any more: the other window deleted the last term.)
    if (mtime !== undefined) {
      try {
        theirs = sanitizeGlossaryFile(JSON.parse(await fs.readFile(file, 'utf8')));
      } catch {
        // Unreadable now: what is here is written over it.
        return;
      }
    }
    if (theirs.readOnly) {
      entry.readOnly = true;
      return;
    }
    const there = new Set(theirs.terms.map((t) => t.id));
    const merged = entry.terms.filter((t) => there.has(t.id) || !entry.synced.has(t.id) || entry.touched.has(t.id));
    const ours = new Map(merged.map((t) => [t.id, t]));
    for (const term of theirs.terms) {
      if (entry.deletedIds.has(term.id)) continue;
      const mine = ours.get(term.id);
      if (!mine) merged.push(term);
      else if (term.updatedAt > mine.updatedAt) merged[merged.indexOf(mine)] = term;
    }
    entry.terms = uniqueKeys(merged).slice(0, MAX_TERMS);
  }

  private flushKey(key: string): Promise<void> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    return this.enqueue(key, async () => {
      const entry = this.entries.get(key);
      if (!entry || !entry.dirty || entry.readOnly) return;
      entry.dirty = false;
      try {
        await this.mergeFromDisk(key, entry);
        if (entry.readOnly) return;
        const file = this.pathOf(key);
        const text = glossaryFileText(entry.ref, entry.terms);
        if (text === undefined) await removeFile(file);
        else await writeFileAtomic(file, text);
        entry.mtime = await this.mtimeOf(file);
        entry.deletedIds.clear();
        entry.touched.clear();
        entry.synced = new Set(entry.terms.map((t) => t.id));
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

  /** Forgets the cached glossary of a document whose viewer closed. */
  evict(ref: DocumentRef): void {
    const key = this.options.keyOf(ref);
    const entry = this.entries.get(key);
    if (entry && !entry.dirty && !this.timers.has(key)) this.entries.delete(key);
  }

  /**
   * The document was renamed or moved: its terms follow it. If the new path has a glossary
   * already, the two are joined, and for a term both have the new path's definition stays.
   */
  async migrate(from: DocumentRef, to: DocumentRef): Promise<void> {
    const fromKey = this.options.keyOf(from);
    const toKey = this.options.keyOf(to);
    if (fromKey === toKey) return;
    await this.flushKey(fromKey);
    this.entries.delete(fromKey);
    const source = await this.read(fromKey);
    if (source.readOnly || (source.terms.length === 0 && source.mtime === undefined)) return;
    const target = await this.entry(to);
    if (target.readOnly) {
      this.log?.warn(`The glossary of ${to.uri} was written by a newer version: the terms of ${from.uri} stay where they are`);
      return;
    }
    await this.mergeInto(source.terms, to);
    await this.flushKey(toKey);
    await this.enqueue(fromKey, async () => {
      await removeFile(this.pathOf(fromKey));
      this.options.onFilesChanged?.(fromKey);
    });
    this.entries.delete(fromKey);
  }

  /**
   * A folder was renamed or moved: the glossary of every document under it follows. `toRef`
   * builds the new reference from the new file-system path (or URI string for other schemes).
   * Returns how many glossaries moved.
   */
  async migrateFolder(from: DocumentRef, to: DocumentRef, toRef: (newPath: string) => DocumentRef): Promise<number> {
    const fromPrefix = normalizeKeyPath(from, this.platform);
    const sep = from.scheme === 'file' ? (this.platform === 'win32' ? '\\' : '/') : '/';
    let moved = 0;
    for (const listed of await this.list()) {
      const ref: DocumentRef = listed.fsPath ? { uri: listed.uri, scheme: 'file', fsPath: listed.fsPath } : { uri: listed.uri, scheme: from.scheme };
      // (A glossary whose file does not say which document it is for cannot be told to be under the folder.)
      if (!listed.uri || this.options.keyOf(ref) !== listed.key) continue;
      const normalized = normalizeKeyPath(ref, this.platform);
      if (!normalized.startsWith(fromPrefix + sep)) continue;
      const original = ref.scheme === 'file' && ref.fsPath ? ref.fsPath : ref.uri;
      const base = to.scheme === 'file' && to.fsPath ? to.fsPath : to.uri;
      await this.migrate(ref, toRef(base + original.slice(fromPrefix.length)));
      moved++;
    }
    return moved;
  }

  /**
   * The glossary of every document that has one, including documents that no longer exist: all
   * the terms the reader defined. (Glossaries of a newer version are left out.)
   */
  async list(): Promise<ListedGlossary[]> {
    await this.flush();
    let names: string[];
    try {
      names = await fs.readdir(this.options.dir);
    } catch {
      return [];
    }
    const out: ListedGlossary[] = [];
    for (const name of names.sort()) {
      const key = FILE_NAME.exec(name)?.[1];
      if (!key) continue;
      const cached = this.entries.get(key);
      if (cached) {
        if (cached.terms.length > 0) out.push({ key, uri: cached.ref.uri, fsPath: cached.ref.fsPath, terms: structuredClone(cached.terms) });
        continue;
      }
      try {
        const content = sanitizeGlossaryFile(JSON.parse(await fs.readFile(`${this.options.dir}/${name}`, 'utf8')));
        if (!content.readOnly && content.terms.length > 0) out.push({ key, uri: content.uri ?? '', fsPath: content.fsPath, terms: content.terms });
      } catch {
        // Unreadable: it is dealt with when its document is opened.
      }
    }
    return out;
  }
}
