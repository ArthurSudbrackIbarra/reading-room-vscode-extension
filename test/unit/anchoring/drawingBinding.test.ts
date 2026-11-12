// What a drawing or text box gets bound to (one test per row of the binding table), how it is
// mapped when its content moves, every degradation flag, the reader's override, and what is stored.
import { describe, expect, it } from 'vitest';
import { STRETCH_MAX, inferBinding, placeDrawing, resolveBinding, sanitizeBinding, type DrawingBinding } from '../../../src/anchoring/binding';
import { hashText } from '../../../src/anchoring/textModel';
import { bindDrawing, drawingBox } from '../../../src/anchoring/runs';
import { toPageSpace, toPdfSpace, type PdfPoint } from '../../../src/shared/drawingGeometry';
import { MAX_STROKE_POINTS, sanitizeDrawing, type Drawing } from '../../../src/shared/drawings';
import { LEFT, LINE_HEIGHT, TEXT_BOX_SIZE, boxOfText, makeDocument, makeShape, type DrawSpec, type TestDocument } from './scenario';

const P1 =
  'In the first experiment the quick brown fox jumps over the lazy dog while the students take notes by hand. The notes are collected at the end of the hour and compared with the text.';
const P2 = 'The second experiment repeats the first one with a longer text about rivers and lakes. Every student writes a short summary of it.';
const SOURCE = ['Reading notes', P1, '[image 200x100]', P2].join('\n\n');
const doc = (source = SOURCE, layout = {}) => makeDocument(source, { charsPerLine: 60, linesPerPage: 30, ...layout });

async function bind(d: TestDocument, spec: DrawSpec, prefer?: 'text' | 'image' | 'page') {
  const drawing = makeShape(d, 'x', spec);
  const binding = (await bindDrawing(drawing, d, { images: (p) => d.images[p] ?? [], textSize: () => TEXT_BOX_SIZE, prefer }))!;
  return { drawing, binding };
}

/**
 * Resolves a binding in another version of the document and returns the drawing as shown there.
 * With `from` (the version it was bound in), that version's text is known, like with a snapshot.
 */
async function shownIn(d: TestDocument, drawing: Drawing, binding: DrawingBinding, from?: TestDocument) {
  const ctx = (doc: TestDocument) => ({
    current: { text: doc.text, hash: hashText(doc.text) },
    oldText: (hash: string) => (from && hash === hashText(from.text) ? from.text : undefined),
  });
  const states = from ? (await resolveBinding(binding, [], ctx(from), from.layout, { images: (p) => from.images[p] ?? [] })).states : [];
  const placement = await resolveBinding(binding, states, ctx(d), d.layout, { images: (p) => d.images[p] ?? [] });
  if (placement.status !== 'anchored') return { placement, shown: undefined, box: undefined, clipped: false };
  const geometry = d.layout.geometry(placement.page!)!;
  const placed = placeDrawing(drawing, binding, placement, geometry, drawing.tool === 'text' ? TEXT_BOX_SIZE : undefined);
  return { placement, shown: placed.drawing, box: drawingBox(placed.drawing, geometry, TEXT_BOX_SIZE), clipped: placed.clipped };
}

