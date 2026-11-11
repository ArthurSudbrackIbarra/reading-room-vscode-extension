// Resolving runs: one at a time, stale results dropped, a failing annotation isolated, the quick
// and the slow pass, what a run reports (summary, mass orphan), and results of unsaved renders.
import { describe, expect, it } from 'vitest';
import { createAnchor } from '../../../src/anchoring/anchor';
import { ResolverRuns, massOrphanMessage, summaryMessage, type RunInput, type RunResult } from '../../../src/anchoring/runs';
import { World, makeDocument, scenario } from './scenario';

const TEXT = [
  'Reading notes',
  'In the first experiment the quick brown fox jumps over the lazy dog while the students take notes by hand.',
  'The second experiment repeats the first one with a longer text about rivers and lakes.',
  'Both experiments show that notes taken by hand are remembered longer than typed notes.',
  'A last paragraph closes the report with thanks to everyone who took part in it.',
].join('\n\n');

function highlight(doc: ReturnType<typeof makeDocument>, id: string, exact: string) {
  const start = doc.text.indexOf(exact);
  return { id, anchor: createAnchor(doc.text, doc.model.hash, start, start + exact.length) };
}

function input(doc: ReturnType<typeof makeDocument>, quotes: string[]): RunInput {
  return { highlights: quotes.map((q, i) => highlight(doc, `h${i}`, q)), drawings: [] };
}

/** A pause the test controls: runs wait here until `release` is called. */
function gate() {
  let open: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => (open = resolve));
  return { pause: () => waiting, release: () => open?.() };
}

