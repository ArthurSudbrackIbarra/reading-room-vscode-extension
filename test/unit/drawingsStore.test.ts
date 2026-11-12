// Drawings in the store: kept in a companion file next to the record, which 0.4.x never reads,
// so the previous release cannot erase them (sanitizeRecord rebuilds records from known fields).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_STROKE_POINTS } from '../../src/shared/drawings';
import { HighlightStore, recordKey, type DocumentRef } from '../../src/store/HighlightStore';
import { HighlightStore as OldHighlightStore } from '../fixtures/store-0.4.0/HighlightStore';
import { makeDrawing, makeHighlight, makeText } from './helpers';

const winRef = (fsPath: string): DocumentRef => ({ uri: `file:///${fsPath.replace(/\\/g, '/')}`, scheme: 'file', fsPath });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mpv-drawings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newStore(extra: Partial<ConstructorParameters<typeof HighlightStore>[0]> = {}) {
  return new HighlightStore({ dir, platform: 'win32', coalesceMs: 5, ...extra });
}

function oldStore() {
  return new OldHighlightStore({ dir, platform: 'win32', coalesceMs: 5 });
}

const recordFile = (ref: DocumentRef) => join(dir, `${recordKey(ref, 'win32')}.json`);
const drawingsFile = (ref: DocumentRef) => join(dir, `${recordKey(ref, 'win32')}.drawings.json`);
const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();

