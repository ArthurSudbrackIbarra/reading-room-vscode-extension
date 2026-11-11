import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HighlightStore, normalizeKeyPath, recordKey, type DocumentRef } from '../../src/store/HighlightStore';
import { writeFileAtomic } from '../../src/store/atomicWrite';
import { makeHighlight } from './helpers';

const winRef = (fsPath: string): DocumentRef => ({
  uri: `file:///${fsPath.replace(/\\/g, '/')}`,
  scheme: 'file',
  fsPath,
});
const posixRef = (fsPath: string): DocumentRef => ({ uri: `file://${fsPath}`, scheme: 'file', fsPath });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mpv-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newStore(platform: NodeJS.Platform = 'win32', extra: Partial<ConstructorParameters<typeof HighlightStore>[0]> = {}) {
  return new HighlightStore({ dir, platform, coalesceMs: 10, ...extra });
}

describe('record keys', () => {
  it('are case-insensitive on Windows and macOS', () => {
    const a = winRef('C:\\Users\\Me\\Notes\\A.md');
    const b = winRef('c:\\users\\me\\notes\\a.MD');
    expect(recordKey(a, 'win32')).toBe(recordKey(b, 'win32'));
    expect(recordKey(posixRef('/Users/me/A.md'), 'darwin')).toBe(recordKey(posixRef('/users/me/a.md'), 'darwin'));
  });

  it('are case-sensitive on Linux', () => {
    expect(recordKey(posixRef('/home/me/A.md'), 'linux')).not.toBe(recordKey(posixRef('/home/me/a.md'), 'linux'));
  });

  it('normalize redundant path segments', () => {
    expect(normalizeKeyPath(winRef('C:\\Notes\\sub\\..\\a.md'), 'win32')).toBe('c:\\notes\\a.md');
  });

  it('use the URI for non-file schemes', () => {
    const ref: DocumentRef = { uri: 'vscode-remote://ssh-remote+box/home/me/a.md', scheme: 'vscode-remote' };
    expect(normalizeKeyPath(ref, 'win32')).toBe(ref.uri);
  });
});

