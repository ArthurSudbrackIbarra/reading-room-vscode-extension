// Mozilla's list of translation models (the ones Firefox translates pages with), and the list of
// language packs this extension makes of it. Pure: no `vscode`, no files, no network.
//
// The registry has several models for some directions (other sizes, models not released yet).
// One is picked per direction (`selectEntry`), and what is needed to download and check it is
// kept as a "pack". The list of packs shipped with the extension (`models.json`, made by
// `npm run translation-models`) is what the reader is asked about before anything is downloaded;
// Mozilla's own list is only read again when a file of the shipped list is gone.

/** Where the models are. Paths of the registry are relative to this, and nothing is fetched from anywhere else. */
export const MODELS_BASE_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data';
export const REGISTRY_URL = `${MODELS_BASE_URL}/db/models.json`;

interface RegistryFile {
  path?: unknown;
  uncompressedSize?: unknown;
  uncompressedHash?: unknown;
}

interface RegistryEntry {
  architecture?: unknown;
  releaseStatus?: unknown;
  files?: Record<string, RegistryFile | undefined>;
}

export interface PackFile {
  /** Relative to `MODELS_BASE_URL`; a gzip file. */
  path: string;
  /** Bytes when unpacked, where the registry says. */
  size?: number;
  /** SHA-256 of the unpacked file, where the registry says. */
  sha256?: string;
}

/** One direction, as it is downloaded and loaded. */
export interface Pack {
  /** "ja-en": the two languages as Mozilla names them. */
  pair: string;
  architecture: string;
  model: PackFile;
  shortlist?: PackFile;
  /** One vocabulary for both languages, or the source's and then the target's. */
  vocabs: PackFile[];
  /** The size of the download in bytes, where it was measured. */
  bytes?: number;
}

export interface PackList {
  /** When the list was made from the registry. */
  generated: string;
  packs: Record<string, Pack>;
}

/** Released models first; of two that are released, the one made to use less memory. */
const STATUS_ORDER = ['Release', 'Release Android', 'Release Desktop', 'Nightly'];
const ARCHITECTURE_ORDER = ['base-memory', 'base', 'tiny'];

function rank(order: string[], value: unknown): number {
  const index = typeof value === 'string' ? order.indexOf(value) : -1;
  return index < 0 ? order.length : index;
}

/** A path of the registry that is safe to append to the base URL: inside `models/`, a gzip file, nothing that climbs out. */
function safePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  if (!/^models\/[A-Za-z0-9._\-/]+\.gz$/.test(value) || value.includes('..') || value.includes('//')) return undefined;
  return value;
}

/** A file of a pack, from what a list says about it (anything that is not as expected is left out). */
function checkedFile(path: unknown, size: unknown, sha256: unknown): PackFile | undefined {
  const safe = safePath(path);
  if (!safe) return undefined;
  const out: PackFile = { path: safe };
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) out.size = size;
  if (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)) out.sha256 = sha256;
  return out;
}

/** A file as Mozilla's registry describes it. */
function packFile(file: RegistryFile | undefined): PackFile | undefined {
  return checkedFile(file?.path, file?.uncompressedSize, file?.uncompressedHash);
}

/** A file as the shipped list describes it. */
function listedFile(file: Partial<PackFile> | undefined): PackFile | undefined {
  return checkedFile(file?.path, file?.size, file?.sha256);
}

/** The model of a direction this extension uses: a released one (models that are not released are not offered). */
export function selectEntry(entries: unknown): RegistryEntry | undefined {
  if (!Array.isArray(entries)) return undefined;
  return (entries as RegistryEntry[])
    .filter((entry) => entry && typeof entry === 'object' && rank(STATUS_ORDER, entry.releaseStatus) < STATUS_ORDER.length)
    .sort(
      (a, b) => rank(STATUS_ORDER, a.releaseStatus) - rank(STATUS_ORDER, b.releaseStatus) || rank(ARCHITECTURE_ORDER, a.architecture) - rank(ARCHITECTURE_ORDER, b.architecture),
    )[0];
}

function packOf(pair: string, entries: unknown): Pack | undefined {
  const entry = selectEntry(entries);
  const files = entry?.files;
  if (!entry || !files) return undefined;
  const model = packFile(files.model);
  // The hash of the model is what a download is checked against: a model without one is not offered.
  if (!model?.sha256) return undefined;
  const one = packFile(files.vocab);
  const two = [packFile(files.srcVocab), packFile(files.trgVocab)];
  const vocabs = one ? [one] : two.every((file) => file !== undefined) ? (two as PackFile[]) : [];
  if (vocabs.length === 0) return undefined;
  const pack: Pack = { pair, architecture: typeof entry.architecture === 'string' ? entry.architecture : 'unknown', model, vocabs };
  const shortlist = packFile(files.lexicalShortlist);
  if (shortlist) pack.shortlist = shortlist;
  return pack;
}

/** The packs of a registry as it was fetched (anything in it that is not as expected is left out). */
export function packsOfRegistry(registry: unknown, generated: string): PackList {
  const packs: Record<string, Pack> = {};
  const models = (registry as { models?: unknown } | undefined)?.models;
  if (models && typeof models === 'object') {
    for (const pair of Object.keys(models).sort()) {
      if (!/^[a-z]{2,3}(_[a-z]{4})?-[a-z]{2,3}(_[a-z]{4})?$/.test(pair)) continue;
      const pack = packOf(pair, (models as Record<string, unknown>)[pair]);
      if (pack) packs[pair] = pack;
    }
  }
  return { generated, packs };
}

/** The shipped list as it was read from its file. */
export function parsePackList(json: string): PackList {
  const value = JSON.parse(json) as Partial<PackList>;
  if (!value || typeof value !== 'object' || !value.packs || typeof value.packs !== 'object') throw new Error('The list of language packs is not readable.');
  const packs: Record<string, Pack> = {};
  for (const [pair, pack] of Object.entries(value.packs)) {
    const model = listedFile(pack?.model);
    const vocabs = (Array.isArray(pack?.vocabs) ? pack.vocabs : []).map((file) => listedFile(file));
    if (!model?.sha256 || vocabs.length === 0 || vocabs.some((file) => file === undefined)) continue;
    const out: Pack = { pair, architecture: String(pack.architecture ?? 'unknown'), model, vocabs: vocabs as PackFile[] };
    const shortlist = listedFile(pack.shortlist);
    if (shortlist) out.shortlist = shortlist;
    if (typeof pack.bytes === 'number' && pack.bytes > 0) out.bytes = pack.bytes;
    packs[pair] = out;
  }
  return { generated: String(value.generated ?? ''), packs };
}

/** About how large the download of a pack is: measured, or else estimated from its model (all of a pack, compressed, is a little smaller than its model unpacked). */
export function downloadBytes(pack: Pack): number {
  return pack.bytes ?? Math.round((pack.model.size ?? 30_000_000) * 0.9);
}

/** "38 MB" */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