describe('inferBinding', () => {
  it('text-stretch: a closed shape around words, or a stroke under them, on one line', async () => {
    const d = doc();
    expect((await bind(d, { shape: 'ellipse', around: 'quick brown fox' })).binding).toMatchObject({ mode: 'text-stretch', anchors: [{ exact: 'quick brown fox' }], page: 0 });
    expect((await bind(d, { shape: 'rect', around: 'lazy dog' })).binding.mode).toBe('text-stretch');
    const under = await bind(d, { shape: 'underline', under: 'take notes by hand' });
    expect(under.binding).toMatchObject({ mode: 'text-stretch', anchors: [{ exact: 'take notes by hand.' }] });
    // The reference box is where those words were.
    expect(under.binding.ref[0][1]).toBeCloseTo(boxOfText(d, 'take notes by hand').box[1], 5);
  });

  it('text-pin: over text spanning several lines', async () => {
    const d = doc();
    const at = boxOfText(d, 'In the first experiment');
    const drawing = sanitizeDrawing({
      ...makeShape(d, 'x', { shape: 'rect', around: 'quick' }),
      points: [toPdfSpace(d.layout.geometry(0)!, [at.box[0], at.box[1] + 3 * LINE_HEIGHT]), toPdfSpace(d.layout.geometry(0)!, [at.box[0] + 200, at.box[1]])],
    })!;
    const binding = (await bindDrawing(drawing, d))!;
    expect(binding.mode).toBe('text-pin');
    expect(binding.anchors[0].exact.startsWith('In the first experiment')).toBe(true);
  });

  it('span: a tall narrow mark beside several lines, or a line or arrow with both ends near words', async () => {
    const d = doc();
    const bracket = await bind(d, { shape: 'bracket', beside: ['In the first experiment', 'the hour and compared'] });
    expect(bracket.binding.mode).toBe('span');
    expect(bracket.binding.anchors.map((a) => a.exact.slice(0, 12))).toEqual(['In the first', 'are collecte']);
    const arrow = await bind(d, { shape: 'arrow', from: 'quick', to: 'rivers' });
    expect(arrow.binding).toMatchObject({ mode: 'span', anchors: [{ exact: 'quick' }, { exact: 'rivers' }] });
  });

  it('line: in a margin or in blank space near text', async () => {
    const d = doc();
    const margin = await bind(d, { shape: 'margin', beside: 'The second experiment' });
    expect(margin.binding.mode).toBe('line');
    expect(margin.binding.anchors[0].exact.startsWith('The second experiment')).toBe(true);
    expect((await bind(d, { shape: 'note', beside: 'In the first experiment' })).binding.mode).toBe('line');
  });

  it('block: mostly over an image, with the text after and before it to find it again', async () => {
    const d = doc();
    const { binding } = await bind(d, { shape: 'rect', onImage: 0 });
    expect(binding).toMatchObject({ mode: 'block', image: { ordinal: 0, aspect: 2 }, ref: [d.images[0][0]] });
    expect(binding.anchors.map((a) => a.exact.slice(0, 10))).toEqual(['The second', 'text.']);
  });

  it('page: a page without text, and whenever the reader asks for it', async () => {
    const d = doc('[image 300x300]');
    expect((await bind(d, { shape: 'rect', at: [100, 500, 200, 560], page: 0 })).binding).toMatchObject({ mode: 'page', anchors: [], ref: [] });
    const chosen = await bind(doc(), { shape: 'ellipse', around: 'quick brown fox' }, 'page');
    expect(chosen.binding).toMatchObject({ mode: 'page', manual: true });
  });

  it('the reader can ask for the text or the image instead of what was inferred', async () => {
    const d = doc();
    expect((await bind(d, { shape: 'rect', onImage: 0 }, 'text')).binding).toMatchObject({ mode: 'line', manual: true });
    expect((await bind(d, { shape: 'ellipse', around: 'rivers and lakes' }, 'image')).binding).toMatchObject({ mode: 'block', manual: true });
  });

  it('a text box never stretches: it is pinned to the words under it, or follows the nearest line', async () => {
    const d = doc();
    expect((await bind(d, { shape: 'text', over: 'quick brown fox' })).binding.mode).toBe('text-pin');
    expect((await bind(d, { shape: 'note', beside: 'The second experiment' })).binding.mode).toBe('line');
  });

  it('text that runs sideways on the page as shown binds to the page', () => {
    const d = doc(SOURCE, { rotate: 90 });
    expect(d.layout.sideways(0)).toBe(true);
    expect(inferBinding({ tool: 'ellipse', page: 0, box: [100, 100, 150, 120] }, d.layout)).toMatchObject({ mode: 'page' });
    expect(doc().layout.sideways(0)).toBe(false);
  });
});

