// Storage of anchors, bindings and text snapshots, and compatibility with earlier releases.
// The IDs (F1 …) are the storage cases of docs/prompts/robust-annotations.md §6.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnchor, type AnchorState } from '../../src/anchoring/anchor';
import type { DrawingBinding } from '../../src/anchoring/binding';
import { TEXT_MODEL_VERSION, hashText } from '../../src/anchoring/textModel';
import type { Highlight, ReadingMarker, StoredRecord } from '../../src/shared/types';
import { HighlightStore, MAX_SNAPSHOTS, recordKey, referencedHashes, type DocumentRef } from '../../src/store/HighlightStore';
import { applyResolved, prepareRecord } from '../../src/store/resolutions';
import { HighlightStore as Store04 } from '../fixtures/store-0.4.0/HighlightStore';
import { HighlightStore as Store07 } from '../fixtures/store-0.7.0/HighlightStore';
import { makeDrawing, makeHighlight, makeText } from './helpers';

const winRef = (fsPath: string): DocumentRef => ({ uri: `file:///${fsPath.replace(/\\/g, '/')}`, scheme: 'file', fsPath });
const TEXT = 'Intro words. The quick brown fox jumps over the lazy dog. Closing words follow here.';
const HASH = hashText(TEXT);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mpv-v2-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const newStore = (extra: Partial<ConstructorParameters<typeof HighlightStore>[0]> = {}) => new HighlightStore({ dir, platform: 'win32', coalesceMs: 5, ...extra });
const key = (ref: DocumentRef) => recordKey(ref, 'win32');
const file = (ref: DocumentRef, suffix: string) => join(dir, `${key(ref)}${suffix}`);
const files = () => readdirSync(dir).sort();
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function found(exact: string): AnchorState {
  const start = TEXT.indexOf(exact);
  return { status: 'anchored', kind: 'exact', resolvedIn: HASH, found: { hash: HASH, v: TEXT_MODEL_VERSION, length: TEXT.length, start, end: start + exact.length, page: 0 } };
}

function anchoredHighlight(exact: string): Highlight {
  const start = TEXT.indexOf(exact);
  const h = makeHighlight(exact, TEXT.slice(Math.max(0, start - 32), start), TEXT.slice(start + exact.length, start + exact.length + 32), 'yellow', start);
  h.target.hints.textModelHash = HASH;
  h.anchor = createAnchor(TEXT, HASH, start, start + exact.length);
  h.state = found(exact);
  return h;
}

function binding(forVersion: string): DrawingBinding {
  const start = TEXT.indexOf('lazy dog');
  return {
    mode: 'text-stretch',
    anchors: [createAnchor(TEXT, HASH, start, start + 8)],
    ref: [[100, 200, 148, 214]],
    page: 0,
    pageSize: [595, 842],
    frame: [1, 0, 0, -1, 0, 842],
    for: forVersion,
  };
}

function marker(): ReadingMarker {
  const start = TEXT.indexOf('Closing');
  return {
    pageIndex: 0,
    y: 0.5,
    createdAt: '2026-11-11T09:00:00.000Z',
    selector: [
      { type: 'TextQuoteSelector', exact: 'Closing words follow here.', prefix: TEXT.slice(start - 32, start), suffix: '' },
      { type: 'TextPositionSelector', start, end: TEXT.length },
    ],
    anchor: createAnchor(TEXT, HASH, start, TEXT.length),
    state: found('Closing words follow here.'),
  };
}

/** A record with one annotation of every kind, each with its anchor and state. */
async function writeFull(ref: DocumentRef, store = newStore()): Promise<StoredRecord> {
  const drawing = makeDrawing({
    tool: 'ellipse',
    points: [
      [100, 628],
      [148, 642],
    ],
  });
  const text = makeText({ text: 'A note' });
  await store.update(ref, (r) => {
    r.highlights.push(anchoredHighlight('quick brown fox'));
    r.marker = marker();
    r.drawings.push(
      { ...drawing, binding: binding(drawing.updatedAt), anchorStates: [found('lazy dog')] },
      { ...text, binding: { ...binding(text.updatedAt), mode: 'text-pin' }, anchorStates: [found('lazy dog')] },
    );
    r.view.zoom = 1.25;
  });
  await store.flush();
  await store.saveSnapshot(ref, HASH, TEXT);
  return structuredClone(await store.get(ref));
}

