// Performance budgets (docs/prompts/robust-annotations.md §5.9) on a synthetic document of about
// 300 pages and a million characters, with 500 highlights and 200 drawings. The limits asserted
// here are several times the budgets, so a slow machine does not fail the suite; the measured
// times are printed (run with --silent=false to see them).
import { describe, expect, it } from 'vitest';
import { createAnchor, type AnchorState, type TextAnchor } from '../../../src/anchoring/anchor';
import type { DrawingBinding } from '../../../src/anchoring/binding';
import { diffTexts } from '../../../src/anchoring/diff';
import { resolveAnchor, type ResolveContext } from '../../../src/anchoring/resolve';
import { ResolverRuns, bindDrawing } from '../../../src/anchoring/runs';
import { hashText } from '../../../src/anchoring/textModel';
import { toPdfSpace, type PdfPoint } from '../../../src/shared/drawingGeometry';
import { sanitizeDrawing, type Drawing } from '../../../src/shared/drawings';
import { makeDocument, type TestDocument } from './scenario';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(42);
const LETTERS = 'etaoinshrdlucmfwypvbgkqjxz';
const VOCABULARY = Array.from({ length: 3000 }, () =>
  Array.from({ length: 2 + Math.floor(random() * 8) }, () => LETTERS[Math.floor(random() * random() * LETTERS.length)]).join(''),
);

function paragraph(): string {
  const words: string[] = [];
  for (let i = 0, n = 60 + Math.floor(random() * 80); i < n; i++) {
    let w = VOCABULARY[Math.floor(random() * random() * VOCABULARY.length)];
    if (i % 14 === 13) w += '.';
    words.push(w);
  }
  return `${words.join(' ')}.`;
}

const PARAGRAPHS = Array.from({ length: 1550 }, paragraph);
const SOURCE = PARAGRAPHS.join('\n\n');
const LAYOUT = { charsPerLine: 90, linesPerPage: 46 };

function time<T>(run: () => T): [T, number] {
  const started = performance.now();
  const value = run();
  return [value, performance.now() - started];
}

