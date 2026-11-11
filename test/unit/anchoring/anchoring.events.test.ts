// Whole-document events on a laid-out document: text hidden and shown again, undo and revert,
// the transient states of an external write, garbage in the file, very large files, a picture that
// loads in one render and not in the next. IDs are the edge cases of docs/prompts/robust-annotations.md §6.
import { describe, expect, it } from 'vitest';
import { boxOfText, scenario, type World } from './scenario';
import { step, textOf, track } from './track';

const TITLE = 'Reading notes';
const INTRO = 'This report describes two experiments on the reading habits of students in their first year at the university. It was written over one summer and revised twice.';
const P1 = 'In the first experiment the quick brown fox jumps over the lazy dog while the students take notes by hand. The notes are collected at the end of the hour and compared with the text.';
const HEADING = 'Results';
const P2 = 'The second experiment repeats the first one with a longer text about rivers and lakes. Every student writes a short summary of it, and the summaries are graded by two teachers.';
const P3 = 'Both experiments show that notes taken by hand are remembered longer than typed notes. The difference is small but it is stable across all groups of students.';
const BASE = [TITLE, INTRO, P1, HEADING, P2, P3].join('\n\n');
const LONG_PARAGRAPH = `A paragraph that was added later. ${'It has many more words than the others and takes a lot of room. '.repeat(12)}`.trim();
const LAYOUT = { charsPerLine: 60, linesPerPage: 16 };

const base = (name: string) => scenario(name).doc(BASE).layout(LAYOUT);
const insertAbove = (t: string) => t.replace(P1, `${LONG_PARAGRAPH}\n\n${P1}`);

/** Where a drawing is shown, relative to the words it is on: the page difference and the four sides. */
function offsetFrom(world: World, id: string, words: string): number[] {
  const text = boxOfText(world.doc, words);
  const shown = world.shownBox(id)!;
  return [shown.page - text.page, ...shown.box.map((v, i) => Math.round((v - text.box[i]) * 100) / 100)];
}