describe('the three files', () => {
  it('F1, F4: anchors, bindings and states go to the anchors file; the record and drawings files keep their old format', async () => {
    const ref = winRef('C:\\Notes\\full.md');
    const written = await writeFull(ref);
    expect(files()).toEqual([`${key(ref)}.anchors.json`, `${key(ref)}.drawings.json`, `${key(ref)}.json`, `${key(ref)}.text-${HASH}.gz`]);
    const record = JSON.parse(readFileSync(file(ref, '.json'), 'utf8'));
    expect(record.schemaVersion).toBe(1);
    expect(Object.keys(record).sort()).toEqual(['fsPath', 'highlights', 'marker', 'schemaVersion', 'updatedAt', 'uri', 'view']);
    expect(record.highlights[0]).not.toHaveProperty('anchor');
    expect(record.highlights[0]).not.toHaveProperty('state');
    expect(record.marker).not.toHaveProperty('anchor');
    const drawings = JSON.parse(readFileSync(file(ref, '.drawings.json'), 'utf8'));
    expect(drawings.schemaVersion).toBe(1);
    for (const d of drawings.drawings) {
      expect(d).not.toHaveProperty('binding');
      expect(d).not.toHaveProperty('anchorStates');
    }
    const anchors = JSON.parse(readFileSync(file(ref, '.anchors.json'), 'utf8'));
    expect(anchors).toMatchObject({ schemaVersion: 1, textModelVersion: TEXT_MODEL_VERSION });
    expect(Object.keys(anchors.highlights)).toHaveLength(1);
    expect(Object.keys(anchors.drawings)).toHaveLength(2);
    expect(anchors.marker.for).toBe(marker().createdAt);
    // Read back in a new session: everything is joined again, and writing it again changes nothing.
    const again = newStore();
    const reloaded = await again.get(ref);
    expect({ ...reloaded, updatedAt: '' }).toEqual({ ...written, updatedAt: '' });
    const onDisk = () => ['.json', '.anchors.json', '.drawings.json'].map((suffix) => ({ ...JSON.parse(readFileSync(file(ref, suffix), 'utf8')), updatedAt: '' }));
    const before = onDisk();
    await again.update(ref, () => undefined);
    await again.flush();
    expect(onDisk()).toEqual(before);
  });

  it('F1: records of earlier versions get anchors from their stored quotes, once', async () => {
    const ref = winRef('C:\\Notes\\legacy.md');
    const old = new Store07({ dir, platform: 'win32', coalesceMs: 5 });
    const legacy = makeHighlight('quick brown fox', 'Intro words. The ', ' jumps over the lazy dog.', 'pink', 17);
    legacy.target.hints.textModelHash = HASH;
    const orphan = makeHighlight('gone text', 'before ', ' after');
    orphan.status = 'orphaned';
    const { anchor: _a, state: _s, ...plainMarker } = marker();
    await old.update(ref, (r) => {
      r.highlights.push(legacy, orphan);
      r.marker = plainMarker;
    });
    await old.flush();
    const store = newStore();
    const record = await store.get(ref);
    expect(record.highlights[0].anchor).toBeUndefined();
    prepareRecord(record);
    expect(record.highlights[0].anchor).toEqual({ exact: 'quick brown fox', prefix: 'Intro words. The ', suffix: ' jumps over the lazy dog.' });
    expect(record.highlights[0].state?.found).toMatchObject({ hash: HASH, start: 17, end: 32 });
    // An orphan's stored hash is not where it was found: no state.
    expect(record.highlights[1].state).toBeUndefined();
    expect(record.marker?.anchor?.exact).toBe('Closing words follow here.');
    const once = JSON.stringify(record);
    prepareRecord(record);
    expect(JSON.stringify(record)).toBe(once);
    // The quotes of the record file are untouched.
    expect(record.highlights[0].target.selector[0]).toEqual(legacy.target.selector[0]);
  });

  it('F2: fields of a newer version are kept at the top level and on every annotation', async () => {
    const ref = winRef('C:\\Notes\\future.md');
    const h = { ...makeHighlight('quoted text'), tag: 'important' };
    writeFileSync(
      file(ref, '.json'),
      JSON.stringify({
        schemaVersion: 1,
        uri: ref.uri,
        view: {},
        highlights: [h],
        marker: { pageIndex: 1, y: 0.2, createdAt: 'x', label: 'here' },
        updatedAt: 'x',
        future: { a: [1, 2] },
      }),
    );
    writeFileSync(file(ref, '.drawings.json'), JSON.stringify({ schemaVersion: 1, uri: ref.uri, drawings: [{ ...makeDrawing(), layer: 3 }] }));
    const store = newStore();
    await store.update(ref, (r) => {
      r.highlights.push(makeHighlight('another'));
    });
    await store.flush();
    const record = JSON.parse(readFileSync(file(ref, '.json'), 'utf8'));
    expect(record.future).toEqual({ a: [1, 2] });
    expect(record.highlights[0].tag).toBe('important');
    expect(record.marker.label).toBe('here');
    expect(JSON.parse(readFileSync(file(ref, '.drawings.json'), 'utf8')).drawings[0].layer).toBe(3);
  });

  it('F2: a record of a newer format is shown and never written or moved aside', async () => {
    for (const [suffix, body] of [
      ['.json', { schemaVersion: 2, uri: 'x', view: {}, highlights: [makeHighlight('from the future')], updatedAt: 'x', shape: 'new' }],
      ['.anchors.json', { schemaVersion: 2, highlights: {} }],
    ] as const) {
      const ref = winRef(`C:\\Notes\\newer${suffix}.md`);
      writeFileSync(
        file(ref, '.json'),
        JSON.stringify(suffix === '.json' ? body : { schemaVersion: 1, uri: ref.uri, view: {}, highlights: [makeHighlight('from the future')], updatedAt: 'x' }),
      );
      if (suffix !== '.json') writeFileSync(file(ref, suffix), JSON.stringify(body));
      const before = files().map((name) => [name, readFileSync(join(dir, name), 'utf8')]);
      const notified: string[] = [];
      const store = newStore({ onReadOnly: (r) => notified.push(r.uri), onCorrupt: () => notified.push('corrupt') });
      expect((await store.get(ref)).highlights).toHaveLength(1);
      expect(await store.isReadOnly(ref)).toBe(true);
      await store.update(ref, (r) => {
        r.highlights = [];
      });
      await store.flush();
      expect(await store.saveSnapshot(ref, HASH, TEXT)).toBe(false);
      expect((await store.get(ref)).highlights).toHaveLength(1);
      expect(notified).toEqual([ref.uri]);
      expect(files().map((name) => [name, readFileSync(join(dir, name), 'utf8')])).toEqual(before);
    }
  });

  it('F2: data an older version moved aside as "corrupt" is taken back in', async () => {
    const ref = winRef('C:\\Notes\\aside.md');
    const lost = makeHighlight('moved aside by an older version');
    writeFileSync(file(ref, '.corrupt-1700000000000.json'), JSON.stringify({ schemaVersion: 1, uri: ref.uri, view: { zoom: 2 }, highlights: [lost], updatedAt: 'x' }));
    writeFileSync(file(ref, '.corrupt-1700000000001.json'), '{"schemaVersion":1,"highlights":[tru');
    const kept = makeHighlight('made while downgraded');
    writeFileSync(file(ref, '.json'), JSON.stringify({ schemaVersion: 1, uri: ref.uri, view: {}, highlights: [kept], updatedAt: 'x' }));
    const store = newStore();
    const record = await store.get(ref);
    expect(record.highlights.map((h) => h.id).sort()).toEqual([kept.id, lost.id].sort());
    expect(record.view.zoom).toBe(2);
    await store.flush();
    // The readable one is gone (its data is in the record now); the really corrupt one stays.
    expect(files().filter((n) => n.includes('.corrupt-'))).toEqual([`${key(ref)}.corrupt-1700000000001.json`]);
    expect((await newStore().get(ref)).highlights).toHaveLength(2);
  });
});