describe('resolveBinding and placeDrawing', () => {
  it('stretch: the shape is fitted to the new box of its words', async () => {
    const d = doc();
    const { drawing, binding } = await bind(d, { shape: 'ellipse', around: 'quick brown fox' });
    const edited = doc(SOURCE.replace('quick brown fox', 'quick dark brown fox').replace('Reading notes', 'Reading notes\n\nA new line of text above.'));
    const { placement, box } = await shownIn(edited, drawing, binding);
    expect(placement).toMatchObject({ status: 'anchored', kind: 'edited', flags: [] });
    const words = boxOfText(edited, 'quick dark brown fox').box;
    expect(Math.abs(box![0] - (words[0] - 3.5))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(box![2] - (words[2] + 3.5))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(box![1] - (words[1] - 2.5))).toBeLessThanOrEqual(1.5);
  });

  it('reflowed: words that now wrap, and a stretch beyond STRETCH_MAX, pin the shape instead', async () => {
    const d = doc();
    const { drawing, binding } = await bind(d, { shape: 'ellipse', around: 'fox jumps over' });
    const wrapped = await shownIn(doc(SOURCE, { charsPerLine: 52 }), drawing, binding);
    expect(wrapped.placement.flags).toEqual(['reflowed']);
    // Two words that become a long phrase on one line.
    const short = await bind(d, { shape: 'underline', under: 'quick brown' });
    const long = doc(SOURCE.replace('quick brown', 'quick and very small but extremely brown'), { charsPerLine: 120 });
    expect(boxOfText(long, 'quick and very small but extremely brown').boxes).toHaveLength(1);
    const stretched = await shownIn(long, short.drawing, short.binding, d);
    expect(STRETCH_MAX).toBe(3);
    expect(stretched.placement).toMatchObject({ status: 'anchored', flags: ['reflowed'] });
    const width = stretched.box![2] - stretched.box![0];
    expect(width).toBeCloseTo(drawingBox(short.drawing, d.layout.geometry(0)!)[2] - drawingBox(short.drawing, d.layout.geometry(0)!)[0], 1);
  });

  it('span: both ends are mapped; when one end is gone, or on another page, it is pinned to the other', async () => {
    const d = doc();
    const { drawing, binding } = await bind(d, { shape: 'arrow', from: 'quick', to: 'rivers' });
    const gone = await shownIn(doc(SOURCE.replace(' about rivers and lakes', '')), drawing, binding);
    expect(gone.placement).toMatchObject({ status: 'anchored', flags: ['reflowed'] });
    const both = await shownIn(doc(SOURCE.replace(P2, '')), drawing, binding);
    expect(both.placement).toMatchObject({ status: 'anchored', flags: ['reflowed'] });
    const none = await shownIn(doc('Other text entirely, about something else.'), drawing, binding);
    expect(none.placement).toMatchObject({ status: 'orphaned' });
  });

  it('clipped: a shape that would leave the page is moved back inside, whole', async () => {
    const d = doc();
    const { drawing, binding } = await bind(d, { shape: 'text', over: 'compared with the' });
    const narrow = doc(SOURCE, { charsPerLine: 60, page: [300, 842] });
    const { box, clipped } = await shownIn(narrow, drawing, binding);
    expect(clipped).toBe(true);
    expect(box![0]).toBeGreaterThanOrEqual(-0.01);
    expect(box![2]).toBeLessThanOrEqual(300.01);
  });

  it('needs-review: an image whose shape changed keeps the drawing, flagged', async () => {
    const d = doc();
    const { drawing, binding } = await bind(d, { shape: 'rect', onImage: 0 });
    const same = await shownIn(doc(SOURCE.replace('[image 200x100]', '[image 400x200]')), drawing, binding);
    expect(same.placement.flags).toEqual([]);
    const squeezed = await shownIn(doc(SOURCE.replace('[image 200x100]', '[image 200x160]')), drawing, binding);
    expect(squeezed.placement).toMatchObject({ status: 'anchored', flags: ['needs-review'] });
    const without = await shownIn(doc(SOURCE.replace('[image 200x100]\n\n', '')), drawing, binding);
    expect(without.placement.status).toBe('orphaned');
  });

  it('page: stays on its page through the page map, is found again by its fingerprint, orphans when the page is gone', async () => {
    const d = doc(SOURCE, { linesPerPage: 6 });
    const { drawing, binding } = await bind(d, { shape: 'rect', at: [100, 500, 200, 560], page: 1 }, 'page');
    const ctx = { current: { text: d.text, hash: 'h' }, oldText: () => undefined };
    const print = { ...binding, pagePrint: 'abc|595x842|0|' };
    expect(await resolveBinding(print, [], ctx, d.layout, { pageMap: (p) => (p === 1 ? 2 : undefined) })).toMatchObject({ status: 'anchored', page: 2, kind: 'shifted' });
    // The state remembers where it is now: the next page map starts from there.
    const moved = await resolveBinding(print, [], ctx, d.layout, { pageMap: (p) => p + 1 });
    expect(moved.states[0]?.found?.page).toBe(2);
    expect(await resolveBinding(print, moved.states, ctx, d.layout, { pageMap: (p) => (p === 2 ? 0 : undefined) })).toMatchObject({ page: 0 });
    expect(await resolveBinding(print, [], ctx, d.layout, { pageMap: () => undefined })).toMatchObject({ status: 'orphaned', reason: 'page-missing' });
    expect(await resolveBinding(print, [], ctx, d.layout, { pageMap: () => undefined, findPage: (p) => (p === 'abc|595x842|0|' ? 1 : undefined) })).toMatchObject({
      status: 'anchored',
      page: 1,
    });
    void drawing;
  });

  it('nothing moved: the stored drawing itself is what is shown', async () => {
    const d = doc();
    for (const spec of [
      { shape: 'ellipse', around: 'quick brown fox' },
      { shape: 'bracket', beside: ['In the first experiment', 'the hour and compared'] },
      { shape: 'margin', beside: 'The second experiment' },
      { shape: 'rect', onImage: 0 },
    ] as DrawSpec[]) {
      const { drawing, binding } = await bind(d, spec);
      expect((await shownIn(d, drawing, binding)).shown).toBe(drawing);
    }
  });

  it('geometry is stored in PDF units rounded to two decimals, on any page rotation', async () => {
    const d = doc();
    const { drawing, binding } = await bind(d, { shape: 'ellipse', around: 'quick brown fox' });
    const turned = doc(`A new first line.\n\n${SOURCE}`, { rotate: 0, page: [612, 792] });
    const { shown } = await shownIn(turned, drawing, binding);
    for (const [x, y] of shown!.points) {
      expect(Math.round(x * 100) / 100).toBe(x);
      expect(Math.round(y * 100) / 100).toBe(y);
    }
    // In page space the shape is where its words are, whatever the page box.
    const g = turned.layout.geometry(shown!.pageIndex)!;
    const corners = shown!.points.map((p) => toPageSpace(g, p as PdfPoint));
    const words = boxOfText(turned, 'quick brown fox').box;
    expect(Math.min(...corners.map((c) => c[0]))).toBeCloseTo(words[0] - 3, 0);
  });
});