describe('HighlightStore', () => {
  it('persists highlights and zoom, and reads them back in a new instance', async () => {
    const ref = winRef('C:\\Notes\\doc.md');
    const store = newStore();
    const h = makeHighlight('persist me', 'before ', ' after', 'pink');
    await store.update(ref, (r) => {
      r.highlights.push(h);
      r.view.zoom = 1.5;
    });
    await store.flush();
    const file = join(dir, `${recordKey(ref, 'win32')}.json`);
    expect(existsSync(file)).toBe(true);

    const reloaded = await newStore().get(ref);
    expect(reloaded.highlights).toHaveLength(1);
    expect(reloaded.highlights[0]).toMatchObject({ id: h.id, color: 'pink' });
    expect(reloaded.view.zoom).toBe(1.5);
    expect(reloaded.fsPath).toBe('C:\\Notes\\doc.md');
  });

  it('returns an empty record for unknown files without creating a file', async () => {
    const record = await newStore().get(winRef('C:\\Notes\\new.md'));
    expect(record.highlights).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('serializes rapid concurrent updates without losing any', async () => {
    const ref = winRef('C:\\Notes\\busy.md');
    const store = newStore('win32', { coalesceMs: 1 });
    const updates = Array.from({ length: 50 }, (_, i) =>
      store.update(ref, (r) => {
        r.highlights.push(makeHighlight(`quote ${i}`));
      }),
    );
    await Promise.all(updates);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.flush();
    const record = await newStore().get(ref);
    expect(record.highlights).toHaveLength(50);
  });

  it('keeps the previous file intact when a write crashes before the rename', async () => {
    const ref = winRef('C:\\Notes\\crash.md');
    const store = newStore();
    await store.update(ref, (r) => {
      r.highlights.push(makeHighlight('original'));
    });
    await store.flush();
    const file = join(dir, `${recordKey(ref, 'win32')}.json`);
    const before = readFileSync(file, 'utf8');

    const crashing = newStore('win32', {
      writeHooks: {
        beforeRename: () => {
          throw new Error('simulated crash');
        },
      },
    });
    await crashing.update(ref, (r) => {
      r.highlights.push(makeHighlight('never saved'));
    });
    await expect(crashing.flush()).rejects.toThrow('simulated crash');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('writeFileAtomic never leaves a partially written target', async () => {
    const target = join(dir, 'x.json');
    writeFileSync(target, '{"ok":1}');
    await writeFileAtomic(target, '{"ok":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":2}');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  it('moves a corrupt file aside and starts empty', async () => {
    const ref = winRef('C:\\Notes\\corrupt.md');
    const key = recordKey(ref, 'win32');
    writeFileSync(join(dir, `${key}.json`), '{"schemaVersion":1, "highlights": [trunc');
    let reported: string | undefined;
    const store = newStore('win32', { onCorrupt: (_ref, movedTo) => (reported = movedTo) });
    const record = await store.get(ref);
    expect(record.highlights).toEqual([]);
    expect(reported).toMatch(/\.corrupt-\d+\.json$/);
    expect(readdirSync(dir).some((n) => n.startsWith(`${key}.corrupt-`))).toBe(true);
    expect(existsSync(join(dir, `${key}.json`))).toBe(false);
  });

  it('drops invalid highlight entries but keeps valid ones', async () => {
    const ref = winRef('C:\\Notes\\partial.md');
    const good = makeHighlight('good one');
    writeFileSync(
      join(dir, `${recordKey(ref, 'win32')}.json`),
      JSON.stringify({ schemaVersion: 1, uri: ref.uri, view: { zoom: 'page-fit' }, highlights: [good, { id: 'bad' }], updatedAt: 'x' }),
    );
    const record = await newStore().get(ref);
    expect(record.highlights.map((h) => h.id)).toEqual([good.id]);
    expect(record.view.zoom).toBe('page-fit');
  });

  it('migrates highlights and zoom when a file is renamed', async () => {
    const from = winRef('C:\\Notes\\old.md');
    const to = winRef('C:\\Notes\\renamed.md');
    const store = newStore();
    await store.update(from, (r) => {
      r.highlights.push(makeHighlight('moving'));
      r.view.zoom = 2;
    });
    await store.flush();
    expect(await store.migrate(from, to)).toBe(true);

    const fresh = newStore();
    expect((await fresh.get(from)).highlights).toEqual([]);
    const moved = await fresh.get(to);
    expect(moved.highlights.map((h) => h.target.selector[0].exact)).toEqual(['moving']);
    expect(moved.view.zoom).toBe(2);
    expect(moved.fsPath).toBe('C:\\Notes\\renamed.md');
    expect(existsSync(join(dir, `${recordKey(from, 'win32')}.json`))).toBe(false);
  });

  it('handles a case-only rename on Windows (same key)', async () => {
    const from = winRef('C:\\Notes\\case.md');
    const to = winRef('C:\\Notes\\CASE.md');
    const store = newStore();
    await store.update(from, (r) => {
      r.highlights.push(makeHighlight('case'));
    });
    await store.flush();
    expect(await store.migrate(from, to)).toBe(true);
    expect((await newStore().get(to)).fsPath).toBe('C:\\Notes\\CASE.md');
  });

  it('migrates every record under a renamed folder', async () => {
    const store = newStore();
    const inside = [winRef('C:\\Proj\\docs\\a.md'), winRef('C:\\Proj\\docs\\deep\\b.md')];
    const outside = winRef('C:\\Proj\\docs-other\\c.md');
    for (const ref of [...inside, outside]) {
      await store.update(ref, (r) => {
        r.highlights.push(makeHighlight(`in ${ref.fsPath}`));
      });
    }
    await store.flush();
    const moved = await store.migrateFolder(winRef('C:\\Proj\\docs'), winRef('C:\\Proj\\manual'), (p) => winRef(p));
    expect(moved).toBe(2);
    const fresh = newStore();
    expect((await fresh.get(winRef('C:\\Proj\\manual\\a.md'))).highlights).toHaveLength(1);
    expect((await fresh.get(winRef('C:\\Proj\\manual\\deep\\b.md'))).highlights).toHaveLength(1);
    expect((await fresh.get(outside)).highlights).toHaveLength(1);
    expect((await fresh.get(inside[0])).highlights).toHaveLength(0);
  });

  it('merges concurrent changes from two windows instead of overwriting', async () => {
    const ref = winRef('C:\\Notes\\shared.md');
    const windowA = newStore();
    const windowB = newStore();
    await windowA.get(ref);
    await windowB.get(ref);
    await windowA.update(ref, (r) => {
      r.highlights.push(makeHighlight('from A'));
    });
    await windowA.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await windowB.update(ref, (r) => {
      r.highlights.push(makeHighlight('from B'));
    });
    await windowB.flush();
    const quotes = (await newStore().get(ref)).highlights.map((h) => h.target.selector[0].exact).sort();
    expect(quotes).toEqual(['from A', 'from B']);
  });

  it('deletes the file when the last highlight is removed and no zoom is stored', async () => {
    const ref = winRef('C:\\Notes\\empty.md');
    const store = newStore();
    const h = makeHighlight('temporary');
    await store.update(ref, (r) => {
      r.highlights.push(h);
    });
    await store.flush();
    await store.update(ref, (r) => {
      r.highlights = r.highlights.filter((x) => x.id !== h.id);
    });
    await store.flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('lists records and merges one into another file', async () => {
    const store = newStore();
    const lost = winRef('C:\\Old\\gone.md');
    await store.update(lost, (r) => {
      r.highlights.push(makeHighlight('keep me'));
    });
    await store.flush();
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    const target = winRef('C:\\New\\found.md');
    expect(await store.mergeInto(listed[0].record, target)).toEqual({ highlights: 1, drawings: 0 });
    await store.flush();
    expect((await newStore().get(target)).highlights).toHaveLength(1);
  });
});
