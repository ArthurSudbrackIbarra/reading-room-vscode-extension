// Language packs on disk: a download is checked before it becomes a pack, and a download that
// stops half way leaves none. (The server is a function here: nothing is fetched.)
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PackError, PackStore } from '../../src/translate/PackStore';
import { MODELS_BASE_URL, type Pack } from '../../src/translate/registry';

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const model = Buffer.from('the model '.repeat(500));
const shortlist = Buffer.from('the shortlist '.repeat(50));
const vocab = Buffer.from('the vocabulary '.repeat(20));
const target = Buffer.from('the other vocabulary '.repeat(20));

const pack: Pack = {
  pair: 'ja-en',
  architecture: 'base-memory',
  model: { path: 'models/ja-en/run/model.bin.gz', size: model.length, sha256: sha256(model) },
  shortlist: { path: 'models/ja-en/run/lex.bin.gz' },
  vocabs: [{ path: 'models/ja-en/run/vocab.spm.gz' }],
  bytes: 1234,
};

type Served = Record<string, Buffer | number | (() => Response)>;

/** A server that has these files (unpacked: it serves them gzipped), or answers with a status. */
function server(files: Served): { fetcher: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const path = String(url).replace(`${MODELS_BASE_URL}/`, '');
    asked.push(path);
    const file = files[path];
    if (typeof file === 'function') return file();
    if (file === undefined) return new Response('not found', { status: 404 });
    if (typeof file === 'number') return new Response('no', { status: file });
    return new Response(new Uint8Array(gzipSync(file)));
  }) as typeof fetch;
  return { fetcher, asked };
}

