import { describe, expect, it } from 'vitest';
import { TextModel, hashText, trimRange } from '../../src/anchoring/textModel';
import { A4_VIEW, MARGINS, pageFromLines } from './helpers';

describe('TextModel', () => {
  it('joins items, collapses whitespace and turns line ends into single spaces', () => {
    const model = new TextModel([
      {
        view: A4_VIEW,
        items: [
          { str: 'Hello,   ', hasEOL: false, transform: [1, 0, 0, 1, 50, 700] },
          { str: 'world', hasEOL: true, transform: [1, 0, 0, 1, 90, 700] },
          { str: '', hasEOL: false, transform: [1, 0, 0, 1, 50, 690] },
          { str: '  second\tline ', hasEOL: true, transform: [1, 0, 0, 1, 50, 680] },
        ],
      },
    ]);
    expect(model.text).toBe('Hello, world second line');
  });

  it('separates pages with a single space and records where each page starts', () => {
    const model = new TextModel([pageFromLines(['Page one ends here.']), pageFromLines(['Page two starts here.'])]);
    expect(model.text).toBe('Page one ends here. Page two starts here.');
    expect(model.pageStart).toEqual([0, 20, model.text.length]);
    expect(model.pageOf(0)).toBe(0);
    expect(model.pageOf(25)).toBe(1);
  });

  it('excludes header and footer text inside the page margins', () => {
    const model = new TextModel([pageFromLines(['Body text.'], { footer: '1 / 3' })], { marginsPt: MARGINS });
    expect(model.text).toBe('Body text.');
    expect(model.isIncluded(0, 1)).toBe(false);
    expect(model.indexAt(0, 1, 0, 'start')).toBeUndefined();
    const withFooter = new TextModel([pageFromLines(['Body text.'], { footer: '1 / 3' })]);
    expect(withFooter.text).toBe('Body text. 1 / 3');
  });

  it('maps text-layer positions to normalized offsets and back', () => {
    const model = new TextModel([pageFromLines(['The quick  brown fox', 'jumps over'])]);
    expect(model.text).toBe('The quick brown fox jumps over');
    // "quick" starts at raw offset 4 of item 0.
    expect(model.indexAt(0, 0, 4, 'start')).toBe(4);
    // The double space collapses: raw offset 10 ("b") is normalized offset 10.
    expect(model.indexAt(0, 0, 11, 'start')).toBe(10);
    // An exclusive end after "fox" (raw offset 20 = item length).
    expect(model.indexAt(0, 0, 20, 'end')).toBe(19);
    // "jumps" in the next item.
    expect(model.indexAt(0, 1, 0, 'start')).toBe(20);

    const segments = model.segments(4, 25); // "quick brown fox jumps"
    expect(segments).toEqual([
      {
        page: 0,
        segments: [
          { item: 0, from: 4, to: 20 },
          { item: 1, from: 0, to: 5 },
        ],
      },
    ]);
  });

  it('splits a range across a page break', () => {
    const model = new TextModel([pageFromLines(['end of page one']), pageFromLines(['start of page two'])]);
    const start = model.text.indexOf('page one');
    const end = model.text.indexOf(' of page two');
    const segments = model.segments(start, end);
    expect(segments.map((s) => s.page)).toEqual([0, 1]);
    expect(segments[0].segments).toEqual([{ item: 0, from: 7, to: 15 }]);
    expect(segments[1].segments).toEqual([{ item: 0, from: 0, to: 5 }]);
  });

  it('handles items split per word like PDF.js text content', () => {
    const model = new TextModel([pageFromLines(['alpha beta gamma'], { splitWords: true })]);
    expect(model.text).toBe('alpha beta gamma');
    const start = model.text.indexOf('beta');
    const segments = model.segments(start, start + 'beta gamma'.length);
    expect(segments[0].segments).toEqual([
      { item: 2, from: 0, to: 4 },
      { item: 3, from: 0, to: 1 },
      { item: 4, from: 0, to: 5 },
    ]);
  });

  it('produces the same text for different line wrapping', () => {
    const a = new TextModel([pageFromLines(['one two three', 'four five'])]);
    const b = new TextModel([pageFromLines(['one two', 'three four five'])]);
    expect(a.text).toBe(b.text);
    expect(a.hash).toBe(b.hash);
  });

  it('trims whitespace from ranges and hashes deterministically', () => {
    expect(trimRange(' ab ', 0, 4)).toEqual([1, 3]);
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});