describe('F3: round trips through earlier releases', () => {
  for (const [name, Old] of [
    ['0.4.0 (same store as 0.3.x)', Store04],
    ['0.7.0', Store07],
  ] as const) {
    it(`new -> ${name} -> new loses nothing`, async () => {
      const ref = winRef('C:\\Notes\\roundtrip.md');
      const written = await writeFull(ref);
      // The old release opens the document, changes something and saves.
      const old = new Old({ dir, platform: 'win32', coalesceMs: 5 });
      const seen = await old.get(ref);
      expect(seen.highlights.map((h) => h.id)).toEqual(written.highlights.map((h) => h.id));
      const added = makeHighlight('added by the old release');
      await old.update(ref, (r) => {
        r.highlights.push(added);
        r.highlights[0].color = 'green';
        r.highlights[0].updatedAt = new Date().toISOString();
      });
      await old.flush();
      const back = await newStore().get(ref);
      expect(back.highlights.map((h) => h.id)).toEqual([...written.highlights.map((h) => h.id), added.id]);
      expect(back.highlights[0]).toMatchObject({ color: 'green', anchor: written.highlights[0].anchor, state: written.highlights[0].state });
      expect(back.marker).toEqual(written.marker);
      expect(back.drawings).toEqual(written.drawings);
      expect(back.view.zoom).toBe(1.25);
      expect(await newStore().readSnapshot(ref, HASH)).toBe(TEXT);
    });
  }

  it('a drawing moved by 0.7.0 keeps its binding on file, marked as made for the version before', async () => {
    const ref = winRef('C:\\Notes\\moved.md');
    const written = await writeFull(ref);
    const old = new Store07({ dir, platform: 'win32', coalesceMs: 5 });
    await old.update(ref, (r) => {
      r.drawings[0] = {
        ...r.drawings[0],
        points: [
          [10, 10],
          [60, 30],
        ],
        updatedAt: '2026-12-01T00:00:00.000Z',
      };
    });
    await old.flush();
    const back = await newStore().get(ref);
    expect(back.drawings[0].points).toEqual([
      [10, 10],
      [60, 30],
    ]);
    // The viewer sees that the binding is for another version of the drawing and infers it again.
    expect(back.drawings[0].binding?.for).toBe(written.drawings[0].updatedAt);
    expect(back.drawings[0].binding?.for).not.toBe(back.drawings[0].updatedAt);
  });

  it('a marker placed by an older release does not get the anchor of the one before it', async () => {
    const ref = winRef('C:\\Notes\\marker.md');
    await writeFull(ref);
    const old = new Store07({ dir, platform: 'win32', coalesceMs: 5 });
    await old.update(ref, (r) => {
      r.marker = { pageIndex: 3, y: 0.1, createdAt: '2026-12-01T00:00:00.000Z' };
    });
    await old.flush();
    const back = await newStore().get(ref);
    expect(back.marker).toEqual({ pageIndex: 3, y: 0.1, createdAt: '2026-12-01T00:00:00.000Z' });
  });
});

