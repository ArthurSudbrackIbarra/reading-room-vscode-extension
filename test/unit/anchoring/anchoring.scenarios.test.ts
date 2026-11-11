// Scenarios: annotations on a laid-out document, edits, and what must be true after each render.
// Every run goes through the engine the viewer uses and through assertInvariants (see scenario.ts).
// The IDs (A1, C2, E5, G2 …) are the edge cases of docs/prompts/robust-annotations.md §6.
import { describe, expect, it } from 'vitest';
import { massOrphanMessage, summaryMessage } from '../../../src/anchoring/runs';
import { scenario } from './scenario';

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

describe('edits elsewhere and layout changes', () => {
  it('A1, C1, C2: a long paragraph inserted above pushes everything to later pages', async () => {
    const world = await base('insert above')
      .highlight('h', 'quick brown fox')
      .highlight('late', 'stable across all groups')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .draw('under', { shape: 'underline', under: 'lazy dog' })
      .draw('note', { shape: 'text', over: 'rivers and lakes' })
      .draw('mark', { shape: 'margin', beside: 'Both experiments show' })
      .draw('bracket', { shape: 'bracket', beside: ['In the first experiment', 'hour and compared'] })
      .marker('m', { lineStartingWith: 'The second experiment' })
      .expect('circle', { mode: 'text-stretch', boxCovers: 'quick brown fox' })
      .expect('under', { mode: 'text-stretch' })
      .expect('note', { mode: 'text-pin' })
      .expect('mark', { mode: 'line' })
      .expect('bracket', { mode: 'span' })
      .edit(insertAbove)
      .expect('h', { status: 'anchored', kind: 'shifted', text: 'quick brown fox', page: 1 })
      .expect('late', { status: 'anchored', kind: 'shifted', page: 2 })
      .expect('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] })
      .expect('under', { status: 'anchored', underlines: 'lazy dog', flags: [] })
      .expect('note', { status: 'anchored', follows: 'rivers and lakes' })
      .expect('mark', { status: 'anchored', follows: 'Both experiments show' })
      .expect('bracket', { status: 'anchored', page: 1 })
      .expect('m', { status: 'anchored', lineStartsWith: 'The second experiment' })
      // And back: the page count shrinks again.
      .edit((t) => t.replace(`${LONG_PARAGRAPH}\n\n`, ''))
      .expect('h', { status: 'anchored', kind: 'shifted', page: 0 })
      .expect('circle', { boxCovers: 'quick brown fox', page: 0 })
      .expect('m', { lineStartsWith: 'The second experiment' })
      .run();
    expect(world.last!.summary).toMatchObject({ moved: 0, edited: 0, orphanedNow: 0 });
    expect(summaryMessage(world.last!.summary)).toBeUndefined();
  });

  it('A2: an edit after everything changes nothing', async () => {
    await base('edit after')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .edit((t) => `${t}\n\nOne more closing paragraph.`)
      .expect('h', { kind: 'exact', page: 0 })
      .expect('circle', { boxCovers: 'quick brown fox' })
      .check((w) => expect(w.last!.drawings.get('circle')!.shown).toBe(w.drawings.get('circle')!.drawing))
      .run();
  });

  it('A16, C4, B17: rewrapping, another page size and page numbers keep everything on its words', async () => {
    await base('relayout')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown' })
      .draw('note', { shape: 'text', over: 'rivers and lakes' })
      .marker('m', { lineStartingWith: 'The second experiment' })
      .relayout({ charsPerLine: 72 })
      .expect('h', { kind: 'exact', text: 'quick brown fox' })
      .expect('circle', { boxCovers: 'quick brown', flags: [] })
      .expect('note', { follows: 'rivers and lakes' })
      .expect('m', { status: 'anchored' })
      .relayout({ page: [612, 792], footer: 'Page 1', header: 'Reading notes' })
      .expect('h', { kind: 'exact' })
      .expect('circle', { boxCovers: 'quick brown' })
      .relayout({ charsPerLine: 60, page: [595, 842], footer: undefined, header: undefined })
      .expect('circle', { boxCovers: 'quick brown', flags: [] })
      .check((w) => expect(w.last!.drawings.get('circle')!.shown).toEqual(w.drawings.get('circle')!.drawing))
      .run();
  });

  it('C5: the same text split into other text items resolves the same', async () => {
    const world = await base('split')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .marker('m', { lineStartingWith: 'The second experiment' })
      .run();
    const before = { h: world.last!.highlights.get('h'), box: world.shownBox('circle'), m: world.last!.marker };
    await world.edit((t) => t, { layout: { splitWords: true } });
    expect(world.last!.highlights.get('h')).toMatchObject({ status: 'anchored', kind: 'exact', start: before.h!.start, end: before.h!.end });
    expect(world.last!.marker).toMatchObject({ page: before.m!.page, y: before.m!.y, offset: before.m!.offset });
    const box = world.shownBox('circle')!;
    box.box.forEach((n, i) => expect(n).toBeCloseTo(before.box!.box[i], 1));
  });

  it('A23, C1: a highlight that spans a page break, then does not, then does again', async () => {
    await scenario('page break')
      .doc(BASE)
      .layout({ charsPerLine: 60, linesPerPage: 9 })
      .highlight('h', 'compared with the text.')
      .check((w) => expect(w.doc.layout.rangeBoxes(w.last!.highlights.get('h')!.start!, w.last!.highlights.get('h')!.end!).map((p) => p.page)).toEqual([0, 1]))
      .edit((t) => t.replace(`${INTRO}\n\n`, ''))
      .expect('h', { kind: 'shifted' })
      .check((w) => expect(w.doc.layout.rangeBoxes(w.last!.highlights.get('h')!.start!, w.last!.highlights.get('h')!.end!).map((p) => p.page)).toEqual([0]))
      .edit((t) => t.replace(`${TITLE}\n\n`, `${TITLE}\n\n${INTRO}\n\n`))
      .expect('h', { kind: 'shifted' })
      .check((w) => expect(w.doc.layout.rangeBoxes(w.last!.highlights.get('h')!.start!, w.last!.highlights.get('h')!.end!).map((p) => p.page)).toEqual([0, 1]))
      .run();
  });
});

describe('edits inside annotated text', () => {
  it('A3, A5, E1: words inserted or fixed inside keep everything on the passage; shapes re-fit', async () => {
    const world = await base('edit inside')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .draw('under', { shape: 'underline', under: 'quick brown fox' })
      .draw('note', { shape: 'text', over: 'quick brown fox' })
      .edit((t) => t.replace('quick brown fox', 'quick dark brown fox'))
      .expect('h', { status: 'anchored', kind: 'edited', text: 'quick dark brown fox' })
      .expect('circle', { status: 'anchored', boxCovers: 'quick dark brown fox', flags: [] })
      .expect('under', { status: 'anchored', underlines: 'quick dark brown fox' })
      .expect('note', { status: 'anchored', follows: 'quick dark brown fox' })
      .run();
    expect(summaryMessage(world.last!.summary)).toMatch(/on text that changed/);
    // E10: the highlight and the circle are on the same words.
    const h = world.last!.highlights.get('h')!;
    expect(world.doc.text.slice(h.start, h.end)).toBe('quick dark brown fox');
  });

  it('A7, E7: deleting the head or the tail shrinks them to the rest', async () => {
    await base('partial')
      .highlight('h', 'quick brown fox jumps')
      .draw('under', { shape: 'underline', under: 'quick brown fox jumps' })
      .edit((t) => t.replace('quick brown ', ''))
      .expect('h', { kind: 'partial', text: 'fox jumps' })
      .expect('under', { status: 'anchored', underlines: 'fox jumps' })
      .edit((t) => t.replace('fox jumps', 'quick brown fox jumps'))
      .expect('h', { kind: 'exact', text: 'quick brown fox jumps' })
      .expect('under', { underlines: 'quick brown fox jumps' })
      .run();
  });

  it('A8, A9, E7, I4: deleting the text orphans them with a reason; restoring it brings them back', async () => {
    const world = await base('delete')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .draw('note', { shape: 'text', over: 'quick brown fox' })
      .draw('other', { shape: 'underline', under: 'stable across' })
      .edit((t) => t.replace('quick brown fox ', ''))
      .expect('h', { status: 'orphaned', reason: 'deleted' })
      .expect('circle', { status: 'orphaned', reason: 'deleted' })
      .expect('note', { status: 'orphaned', reason: 'deleted' })
      .expect('other', { status: 'anchored', follows: 'stable across' })
      .check((w) => {
        expect(w.last!.drawings.get('circle')!.tombstone).toMatchObject({ page: 0 });
        expect(summaryMessage(w.last!.summary)).toBe('3 orphaned: their text was deleted.');
        expect(w.last!.summary.massOrphan).toBe(true);
        expect(massOrphanMessage(w.last!.summary)).toMatch(/^3 of 4 annotations aren't in this version/);
      })
      .edit((t) => t.replace(`${P1.replace('quick brown fox ', '')}\n\n`, ''))
      .expect('h', { status: 'orphaned', reason: 'deleted' })
      .edit((t) => t.replace(HEADING, `${P1}\n\n${HEADING}`))
      .expect('h', { status: 'anchored', kind: 'exact', text: 'quick brown fox' })
      .expect('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] })
      .expect('note', { status: 'anchored', follows: 'quick brown fox' })
      .run();
    expect(summaryMessage(world.last!.summary)).toBe('3 annotations are back.');
  });

  it('A10, E7: replaced text orphans them and offers what replaced it', async () => {
    await base('replace')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .edit((t) => t.replace('quick brown fox', 'tired old horse'))
      .expect('h', { status: 'orphaned', reason: 'replaced', candidate: 'tired old horse' })
      .expect('circle', { status: 'orphaned', reason: 'replaced' })
      .run();
  });

  it('A11, A12: splitting a highlighted passage into two blocks, then joining them again', async () => {
    await base('split and join')
      .highlight('h', 'take notes by hand. The notes are collected')
      .edit((t) => t.replace('by hand. The notes', 'by hand.\n\nThe notes'))
      .expect('h', { kind: 'exact', text: 'take notes by hand. The notes are collected' })
      .edit((t) => t.replace('by hand.\n\nThe notes', 'by hand.\n\nSummary\n\nThe notes'))
      .expect('h', { kind: 'edited', text: 'take notes by hand. Summary The notes are collected' })
      .edit((t) => t.replace('by hand.\n\nSummary\n\nThe notes', 'by hand. The notes'))
      .expect('h', { kind: 'exact' })
      .run();
  });
});

describe('moves and copies', () => {
  const moveDown = (t: string) => t.replace(`${P1}\n\n`, '').concat(`\n\n${P1}`);

  it('A13, G3, E5: a paragraph cut and pasted elsewhere takes everything with it', async () => {
    const world = await base('move')
      .highlight('h', 'quick brown fox')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .draw('bracket', { shape: 'bracket', beside: ['In the first experiment', 'hour and compared'] })
      .draw('mark', { shape: 'margin', beside: 'In the first experiment' })
      .marker('m', { lineStartingWith: 'In the first experiment' })
      .edit(moveDown)
      .expect('h', { status: 'anchored', kind: 'moved', text: 'quick brown fox' })
      .expect('circle', { status: 'anchored', boxCovers: 'quick brown fox' })
      .expect('mark', { status: 'anchored', follows: 'In the first experiment' })
      .expect('m', { status: 'anchored', lineStartsWith: 'In the first experiment' })
      .run();
    expect(summaryMessage(world.last!.summary)).toMatch(/moved with their text/);
    const bracket = world.shownBox('bracket')!;
    const first = world.doc.layout.lineOf(world.doc.text.indexOf('In the first experiment'))!;
    expect(bracket.page).toBe(first.page);
    expect(Math.abs(bracket.box[1] - first.line.box[1])).toBeLessThanOrEqual(1);
  });

  it('A14, A27: a copy pasted below or above does not take the annotations', async () => {
    for (const edit of [(t: string) => t.replace(P1, `${P1}\n\n${P1}`), (t: string) => t.replace(P1, `${P1.replace('quick', 'really quick')}\n\n${P1}`)]) {
      const world = await base('copy')
        .highlight('h', 'quick brown fox')
        .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
        .edit(edit)
        .expect('h', { status: 'anchored', text: 'quick brown fox' })
        .run();
      const h = world.last!.highlights.get('h')!;
      // The original is the one whose paragraph is unchanged.
      expect(world.doc.text.slice(h.start! - 28, h.start)).toBe('In the first experiment the ');
      const circle = world.shownBox('circle')!;
      const boxes = world.doc.layout.rangeBoxes(h.start!, h.end!)[0];
      expect(circle.page).toBe(boxes.page);
      expect(circle.box[1]).toBeLessThanOrEqual(boxes.boxes[0][1] + 3.5);
      expect(circle.box[3]).toBeGreaterThanOrEqual(boxes.boxes[0][3] - 3.5);
    }
  });
});

describe('whole-document events', () => {
  it('B9, B10, G4, I4: an emptied or unrelated file orphans everything, rewrites nothing, and it all comes back', async () => {
    const world = await base('emptied')
      .highlight('h', 'quick brown fox')
      .highlight('h2', 'graded by two teachers')
      .draw('circle', { shape: 'ellipse', around: 'quick brown fox' })
      .marker('m', { lineStartingWith: 'Both experiments show' })
      .run();
    const states = () => JSON.stringify([world.highlights.get('h')!.state!.found, world.highlights.get('h2')!.state!.found, world.marker!.state!.found]);
    const found = states();
    const markerPage = world.last!.marker!.page;
    for (const text of ['', '   \n\n  ', 'Shopping list\n\nMilk, eggs and a loaf of bread for the weekend.', TITLE]) {
      await world.edit(() => text);
      world.checkHighlight('h', { status: 'orphaned', reason: 'not-found' });
      world.checkHighlight('h2', { status: 'orphaned', reason: 'not-found' });
      world.checkDrawing('circle', { status: 'orphaned' });
      world.checkMarker({ stored: true, page: 0 });
      expect(states()).toBe(found);
      expect(world.marker!.page).toBe(markerPage);
    }
    expect(world.last!.summary.orphanedNow).toBe(4);
    await world.edit(() => BASE);
    world.checkHighlight('h', { status: 'anchored', kind: 'exact' });
    world.checkHighlight('h2', { status: 'anchored', kind: 'exact' });
    world.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] });
    world.checkMarker({ status: 'anchored', lineStartsWith: 'Both experiments show', stored: false });
    expect(world.last!.summary.restored).toBe(4);
  });

  it('B6: a provisional render shows its results but stores none of them', async () => {
    const world = await base('provisional').highlight('h', 'quick brown fox').draw('circle', { shape: 'ellipse', around: 'quick brown fox' }).run();
    const stored = JSON.stringify([world.highlights.get('h')!.state, world.drawings.get('circle')!.states]);
    await world.edit((t) => t.replace('quick brown fox ', ''), { provisional: true });
    world.checkHighlight('h', { status: 'orphaned', reason: 'deleted' });
    expect(world.last!.provisional).toBe(true);
    expect(JSON.stringify([world.highlights.get('h')!.state, world.drawings.get('circle')!.states])).toBe(stored);
    // The unsaved edit is thrown away: the saved text is rendered again.
    await world.edit(() => BASE);
    world.checkHighlight('h', { status: 'anchored', kind: 'exact' });
  });

  it('B3: the file changed while the viewer was closed, with and without a snapshot', async () => {
    for (const noSnapshots of [false, true]) {
      const world = await base('closed').highlight('h', 'quick brown fox').highlight('gone', 'graded by two teachers').draw('circle', { shape: 'ellipse', around: 'quick brown fox' }).run();
      await world.edit((t) => insertAbove(t).replace(', and the summaries are graded by two teachers', ''), { noSnapshots });
      world.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
      world.checkHighlight('gone', { status: 'orphaned', reason: 'deleted' });
      world.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick brown fox' });
    }
  });

  it('A14b: with the editor telling which block is the copy, annotations stay on the original', async () => {
    const world = await base('copy hint').highlight('h', 'quick brown fox').run();
    await world.edit((t) => t.replace(P1, `${P1}\n\n${P1}`), { hints: [{ text: `${P1}\n`, side: 'before' }] });
    const first = world.doc.text.indexOf('quick brown fox');
    expect(world.last!.highlights.get('h')!.start).toBe(world.doc.text.indexOf('quick brown fox', first + 1));
    await world.edit((t) => t.replace('quick brown fox', 'slow grey fox'));
    world.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
  });
});