describe('what is stored', () => {
  it('a binding survives being stored and read back; a broken one is dropped', async () => {
    const d = doc();
    for (const spec of [
      { shape: 'ellipse', around: 'quick brown fox' },
      { shape: 'arrow', from: 'quick', to: 'rivers' },
      { shape: 'rect', onImage: 0 },
    ] as DrawSpec[]) {
      const { binding } = await bind(d, spec);
      expect(sanitizeBinding(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
    }
    const { binding } = await bind(d, { shape: 'ellipse', around: 'quick brown fox' });
    for (const broken of [
      null,
      {},
      { ...binding, mode: 'magnet' },
      { ...binding, frame: [1, 0, 0, 0, 0, 0] },
      { ...binding, frame: [1, 2] },
      { ...binding, ref: [] },
      { ...binding, anchors: [] },
      { ...binding, pageSize: [0, 10] },
      { ...binding, ref: [[1, 2, 3, Number.NaN]] },
    ]) {
      expect(sanitizeBinding(broken)).toBeUndefined();
    }
  });

  it('E15: absurd geometry is refused or fitted, and never breaks the others', () => {
    const base = makeShape(doc(), 'p', { shape: 'margin', beside: 'The second experiment' });
    expect(sanitizeDrawing({ ...base, points: [[Number.NaN, 1]] })).toBeUndefined();
    expect(
      sanitizeDrawing({
        ...base,
        points: [
          [Infinity, 1],
          [2, 3],
        ],
      }),
    ).toBeUndefined();
    expect(
      sanitizeDrawing({
        ...base,
        points: [
          [1e9, 1],
          [2, 3],
        ],
      }),
    ).toBeUndefined();
    expect(sanitizeDrawing({ ...base, points: [] })).toBeUndefined();
    // Negative coordinates are positions (a crop box can start below zero); one point is a dot.
    expect(sanitizeDrawing({ ...base, points: [[-12.346, -7]] })?.points).toEqual([[-12.35, -7]]);
    const long = Array.from({ length: 100_000 }, (_, i): PdfPoint => [i / 100, Math.sin(i / 50) * 20]);
    let reported = 0;
    const fitted = sanitizeDrawing({ ...base, points: long }, () => reported++);
    expect(fitted!.points.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    expect(reported).toBe(1);
    expect(LEFT).toBeGreaterThan(0);
  });
});
