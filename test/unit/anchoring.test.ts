import { describe, expect, it } from 'vitest';
import { anchorQuote, createSelectors, MAX_ERROR_RATIO } from '../../src/anchoring/match';
import { TextModel } from '../../src/anchoring/textModel';
import type { TextQuoteSelector } from '../../src/shared/types';
import { MARGINS, pageFromLines } from './helpers';

function selectorsFor(text: string, exact: string, occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(exact, start + 1);
  if (start < 0) throw new Error(`"${exact}" not found`);
  return createSelectors(text, start, start + exact.length);
}

const BASE =
  'Markdown PDF Viewer renders Markdown files as real PDFs. Highlights are stored as text quotes ' +
  'with some context before and after, so they survive edits. The viewer re-anchors every highlight ' +
  'after each render and marks the ones it cannot find as orphaned instead of deleting them.';

describe('anchorQuote', () => {
  it('finds an unchanged quote through the fast path', () => {
    const [quote, position] = selectorsFor(BASE, 'stored as text quotes');
    const match = anchorQuote(BASE, quote, position);
    expect(match).toMatchObject({ start: position.start, end: position.end, errors: 0, score: 1 });
  });

  it('follows the quote when text is inserted before it', () => {
    const [quote, position] = selectorsFor(BASE, 'survive edits');
    const edited = 'A new introductory sentence was added. ' + BASE;
    const match = anchorQuote(edited, quote, position);
    expect(match).not.toBeNull();
    expect(edited.slice(match!.start, match!.end)).toBe('survive edits');
  });

  it('picks the right duplicate using the prefix and suffix', () => {
    const text = 'Error: the file was not found. Later: the file was saved to disk. Finally: the file was closed.';
    const [quote, position] = selectorsFor(text, 'the file was', 1);
    const shifted = 'Intro. ' + text;
    const match = anchorQuote(shifted, quote, { ...position, start: 0, end: 0 });
    expect(shifted.slice(match!.start, match!.end + ' saved'.length)).toBe('the file was saved');
  });

  it('uses the old position as a tie-breaker when the context is identical', () => {
    const text = 'repeat repeat repeat repeat repeat repeat';
    const quote: TextQuoteSelector = { type: 'TextQuoteSelector', exact: 'repeat', prefix: '', suffix: '' };
    const match = anchorQuote(text, quote, { type: 'TextPositionSelector', start: 28, end: 34 });
    expect(match!.start).toBe(28);
  });

  it('survives a small edit inside the quote (fuzzy match)', () => {
    const [quote, position] = selectorsFor(BASE, 'marks the ones it cannot find as orphaned');
    const edited = BASE.replace('cannot find', 'can not find');
    const match = anchorQuote(edited, quote, position);
    expect(match).not.toBeNull();
    expect(match!.errors).toBeGreaterThan(0);
    expect(edited.slice(match!.start, match!.end)).toContain('can not find as orphaned');
  });

  it('survives a deletion inside the quote', () => {
    const [quote, position] = selectorsFor(BASE, 'renders Markdown files as real PDFs');
    const edited = BASE.replace('Markdown files as real PDFs', 'Markdown files as PDFs');
    const match = anchorQuote(edited, quote, position);
    expect(edited.slice(match!.start, match!.end)).toMatch(/renders Markdown files as PDFs?/);
  });

  it('is not affected by re-wrapped lines and changed whitespace', () => {
    const before = new TextModel([pageFromLines(['Highlights are stored as', 'text quotes with context.'])]);
    const after = new TextModel([pageFromLines(['Highlights are', 'stored   as text quotes', 'with context.'])]);
    const [quote, position] = selectorsFor(before.text, 'stored as text quotes');
    const match = anchorQuote(after.text, quote, position);
    expect(match).toMatchObject({ errors: 0 });
    expect(after.text.slice(match!.start, match!.end)).toBe('stored as text quotes');
  });

  it('anchors a quote that spans a page break', () => {
    const model = new TextModel([pageFromLines(['The last line of page one'], { footer: '1 / 2' }), pageFromLines(['continues on page two.'], { footer: '2 / 2' })], {
      marginsPt: MARGINS,
    });
    expect(model.text).toBe('The last line of page one continues on page two.');
    const [quote, position] = selectorsFor(model.text, 'page one continues');
    const match = anchorQuote(model.text, quote, position)!;
    const pages = model.segments(match.start, match.end).map((s) => s.page);
    expect(pages).toEqual([0, 1]);
  });

  it('ignores footer text that would otherwise sit between pages', () => {
    const withFooter = new TextModel([pageFromLines(['alpha beta'], { footer: '1 / 2' }), pageFromLines(['gamma delta'])], {
      marginsPt: MARGINS,
    });
    const [quote] = selectorsFor('alpha beta gamma delta', 'beta gamma');
    const match = anchorQuote(withFooter.text, quote);
    expect(match).toMatchObject({ errors: 0 });
  });

  it('orphans a quote that was rewritten', () => {
    const [quote, position] = selectorsFor(BASE, 'Highlights are stored as text quotes');
    const edited = BASE.replace('Highlights are stored as text quotes', 'Annotations are persisted in a database');
    expect(anchorQuote(edited, quote, position)).toBeNull();
  });

  it('accepts at most the allowed share of errors', () => {
    const exact = 'abcdefghijklmnopqrst'; // 20 characters → at most 4 errors
    const quote: TextQuoteSelector = { type: 'TextQuoteSelector', exact, prefix: '', suffix: '' };
    const fourErrors = 'xx abcdXfghiXklmnXpqrXt xx';
    const sixErrors = 'xx aXcdXfgXijXlmnXpqXst xx';
    expect(MAX_ERROR_RATIO).toBe(0.2);
    expect(anchorQuote(fourErrors, quote)).not.toBeNull();
    expect(anchorQuote(sixErrors, quote)).toBeNull();
  });

  it('handles long quotes (beyond the 256-error search window)', () => {
    const paragraph = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about topic ${i * 7}.`).join(' ');
    const exact = paragraph.slice(100, 1400);
    const [quote, position] = selectorsFor(paragraph, exact);
    const edited = paragraph.replace('topic 63', 'subject 63');
    const match = anchorQuote(edited, quote, position);
    expect(match).not.toBeNull();
    expect(Math.abs(match!.start - 100)).toBeLessThan(5);
  });

  it('returns null for empty input', () => {
    const quote: TextQuoteSelector = { type: 'TextQuoteSelector', exact: '', prefix: '', suffix: '' };
    expect(anchorQuote('text', quote)).toBeNull();
  });
});

describe('createSelectors', () => {
  it('stores 32 characters of context on each side', () => {
    const [quote, position] = createSelectors(BASE, 100, 120);
    expect(quote.exact).toBe(BASE.slice(100, 120));
    expect(quote.prefix).toBe(BASE.slice(68, 100));
    expect(quote.suffix).toBe(BASE.slice(120, 152));
    expect(position).toEqual({ type: 'TextPositionSelector', start: 100, end: 120 });
  });

  it('clips context at the document edges', () => {
    const [quote] = createSelectors('short text', 0, 5);
    expect(quote.prefix).toBe('');
    expect(quote.suffix).toBe(' text');
  });
});