describe('F5: renames, lists, copies and deletes cover anchors and snapshots', () => {
  it('B8: a rename moves all four kinds of files', async () => {
    const from = winRef('C:\\Notes\\before.md');
    const to = winRef('C:\\Notes\\after.md');
    const store = newStore();
    const written = await writeFull(from, store);
    expect(await store.migrate(from, to)).toBe(true);
    expect(files()).toEqual([`${key(to)}.anchors.json`, `${key(to)}.drawings.json`, `${key(to)}.json`, `${key(to)}.text-${HASH}.gz`]);
    const moved = await newStore().get(to);
    expect(moved.highlights).toEqual(written.highlights);
    expect(moved.drawings).toEqual(written.drawings);
    expect(moved.marker).toEqual(written.marker);
    expect(await newStore().readSnapshot(to, HASH)).toBe(TEXT);
  });

  it('a folder rename moves them for every file under it', async () => {
    const store = newStore();
    await writeFull(winRef('C:\\Old\\a.md'), store);
    await writeFull(winRef('C:\\Old\\sub\\b.md'), store);
    const moved = await store.migrateFolder(winRef('C:\\Old'), winRef('C:\\New'), (path) => winRef(path));
    expect(moved).toBe(2);
    for (const path of ['C:\\New\\a.md', 'C:\\New\\sub\\b.md']) {
      const record = await newStore().get(winRef(path));
      expect(record.highlights[0].anchor).toBeDefined();
      expect(record.drawings[0].binding).toBeDefined();
      expect(await newStore().readSnapshot(winRef(path), HASH)).toBe(TEXT);
    }
    expect(files().some((n) => n.startsWith(key(winRef('C:\\Old\\a.md'))))).toBe(false);
  });

  it('B13: Reattach copies anchors and bindings, not where they were found in the other file', async () => {
    const store = newStore();
    await writeFull(winRef('C:\\Notes\\source.md'), store);
    const listed = (await newStore().list()).find((r) => r.record.fsPath?.endsWith('source.md'))!;
    expect(listed.record.highlights[0].anchor).toBeDefined();
    const target = winRef('C:\\Notes\\copy.md');
    expect(await store.mergeInto(listed.record, target)).toEqual({ highlights: 1, drawings: 2 });
    await store.flush();
    const copy = await newStore().get(target);
    expect(copy.highlights[0].anchor).toEqual(listed.record.highlights[0].anchor);
    expect(copy.highlights[0].state).toBeUndefined();
    expect(copy.drawings[0].binding).toEqual(listed.record.drawings[0].binding);
    expect(copy.drawings[0].anchorStates).toBeUndefined();
  });

  it('deleting everything removes every file, snapshots included', async () => {
    const ref = winRef('C:\\Notes\\empty.md');
    const store = newStore();
    await writeFull(ref, store);
    await store.update(ref, (r) => {
      r.highlights = [];
      r.drawings = [];
      delete r.marker;
      r.view = {};
    });
    await store.flush();
    expect(files()).toEqual([]);
    await writeFull(ref, store);
    await store.deleteKey(key(ref));
    expect(files()).toEqual([]);
  });

  it('E11: a change of the zoom writes neither the drawings nor the anchors file; a change of a drawing writes its file', async () => {
    const ref = winRef('C:\\Notes\\zoom.md');
    const store = newStore();
    await writeFull(ref, store);
    const read = (suffix: string) => readFileSync(file(ref, suffix), 'utf8');
    const before = { record: read('.json'), drawings: read('.drawings.json'), anchors: read('.anchors.json') };
    await tick();
    await store.update(ref, (r) => {
      r.view.zoom = 3;
    });
    await store.flush();
    expect(read('.json')).not.toBe(before.record);
    expect(read('.drawings.json')).toBe(before.drawings);
    expect(read('.anchors.json')).toBe(before.anchors);
    await store.update(ref, (r) => {
      r.drawings[0] = {
        ...r.drawings[0],
        points: [
          [101, 628],
          [149, 642],
        ],
      };
    });
    await store.flush();
    expect(read('.drawings.json')).not.toBe(before.drawings);
    expect(read('.anchors.json')).toBe(before.anchors);
    // A file that went missing is written again with the next change.
    rmSync(file(ref, '.anchors.json'));
    await store.update(ref, (r) => {
      r.view.zoom = 1;
    });
    await store.flush();
    expect(JSON.parse(read('.anchors.json')).highlights).toEqual(JSON.parse(before.anchors).highlights);
  });

  it('D8: results that arrive after Delete All bring nothing back', async () => {
    const ref = winRef('C:\\Notes\\gone.md');
    const store = newStore();
    const record = await writeFull(ref, store);
    const payload = {
      hash: HASH,
      highlights: [{ id: record.highlights[0].id, state: found('quick brown fox'), pages: [{ pageIndex: 0, rects: [[10, 20, 30, 40]] }] }],
      marker: { state: found('Closing words follow here.') },
      drawings: [{ id: record.drawings[0].id, states: [found('lazy dog')] }],
      pages: ['abc|595x842|0|'],
    };
    await store.deleteKey(key(ref));
    // The viewer had a run in flight: its results are for annotations that no longer exist.
    await store.update(ref, (r) => applyResolved(r, structuredClone(payload)));
    await store.flush();
    expect(files()).toEqual([]);
    expect((await store.get(ref)).highlights).toEqual([]);
  });

  it('a cached record is forgotten on evict only when nothing is pending', async () => {
    const ref = winRef('C:\\Notes\\evict.md');
    const store = newStore();
    await writeFull(ref, store);
    store.evict(ref);
    writeFileSync(file(ref, '.json'), JSON.stringify({ schemaVersion: 1, uri: ref.uri, view: {}, highlights: [], marker: { pageIndex: 7, y: 0, createdAt: 'x' }, updatedAt: 'x' }));
    expect((await store.get(ref)).marker?.pageIndex).toBe(7);
  });
});