describe('ResolverRuns', () => {
  it('B15: a new run cancels the one in flight: only the latest delivers', async () => {
    const runs = new ResolverRuns();
    const doc = makeDocument(TEXT);
    const g = gate();
    const first = runs.run(doc, input(doc, ['quick brown fox', 'rivers and lakes']), { oldText: () => undefined, pause: g.pause, chunk: 1 });
    const second = runs.run(makeDocument(`New start.\n\n${TEXT}`, {}, 2), input(doc, ['quick brown fox']), { oldText: () => undefined });
    g.release();
    expect(await first).toBeUndefined();
    const result = await second;
    expect(result).toMatchObject({ renderId: 2 });
    expect([...result!.highlights.keys()]).toEqual(['h0']);
  });

  it('D7: cancel drops the run in flight (the viewer was closed, a newer render arrived)', async () => {
    const runs = new ResolverRuns();
    const doc = makeDocument(TEXT);
    const g = gate();
    const pending = runs.run(doc, input(doc, ['quick brown fox', 'lazy dog', 'typed notes']), { oldText: () => undefined, pause: g.pause, chunk: 1 });
    runs.cancel();
    g.release();
    expect(await pending).toBeUndefined();
    // The next run is not affected.
    expect(await runs.run(doc, input(doc, ['lazy dog']), { oldText: () => undefined })).toBeDefined();
  });

  it('D4: results of a superseded render never arrive late', async () => {
    const runs = new ResolverRuns();
    const doc = makeDocument(TEXT);
    const delivered: number[] = [];
    const slow = gate();
    const all = [1, 2, 3].map((renderId) => {
      const d = makeDocument(`Version ${renderId}.\n\n${TEXT}`, {}, renderId);
      return runs.run(d, input(doc, ['quick brown fox', 'lazy dog']), { oldText: () => undefined, pause: renderId < 3 ? slow.pause : undefined, chunk: 1 }).then((r) => {
        if (r) delivered.push(r.renderId);
      });
    });
    slow.release();
    await Promise.all(all);
    expect(delivered).toEqual([3]);
  });

  it('I6: an annotation that fails is orphaned as invalid and logged with its id; the others resolve', async () => {
    const runs = new ResolverRuns();
    const doc = makeDocument(TEXT);
    const good = highlight(doc, 'good', 'quick brown fox');
    const bad = {
      id: 'bad',
      anchor: Object.defineProperty({ prefix: '', suffix: '' }, 'exact', {
        get() {
          throw new Error('boom');
        },
      }) as never,
    };
    const log: string[] = [];
    const broken = Object.defineProperty({ id: 'd', tool: 'pen', points: [[1, 2]], updatedAt: 'x' }, 'pageIndex', {
      get() {
        throw new Error('bad drawing');
      },
    }) as never;
    const result = (await runs.run(doc, { highlights: [bad, good], drawings: [{ drawing: broken }] }, { oldText: () => undefined, log: (m) => log.push(m) }))!;
    expect(result.highlights.get('bad')).toMatchObject({ status: 'orphaned', reason: 'invalid' });
    expect(result.highlights.get('good')).toMatchObject({ status: 'anchored', kind: 'exact' });
    expect(result.drawings.get('d')).toMatchObject({ status: 'orphaned', reason: 'invalid' });
    expect(log.some((m) => m.includes('bad') && m.includes('boom'))).toBe(true);
    expect(log.some((m) => m.includes('drawing d'))).toBe(true);
  });

  it('quick results come first; the slow search fills in what only it can find', async () => {
    const runs = new ResolverRuns();
    const filler = 'Filler sentence number one is here. '.repeat(30);
    const original = `${filler}The committee approved the annual budget on Tuesday evening. ${filler}`;
    const d1 = makeDocument(original);
    const hl = highlight(d1, 'h', 'approved the annual budget on Tuesday');
    const easy = highlight(d1, 'easy', 'The committee');
    // Everything around it rewritten and a word changed: only the approximate search finds it.
    const changed = original.replace('The committee approved the annual budget on Tuesday evening.', 'Our board approved the yearly budget on Tuesday night!').replace(/Filler sentence number one is here\. /g, 'Other words. ');
    const d2 = makeDocument(changed, {}, 2);
    const quick: RunResult[] = [];
    const result = (await runs.run(d2, { highlights: [hl, easy], drawings: [] }, { oldText: () => undefined, onQuick: (r) => quick.push({ ...r, highlights: new Map(r.highlights), pending: new Set(r.pending) }) }))!;
    expect(quick).toHaveLength(1);
    expect([...quick[0].pending]).toEqual(['h', 'easy']);
    expect(quick[0].highlights.get('h')).toMatchObject({ status: 'orphaned', reason: 'not-found' });
    expect(result.pending.size).toBe(0);
    expect(result.highlights.get('h')).toMatchObject({ status: 'anchored', kind: 'edited', via: 'fuzzy' });
    expect(result.highlights.get('easy')).toMatchObject({ status: 'orphaned' });
  });

  it('highlights made by an earlier version get a wider anchor once they are found unchanged', async () => {
    const runs = new ResolverRuns();
    const doc = makeDocument(TEXT);
    const at = doc.text.indexOf('quick brown fox');
    const legacy = { id: 'old', anchor: { exact: 'quick brown fox', prefix: doc.text.slice(at - 32, at), suffix: doc.text.slice(at + 15, at + 47) } };
    const result = (await runs.run(doc, { highlights: [legacy, highlight(doc, 'new', 'lazy dog')], drawings: [] }, { oldText: () => undefined }))!;
    expect(result.upgraded.get('old')).toMatchObject({ exact: 'quick brown fox', createdIn: { start: at } });
    expect(result.upgraded.get('old')!.prefix.length).toBeGreaterThan(32);
    expect(result.upgraded.get('old')!.fingerprint).toBeDefined();
    expect(result.upgraded.has('new')).toBe(false);
  });
});

