// The reader's own reading sounds ("Custom"): copies of the audio files they added, kept in the
// extension's global storage (never next to their files), with an index (sounds.json) of names
// and levels. Every change re-reads the index first, so two VS Code windows adding sounds do not
// lose each other's. No vscode imports, so it can be unit-tested.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { CUSTOM_ID_PATTERN, CUSTOM_SOUND_EXTENSIONS, clampGainDb, type CustomSound } from '../shared/sounds';
import { copyFileAtomic, moveAside, removeFile, writeFileAtomic } from './atomicWrite';

/** Larger files would be slow to load: the viewer reads the whole file before playing it. */
export const MAX_SOUND_FILE_BYTES = 150 * 1024 * 1024;
export const MAX_SOUND_NAME_LENGTH = 80;
const INDEX_FILE = 'sounds.json';
const INDEX_VERSION = 1;

export interface CustomSoundRecord extends CustomSound {
  /** The copy's file name in the library folder. */
  file: string;
  /** Name and size of the file it was copied from (adding the same file twice is skipped). */
  source: { name: string; size: number };
  /** When it was added (ISO date). */
  added: string;
}

/** A file to add: a local path, or (for files in a remote workspace) a way to read it. */
export interface SoundFile {
  name: string;
  size: number;
  path?: string;
  read?: () => Promise<Uint8Array>;
}

export interface AddResult {
  added: CustomSoundRecord[];
  skipped: { file: string; reason: string }[];
}

interface Logger {
  warn(message: string): void;
}

export function cleanSoundName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/\s+/g, ' ').trim().slice(0, MAX_SOUND_NAME_LENGTH).trim();
  return name || undefined;
}

/** A sound's name from its file name: no extension, underscores as spaces. */
export function soundNameFromFile(fileName: string): string {
  const stem = basename(fileName, extname(fileName)).replace(/_+/g, ' ');
  return cleanSoundName(stem) ?? 'Sound';
}

function extensionOf(fileName: string): string {
  return extname(fileName).slice(1).toLowerCase();
}