describe('F6, G6: merges between windows', () => {
  it('what the reader changed in another window wins over what this window derived', async () => {
    const ref = winRef('C:\\Notes\\shared.md');
    const a = newStore();
    const b = newStore();
    await writeFull(ref, a);
    await b.get(ref);
    await tick();
    // Window B: the reader adds a note and places the marker somewhere else.
    await b.update(ref, (r) => {
      r.highlights[0].note = 'written in B';
      r.highlights[0].updatedAt = new Date().toISOString();
      r.marker = { pageIndex: 4, y: 0.3, createdAt: new Date().toISOString() };
    });
    await b.flush();
    await tick();
    // Window A: a render re-resolves everything (derived changes only).
    const stale: AnchorState = { status: 'orphaned', reason: 'deleted', resolvedIn: 'other', found: found('quick brown fox').found };
    await a.update(ref, (r) => {
      expect(applyResolved(r, { hash: 'other', highlights: [{ id: r.highlights[0].id, state: stale }], marker: { state: stale }, drawings: [] })).toBe(true);
    });
    await a.flush();
    const merged = await newStore().get(ref);
    expect(merged.highlights[0].note).toBe('written in B');
    expect(merged.marker).toMatchObject({ pageIndex: 4, y: 0.3 });
    // A's derived state for the old marker is not attached to B's marker.
    expect(merged.marker?.state).toBeUndefined();
  });

  it('a marker the reader placed here after the other window placed one wins; an older one of ours does not', async () => {
    const ref = winRef('C:\\Notes\\markers.md');
    const a = newStore();
    const b = newStore();
    await a.update(ref, (r) => {
      r.marker = { pageIndex: 1, y: 0.1, createdAt: new Date().toISOString() };
    });
    await a.flush();
    await b.get(ref);
    await tick();
    await a.update(ref, (r) => {
      r.marker = { pageIndex: 2, y: 0.2, createdAt: new Date().toISOString() };
    });
    await a.flush();
    await tick();
    // B still holds marker 1 in memory; the reader places a newer one there.
    await b.update(ref, (r) => {
      r.marker = { pageIndex: 3, y: 0.3, createdAt: new Date().toISOString() };
    });
    await b.flush();
    // A writes again (a derived change): B's marker is newer than anything the reader did in A.
    await tick();
    await a.update(ref, (r) => {
      r.view.zoom = 1.5;
    });
    await a.flush();
    expect((await newStore().get(ref)).marker?.pageIndex).toBe(3);
    // Removing it here, later, wins over theirs.
    await tick();
    await a.update(ref, (r) => {
      delete r.marker;
      r.view.zoom = 2;
    });
    await a.flush();
    expect((await newStore().get(ref)).marker).toBeUndefined();
  });

  it('resolving does not move updatedAt, and keeps the note of an orphan (H1)', async () => {
    const ref = winRef('C:\\Notes\\derived.md');
    const store = newStore();
    await writeFull(ref, store);
    await store.update(ref, (r) => {
      r.highlights[0].note = 'my note';
    });
    const before = structuredClone((await store.get(ref)).highlights[0]);
    const orphaned: AnchorState = { status: 'orphaned', reason: 'deleted', resolvedIn: 'v2', found: before.state!.found };
    await store.update(ref, (r) => {
      applyResolved(r, { hash: 'v2', highlights: [{ id: before.id, state: orphaned, pages: [{ pageIndex: 9, rects: [[1, 2, 3, 4]] }] }], drawings: [] });
    });
    const after = (await store.get(ref)).highlights[0];
    expect(after).toMatchObject({ status: 'orphaned', note: 'my note', updatedAt: before.updatedAt, anchor: before.anchor, color: before.color, createdAt: before.createdAt });
    // An orphan keeps the position, rectangles and hash of the version it was last found in.
    expect(after.target).toEqual(before.target);
    expect(after.state).toEqual(orphaned);
  });
});

