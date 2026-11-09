// Store behavior for notes on highlights and the reading marker (added in 0.2.0).
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HighlightStore, recordKey, sanitizeMarker, type DocumentRef } from '../../src/store/HighlightStore';
import type { ReadingMarker } from '../../src/shared/types';
import { makeHighlight } from './helpers';

const winRef = (fsPath: string): DocumentRef => ({ uri: `file:///${fsPath.replace(/\\/g, '/')}`, scheme: 'file', fsPath });

function marker(overrides: Partial<ReadingMarker> = {}): ReadingMarker {
  return {
    pageIndex: 3,
    y: 0.42,
    createdAt: '2026-11-09T10:00:00.000Z',
    selector: [
      { type: 'TextQuoteSelector', exact: 'the line where I stopped', prefix: 'before ', suffix: ' after' },
      { type: 'TextPositionSelector', start: 1200, end: 1224 },
    ],
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mpv-notes-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const newStore = () => new HighlightStore({ dir, platform: 'win32', coalesceMs: 5 });

describe('notes on highlights', () => {
  it('persists a note and removes it again', async () => {
    const ref = winRef('C:\\Docs\\paper.pdf');
    const h = { ...makeHighlight('important claim'), note: 'Check this against the 2019 data.\nSecond line.' };
    const store = newStore();
    await store.update(ref, (r) => {
      r.highlights.push(h);
    });
    await store.flush();
    expect((await newStore().get(ref)).highlights[0].note).toBe('Check this against the 2019 data.\nSecond line.');

    await store.update(ref, (r) => {
      delete r.highlights[0].note;
    });
    await store.flush();
    expect((await newStore().get(ref)).highlights[0].note).toBeUndefined();
  });

  it('drops blank notes when reading a record', async () => {
    const ref = winRef('C:\\Docs\\blank.md');
    const h = { ...makeHighlight('x'), note: '   ' };
    writeFileSync(join(dir, `${recordKey(ref, 'win32')}.json`), JSON.stringify({ schemaVersion: 1, uri: ref.uri, view: {}, highlights: [h] }));
    const record = await newStore().get(ref);
    expect(record.highlights[0].note).toBeUndefined();
  });
});

describe('reading marker', () => {
  it('persists on its own (a record with only a marker keeps its file)', async () => {
    const ref = winRef('C:\\Docs\\book.pdf');
    const store = newStore();
    await store.update(ref, (r) => {
      r.marker = marker();
    });
    await store.flush();
    expect(existsSync(join(dir, `${recordKey(ref, 'win32')}.json`))).toBe(true);
    expect((await newStore().get(ref)).marker).toEqual(marker());

    await store.update(ref, (r) => {
      delete r.marker;
    });
    await store.flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('validates and clamps markers', () => {
    expect(sanitizeMarker({ pageIndex: -1, y: 0.5, createdAt: 'x' })).toBeUndefined();
    expect(sanitizeMarker({ pageIndex: 1.5, y: 0.5 })).toBeUndefined();
    expect(sanitizeMarker({ pageIndex: 2, y: 'top' })).toBeUndefined();
    expect(sanitizeMarker({ pageIndex: 2, y: 1.7, createdAt: 'x' })).toMatchObject({ pageIndex: 2, y: 1 });
    expect(sanitizeMarker({ pageIndex: 0, y: 0.1, selector: [{ type: 'nope' }] })).toBeUndefined();
    const clean = sanitizeMarker({ ...marker(), extra: 'dropped' });
    expect(clean).toEqual(marker());
  });

  it('moves with the file on rename', async () => {
    const from = winRef('C:\\Docs\\draft.md');
    const to = winRef('C:\\Docs\\final.md');
    const store = newStore();
    await store.update(from, (r) => {
      r.marker = marker({ pageIndex: 7 });
    });
    await store.flush();
    expect(await store.migrate(from, to)).toBe(true);
    const fresh = newStore();
    expect((await fresh.get(to)).marker?.pageIndex).toBe(7);
    expect((await fresh.get(from)).marker).toBeUndefined();
  });

  it('keeps the marker another window set, unless this window changed it', async () => {
    const ref = winRef('C:\\Docs\\shared.pdf');
    const windowA = newStore();
    const windowB = newStore();
    await windowA.get(ref);
    await windowB.get(ref);
    await windowA.update(ref, (r) => {
      r.marker = marker({ pageIndex: 5 });
    });
    await windowA.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Window B only adds a highlight: A's marker must survive B's write.
    await windowB.update(ref, (r) => {
      r.highlights.push(makeHighlight('from B'));
    });
    await windowB.flush();
    const merged = await newStore().get(ref);
    expect(merged.marker?.pageIndex).toBe(5);
    expect(merged.highlights).toHaveLength(1);

    // Now B moves the marker: B's value wins.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await windowB.update(ref, (r) => {
      r.marker = marker({ pageIndex: 9 });
    });
    await windowB.flush();
    expect((await newStore().get(ref)).marker?.pageIndex).toBe(9);
  });
});

describe('undo of a delete', () => {
  it('a highlight added back after being deleted survives a merge with another window', async () => {
    const ref = winRef('C:\\Docs\\undo.md');
    const h = makeHighlight('bring me back');
    const windowA = newStore();
    const windowB = newStore();
    await windowA.update(ref, (r) => {
      r.highlights.push(h);
    });
    await windowA.flush();
    await windowB.get(ref);
    // A deletes, writes, then undoes (adds the same highlight back).
    await windowA.update(ref, (r) => {
      r.highlights = [];
    });
    await windowA.flush();
    await windowA.update(ref, (r) => {
      r.highlights.push(structuredClone(h));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // B writes in between (unrelated change), so A has to merge on its next write.
    await windowB.update(ref, (r) => {
      r.view.zoom = 1.25;
    });
    await windowB.flush();
    await windowA.flush();
    expect((await newStore().get(ref)).highlights.map((x) => x.id)).toEqual([h.id]);
  });
});
