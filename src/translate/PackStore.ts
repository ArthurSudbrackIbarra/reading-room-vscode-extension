// The language packs on this computer: downloaded from Mozilla's storage into the extension's
// storage folder (`translation/<pair>/`), checked, and read from there by the translator.
// No `vscode` here. Files are written through store/atomicWrite.ts only.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { removeFolder, writeFileAtomic } from '../store/atomicWrite';
import { MODELS_BASE_URL, type Pack, type PackFile } from './registry';

const unpack = promisify(gunzip);

/** A pack is complete when this file is in its folder: it is written last. */
const MANIFEST = 'pack.json';
const MANIFEST_VERSION = 1;
/** No file of a pack is anywhere near this large: more is not a language pack. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;

type Role = 'model' | 'shortlist' | 'vocab';

interface ManifestFile {
  role: Role;
  name: string;
  size: number;
  sha256: string;
}

interface Manifest {
  version: number;
  pair: string;
  architecture: string;
  installedAt: string;
  files: ManifestFile[];
}

/** A pack that is ready to be loaded: the paths of its files. */
export interface InstalledPack {
  pair: string;
  architecture: string;
  installedAt: string;
  /** Bytes on disk. */
  bytes: number;
  model: string;
  shortlist?: string;
  /** One vocabulary for both languages, or the source's and then the target's. */
  vocabs: string[];
}

export type PackErrorKind =
  /** The server does not have the file (any more). */
  | 'gone'
  /** No answer, or an answer that is not the file. */
  | 'network'
  /** What arrived is not what the list says it is. */
  | 'damaged'
  | 'cancelled';

export class PackError extends Error {
  constructor(
    readonly kind: PackErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PackError';
  }
}

const PAIR = /^[a-z]{2,3}(_[a-z]{4})?-[a-z]{2,3}(_[a-z]{4})?$/;

export class PackStore {
  constructor(
    private readonly dir: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private folder(pair: string): string {
    if (!PAIR.test(pair)) throw new Error(`Not a language pair: ${pair}`);
    return join(this.dir, pair);
  }

  /** The pack of a direction, if all of it is here. */
  async get(pair: string): Promise<InstalledPack | undefined> {
    const folder = this.folder(pair);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(join(folder, MANIFEST), 'utf8')) as Manifest;
    } catch {
      return undefined;
    }
    if (manifest?.version !== MANIFEST_VERSION || manifest.pair !== pair || !Array.isArray(manifest.files)) return undefined;
    let bytes = 0;
    for (const file of manifest.files) {
      // Names are this module's own (see `fileName`): anything else in a manifest is not followed.
      if (typeof file?.name !== 'string' || !/^[a-z0-9]+\.(bin|spm)$/.test(file.name)) return undefined;
      try {
        const stat = await fs.stat(join(folder, file.name));
        if (!stat.isFile() || stat.size !== file.size) return undefined;
        bytes += stat.size;
      } catch {
        return undefined;
      }
    }
    const paths = (role: Role): string[] => manifest.files.filter((file) => file.role === role).map((file) => join(folder, file.name));
    const [model] = paths('model');
    const vocabs = paths('vocab');
    if (!model || vocabs.length === 0) return undefined;
    return { pair, architecture: String(manifest.architecture), installedAt: String(manifest.installedAt), bytes, model, shortlist: paths('shortlist')[0], vocabs };
  }

  /** Every pack that is here, by name of its pair. */
  async installed(): Promise<InstalledPack[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const packs = await Promise.all(names.filter((name) => PAIR.test(name)).map((name) => this.get(name)));
    return packs.filter((pack): pack is InstalledPack => pack !== undefined).sort((a, b) => a.pair.localeCompare(b.pair));
  }

  /**
   * Downloads a pack, checks it and stores it. Every file is unpacked and checked in memory before
   * it is written, and the manifest is written last: a download that stops half way leaves no pack.
   * `onProgress`: bytes received so far, of how many (when the list says).
   */
  async install(pack: Pack, options: { onProgress?(received: number, total: number | undefined): void; signal?: AbortSignal } = {}): Promise<InstalledPack> {
    const folder = this.folder(pack.pair);
    const wanted: { role: Role; name: string; file: PackFile }[] = [
      { role: 'model', name: 'model.bin', file: pack.model },
      ...(pack.shortlist ? [{ role: 'shortlist' as const, name: 'shortlist.bin', file: pack.shortlist }] : []),
      ...pack.vocabs.map((file, i) => ({ role: 'vocab' as const, name: pack.vocabs.length === 1 ? 'vocab.spm' : i === 0 ? 'srcvocab.spm' : 'trgvocab.spm', file })),
    ];
    let received = 0;
    const files: ManifestFile[] = [];
    // An earlier, incomplete or older copy is not a pack while the new one is written.
    await removeFolder(folder);
    for (const { role, name, file } of wanted) {
      const packed = await this.download(file, options.signal, (bytes) => {
        received += bytes;
        options.onProgress?.(received, pack.bytes);
      });
      let data: Buffer;
      try {
        data = await unpack(packed, { maxOutputLength: MAX_UNPACKED_BYTES });
      } catch {
        throw new PackError('damaged', `${file.path} could not be unpacked.`);
      }
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (data.length === 0 || (file.size !== undefined && file.size !== data.length) || (file.sha256 !== undefined && file.sha256 !== sha256)) {
        throw new PackError('damaged', `${file.path} is not the file the list of language packs describes.`);
      }
      if (options.signal?.aborted) throw new PackError('cancelled', 'The download was cancelled.');
      await writeFileAtomic(join(folder, name), data);
      files.push({ role, name, size: data.length, sha256 });
    }
    const manifest: Manifest = { version: MANIFEST_VERSION, pair: pack.pair, architecture: pack.architecture, installedAt: new Date().toISOString(), files };
    await writeFileAtomic(join(folder, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    const installed = await this.get(pack.pair);
    if (!installed) throw new PackError('damaged', `The ${pack.pair} language pack could not be stored.`);
    return installed;
  }

  private async download(file: PackFile, signal: AbortSignal | undefined, onBytes: (bytes: number) => void): Promise<Buffer> {
    const url = `${MODELS_BASE_URL}/${file.path}`;
    let response: Response;
    try {
      response = await this.fetcher(url, { signal });
    } catch (err) {
      if (signal?.aborted) throw new PackError('cancelled', 'The download was cancelled.');
      throw new PackError('network', `${url} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.status === 404 || response.status === 410 || response.status === 403) throw new PackError('gone', `${url} is not there (${response.status}).`);
    if (!response.ok || !response.body) throw new PackError('network', `${url} answered ${response.status}.`);
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += part.byteLength;
        if (size > MAX_DOWNLOAD_BYTES) throw new PackError('damaged', `${url} is larger than a language pack can be.`);
        parts.push(part);
        onBytes(part.byteLength);
      }
    } catch (err) {
      if (err instanceof PackError) throw err;
      if (signal?.aborted) throw new PackError('cancelled', 'The download was cancelled.');
      throw new PackError('network', `The download of ${url} stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
    return Buffer.concat(parts);
  }

  async remove(pair: string): Promise<void> {
    await removeFolder(this.folder(pair));
  }
}