describe('applyResolved', () => {
  it('stores positions, rectangles, states, wider anchors and inferred bindings, and reports no change the second time', () => {
    const drawing = makeDrawing();
    const legacy = makeHighlight('quick brown fox', 'The ', ' jumps', 'yellow', 3);
    const record: StoredRecord = { schemaVersion: 1, uri: 'x', view: {}, highlights: [legacy], updatedAt: 'x', drawings: [drawing] };
    prepareRecord(record);
    const wide = createAnchor(TEXT, HASH, 17, 32);
    const payload = {
      hash: HASH,
      highlights: [{ id: legacy.id, state: found('quick brown fox'), pages: [{ pageIndex: 0, rects: [[10, 20, 30, 40]] }], anchor: wide }],
      drawings: [{ id: drawing.id, states: [found('lazy dog')], binding: binding(drawing.updatedAt) }],
      pages: ['abc|595x842|0|'],
    };
    expect(applyResolved(record, payload)).toBe(true);
    expect(record.highlights[0]).toMatchObject({ status: 'anchored', anchor: wide, state: found('quick brown fox') });
    expect(record.highlights[0].target.selector[1]).toMatchObject({ start: 17, end: 32 });
    expect(record.highlights[0].target.hints).toEqual({ pages: [{ pageIndex: 0, rects: [[10, 20, 30, 40]] }], textModelHash: HASH });
    expect(record.drawings[0].binding).toEqual(binding(drawing.updatedAt));
    expect(record.drawings[0].anchorStates).toEqual([found('lazy dog')]);
    expect(record.pages).toEqual(['abc|595x842|0|']);
    expect(applyResolved(record, structuredClone(payload))).toBe(false);
  });

  it('ignores what is not well formed, a binding for another version of the drawing, and unknown ids', () => {
    const drawing = makeDrawing();
    const h = anchoredHighlight('quick brown fox');
    const record: StoredRecord = { schemaVersion: 1, uri: 'x', view: {}, highlights: [h], updatedAt: 'x', drawings: [drawing] };
    const before = JSON.stringify(record);
    for (const payload of [
      null,
      'x',
      { hash: HASH },
      {
        hash: HASH,
        highlights: [
          { id: h.id, state: 'nope' },
          { id: 'unknown', state: found('lazy dog') },
        ],
        drawings: [
          { id: drawing.id, binding: binding('another version') },
          { id: drawing.id, states: [found('lazy dog')] },
        ],
      },
    ]) {
      expect(applyResolved(record, payload)).toBe(false);
    }
    expect(JSON.stringify(record)).toBe(before);
  });
});

