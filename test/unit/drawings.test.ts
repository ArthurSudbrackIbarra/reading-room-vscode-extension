import { describe, expect, it } from 'vitest';
import { MAX_STROKE_POINTS, MAX_TEXT_LENGTH, MAX_TEXT_SIZE, MIN_TEXT_BOX_WIDTH, MIN_TEXT_SIZE, applyTextStyle, normalizeText, sanitizeDrawing, sanitizeTextStyle, textStyleOf } from '../../src/shared/drawings';
import { makeDrawing as make, makeText } from './helpers';

const makeDrawing: typeof make = (overrides = {}) => make({ id: 'd-1', ...overrides });

describe('sanitizeDrawing', () => {
  it('keeps a valid drawing: known fields checked, fields of a newer version carried along untouched', () => {
    const raw = { ...makeDrawing({ textModelHash: 'abc' }), layer: 'front', future: { a: 1 } };
    expect(sanitizeDrawing(raw)).toEqual({ ...makeDrawing({ textModelHash: 'abc' }), layer: 'front', future: { a: 1 } });
    // A known field with a bad value is still refused or cleaned.
    expect(sanitizeDrawing({ ...raw, width: 'huge' })).toBeUndefined();
    expect(sanitizeDrawing({ ...raw, binding: { mode: 'nonsense' } })).not.toHaveProperty('binding');
  });

  it('accepts every tool, ink and width', () => {
    for (const tool of ['pen', 'line', 'arrow', 'rect', 'ellipse'] as const) {
      for (const color of ['black', 'gray', 'white', 'brown', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const) {
        for (const width of ['thin', 'medium', 'thick'] as const) {
          expect(sanitizeDrawing(makeDrawing({ tool, color, width }))?.tool).toBe(tool);
        }
      }
    }
  });

  it('keeps a pen stroke drawn with straight lines (what the eraser leaves), on pen strokes only', () => {
    const piece = makeDrawing({ tool: 'pen', points: [[10, 10], [40, 10], [40, 30]], polyline: true });
    expect(sanitizeDrawing(piece)).toEqual(piece);
    expect(sanitizeDrawing({ ...makeDrawing({ tool: 'pen' }), polyline: 'yes' })).not.toHaveProperty('polyline');
    expect(sanitizeDrawing({ ...makeDrawing({ tool: 'line', points: [[0, 0], [5, 5]] }), polyline: true })).not.toHaveProperty('polyline');
  });

  it('refuses unknown tools, inks and widths', () => {
    expect(sanitizeDrawing({ ...makeDrawing(), tool: 'polygon' })).toBeUndefined();
    expect(sanitizeDrawing({ ...makeDrawing(), tool: 'eraser' })).toBeUndefined();
    for (const color of ['magenta', '#ff00', '#ggg', 'rgb(1, 2, 3)', 7, null]) expect(sanitizeDrawing({ ...makeDrawing(), color })).toBeUndefined();
    expect(sanitizeDrawing({ ...makeDrawing(), width: 3 })).toBeUndefined();
  });

  it('keeps custom colors, written as #RRGGBB', () => {
    expect(sanitizeDrawing({ ...makeDrawing(), color: '#1f77b4' })?.color).toBe('#1F77B4');
    expect(sanitizeDrawing({ ...makeDrawing(), color: '#abc' })?.color).toBe('#AABBCC');
    // 0.5.0 stored preset names; they still load as they are.
    expect(sanitizeDrawing({ ...makeDrawing(), color: 'purple' })?.color).toBe('purple');
  });

  it('refuses numbers that are not finite coordinates', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1e9, '12', null]) {
      expect(sanitizeDrawing({ ...makeDrawing(), points: [[bad, 1], [2, 3]] })).toBeUndefined();
    }
    expect(sanitizeDrawing({ ...makeDrawing(), points: [[1, 2, 3], [4, 5]] })).toBeUndefined();
    expect(sanitizeDrawing({ ...makeDrawing(), pageIndex: -1 })).toBeUndefined();
    expect(sanitizeDrawing({ ...makeDrawing(), pageIndex: 1.5 })).toBeUndefined();
    expect(sanitizeDrawing({ ...makeDrawing(), id: '' })).toBeUndefined();
    expect(sanitizeDrawing({ ...makeDrawing(), id: 'x'.repeat(200) })).toBeUndefined();
    expect(sanitizeDrawing('a drawing')).toBeUndefined();
    expect(sanitizeDrawing([makeDrawing()])).toBeUndefined();
  });

  it('wants two points for lines, arrows and shapes, and one or more for the pen', () => {
    expect(sanitizeDrawing(makeDrawing({ points: [[1, 2]] }))).toBeUndefined();
    expect(sanitizeDrawing(makeDrawing({ tool: 'arrow', points: [[1, 2], [3, 4], [5, 6]] }))).toBeUndefined();
    expect(sanitizeDrawing(makeDrawing({ tool: 'pen', points: [] }))).toBeUndefined();
    expect(sanitizeDrawing(makeDrawing({ tool: 'pen', points: [[1, 2]] }))?.points).toEqual([[1, 2]]);
  });

  it('rounds to two decimals, stores boxes by their corners and drops repeated pen points', () => {
    expect(sanitizeDrawing(makeDrawing({ points: [[1.23456, 2.0049], [3.999, 4]] }))?.points).toEqual([
      [1.23, 2],
      [4, 4],
    ]);
    expect(sanitizeDrawing(makeDrawing({ tool: 'rect', points: [[100, 10], [20, 50]] }))?.points).toEqual([
      [20, 10],
      [100, 50],
    ]);
    expect(sanitizeDrawing(makeDrawing({ tool: 'pen', points: [[1, 1], [1, 1], [2, 2], [2, 2.001]] }))?.points).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('fills in missing dates', () => {
    const { createdAt: _c, updatedAt: _u, ...rest } = makeDrawing();
    const clean = sanitizeDrawing(rest);
    expect(clean?.createdAt).toBe(new Date(0).toISOString());
    expect(clean?.updatedAt).toBe(clean?.createdAt);
  });

  it('simplifies a stroke over the point limit and says so', () => {
    const points = Array.from({ length: MAX_STROKE_POINTS * 3 }, (_, i): [number, number] => [i * 0.1, Math.sin(i / 3) * 20]);
    const told: number[] = [];
    const clean = sanitizeDrawing(makeDrawing({ tool: 'pen', points }), (_d, before) => told.push(before));
    expect(clean).toBeDefined();
    expect(clean!.points.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    expect(told).toEqual([points.length]);
    expect(clean!.points[0]).toEqual(points[0]);
  });
});

describe('text boxes', () => {
  it('keep a valid text box: known fields checked, fields of a newer version carried along', () => {
    const text = makeText({ id: 't-1', color: '#336699', size: 18, align: 'justify', boxWidth: 200, textModelHash: 'h', spans: [{ start: 2, end: 6, bold: true }] });
    expect(sanitizeDrawing({ ...text, width: 'thick', extra: 1 })).toEqual({ ...text, extra: 1 });
  });

  it('keep the bold, italic and underlined parts: inside the text, in order, merged', () => {
    const text = makeText({ text: 'abcdefghij' });
    const spans = [
      { start: 6, end: 50, italic: true },
      { start: 0, end: 3, bold: true },
      { start: 3, end: 5, bold: true },
      { start: 4, end: 4, underline: true },
      { start: 7, end: 9 },
      { start: 'x', end: 2, bold: true },
    ];
    expect(sanitizeDrawing({ ...text, spans })).toMatchObject({
      spans: [
        { start: 0, end: 5, bold: true },
        { start: 6, end: 10, italic: true },
      ],
    });
    expect(sanitizeDrawing({ ...text, spans: [] })).not.toHaveProperty('spans');
    expect(sanitizeDrawing({ ...text, spans: 'bold' })).not.toHaveProperty('spans');
    // Trailing white space goes, and the spans with it.
    expect(sanitizeDrawing({ ...text, text: 'abc   ', spans: [{ start: 1, end: 6, underline: true }] })).toMatchObject({ text: 'abc', spans: [{ start: 1, end: 3, underline: true }] });
    // Cleaning that moves characters (a tab becomes four spaces) drops the spans rather than misplace them.
    expect(sanitizeDrawing({ ...text, text: 'a' + String.fromCharCode(9) + 'bc', spans: [{ start: 2, end: 4, bold: true }] })).not.toHaveProperty('spans');
  });

  it('read a text box of 0.6.0, whose bold, italic and underline were the whole box', () => {
    const old = { ...makeText({ text: 'All bold' }), bold: true, italic: false, underline: true };
    const clean = sanitizeDrawing(old);
    expect(clean).toMatchObject({ spans: [{ start: 0, end: 8, bold: true, underline: true }] });
    expect(clean).not.toHaveProperty('bold');
    expect(sanitizeDrawing({ ...makeText(), bold: false, italic: false, underline: false })).not.toHaveProperty('spans');
  });

  it('show and set the style of a whole box', () => {
    const text = makeText({ text: 'one two', spans: [{ start: 0, end: 3, bold: true }] });
    expect(textStyleOf(text)).toMatchObject({ bold: false, italic: false, size: 12 });
    const bold = applyTextStyle(text, { bold: true, size: 20 });
    expect(bold.spans).toEqual([{ start: 0, end: 7, bold: true }]);
    expect(textStyleOf(bold)).toMatchObject({ bold: true, size: 20 });
    expect(applyTextStyle(bold, { bold: false })).not.toHaveProperty('spans');
  });

  it('fill in a missing style with the defaults, and refuse a wrong color', () => {
    const { size: _s, align: _a, ...bare } = makeText({ id: 't-2' });
    expect(sanitizeDrawing(bare)).toMatchObject({ size: 12, align: 'left' });
    expect(sanitizeDrawing({ ...makeText(), align: 'middle', bold: 'yes' })).toMatchObject({ align: 'left' });
    expect(sanitizeDrawing({ ...makeText(), align: 'middle', bold: 'yes' })).not.toHaveProperty('spans');
    expect(sanitizeDrawing({ ...makeText(), color: 'teal-ish' })).toBeUndefined();
  });

  it('want one point and some text', () => {
    expect(sanitizeDrawing(makeText({ points: [] }))).toBeUndefined();
    expect(sanitizeDrawing(makeText({ points: [[1, 2], [3, 4]] }))).toBeUndefined();
    expect(sanitizeDrawing(makeText({ text: '' }))).toBeUndefined();
    expect(sanitizeDrawing(makeText({ text: ' \n\t ' }))).toBeUndefined();
    expect(sanitizeDrawing({ ...makeText(), text: 42 })).toBeUndefined();
  });

  it('keep sizes and widths in range', () => {
    expect(sanitizeDrawing(makeText({ size: 1000 }))).toMatchObject({ size: MAX_TEXT_SIZE });
    expect(sanitizeDrawing(makeText({ size: 0.1 }))).toMatchObject({ size: MIN_TEXT_SIZE });
    expect(sanitizeDrawing(makeText({ size: 11.3 }))).toMatchObject({ size: 11.5 });
    expect(sanitizeDrawing(makeText({ boxWidth: 1 }))).toMatchObject({ boxWidth: MIN_TEXT_BOX_WIDTH });
    expect(sanitizeDrawing({ ...makeText(), boxWidth: 'wide' })).not.toHaveProperty('boxWidth');
  });

  it('store line breaks as \\n, tabs as spaces, no control characters and no trailing white space', () => {
    expect(normalizeText('a\r\nb\rc\u2028d\te\u0007f  \n\n')).toBe('a\nb\nc\nd    ef');
    expect(sanitizeDrawing(makeText({ text: '  indented\r\nnext  ' }))).toMatchObject({ text: '  indented\nnext' });
  });

  it('shorten a text over the limit and say so', () => {
    const told: number[] = [];
    const clean = sanitizeDrawing(makeText({ text: 'x'.repeat(MAX_TEXT_LENGTH + 5) }), (_d, before) => told.push(before));
    expect(clean && 'text' in clean ? clean.text.length : 0).toBe(MAX_TEXT_LENGTH);
    expect(told).toEqual([MAX_TEXT_LENGTH + 5]);
  });

  it('style from untrusted input', () => {
    expect(sanitizeTextStyle({ size: 30, underline: true, color: '#ABCDEF', align: 'right' })).toEqual({
      size: 30,
      bold: false,
      italic: false,
      underline: true,
      align: 'right',
      color: '#ABCDEF',
    });
    expect(sanitizeTextStyle('nonsense').size).toBe(12);
  });
});
