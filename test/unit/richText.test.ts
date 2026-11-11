// Bold, italic and underline on parts of a text: the spans a text box stores.
import { describe, expect, it } from 'vitest';
import { rangeStyle, replaceRange, sameSpans, sanitizeSpans, styleAt, styleRange, textRuns, type TextSpan } from '../../src/shared/richText';

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
    expect(sanitizeSpans([{ start: 5, end: 8, bold: true }, { start: 0, end: 5, bold: true }, { start: 2, end: 3 }], 6)).toEqual([{ start: 0, end: 6, bold: true }]);
    expect(sanitizeSpans([{ start: -1, end: 3, bold: true }, { start: 1.5, end: 3, bold: true }, null, 'x'], 6)).toBeUndefined();
    expect(sanitizeSpans({ start: 0, end: 2, bold: true }, 6)).toBeUndefined();
    expect(sameSpans(sanitizeSpans([{ start: 0, end: 2, italic: true, bold: true }], 4), [{ start: 0, end: 2, bold: true, italic: true }])).toBe(true);
    expect(sameSpans(undefined, [])).toBe(true);
  });
});