const all: Served = {
  'models/ja-en/run/model.bin.gz': model,
  'models/ja-en/run/lex.bin.gz': shortlist,
  'models/ja-en/run/vocab.spm.gz': vocab,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reading-room-packs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('language packs on disk', () => {
  it('downloads a pack, unpacks it and finds it again', async () => {
    const { fetcher, asked } = server(all);
    const store = new PackStore(dir, fetcher);
    expect(await store.get('ja-en')).toBeUndefined();
    expect(await store.installed()).toEqual([]);

    const progress: number[] = [];
    const installed = await store.install(pack, { onProgress: (received) => progress.push(received) });
    expect(asked).toEqual(['models/ja-en/run/model.bin.gz', 'models/ja-en/run/lex.bin.gz', 'models/ja-en/run/vocab.spm.gz']);
    expect(readFileSync(installed.model).equals(model)).toBe(true);
    expect(readFileSync(installed.shortlist as string).equals(shortlist)).toBe(true);
    expect(installed.vocabs.map((path) => readFileSync(path).toString())).toEqual([vocab.toString()]);
    expect(installed.bytes).toBe(model.length + shortlist.length + vocab.length);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));

    // Another store on the same folder (the next session) has it too.
    const again = new PackStore(dir, server({}).fetcher);
    expect(await again.get('ja-en')).toEqual(installed);
    expect((await again.installed()).map((p) => p.pair)).toEqual(['ja-en']);
  });

  it('keeps the two vocabularies of a pack that has two, the source first', async () => {
    const two: Pack = { ...pack, pair: 'en-ja', vocabs: [{ path: 'models/en-ja/src.spm.gz' }, { path: 'models/en-ja/trg.spm.gz' }], shortlist: undefined };
    const { fetcher } = server({ 'models/ja-en/run/model.bin.gz': model, 'models/en-ja/src.spm.gz': vocab, 'models/en-ja/trg.spm.gz': target });
    const installed = await new PackStore(dir, fetcher).install(two);
    expect(installed.shortlist).toBeUndefined();
    expect(installed.vocabs.map((path) => readFileSync(path).toString())).toEqual([vocab.toString(), target.toString()]);
  });

  it('refuses a model that is not the one the list describes, and leaves no pack', async () => {
    const store = new PackStore(dir, server({ ...all, 'models/ja-en/run/model.bin.gz': Buffer.from('another model '.repeat(500)) }).fetcher);
    await expect(store.install(pack)).rejects.toMatchObject({ kind: 'damaged' });
    expect(await store.get('ja-en')).toBeUndefined();
    expect(await store.installed()).toEqual([]);
    // The same bytes with another size are refused too (before the hash is looked at).
    const sized = new PackStore(dir, server(all).fetcher);
    await expect(sized.install({ ...pack, model: { ...pack.model, size: model.length + 1 } })).rejects.toMatchObject({ kind: 'damaged' });
  });

  it('refuses what is not a gzip file', async () => {
    const store = new PackStore(dir, server({ ...all, 'models/ja-en/run/lex.bin.gz': () => new Response('<html>sign in</html>') }).fetcher);
    await expect(store.install(pack)).rejects.toMatchObject({ kind: 'damaged' });
    expect(await store.get('ja-en')).toBeUndefined();
  });

  it('tells a file that is gone from a server that cannot be reached', async () => {
    const gone = new PackStore(dir, server({ 'models/ja-en/run/model.bin.gz': model }).fetcher);
    await expect(gone.install(pack)).rejects.toMatchObject({ kind: 'gone' });
    expect(await gone.get('ja-en')).toBeUndefined();

    const failing = new PackStore(dir, server({ ...all, 'models/ja-en/run/model.bin.gz': 503 }).fetcher);
    await expect(failing.install(pack)).rejects.toMatchObject({ kind: 'network' });

    const offline = new PackStore(dir, (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const error = await offline.install(pack).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).kind).toBe('network');
  });

  it('stops when the download is cancelled', async () => {
    const abort = new AbortController();
    const store = new PackStore(dir, (async () => {
      abort.abort();
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch);
    await expect(store.install(pack, { signal: abort.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('replaces a pack that is downloaded again, and a failed download takes the old one with it', async () => {
    const store = new PackStore(dir, server(all).fetcher);
    const first = await store.install(pack);
    const newer = Buffer.from('a newer model '.repeat(500));
    const retrained: Pack = { ...pack, model: { path: pack.model.path, size: newer.length, sha256: sha256(newer) } };
    const second = await new PackStore(dir, server({ ...all, 'models/ja-en/run/model.bin.gz': newer }).fetcher).install(retrained);
    expect(readFileSync(second.model).equals(newer)).toBe(true);
    expect(second.bytes).not.toBe(first.bytes);
    // A pack is whole or it is not there: never files of two downloads.
    await expect(new PackStore(dir, server({}).fetcher).install(pack)).rejects.toMatchObject({ kind: 'gone' });
    expect(await store.get('ja-en')).toBeUndefined();
  });

  it('does not take a folder with a missing or changed file for a pack', async () => {
    const store = new PackStore(dir, server(all).fetcher);
    const installed = await store.install(pack);
    writeFileSync(installed.vocabs[0], 'cut');
    expect(await store.get('ja-en')).toBeUndefined();
    await store.install(pack);
    rmSync(installed.model);
    expect(await store.get('ja-en')).toBeUndefined();
    expect(await store.installed()).toEqual([]);
  });

  it('does not follow a manifest that names files outside the pack', async () => {
    const store = new PackStore(dir, server(all).fetcher);
    await store.install(pack);
    const manifestPath = join(dir, 'ja-en', 'pack.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { name: string }[] };
    manifest.files[0].name = '../../elsewhere.bin';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(await store.get('ja-en')).toBeUndefined();
  });

  it('removes a pack, and only takes pairs of languages for names', async () => {
    const store = new PackStore(dir, server(all).fetcher);
    await store.install(pack);
    expect(readdirSync(dir)).toEqual(['ja-en']);
    await store.remove('ja-en');
    expect(existsSync(join(dir, 'ja-en'))).toBe(false);
    expect(await store.installed()).toEqual([]);
    await expect(store.get('../ja-en')).rejects.toThrow();
    await expect(store.remove('..')).rejects.toThrow();
    await expect(store.install({ ...pack, pair: 'ja-en/../x' })).rejects.toThrow();
  });
});