describe('performance', () => {
  let doc: TestDocument;
  let edited: TestDocument;
  const highlights: { id: string; anchor: TextAnchor; state: AnchorState }[] = [];
  const drawings: { drawing: Drawing; binding: DrawingBinding }[] = [];

  it('the synthetic document is about 300 pages and a million characters', async () => {
    doc = makeDocument(SOURCE, LAYOUT);
    expect(doc.layout.pageCount).toBeGreaterThan(280);
    expect(doc.text.length).toBeGreaterThan(900_000);
    const text = doc.text;
    for (let i = 0; i < 500; i++) {
      let start = Math.floor(random() * (text.length - 400));
      while (text[start - 1] !== ' ' && start > 0) start--;
      let end = start + 20 + Math.floor(random() * 120);
      while (text[end] !== ' ' && end < text.length) end++;
      const anchor = createAnchor(text, doc.model.hash, start, end);
      highlights.push({ id: `h${i}`, anchor, state: { status: 'anchored', kind: 'exact', found: { hash: doc.model.hash, v: 1, length: text.length, start, end } } });
    }
    for (let i = 0; i < 200; i++) {
      let start = Math.floor(random() * (text.length - 400));
      while (text[start - 1] !== ' ' && start > 0) start--;
      let end = start + 6;
      while (text[end] !== ' ' && end < text.length) end++;
      const part = doc.layout.rangeBoxes(start, end)[0];
      const box = part.boxes[0];
      const geometry = doc.layout.geometry(part.page)!;
      const drawing = sanitizeDrawing({
        id: `d${i}`,
        tool: i % 2 ? 'ellipse' : 'line',
        color: 'red',
        width: 'thin',
        pageIndex: part.page,
        points: (i % 2
          ? [
              [box[0] - 2, box[3] + 2],
              [box[2] + 2, box[1] - 2],
            ]
          : [
              [box[0], box[3] + 1],
              [box[2], box[3] + 1],
            ]
        ).map((p) => toPdfSpace(geometry, p as PdfPoint)),
        createdAt: '2026-11-11T00:00:00.000Z',
        updatedAt: '2026-11-11T00:00:00.000Z',
      })!;
      drawings.push({ drawing, binding: (await bindDrawing(drawing, doc))! });
    }
    // A small edit near the start: a sentence added to the third paragraph.
    edited = makeDocument(SOURCE.replace(PARAGRAPHS[2], `${PARAGRAPHS[2]} One more sentence was typed here by the author.`), LAYOUT, 2);
    expect(edited.text.length).toBeGreaterThan(doc.text.length);
  }, 60_000);

  it('typical case: everything resolves after a small edit well inside the budget (300 ms)', async () => {
    const [diff, diffMs] = time(() => diffTexts(doc.text, edited.text));
    expect(diff).toBeDefined();
    const ctx: ResolveContext = { current: { text: edited.text, hash: edited.model.hash }, oldText: (h) => (h === doc.model.hash ? doc.text : undefined), diffs: new Map() };
    const [results, engineMs] = time(() => highlights.map((h) => resolveAnchor(h.anchor, h.state, ctx)));
    expect(results.every((r) => r.status === 'anchored')).toBe(true);
    expect(results.filter((r) => r.kind === 'shifted').length).toBeGreaterThan(450);
    const runs = new ResolverRuns();
    let longest = 0;
    let last = performance.now();
    const started = performance.now();
    const result = await runs.run(
      edited,
      { highlights, drawings: drawings.map((d) => ({ drawing: d.drawing, binding: d.binding })) },
      {
        oldText: (h) => (h === doc.model.hash ? doc.text : undefined),
        pause: async () => {
          longest = Math.max(longest, performance.now() - last);
          await new Promise((resolve) => setTimeout(resolve, 0));
          last = performance.now();
        },
      },
    );
    const runMs = performance.now() - started;
    expect(result!.highlights.size).toBe(500);
    expect([...result!.drawings.values()].every((d) => d.status === 'anchored')).toBe(true);
    console.log(
      `PERF typical: diff ${diffMs.toFixed(0)} ms, 500 highlights ${engineMs.toFixed(0)} ms, whole run (500 highlights + 200 drawings) ${runMs.toFixed(0)} ms, longest stretch between pauses ${longest.toFixed(0)} ms`,
    );
    expect(engineMs).toBeLessThan(1500);
    expect(runMs).toBeLessThan(3000);
  }, 60_000);

  it('the same text again: offsets are reused (no diff, no search)', () => {
    const ctx: ResolveContext = { current: { text: doc.text, hash: doc.model.hash }, oldText: () => undefined };
    const [results, ms] = time(() => highlights.map((h) => resolveAnchor(h.anchor, h.state, ctx)));
    expect(results.every((r) => r.via === 'same')).toBe(true);
    console.log(`PERF same text: 500 highlights ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(500);
  });

  it('worst case: no snapshot, every quote has to be searched for (budget about 3 s)', () => {
    const ctx: ResolveContext = { current: { text: edited.text, hash: edited.model.hash }, oldText: () => undefined };
    const [results, ms] = time(() => highlights.map((h) => resolveAnchor(h.anchor, h.state, ctx, { fuzzy: false })));
    expect(results.every((r) => r.status === 'anchored')).toBe(true);
    // And quotes that are not there at all: the quick pass says so; the slow search runs later, in the background.
    const gone = highlights
      .slice(0, 20)
      .map((h) => ({ ...h.anchor, exact: `${h.anchor.exact} zzzz qqqq`, prefix: 'not in the text at all, nowhere', suffix: 'nor is this piece of context' }));
    const [quick, quickMs] = time(() => gone.map((a) => resolveAnchor(a, undefined, ctx, { fuzzy: false })));
    expect(quick.every((r) => r.status === 'orphaned')).toBe(true);
    const [, fuzzyMs] = time(() => gone.slice(0, 5).map((a) => resolveAnchor(a, undefined, ctx)));
    console.log(`PERF worst: 500 searched ${ms.toFixed(0)} ms; 20 missing, quick pass ${quickMs.toFixed(0)} ms; approximate search ${(fuzzyMs / 5).toFixed(0)} ms each`);
    expect(ms).toBeLessThan(9000);
  }, 120_000);

  it('a diff of the whole document stays within its time budget, or gives up', () => {
    const shuffled = [...PARAGRAPHS].sort(() => random() - 0.5).join(' ');
    const [diff, ms] = time(() => diffTexts(doc.text, shuffled));
    console.log(`PERF reordered document: diff ${ms.toFixed(0)} ms (${diff ? `${diff.segments.length} segments` : 'gave up'})`);
    expect(ms).toBeLessThan(2500);
    expect(hashText(shuffled)).not.toBe(doc.model.hash);
  }, 60_000);
});
