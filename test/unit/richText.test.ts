// Bold, italic, underline and color on parts of a text: the spans a text box stores.
import { describe, expect, it } from 'vitest';
import {
  MIXED_COLOR,
  colorAt,
  colorRange,
  rangeColor,
  rangeStyle,
  replaceRange,
  sameSpans,
  sanitizeSpans,
  styleAt,
  styleRange,
  textRuns,
  withoutColor,
  type TextSpan,
} from '../../src/shared/richText';

const NL = String.fromCharCode(10);

describe('styled parts of a text', () => {
  const text = 'The quick brown fox';
  const spans: TextSpan[] = [
    { start: 4, end: 9, bold: true },
    { start: 10, end: 15, italic: true, underline: true },
  ];

  it('tell the style of each character', () => {
    expect(styleAt(spans, 4)).toEqual({ bold: true, italic: false, underline: false });
    expect(styleAt(spans, 9)).toEqual({ bold: false, italic: false, underline: false });
    expect(styleAt(spans, 12)).toEqual({ bold: false, italic: true, underline: true });
    expect(styleAt(undefined, 3)).toEqual({ bold: false, italic: false, underline: false });
  });

  it('cut the text into runs of one style each, covering all of it', () => {
    const runs = textRuns(text, spans);
    expect(runs.map((r) => r.text)).toEqual(['The ', 'quick', ' ', 'brown', ' fox']);
    expect(runs.map((r) => r.bold)).toEqual([false, true, false, false, false]);
    expect(runs.map((r) => r.italic)).toEqual([false, false, false, true, false]);
    expect(runs.map((r) => r.text).join('')).toBe(text);
    expect(textRuns('', undefined)).toEqual([]);
    // A stretch of the text (a line): runs inside it only.
    expect(textRuns(text, spans, 6, 12).map((r) => [r.start, r.end, r.bold, r.italic])).toEqual([
      [6, 9, true, false],
      [9, 10, false, false],
      [10, 12, false, true],
    ]);
  });

  it('set a style on a range, merging with what is there', () => {
    expect(styleRange(spans, text.length, 0, 6, { bold: true })).toEqual([
      { start: 0, end: 9, bold: true },
      { start: 10, end: 15, italic: true, underline: true },
    ]);
    expect(styleRange(spans, text.length, 6, 12, { italic: true })).toEqual([
      { start: 4, end: 6, bold: true },
      { start: 6, end: 9, bold: true, italic: true },
      { start: 9, end: 10, italic: true },
      { start: 10, end: 15, italic: true, underline: true },
    ]);
  });

  it('clear a style on a range, and store nothing when nothing is styled', () => {
    expect(styleRange(spans, text.length, 0, text.length, { bold: false })).toEqual([{ start: 10, end: 15, italic: true, underline: true }]);
    expect(styleRange(spans, text.length, 0, text.length, { bold: false, italic: false, underline: false })).toBeUndefined();
  });

  it('say which styles all of a range has (line breaks do not count)', () => {
    expect(rangeStyle(text, spans, 4, 9).bold).toBe(true);
    expect(rangeStyle(text, spans, 3, 9).bold).toBe(false);
    expect(rangeStyle(text, spans, 0, text.length)).toEqual({ bold: false, italic: false, underline: false });
    const lines = `ab${NL}cd`;
    const bold = [
      { start: 0, end: 2, bold: true as const },
      { start: 3, end: 5, bold: true as const },
    ];
    expect(rangeStyle(lines, bold, 0, 5).bold).toBe(true);
    expect(rangeStyle(lines, bold, 2, 3).bold).toBe(false);
  });

  it('follow the text as characters are typed, deleted and replaced', () => {
    // Typing plain text before a bold word moves it.
    expect(replaceRange(spans, text.length, 0, 0, 3)).toEqual([
      { start: 7, end: 12, bold: true },
      { start: 13, end: 18, italic: true, underline: true },
    ]);
    // Typing bold text right after a bold word extends it.
    expect(replaceRange(spans, text.length, 9, 9, 2, { bold: true })?.[0]).toEqual({ start: 4, end: 11, bold: true });
    // Typing plain text inside a bold word splits it.
    expect(replaceRange(spans, text.length, 6, 6, 1)?.slice(0, 2)).toEqual([
      { start: 4, end: 6, bold: true },
      { start: 7, end: 10, bold: true },
    ]);
    // Deleting across two styled words keeps what is left of each.
    expect(replaceRange(spans, text.length, 6, 12, 0)).toEqual([
      { start: 4, end: 6, bold: true },
      { start: 6, end: 9, italic: true, underline: true },
    ]);
    // Deleting everything leaves nothing styled.
    expect(replaceRange(spans, text.length, 0, text.length, 0)).toBeUndefined();
  });

  it('clean spans from a file: inside the text, sorted, merged, styled', () => {
    expect(
      sanitizeSpans(
        [
          { start: 5, end: 8, bold: true },
          { start: 0, end: 5, bold: true },
          { start: 2, end: 3 },
        ],
        6,
      ),
    ).toEqual([{ start: 0, end: 6, bold: true }]);
    expect(sanitizeSpans([{ start: -1, end: 3, bold: true }, { start: 1.5, end: 3, bold: true }, null, 'x'], 6)).toBeUndefined();
    expect(sanitizeSpans({ start: 0, end: 2, bold: true }, 6)).toBeUndefined();
    expect(sameSpans(sanitizeSpans([{ start: 0, end: 2, italic: true, bold: true }], 4), [{ start: 0, end: 2, bold: true, italic: true }])).toBe(true);
    expect(sameSpans(undefined, [])).toBe(true);
  });
});