describe('drawings in the store', () => {
  it('persist in a companion file and read back in a new instance', async () => {
    const ref = winRef('C:\\Notes\\draw.md');
    const pen = makeDrawing({
      tool: 'pen',
      points: [
        [1, 2],
        [3, 4],
        [6, 5],
      ],
      textModelHash: 'hash-1',
    });
    const rect = makeDrawing({
      tool: 'rect',
      color: 'blue',
      width: 'thick',
      pageIndex: 2,
      points: [
        [10, 10],
        [90, 60],
      ],
    });
    const first = newStore();
    await first.update(ref, (r) => {
      r.highlights.push(makeHighlight('next to a drawing'));
      r.drawings.push(pen, rect);
    });
    await first.flush();
    // A new store instance is like a new VS Code session.
    const store = newStore();
    await store.update(ref, (r) => r.drawings.push(makeDrawing({ tool: 'arrow' })));
    await store.flush();
    expect(existsSync(drawingsFile(ref))).toBe(true);
    // The record file itself never holds drawings (0.4.x would erase them).
    expect(JSON.parse(readFileSync(recordFile(ref), 'utf8'))).not.toHaveProperty('drawings');
    const reloaded = await newStore().get(ref);
    expect(reloaded.highlights).toHaveLength(1);
    expect(reloaded.drawings).toHaveLength(3);
    expect(reloaded.drawings.find((d) => d.id === pen.id)).toEqual(pen);
    expect(reloaded.drawings.find((d) => d.id === rect.id)).toEqual(rect);
  });

  it('keep text boxes and custom colors next to the drawings', async () => {
    const ref = winRef('C:\\Notes\\text.md');
    const text = makeText({ text: 'Remember this', color: '#3366CC', size: 16, align: 'center', boxWidth: 150, spans: [{ start: 0, end: 8, bold: true, italic: true }] });
    const ink = makeDrawing({ color: '#AA00FF' });
    const store = newStore();
    await store.update(ref, (r) => r.drawings.push(text, ink));
    await store.flush();
    const reloaded = await newStore().get(ref);
    expect(reloaded.drawings.find((d) => d.id === text.id)).toEqual(text);
    expect(reloaded.drawings.find((d) => d.id === ink.id)).toEqual(ink);
    expect(JSON.parse(readFileSync(drawingsFile(ref), 'utf8')).drawings).toHaveLength(2);
  });

  it('keep a document that has only drawings, and remove both files when the last one goes', async () => {
    const ref = winRef('C:\\Notes\\only-drawings.md');
    const d = makeDrawing({
      tool: 'ellipse',
      points: [
        [0, 0],
        [40, 20],
      ],
    });
    const store = newStore();
    await store.update(ref, (r) => r.drawings.push(d));
    await store.flush();
    expect(existsSync(recordFile(ref))).toBe(true);
    expect(existsSync(drawingsFile(ref))).toBe(true);
    expect((await newStore().get(ref)).drawings.map((x) => x.id)).toEqual([d.id]);
    await store.update(ref, (r) => {
      r.drawings = [];
    });
    await store.flush();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('drop the companion file when all drawings are deleted but highlights remain', async () => {
    const ref = winRef('C:\\Notes\\delete-all.md');
    const store = newStore();
    await store.update(ref, (r) => {
      r.highlights.push(makeHighlight('stays'));
      r.drawings.push(makeDrawing(), makeDrawing());
    });
    await store.flush();
    await store.update(ref, (r) => {
      r.drawings = [];
    });
    await store.flush();
    expect(existsSync(drawingsFile(ref))).toBe(false);
    const record = await newStore().get(ref);
    expect(record.highlights).toHaveLength(1);
    expect(record.drawings).toEqual([]);
  });

  it('follow a file rename', async () => {
    const from = winRef('C:\\Notes\\before.md');
    const to = winRef('C:\\Notes\\after.md');
    const store = newStore();
    const d = makeDrawing({ tool: 'pen', points: [[5, 5]] });
    await store.update(from, (r) => r.drawings.push(d));
    await store.flush();
    expect(await store.migrate(from, to)).toBe(true);
    expect(existsSync(drawingsFile(from))).toBe(false);
    expect(existsSync(recordFile(from))).toBe(false);
    const fresh = newStore();
    expect((await fresh.get(to)).drawings).toEqual([d]);
    expect((await fresh.get(from)).drawings).toEqual([]);
  });

  it('follow a folder rename', async () => {
    const store = newStore();
    const drawingsOnly = winRef('C:\\Proj\\docs\\a.md');
    const mixed = winRef('C:\\Proj\\docs\\deep\\b.md');
    await store.update(drawingsOnly, (r) => r.drawings.push(makeDrawing()));
    await store.update(mixed, (r) => {
      r.highlights.push(makeHighlight('b'));
      r.drawings.push(makeDrawing(), makeDrawing());
    });
    await store.flush();
    expect(await store.migrateFolder(winRef('C:\\Proj\\docs'), winRef('C:\\Proj\\manual'), winRef)).toBe(2);
    const fresh = newStore();
    expect((await fresh.get(winRef('C:\\Proj\\manual\\a.md'))).drawings).toHaveLength(1);
    expect((await fresh.get(winRef('C:\\Proj\\manual\\deep\\b.md'))).drawings).toHaveLength(2);
    expect((await fresh.get(drawingsOnly)).drawings).toHaveLength(0);
  });

  it('are listed and copied by Reattach', async () => {
    const store = newStore();
    const lost = winRef('C:\\Old\\gone.md');
    await store.update(lost, (r) => {
      r.highlights.push(makeHighlight('h'));
      r.drawings.push(makeDrawing(), makeDrawing({ tool: 'rect' }));
    });
    await store.flush();
    const listed = await newStore().list();
    expect(listed).toHaveLength(1);
    expect(listed[0].record.drawings).toHaveLength(2);
    const target = winRef('C:\\New\\found.md');
    await store.update(target, (r) => r.drawings.push(makeDrawing()));
    expect(await store.mergeInto(listed[0].record, target)).toEqual({ highlights: 1, drawings: 2 });
    // Copying again adds nothing.
    expect(await store.mergeInto(listed[0].record, target)).toEqual({ highlights: 0, drawings: 0 });
    await store.flush();
    expect((await newStore().get(target)).drawings).toHaveLength(3);
  });

  it('merge across windows by id, newest change first, keeping deletions', async () => {
    const ref = winRef('C:\\Notes\\shared.md');
    const shared = makeDrawing({ color: 'red' });
    const gone = makeDrawing();
    const seed = newStore();
    await seed.update(ref, (r) => r.drawings.push(shared, gone));
    await seed.flush();

    const windowA = newStore();
    const windowB = newStore();
    await windowA.get(ref);
    await windowB.get(ref);
    const fromA = makeDrawing({ tool: 'arrow' });
    await windowA.update(ref, (r) => {
      r.drawings.push(fromA);
      r.drawings = r.drawings.filter((d) => d.id !== gone.id);
    });
    await windowA.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fromB = makeDrawing({ tool: 'ellipse' });
    await windowB.update(ref, (r) => {
      r.drawings.push(fromB);
      const d = r.drawings.find((x) => x.id === shared.id)!;
      d.color = 'green';
      d.updatedAt = '2026-11-10T12:00:00.000Z';
    });
    await windowB.flush();
    const merged = (await newStore().get(ref)).drawings;
    // B still had `gone` (it never deleted it), so like highlights it comes back; A's and B's new ones are both there.
    expect(ids(merged)).toEqual(ids([shared, fromA, fromB, gone]));
    expect(merged.find((d) => d.id === shared.id)?.color).toBe('green');

    // A drawing deleted in this window stays deleted when the other window's file is merged in.
    const windowC = newStore();
    await windowC.get(ref);
    await windowC.update(ref, (r) => {
      r.drawings = r.drawings.filter((d) => d.id !== fromA.id);
    });
    await windowC.flush();
    expect(ids((await newStore().get(ref)).drawings)).not.toContain(fromA.id);
  });

  it('move an unreadable drawings file aside and keep the record', async () => {
    const ref = winRef('C:\\Notes\\broken.md');
    const store = newStore();
    await store.update(ref, (r) => {
      r.highlights.push(makeHighlight('fine'));
      r.drawings.push(makeDrawing());
    });
    await store.flush();
    writeFileSync(drawingsFile(ref), '{"schemaVersion":1,"drawings":[trunc');
    const moved: string[] = [];
    const record = await newStore({ onCorrupt: (_ref, to) => moved.push(to) }).get(ref);
    expect(record.highlights).toHaveLength(1);
    expect(record.drawings).toEqual([]);
    expect(moved[0]).toMatch(/\.drawings\.corrupt-\d+\.json$/);
    expect(existsSync(drawingsFile(ref))).toBe(false);
  });

  it('check every drawing on load: invalid ones are dropped, long strokes simplified and reported', async () => {
    const ref = winRef('C:\\Notes\\checked.md');
    const good = makeDrawing();
    const long = makeDrawing({ tool: 'pen', points: Array.from({ length: MAX_STROKE_POINTS * 2 }, (_, i): [number, number] => [i * 0.2, Math.sin(i) * 9]) });
    writeFileSync(
      drawingsFile(ref),
      JSON.stringify({
        schemaVersion: 1,
        uri: ref.uri,
        drawings: [
          good,
          { ...good },
          { id: 'bad', tool: 'laser' },
          {
            ...makeDrawing(),
            points: [
              [NaN, 1],
              [2, 3],
            ],
          },
          long,
        ],
      }),
    );
    const reported: number[] = [];
    const record = await newStore({ onSimplified: (_ref, count) => reported.push(count) }).get(ref);
    expect(record.drawings.map((d) => d.id)).toEqual([good.id, long.id]);
    expect(record.drawings[1].points.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    expect(reported).toEqual([1]);
  });
});

describe('downgrade to 0.4.x and back', () => {
  it('drawings survive 0.4.x reading and writing the record', async () => {
    const ref = winRef('C:\\Notes\\round-trip.md');
    const drawings = [
      makeDrawing({
        tool: 'pen',
        points: [
          [1, 1],
          [2, 3],
          [4, 2],
        ],
      }),
      makeDrawing({ tool: 'ellipse' }),
    ];
    const current = newStore();
    await current.update(ref, (r) => {
      r.highlights.push(makeHighlight('from 0.5'));
      r.view.zoom = 1.25;
      r.drawings.push(...drawings);
    });
    await current.flush();

    // 0.4.x opens the file and changes it.
    const old = oldStore();
    const seen = await old.get(ref);
    expect(seen.highlights).toHaveLength(1);
    await old.update(ref, (r) => {
      r.highlights.push(makeHighlight('from 0.4'));
      r.view.zoom = 2;
    });
    await old.flush();

    const back = await newStore().get(ref);
    expect(back.highlights.map((h) => h.target.selector[0].exact).sort()).toEqual(['from 0.4', 'from 0.5']);
    expect(back.view.zoom).toBe(2);
    expect(back.drawings).toEqual(drawings);
  });

  it('drawings survive 0.4.x deleting a record it thinks is empty', async () => {
    const ref = winRef('C:\\Notes\\emptied.md');
    const d = makeDrawing({ tool: 'rect' });
    const current = newStore();
    await current.update(ref, (r) => {
      r.highlights.push(makeHighlight('the only highlight'));
      r.drawings.push(d);
    });
    await current.flush();

    const old = oldStore();
    await old.update(ref, (r) => {
      r.highlights = [];
    });
    await old.flush();
    expect(existsSync(recordFile(ref))).toBe(false);

    const back = newStore();
    expect((await back.get(ref)).drawings).toEqual([d]);
    // The next change here writes the record again, next to its drawings.
    await back.update(ref, (r) => r.drawings.push(makeDrawing()));
    await back.flush();
    expect(existsSync(recordFile(ref))).toBe(true);
    expect((await newStore().get(ref)).drawings).toHaveLength(2);
  });

  it('drawings left behind by a 0.4.x rename can be reattached', async () => {
    const from = winRef('C:\\Notes\\old-name.md');
    const to = winRef('C:\\Notes\\new-name.md');
    const d = makeDrawing({ tool: 'arrow' });
    const current = newStore();
    await current.update(from, (r) => {
      r.highlights.push(makeHighlight('moves'));
      r.drawings.push(d);
    });
    await current.flush();

    // 0.4.x moves the record but does not know the drawings file.
    expect(await oldStore().migrate(from, to)).toBe(true);
    expect(existsSync(drawingsFile(from))).toBe(true);

    const back = newStore();
    expect((await back.get(to)).drawings).toEqual([]);
    const left = (await back.list()).find((entry) => entry.record.uri === from.uri);
    expect(left?.record.drawings).toEqual([d]);
    expect(await back.mergeInto(left!.record, to)).toEqual({ highlights: 0, drawings: 1 });
    await back.flush();
    expect((await newStore().get(to)).drawings).toEqual([d]);
  });
});