describe('the reading marker', () => {
  it('G1: stays on its line when the start of the line is edited or deleted', async () => {
    await base('marker edit')
      .marker('m', { lineStartingWith: 'The second experiment' })
      .edit((t) => t.replace('The second experiment repeats', 'A later experiment repeats'))
      .expect('m', { status: 'anchored', lineStartsWith: 'A later experiment repeats' })
      .edit((t) => t.replace('A later experiment repeats the first one', 'It repeats the first one'))
      .expect('m', { status: 'anchored', lineStartsWith: 'It repeats the first one' })
      .run();
  });

  it('G2: goes where its line was when the line is deleted, says so, and returns with the line', async () => {
    await base('marker delete')
      .marker('m', { lineStartingWith: 'The second experiment' })
      .edit((t) => t.replace(`${P2}\n\n`, ''))
      .expect('m', { status: 'orphaned', reason: 'deleted', approximate: true, stored: false, lineStartsWith: 'Both experiments show' })
      .edit((t) => t.replace(P3, `${P2}\n\n${P3}`))
      .expect('m', { status: 'anchored', approximate: false, lineStartsWith: 'The second experiment' })
      .run();
  });

  it('G2: attaches to what replaced its line', async () => {
    await base('marker replace')
      .marker('m', { lineStartingWith: 'Results' })
      .edit((t) => t.replace(`\n\n${HEADING}\n\n`, '\n\nFindings\n\n'))
      .expect('m', { lineStartsWith: 'Findings', stored: false })
      .run();
  });

  it('G4: a document cut short below the marker shows it on the last page and keeps the stored page', async () => {
    const world = await scenario('marker cut').doc(BASE).layout({ charsPerLine: 60, linesPerPage: 9 }).marker('m', { lineStartingWith: 'Both experiments show' }).run();
    const page = world.marker!.page;
    expect(page).toBeGreaterThan(0);
    await world.edit((t) => t.slice(0, t.indexOf(P1)).trim());
    world.checkMarker({ page: 0 });
    expect(world.marker!.page).toBe(page);
    await world.edit(() => BASE);
    world.checkMarker({ status: 'anchored', page, lineStartsWith: 'Both experiments show', stored: false });
  });

  it('G5: a marker without text keeps its page and position', async () => {
    const world = await base('marker no text').run();
    world.marker = { page: 1, y: 0.4 };
    world.readerActed();
    await world.edit(insertAbove);
    world.checkMarker({ page: 1, stored: true });
    expect(world.last!.marker!.y).toBe(0.4);
  });
});