describe('text that goes and comes back', () => {
  it('A25: text that becomes hidden (an HTML comment, the front matter) is deleted; shown again, it is exact', async () => {
    const SENTENCE = ' The notes are collected at the end of the hour and compared with the text.';
    await base('hidden')
      .highlight('h', 'collected at the end of the hour')
      .draw('under', { shape: 'underline', under: 'collected at the end' })
      .edit((t) => t.replace(SENTENCE, ''))
      .expect('h', { status: 'orphaned', reason: 'deleted' })
      .expect('under', { status: 'orphaned', reason: 'deleted' })
      .edit(() => BASE)
      .expect('h', { status: 'anchored', kind: 'exact', text: 'collected at the end of the hour' })
      .expect('under', { status: 'anchored', underlines: 'collected at the end', flags: [] })
      .run();
  });

  it('B4, B5: undo, redo and Revert File go back through earlier versions, and everything returns to where it was', async () => {
    const world = await base('undo')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .marker('m', { lineStartingWith: 'Both experiments show' })
      .run();
    const place = () => JSON.stringify([world.last!.highlights.get('h')!.start, world.shownBox('circle'), world.last!.marker!.page]);
    const first = place();
    const versions = [BASE, insertAbove(BASE), insertAbove(BASE).replace('quick brown fox', 'quick red fox'), insertAbove(BASE).replace(`${P1}\n\n`, '')];
    // Typed forward, undone step by step, redone, then reverted to the saved file in one step.
    for (const i of [1, 2, 3, 2, 1, 0, 1, 2, 3, 0]) {
      await world.edit(() => versions[i]);
      if (i === 3) {
        world.checkHighlight('h', { status: 'orphaned', reason: 'deleted' });
        world.checkDrawing('circle', { status: 'orphaned', reason: 'deleted' });
      } else if (i === 2) {
        world.checkHighlight('h', { status: 'anchored', kind: 'edited', text: 'quick red fox' });
        world.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick red fox' });
      } else {
        world.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
        world.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] });
      }
      world.checkMarker({ status: 'anchored', lineStartsWith: 'Both experiments show' });
    }
    expect(place()).toBe(first);
  });

  it('B2: the transient states of an external write (emptied, half written, complete) lose nothing', async () => {
    const world = await base('transient')
      .highlight('h', 'quick brown fox')
      .highlight('late', 'stable across all groups')
      .draw('circle', { shape: 'ellipse', around: 'rivers and lakes' })
      .marker('m', { lineStartingWith: 'Both experiments show' })
      .run();
    const markerPage = world.marker!.page;
    const next = insertAbove(BASE);
    // The other program truncates the file, has written a part of it (cut inside a word), then all of it.
    const half = next.slice(0, next.indexOf('rivers and lakes') + 3);
    await world.edit(() => '');
    world.checkHighlight('h', { status: 'orphaned' });
    expect(world.marker!.page).toBe(markerPage);
    await world.edit(() => half);
    world.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
    world.checkHighlight('late', { status: 'orphaned' });
    expect(world.marker!.page).toBe(markerPage);
    await world.edit(() => next);
    world.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
    world.checkHighlight('late', { status: 'anchored', text: 'stable across all groups' });
    expect(world.last!.summary.restored).toBeGreaterThanOrEqual(2);
    world.checkDrawing('circle', { status: 'anchored', boxCovers: 'rivers and lakes', flags: [] });
    world.checkMarker({ status: 'anchored', lineStartsWith: 'Both experiments show' });
  });

  it('B6: an annotation made on unsaved text that is never saved is orphaned as not found; the others are untouched', async () => {
    const world = await base('unsaved').highlight('h', 'quick brown fox').draw('circle', { shape: 'ellipse', around: 'rivers and lakes' }).run();
    const stored = JSON.stringify([world.highlights.get('h')!.state, world.drawings.get('circle')!.states]);
    // Refresh with unsaved edits: a sentence that exists only in the editor.
    await world.edit((t) => t.replace(P3, `${P3} A thought typed into the editor and never saved to the file.`), { provisional: true });
    world.addHighlight('new', 'typed into the editor and never saved');
    await world.resolve({ provisional: true });
    world.checkHighlight('new', { status: 'anchored', text: 'typed into the editor and never saved' });
    // Closed without saving, opened again: the file has the saved text.
    await world.edit(() => BASE);
    world.checkHighlight('new', { status: 'orphaned', reason: 'not-found' });
    world.checkHighlight('h', { status: 'anchored', kind: 'exact', text: 'quick brown fox' });
    world.checkDrawing('circle', { status: 'anchored', boxCovers: 'rivers and lakes', flags: [] });
    expect(JSON.stringify([world.highlights.get('h')!.state, world.drawings.get('circle')!.states])).toBe(stored);
  });

  it('B12: binary garbage, NUL bytes and broken UTF-8 crash nothing; annotations orphan and come back with the text', async () => {
    // Built from character codes: NUL, a control character, replacement characters (what invalid
    // UTF-8 decodes to), a zip signature, and two halves of a surrogate pair that are not a pair.
    const garbage = [0, 1, 0xfffd, 0xfffd, 0x50, 0x4b, 3, 4, 0x20, 0xd800, 0x20, 0xdc00, 0, 0x0a]
      .map((c) => String.fromCharCode(c))
      .join('')
      .repeat(60);
    const world = await base('garbage')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .draw('note', { shape: 'text', over: 'rivers and lakes' })
      .marker('m', { lineStartingWith: 'Both experiments show' })
      .run();
    const markerPage = world.marker!.page;
    for (const text of [garbage, `${BASE.slice(0, 200)}${garbage}`, garbage.slice(0, 7)]) {
      await world.edit(() => text);
      world.checkHighlight('h', { status: 'orphaned' });
      world.checkDrawing('circle', { status: 'orphaned' });
      expect(world.marker!.page).toBe(markerPage);
    }
    await world.edit(() => BASE);
    world.checkHighlight('h', { status: 'anchored', kind: 'exact', text: 'quick brown fox' });
    world.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] });
    world.checkDrawing('note', { status: 'anchored', follows: 'rivers and lakes' });
    world.checkMarker({ status: 'anchored', lineStartsWith: 'Both experiments show' });
  });
});