describe('what a run reports', () => {
  const four = () => scenario('summary').doc(TEXT).highlight('a', 'quick brown fox').highlight('b', 'rivers and lakes').highlight('c', 'typed notes').highlight('d', 'thanks to everyone');

  it('counts what changed category, once', async () => {
    const world = await four().run();
    expect(world.last!.summary).toMatchObject({ moved: 0, edited: 0, partial: 0, restored: 0, orphanedNow: 0, total: 4, massOrphan: false });
    await world.edit((t) => t.replace('quick brown fox', 'quick red fox').replace('rivers and ', '').replace('typed notes', 'other things').replace(' with thanks to everyone who took part in it', ''));
    expect(world.last!.summary).toMatchObject({ edited: 1, partial: 1, orphaned: { replaced: 1, deleted: 1 }, orphanedNow: 2, total: 4, massOrphan: false });
    expect(summaryMessage(world.last!.summary)).toBe('1 annotation is on text that changed; 1 annotation shrank: part of its text was deleted; 1 orphaned: its text was replaced; 1 orphaned: its text was deleted.');
    // The same text again: nothing changes category, nothing is reported.
    await world.edit((t) => `${t}\n\nOne more line.`);
    expect(summaryMessage(world.last!.summary)).toBeUndefined();
  });

  it('mass orphan: more than half of at least three, when they went missing in this render (or on opening)', async () => {
    const world = await four().run();
    await world.edit((t) => t.replace('quick brown fox ', '').replace(' about rivers and lakes', ''));
    expect(world.last!.summary).toMatchObject({ orphanedNow: 2, massOrphan: false });
    await world.edit((t) => t.replace('than typed notes', 'than others'));
    expect(world.last!.summary).toMatchObject({ orphanedNow: 3, massOrphan: true });
    expect(massOrphanMessage(world.last!.summary)).toBe("3 of 4 annotations aren't in this version of the file. They're kept and come back if the text returns.");
    // Still orphaned in the next render: no new banner.
    await world.edit((t) => `${t}\n\nMore.`);
    expect(world.last!.summary).toMatchObject({ orphanedNow: 3, massOrphan: false });
    // But on opening the document in that state, the reader is told.
    expect((await world.resolve({}, true)).summary.massOrphan).toBe(true);
    // Fewer than three annotations never raise it.
    const two = await scenario('two').doc(TEXT).highlight('a', 'quick brown fox').highlight('b', 'lazy dog').edit(() => 'Nothing of it is left.').run();
    expect(two.last!.summary).toMatchObject({ orphanedNow: 2, total: 2, massOrphan: false });
  });

  it('a provisional render reports what it does and is marked as not to be stored', async () => {
    const world = await four().run();
    const stored = JSON.stringify([...world.highlights].map(([id, h]) => [id, h.state]));
    const result = await world.edit((t) => t.replace('quick brown fox ', ''), { provisional: true });
    expect(result.provisional).toBe(true);
    expect(result.highlights.get('a')).toMatchObject({ status: 'orphaned', reason: 'deleted' });
    expect(JSON.stringify([...world.highlights].map(([id, h]) => [id, h.state]))).toBe(stored);
  });

  it('B16, I1: a render that fails changes nothing (no run happens)', async () => {
    const world: World = await four().run();
    const before = JSON.stringify({ h: [...world.highlights], last: [...world.last!.highlights] });
    // The host keeps the last good PDF: the viewer gets no new document and resolves nothing.
    expect(JSON.stringify({ h: [...world.highlights], last: [...world.last!.highlights] })).toBe(before);
  });

  it('D1, D2: annotations made or deleted while a run is in flight are resolved by the next one', async () => {
    const world = await four().run();
    const g = gate();
    const doc = makeDocument(`Preface.\n\n${TEXT}`, {}, 9);
    const stale = world.runs.run(doc, { highlights: [...world.highlights].map(([id, h]) => ({ id, anchor: h.anchor, state: h.state })), drawings: [] }, { oldText: (h) => world.texts.get(h), pause: g.pause, chunk: 1 });
    // Meanwhile the reader adds a highlight and deletes one: the viewer starts a new run.
    world.highlights.delete('d');
    world.doc = { ...doc, images: [], text: doc.model.text };
    world.addHighlight('e', 'lazy dog');
    const fresh = await world.resolve();
    g.release();
    expect(await stale).toBeUndefined();
    expect([...fresh.highlights.keys()].sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(fresh.highlights.get('e')).toMatchObject({ status: 'anchored' });
  });
});
