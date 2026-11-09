import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PdfCache, type StatFn } from '../../src/cache/PdfCache';

const DAY = 24 * 60 * 60 * 1000;
const pdf = (n: number, size = 64) => new Uint8Array(size).map((_, i) => (i * 7 + n) % 256);

let dir: string;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mpv-cache-'));
  now = Date.now();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const newCache = () => new PdfCache({ dir, now: () => now });
const files = new Map<string, { size: number; mtime: number }>();
const stat: StatFn = async (path) => files.get(path);

describe('PdfCache', () => {
  beforeEach(() => {
    files.clear();
    files.set('/c:/docs/img.png', { size: 100, mtime: 1000 });
  });

  it('returns what was stored for the same document, theme and source', async () => {
    const cache = newCache();
    await cache.put('c:\\docs\\a.md', 'light', 'hash-1', pdf(1), [{ path: '/c:/docs/img.png', size: 100, mtime: 1000 }], ['Image not found: x.png']);
    const hit = await cache.get('c:\\docs\\a.md', 'light', 'hash-1', stat);
    expect(hit?.pdf).toEqual(pdf(1));
    expect(hit?.warnings).toEqual(['Image not found: x.png']);
    // Other theme, other source, other document: misses.
    expect(await cache.get('c:\\docs\\a.md', 'dark', 'hash-1', stat)).toBeUndefined();
    expect(await cache.get('c:\\docs\\a.md', 'light', 'hash-2', stat)).toBeUndefined();
    expect(await cache.get('c:\\docs\\b.md', 'light', 'hash-1', stat)).toBeUndefined();
  });

  it('keeps one entry per document and theme', async () => {
    const cache = newCache();
    await cache.put('doc', 'light', 'v1', pdf(1), [], []);
    await cache.put('doc', 'light', 'v2', pdf(2), [], []);
    await cache.put('doc', 'dark', 'v2', pdf(3), [], []);
    expect(readdirSync(dir)).toHaveLength(2);
    expect((await cache.get('doc', 'light', 'v2', stat))?.pdf).toEqual(pdf(2));
  });

  it('is invalidated when a file the render read changes, disappears or appears', async () => {
    const cache = newCache();
    const deps = [
      { path: '/c:/docs/img.png', size: 100, mtime: 1000 },
      { path: '/c:/docs/missing.png', missing: true as const },
    ];
    await cache.put('doc', 'light', 'h', pdf(1), deps, []);
    expect(await cache.get('doc', 'light', 'h', stat)).toBeDefined();
    files.set('/c:/docs/img.png', { size: 100, mtime: 2000 });
    expect(await cache.get('doc', 'light', 'h', stat)).toBeUndefined();
    files.set('/c:/docs/img.png', { size: 100, mtime: 1000 });
    files.set('/c:/docs/missing.png', { size: 5, mtime: 5 });
    expect(await cache.get('doc', 'light', 'h', stat)).toBeUndefined();
    files.delete('/c:/docs/missing.png');
    files.delete('/c:/docs/img.png');
    expect(await cache.get('doc', 'light', 'h', stat)).toBeUndefined();
  });

  it('discards damaged entries', async () => {
    const cache = newCache();
    await cache.put('doc', 'light', 'h', pdf(1, 4096), [], []);
    const file = cache.pathOf('doc', 'light');
    const bytes = readFileSync(file);
    bytes[bytes.length - 10] ^= 0xff;
    writeFileSync(file, bytes);
    expect(await cache.get('doc', 'light', 'h', stat)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);

    writeFileSync(file, 'not a cache file');
    expect(await cache.get('doc', 'light', 'h', stat)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('deletes entries unused for longer than the retention period', async () => {
    const cache = newCache();
    await cache.put('old', 'light', 'h', pdf(1), [], []);
    await cache.put('recent', 'light', 'h', pdf(2), [], []);
    const old = new Date(now - 8 * DAY);
    utimesSync(cache.pathOf('old', 'light'), old, old);
    const result = await cache.prune(7, Number.MAX_SAFE_INTEGER);
    expect(result).toMatchObject({ removed: 1, kept: 1 });
    expect(await cache.get('old', 'light', 'h', stat)).toBeUndefined();
    expect(await cache.get('recent', 'light', 'h', stat)).toBeDefined();
  });

  it('a cache hit refreshes the last-used time', async () => {
    const cache = newCache();
    await cache.put('doc', 'light', 'h', pdf(1), [], []);
    const file = cache.pathOf('doc', 'light');
    const old = new Date(now - 6 * DAY);
    utimesSync(file, old, old);
    expect(await cache.get('doc', 'light', 'h', stat)).toBeDefined();
    now += 2 * DAY;
    expect((await cache.prune(7, Number.MAX_SAFE_INTEGER)).removed).toBe(0);
  });

  it('keeps the most recently used entries under the size limit', async () => {
    const cache = newCache();
    for (const [i, name] of ['a', 'b', 'c'].entries()) {
      await cache.put(name, 'light', 'h', pdf(i, 1000), [], []);
      const t = new Date(now - (3 - i) * 1000);
      utimesSync(cache.pathOf(name, 'light'), t, t);
    }
    const size = readFileSync(cache.pathOf('a', 'light')).byteLength;
    const result = await cache.prune(30, size * 2 + 10);
    expect(result.kept).toBe(2);
    expect(await cache.get('a', 'light', 'h', stat)).toBeUndefined();
    expect(await cache.get('c', 'light', 'h', stat)).toBeDefined();
  });

  it('cleans up temp files left by interrupted writes, and clear() empties it', async () => {
    const cache = newCache();
    await cache.put('doc', 'light', 'h', pdf(1), [], []);
    const temp = `${cache.pathOf('other', 'light')}.tmp-123-abcd`;
    writeFileSync(temp, 'partial');
    const old = new Date(now - 2 * DAY);
    utimesSync(temp, old, old);
    await cache.prune(7, Number.MAX_SAFE_INTEGER);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(await cache.clear()).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('cacheDays 0 deletes everything', async () => {
    const cache = newCache();
    await cache.put('doc', 'light', 'h', pdf(1), [], []);
    expect((await cache.prune(0, Number.MAX_SAFE_INTEGER)).removed).toBe(1);
  });
});