describe('parts of a text in a color of their own', () => {
  const text = 'The quick brown fox';
  const spans: TextSpan[] = [
    { start: 4, end: 9, bold: true, color: 'red' },
    { start: 10, end: 15, color: '#1F77B4' },
  ];

  it('tell the color of each character (none: the color of the box)', () => {
    expect(colorAt(spans, 4)).toBe('red');
    expect(colorAt(spans, 8)).toBe('red');
    expect(colorAt(spans, 9)).toBeUndefined();
    expect(colorAt(spans, 12)).toBe('#1F77B4');
    expect(colorAt(undefined, 3)).toBeUndefined();
    expect(colorAt(spans, 99)).toBeUndefined();
    // The color does not change what is said of bold and so on.
    expect(styleAt(spans, 4)).toEqual({ bold: true, italic: false, underline: false });
    expect(styleAt(spans, 12)).toEqual({ bold: false, italic: false, underline: false });
  });

  it('cut the text into runs of one style and one color each', () => {
    const runs = textRuns(text, spans);
    expect(runs.map((r) => r.text)).toEqual(['The ', 'quick', ' ', 'brown', ' fox']);
    expect(runs.map((r) => r.color)).toEqual([undefined, 'red', undefined, '#1F77B4', undefined]);
    expect(runs.map((r) => r.bold)).toEqual([false, true, false, false, false]);
    // A run without a color of its own does not name one.
    expect('color' in runs[0]).toBe(false);
    // Two colors inside one bold word are two runs.
    const split = textRuns('abcd', [
      { start: 0, end: 2, bold: true, color: 'red' },
      { start: 2, end: 4, bold: true, color: 'blue' },
    ]);
    expect(split.map((r) => [r.text, r.bold, r.color])).toEqual([
      ['ab', true, 'red'],
      ['cd', true, 'blue'],
    ]);
    // A stretch of the text (a line): runs inside it only.
    expect(textRuns(text, spans, 6, 12).map((r) => [r.start, r.end, r.color])).toEqual([
      [6, 9, 'red'],
      [9, 10, undefined],
      [10, 12, '#1F77B4'],
    ]);
  });

  it('set a color on a range, keeping bold and so on, and merging with what is there', () => {
    expect(colorRange(undefined, 10, 2, 5, 'green')).toEqual([{ start: 2, end: 5, color: 'green' }]);
    // Over part of a bold word: the word is cut where the color changes, and stays bold.
    expect(colorRange(spans, text.length, 6, 12, 'green')).toEqual([
      { start: 4, end: 6, bold: true, color: 'red' },
      { start: 6, end: 9, bold: true, color: 'green' },
      { start: 9, end: 12, color: 'green' },
      { start: 12, end: 15, color: '#1F77B4' },
    ]);
    // The same color next to itself is one span.
    expect(colorRange([{ start: 0, end: 3, color: 'red' }], 6, 3, 6, 'red')).toEqual([{ start: 0, end: 6, color: 'red' }]);
    // A range beyond the text is cut to it.
    expect(colorRange(undefined, 4, 2, 99, 'red')).toEqual([{ start: 2, end: 4, color: 'red' }]);
  });

  it('take a color away from a range, and store nothing when nothing is left', () => {
    expect(colorRange(spans, text.length, 0, text.length, undefined)).toEqual([{ start: 4, end: 9, bold: true }]);
    expect(colorRange([{ start: 0, end: 4, color: 'red' }], 4, 0, 4, undefined)).toBeUndefined();
    expect(colorRange([{ start: 0, end: 4, color: 'red' }], 4, 1, 3, undefined)).toEqual([
      { start: 0, end: 1, color: 'red' },
      { start: 3, end: 4, color: 'red' },
    ]);
  });

  it('take one color away wherever it is (it became the color of the box)', () => {
    expect(withoutColor(spans, text.length, 'red')).toEqual([
      { start: 4, end: 9, bold: true },
      { start: 10, end: 15, color: '#1F77B4' },
    ]);
    expect(withoutColor(spans, text.length, 'green')).toEqual(spans);
    expect(withoutColor([{ start: 0, end: 2, color: 'red' }], 2, 'red')).toBeUndefined();
    expect(withoutColor(undefined, 5, 'red')).toBeUndefined();
  });

  it('say which color all of a range has, telling none from several (line breaks do not count)', () => {
    expect(rangeColor(text, spans, 4, 9)).toBe('red');
    expect(rangeColor(text, spans, 5, 7)).toBe('red');
    expect(rangeColor(text, spans, 0, 4)).toBeUndefined();
    // Red and no color, red and blue: several.
    expect(rangeColor(text, spans, 3, 9)).toBe(MIXED_COLOR);
    expect(rangeColor(text, spans, 4, 15)).toBe(MIXED_COLOR);
    expect(rangeColor(text, undefined, 0, text.length)).toBeUndefined();
    // A stretch without characters has none.
    expect(rangeColor(text, spans, 6, 6)).toBeUndefined();
    const lines = `ab${NL}cd`;
    const red: TextSpan[] = [
      { start: 0, end: 2, color: 'red' },
      { start: 3, end: 5, color: 'red' },
    ];
    expect(rangeColor(lines, red, 0, 5)).toBe('red');
    expect(rangeColor(lines, red, 2, 3)).toBeUndefined();
  });

  it('stay when bold and so on are set or cleared', () => {
    expect(styleRange(spans, text.length, 0, text.length, { bold: false })).toEqual([
      { start: 4, end: 9, color: 'red' },
      { start: 10, end: 15, color: '#1F77B4' },
    ]);
    expect(styleRange(spans, text.length, 10, 12, { underline: true })).toEqual([
      { start: 4, end: 9, bold: true, color: 'red' },
      { start: 10, end: 12, underline: true, color: '#1F77B4' },
      { start: 12, end: 15, color: '#1F77B4' },
    ]);
    // Clearing every style leaves the colors.
    expect(styleRange(spans, text.length, 0, text.length, { bold: false, italic: false, underline: false })).toEqual([
      { start: 4, end: 9, color: 'red' },
      { start: 10, end: 15, color: '#1F77B4' },
    ]);
    // What all of a range has of bold and so on does not depend on its colors.
    expect(rangeStyle(text, spans, 4, 9)).toEqual({ bold: true, italic: false, underline: false });
  });

  it('follow the text as characters are typed, deleted and replaced', () => {
    // Typing in the color of the box before a colored word moves it.
    expect(replaceRange(spans, text.length, 0, 0, 3)).toEqual([
      { start: 7, end: 12, bold: true, color: 'red' },
      { start: 13, end: 18, color: '#1F77B4' },
    ]);
    // Typing in the same style and color right after a word extends it.
    expect(replaceRange(spans, text.length, 9, 9, 2, { bold: true, color: 'red' })?.[0]).toEqual({ start: 4, end: 11, bold: true, color: 'red' });
    // Typing in another color inside a word splits it.
    expect(replaceRange(spans, text.length, 12, 12, 1, { color: 'green' })?.slice(1)).toEqual([
      { start: 10, end: 12, color: '#1F77B4' },
      { start: 12, end: 13, color: 'green' },
      { start: 13, end: 16, color: '#1F77B4' },
    ]);
    // Typed text takes the typing color whatever was replaced.
    expect(replaceRange(spans, text.length, 4, 15, 2, { bold: false, italic: false, underline: false, color: 'pink' })).toEqual([{ start: 4, end: 6, color: 'pink' }]);
    // Deleting across two colored words keeps what is left of each.
    expect(replaceRange(spans, text.length, 6, 12, 0)).toEqual([
      { start: 4, end: 6, bold: true, color: 'red' },
      { start: 6, end: 9, color: '#1F77B4' },
    ]);
    expect(replaceRange(spans, text.length, 0, text.length, 0)).toBeUndefined();
  });

  it('clean colors from a file: known inks only, custom ones as #RRGGBB, a span may have nothing but a color', () => {
    expect(sanitizeSpans([{ start: 0, end: 2, color: 'red' }], 4)).toEqual([{ start: 0, end: 2, color: 'red' }]);
    expect(sanitizeSpans([{ start: 0, end: 2, color: '#1f77b4' }], 4)).toEqual([{ start: 0, end: 2, color: '#1F77B4' }]);
    expect(sanitizeSpans([{ start: 0, end: 2, color: '#abc' }], 4)).toEqual([{ start: 0, end: 2, color: '#AABBCC' }]);
    // A color that is none is dropped; what else the span has stays.
    expect(sanitizeSpans([{ start: 0, end: 2, color: 'crimson', bold: true }], 4)).toEqual([{ start: 0, end: 2, bold: true }]);
    expect(
      sanitizeSpans(
        [
          { start: 0, end: 2, color: 'url(x)' },
          { start: 2, end: 4, color: 7 },
          { start: 0, end: 1, color: { light: '#fff' } },
        ],
        4,
      ),
    ).toBeUndefined();
    // Sorted, merged and cut to the text; where two spans overlap, the later one's color is kept.
    expect(
      sanitizeSpans(
        [
          { start: 3, end: 9, color: 'blue' },
          { start: 0, end: 3, color: 'blue' },
          { start: 1, end: 2, color: 'red', italic: true },
        ],
        6,
      ),
    ).toEqual([
      { start: 0, end: 1, color: 'blue' },
      { start: 1, end: 2, italic: true, color: 'red' },
      { start: 2, end: 6, color: 'blue' },
    ]);
  });

  it('are stored the same way however they were made', () => {
    // Keys in one order (start, end, bold, italic, underline, color), so equal spans are equal as stored.
    const made = colorRange(styleRange(undefined, 6, 0, 6, { underline: true, bold: true }), 6, 0, 6, 'teal');
    expect(JSON.stringify(made)).toBe('[{"start":0,"end":6,"bold":true,"underline":true,"color":"teal"}]');
    expect(sameSpans(made, sanitizeSpans([{ color: 'teal', underline: true, end: 6, bold: true, start: 0 }], 6))).toBe(true);
    expect(sameSpans([{ start: 0, end: 2, color: 'red' }], [{ start: 0, end: 2, color: 'blue' }])).toBe(false);
    expect(sameSpans([{ start: 0, end: 2, color: 'red' }], [{ start: 0, end: 2 }])).toBe(false);
    // Many colors in one text.
    const many = Array.from({ length: 300 }, (_, i): TextSpan => ({ start: i, end: i + 1, color: `#${i.toString(16).padStart(6, '0').toUpperCase()}` }));
    expect(sanitizeSpans(many, 300)).toEqual(many);
    expect(textRuns('x'.repeat(300), many)).toHaveLength(300);
  });
});