describe('drawings', () => {
  it('E4: an arrow between two words follows both ends, and is pinned when they end up on different pages', async () => {
    await scenario('arrow')
      .doc(BASE)
      .layout({ charsPerLine: 60, linesPerPage: 16 })
      .draw('arrow', { shape: 'arrow', from: 'university', to: 'lazy' })
      .expect('arrow', { mode: 'span', endsNear: ['university', 'lazy'] })
      .edit((t) => t.replace(P1, `One more short paragraph in between.\n\n${P1}`).replace('This report', 'Indeed this report'))
      .expect('arrow', { status: 'anchored', endsNear: ['university', 'lazy'], flags: [] })
      .edit((t) => t.replace('One more short paragraph in between.', LONG_PARAGRAPH))
      .expect('arrow', { status: 'anchored', flags: ['reflowed'], page: 0 })
      .run();
  });

  it('E5: a margin bracket stretches when lines are added inside its span, and shrinks back', async () => {
    const world = await base('bracket').draw('bracket', { shape: 'bracket', beside: ['In the first experiment', 'hour and compared'] }).expect('bracket', { mode: 'span' }).run();
    const height = () => {
      const b = world.shownBox('bracket')!.box;
      return b[3] - b[1];
    };
    const before = height();
    await world.edit((t) => t.replace('by hand. The notes', 'by hand. Some more sentences are added here in the middle of the paragraph, enough of them to make it two lines longer than it was before. The notes'));
    expect(height()).toBeGreaterThan(before + 20);
    const first = world.doc.layout.lineOf(world.doc.text.indexOf('In the first experiment'))!.line.box;
    const last = world.doc.layout.lineOf(world.doc.text.indexOf('hour and compared'))!.line.box;
    const box = world.shownBox('bracket')!.box;
    expect(Math.abs(box[1] - first[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(box[3] - last[3])).toBeLessThanOrEqual(1);
    await world.edit(() => BASE);
    expect(height()).toBeCloseTo(before, 1);
  });

  it('E6: words that wrap onto two lines pin the shape to the first part; unwrapping re-fits it', async () => {
    await base('wrap')
      .draw('circle', { shape: 'ellipse', around: 'fox jumps over' })
      .expect('circle', { mode: 'text-stretch', boxCovers: 'fox jumps over' })
      .relayout({ charsPerLine: 52 })
      .check((w) => expect(w.doc.layout.rangeBoxes(w.doc.text.indexOf('fox jumps over'), w.doc.text.indexOf('fox jumps over') + 14)[0].boxes.length).toBe(2))
      .expect('circle', { status: 'anchored', flags: ['reflowed'] })
      .relayout({ charsPerLine: 60 })
      .expect('circle', { status: 'anchored', flags: [], boxCovers: 'fox jumps over' })
      .run();
  });

  it('E8: a drawing that would leave the page is moved back inside and flagged', async () => {
    await base('clip')
      .draw('note', { shape: 'text', over: 'groups of students' })
      .relayout({ charsPerLine: 84, page: [595, 842] })
      .expect('note', { status: 'anchored', follows: 'groups of students', flags: [] })
      .relayout({ charsPerLine: 96, page: [612, 842] })
      .check((w) => {
        const text = w.doc.layout.rangeBoxes(w.doc.text.indexOf('groups of students'), w.doc.text.indexOf('groups of students') + 6)[0].boxes[0];
        const shown = w.shownBox('note')!;
        // Clipped only if it had to be.
        const flags = w.last!.drawings.get('note')!.flags;
        if (text[0] + 2 + 40 > 612) expect(flags).toEqual(['clipped']);
        expect(shown.box[2]).toBeLessThanOrEqual(612.01);
      })
      .run();
  });

  it('E2: a drawing on an image scales with it, is flagged when its shape changes, and orphans without it', async () => {
    const withImage = (size: string) => [TITLE, INTRO, `[image ${size}]`, P1, P2].join('\n\n');
    const world = await scenario('image').doc(withImage('200x100')).layout({ charsPerLine: 60, linesPerPage: 30 }).draw('box', { shape: 'rect', onImage: 0 }).expect('box', { mode: 'block', insideImage: 0 }).run();
    const width = () => {
      const b = world.shownBox('box')!.box;
      return b[2] - b[0];
    };
    const before = width();
    await world.edit(() => withImage('300x150').replace(INTRO, `${INTRO} ${INTRO}`));
    world.checkDrawing('box', { status: 'anchored', insideImage: 0, flags: [] });
    expect(Math.abs(width() - before * 1.5)).toBeLessThanOrEqual(1);
    await world.edit(() => withImage('300x100'));
    world.checkDrawing('box', { status: 'anchored', insideImage: 0, flags: ['needs-review'] });
    await world.edit(() => [TITLE, INTRO, P1, P2].join('\n\n'));
    world.checkDrawing('box', { status: 'orphaned' });
    await world.edit(() => withImage('200x100'));
    world.checkDrawing('box', { status: 'anchored', insideImage: 0, flags: [] });
    expect(width()).toBeCloseTo(before, 1);
  });

  it('E3: marks in the margin, between paragraphs and at the top of a page follow the nearest line', async () => {
    await base('margins')
      .draw('margin', { shape: 'margin', beside: 'The second experiment' })
      .draw('note', { shape: 'note', beside: 'Both experiments show' })
      .expect('margin', { mode: 'line' })
      .expect('note', { mode: 'line' })
      .edit(insertAbove)
      .expect('margin', { status: 'anchored', follows: 'The second experiment' })
      .expect('note', { status: 'anchored', follows: 'Both experiments show' })
      .run();
  });

  it('E9: a drawing bound to the page stays at its place on that page, and orphans when the page is gone', async () => {
    const world = await base('page').run();
    await world.addDrawing('p', { shape: 'rect', at: [100, 500, 200, 560], page: 1 }, 'page');
    await world.resolve();
    world.checkDrawing('p', { status: 'anchored', mode: 'page', page: 1 });
    await world.edit((t) => t.slice(0, t.indexOf(HEADING)).trim());
    expect(world.doc.layout.pageCount).toBe(1);
    world.checkDrawing('p', { status: 'orphaned', reason: 'page-missing' });
    await world.edit(() => BASE);
    world.checkDrawing('p', { status: 'anchored', page: 1 });
  });

  it('E16: drawings made before bindings existed are bound where they stand; on another version they are flagged', async () => {
    const world = await base('legacy').run();
    await world.addDrawing('same', { shape: 'ellipse', around: 'quick brown fox' });
    await world.addDrawing('older', { shape: 'underline', under: 'lazy dog' });
    for (const id of ['same', 'older']) delete world.drawings.get(id)!.binding;
    world.drawings.get('older')!.drawing.textModelHash = 'another-version';
    world.readerActed();
    const result = await world.resolve();
    expect(result.drawings.get('same')).toMatchObject({ status: 'anchored', flags: [] });
    expect(result.drawings.get('same')!.binding).toMatchObject({ mode: 'text-stretch' });
    expect(result.drawings.get('older')).toMatchObject({ status: 'anchored', flags: ['needs-review'] });
    expect(world.drawings.get('older')!.binding).toMatchObject({ review: true });
    // The binding is stored once; the next render keeps it and follows the text.
    await world.edit(insertAbove);
    world.checkDrawing('same', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] });
    expect(world.last!.drawings.get('same')!.binding).toBeUndefined();
  });

  it('E14: a binding made for another version of the drawing (moved since, here or by an older release) is inferred again', async () => {
    const world = await base('stale binding').draw('circle', { shape: 'ellipse', around: 'quick brown fox' }).run();
    const record = world.drawings.get('circle')!;
    record.drawing = { ...record.drawing, updatedAt: '2026-11-12T00:00:00.000Z' };
    world.readerActed();
    const result = await world.resolve();
    expect(result.drawings.get('circle')!.binding).toMatchObject({ mode: 'text-stretch', for: '2026-11-12T00:00:00.000Z' });
  });
});