function uniqueName(name: string, taken: Iterable<string>): string {
  const names = new Set([...taken].map((n) => n.toLowerCase()));
  if (!names.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, MAX_SOUND_NAME_LENGTH - 6)} (${n})`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

function newId(): string {
  return `custom-${randomBytes(6).toString('hex')}`;
}

/** A record read from the index, or undefined when it is not one. */
function parseRecord(value: unknown): CustomSoundRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const name = cleanSoundName(r.name);
  const file = typeof r.file === 'string' ? r.file : '';
  if (typeof r.id !== 'string' || !CUSTOM_ID_PATTERN.test(r.id) || !name) return undefined;
  // Only plain file names inside the library folder, of a kind the viewer can play.
  if (!file || basename(file) !== file || file.startsWith('.') || !CUSTOM_SOUND_EXTENSIONS.includes(extensionOf(file))) return undefined;
  const source = (r.source && typeof r.source === 'object' ? r.source : {}) as Record<string, unknown>;
  const record: CustomSoundRecord = {
    id: r.id,
    name,
    file,
    source: {
      name: typeof source.name === 'string' ? source.name : file,
      size: typeof source.size === 'number' && Number.isFinite(source.size) ? source.size : -1,
    },
    added: typeof r.added === 'string' ? r.added : new Date(0).toISOString(),
  };
  const gainDb = clampGainDb(r.gainDb);
  if (gainDb !== undefined) record.gainDb = gainDb;
  return record;
}

export class SoundLibrary {
  private records: CustomSoundRecord[] = [];
  /** Size and time of the index when it was last read, to notice changes from another window. */
  private stamp = '';
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly log?: Logger,
  ) {}

  get sounds(): readonly CustomSoundRecord[] {
    return this.records;
  }

  find(id: string): CustomSoundRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  pathOf(record: CustomSoundRecord): string {
    return join(this.dir, record.file);
  }

  /** Reads the index again if it changed on disk. True when the list of sounds changed. */
  reload(): Promise<boolean> {
    return this.serial(() => this.read());
  }

  /** Copies the files into the library. Files of the wrong kind, too large, or already added are skipped. */
  add(files: SoundFile[]): Promise<AddResult> {
    return this.serial(async () => {
      await this.read();
      const result: AddResult = { added: [], skipped: [] };
      for (const file of files) {
        const extension = extensionOf(file.name);
        if (!CUSTOM_SOUND_EXTENSIONS.includes(extension)) {
          result.skipped.push({ file: file.name, reason: 'is not an MP3, Ogg Vorbis, WAV or FLAC file' });
          continue;
        }
        if (file.size === 0) {
          result.skipped.push({ file: file.name, reason: 'is empty' });
          continue;
        }
        if (file.size > MAX_SOUND_FILE_BYTES) {
          const mb = Math.round(file.size / 1048576);
          result.skipped.push({ file: file.name, reason: `is ${mb} MB; sounds can be at most ${MAX_SOUND_FILE_BYTES / 1048576} MB (a few minutes are plenty: they loop)` });
          continue;
        }
        const name = basename(file.name);
        if (this.records.some((r) => r.source.name === name && r.source.size === file.size)) {
          result.skipped.push({ file: file.name, reason: 'is already one of your sounds' });
          continue;
        }
        const id = newId();
        const record: CustomSoundRecord = {
          id,
          name: uniqueName(
            soundNameFromFile(name),
            this.records.map((r) => r.name),
          ),
          file: `${id}.${extension}`,
          source: { name, size: file.size },
          added: new Date().toISOString(),
        };
        const target = this.pathOf(record);
        try {
          if (file.path) await copyFileAtomic(file.path, target);
          else if (file.read) await writeFileAtomic(target, await file.read());
          else throw new Error('nothing to read');
        } catch (err) {
          result.skipped.push({ file: file.name, reason: `could not be copied (${err instanceof Error ? err.message : String(err)})` });
          continue;
        }
        this.records.push(record);
        result.added.push(record);
      }
      if (result.added.length > 0) await this.write();
      return result;
    });
  }

  /** True when the name changed. */
  renameSound(id: string, name: string): Promise<boolean> {
    return this.serial(async () => {
      await this.read();
      const record = this.find(id);
      const clean = cleanSoundName(name);
      if (!record || !clean || clean === record.name) return false;
      record.name = clean;
      await this.write();
      return true;
    });
  }

  /** Removes the sound and deletes its copy (the reader's original file is not touched). */
  removeSound(id: string): Promise<CustomSoundRecord | undefined> {
    return this.serial(async () => {
      await this.read();
      const record = this.find(id);
      if (!record) return undefined;
      this.records = this.records.filter((r) => r !== record);
      await this.write();
      await removeFile(this.pathOf(record)).catch((err: unknown) => this.log?.warn(`Could not delete ${this.pathOf(record)}: ${String(err)}`));
      return record;
    });
  }

  /** Remembers the gain that matches the sound's loudness to the built-in ones. True when it changed. */
  setGain(id: string, gainDb: number): Promise<boolean> {
    return this.serial(async () => {
      await this.read();
      const record = this.find(id);
      const value = clampGainDb(gainDb);
      if (!record || value === undefined) return false;
      const rounded = Math.round(value * 100) / 100;
      if (record.gainDb !== undefined && Math.abs(record.gainDb - rounded) < 0.05) return false;
      record.gainDb = rounded;
      await this.write();
      return true;
    });
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get indexPath(): string {
    return join(this.dir, INDEX_FILE);
  }

  /** Loads the index unless it is unchanged since the last read. True when the sounds changed. */
  private async read(): Promise<boolean> {
    let stat;
    try {
      stat = await fs.stat(this.indexPath);
    } catch {
      const changed = this.records.length > 0;
      this.records = [];
      this.stamp = '';
      return changed;
    }
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    if (stamp === this.stamp) return false;
    const before = JSON.stringify(this.records);
    let records: CustomSoundRecord[] = [];
    try {
      const data = JSON.parse(await fs.readFile(this.indexPath, 'utf8')) as { sounds?: unknown };
      const seen = new Set<string>();
      for (const value of Array.isArray(data.sounds) ? data.sounds : []) {
        const record = parseRecord(value);
        if (!record || seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }
    } catch (err) {
      const aside = `${this.indexPath}.corrupt-${Date.now()}`;
      this.log?.warn(`The list of custom reading sounds was unreadable (${String(err)}); it was kept as ${aside}.`);
      await moveAside(this.indexPath, aside).catch(() => undefined);
      records = [];
    }
    // A sound whose file is gone (deleted by hand) cannot play.
    const present = await Promise.all(
      records.map((r) =>
        fs.stat(this.pathOf(r)).then(
          () => true,
          () => false,
        ),
      ),
    );
    this.records = records.filter((r, i) => {
      if (!present[i]) this.log?.warn(`Custom reading sound "${r.name}" is missing its file (${this.pathOf(r)}); it is left out.`);
      return present[i];
    });
    this.stamp = stamp;
    return JSON.stringify(this.records) !== before;
  }

  private async write(): Promise<void> {
    const data = { version: INDEX_VERSION, sounds: this.records };
    await writeFileAtomic(this.indexPath, `${JSON.stringify(data, null, 2)}\n`);
    const stat = await fs.stat(this.indexPath);
    this.stamp = `${stat.size}:${stat.mtimeMs}`;
  }
}