describe('F7: text snapshots', () => {
  it('are compressed, kept only while an annotation points at them, and capped', async () => {
    const ref = winRef('C:\\Notes\\snap.md');
    const store = newStore();
    // Nothing is kept for a document without annotations.
    expect(await store.saveSnapshot(ref, HASH, TEXT)).toBe(false);
    await writeFull(ref, store);
    const long = `${TEXT} `.repeat(400);
    const longHash = hashText(long);
    expect(await store.saveSnapshot(ref, longHash, long)).toBe(true);
    const bytes = readFileSync(file(ref, `.text-${longHash}.gz`));
    expect(bytes.byteLength).toBeLessThan(long.length / 10);
    expect(gunzipSync(bytes).toString('utf8')).toBe(long);
    expect((await store.snapshotHashes(ref)).sort()).toEqual([HASH, longHash].sort());
    expect(referencedHashes(await store.get(ref))).toEqual(new Set([HASH]));
    // Saving another one prunes what nothing points at (the long one), never the one just saved.
    const other = hashText('other');
    expect(await store.saveSnapshot(ref, other, 'other')).toBe(true);
    expect((await store.snapshotHashes(ref)).sort()).toEqual([HASH, other].sort());
    // Not a hash, empty text: refused.
    expect(await store.saveSnapshot(ref, '../evil', TEXT)).toBe(false);
    expect(await store.saveSnapshot(ref, HASH, '')).toBe(false);
    expect(await store.readSnapshot(ref, '../evil')).toBeUndefined();
  });

  it('keep at most MAX_SNAPSHOTS versions, dropping the oldest', async () => {
    const ref = winRef('C:\\Notes\\many.md');
    const store = newStore();
    const hashes: string[] = [];
    await store.update(ref, (r) => {
      for (let i = 0; i < MAX_SNAPSHOTS + 3; i++) {
        const text = `version ${i} of the text`;
        const hash = hashText(text);
        hashes.push(hash);
        const h = makeHighlight(`quote ${i}`);
        h.state = { status: 'anchored', kind: 'exact', found: { hash, v: TEXT_MODEL_VERSION, length: text.length, start: 0, end: 7 } };
        h.anchor = { exact: `quote ${i}`, prefix: '', suffix: '' };
        r.highlights.push(h);
      }
    });
    for (let i = 0; i < hashes.length; i++) {
      await store.saveSnapshot(ref, hashes[i], `version ${i} of the text`);
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    const kept = await store.snapshotHashes(ref);
    expect(kept).toHaveLength(MAX_SNAPSHOTS);
    expect(kept).toContain(hashes[hashes.length - 1]);
    expect(kept).not.toContain(hashes[0]);
  });

  it('an unreadable snapshot is dropped and anchoring falls back to searching', async () => {
    const ref = winRef('C:\\Notes\\bad.md');
    const store = newStore();
    await writeFull(ref, store);
    writeFileSync(file(ref, `.text-${HASH}.gz`), 'not gzip at all');
    expect(await store.readSnapshot(ref, HASH)).toBeUndefined();
    expect(existsSync(file(ref, `.text-${HASH}.gz`))).toBe(false);
    expect(await store.readSnapshot(ref, 'abcdef')).toBeUndefined();
  });

  it('are removed for every document when the setting is turned off', async () => {
    const store = newStore();
    await writeFull(winRef('C:\\Notes\\one.md'), store);
    await writeFull(winRef('C:\\Notes\\two.md'), store);
    await store.removeAllSnapshots();
    expect(files().filter((n) => n.endsWith('.gz'))).toEqual([]);
    expect(files()).toHaveLength(6);
  });

  it('unreadable anchors only cost the wider context: the record still opens', async () => {
    const ref = winRef('C:\\Notes\\anchors.md');
    await writeFull(ref);
    writeFileSync(file(ref, '.anchors.json'), '{"schemaVersion":1,"highlights":{tru');
    const record = await newStore().get(ref);
    expect(record.highlights).toHaveLength(1);
    expect(record.highlights[0].anchor).toBeUndefined();
    expect(record.drawings).toHaveLength(2);
    // Anchors made with another text model version keep the anchors and drop the positions.
    const good = winRef('C:\\Notes\\model.md');
    await writeFull(good);
    const anchors = JSON.parse(readFileSync(file(good, '.anchors.json'), 'utf8'));
    writeFileSync(file(good, '.anchors.json'), JSON.stringify({ ...anchors, textModelVersion: TEXT_MODEL_VERSION + 1 }));
    const reread = await newStore().get(good);
    expect(reread.highlights[0].anchor).toBeDefined();
    expect(reread.highlights[0].state).toBeUndefined();
    expect(reread.drawings[0].binding).toBeDefined();
    expect(reread.drawings[0].anchorStates).toBeUndefined();
  });
});