describe('layout flips', () => {
  it('B19: a picture that loads in one render and fails in the next only moves things; what is on the picture waits for it', async () => {
    const withImage = [TITLE, INTRO, '[image 200x100]', P1, P2].join('\n\n');
    const without = [TITLE, INTRO, P1, P2].join('\n\n');
    const world = await scenario('flip')
      .doc(withImage)
      .layout({ charsPerLine: 60, linesPerPage: 30 })
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .draw('box', { shape: 'rect', onImage: 0 })
      .run();
    const circle = offsetFrom(world, 'circle', 'quick brown fox');
    for (let round = 0; round < 3; round++) {
      await world.edit(() => without);
      world.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
      world.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] });
      world.checkDrawing('box', { status: 'orphaned' });
      expect(offsetFrom(world, 'circle', 'quick brown fox')).toEqual(circle);
      await world.edit(() => withImage);
      world.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
      world.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] });
      world.checkDrawing('box', { status: 'anchored', insideImage: 0, flags: [] });
      expect(offsetFrom(world, 'circle', 'quick brown fox')).toEqual(circle);
    }
  });

  it('E10: a highlight and a drawing on the same words move identically', async () => {
    const world = await base('same words').highlight('h', 'quick brown fox').draw('circle', { shape: 'ellipse', around: 'quick brown fox' }).draw('under', { shape: 'underline', under: 'quick brown fox' }).run();
    const before = [offsetFrom(world, 'circle', 'quick brown fox'), offsetFrom(world, 'under', 'quick brown fox')];
    const edits: ((t: string) => string)[] = [insertAbove, (t) => t.replace(INTRO, ''), (t) => t.replace('In the first experiment the', 'Then the'), () => BASE];
    for (const edit of edits) {
      await world.edit(edit);
      const h = world.last!.highlights.get('h')!;
      expect(world.doc.text.slice(h.start, h.end)).toBe('quick brown fox');
      // The drawings are where the highlight is: on its page, at the same offsets from its words.
      expect([offsetFrom(world, 'circle', 'quick brown fox'), offsetFrom(world, 'under', 'quick brown fox')]).toEqual(before);
    }
  });
});

describe('very large files (B11)', () => {
  it('100 000 lines: annotations follow an edit near the top and one in the middle', () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `Line ${i} holds reading ${(i * 7919) % 100_003} of the series.`);
    const text = lines.join('\n');
    const early = track(text, 'Line 12345 holds reading');
    const late = track(text, 'Line 87654 holds reading');
    const edited = ['A line added at the top.', 'And another one.', ...lines.slice(0, 50_000), 'Something typed in the middle of the file.', ...lines.slice(50_000)].join('\n');
    const started = performance.now();
    const a = step(early, edited);
    const b = step(late, edited);
    const took = performance.now() - started;
    expect(textOf(edited, a)).toBe('Line 12345 holds reading');
    expect(textOf(edited, b)).toBe('Line 87654 holds reading');
    expect(a.status).toBe('anchored');
    expect(b.status).toBe('anchored');
    expect(took).toBeLessThan(5000);
  });

  it('a single line of 1 MB: the same', () => {
    const words = Array.from({ length: 150_000 }, (_, i) => `w${i}`);
    const text = words.join(' ');
    expect(text.length).toBeGreaterThan(1_000_000);
    const t = track(text, 'w100000 w100001 w100002');
    const edited = ['typed', 'first', ...words.slice(0, 40_000), ...words.slice(40_010)].join(' ');
    const started = performance.now();
    const r = step(t, edited);
    const took = performance.now() - started;
    expect(textOf(edited, r)).toBe('w100000 w100001 w100002');
    expect(took).toBeLessThan(5000);
    // And without the old text: searched for.
    const blind = track(text, 'w100000 w100001 w100002');
    expect(textOf(edited, step(blind, edited, { noSnapshot: true }))).toBe('w100000 w100001 w100002');
  });
});
