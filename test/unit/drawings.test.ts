import { describe, expect, it } from 'vitest';
import { MAX_STROKE_POINTS, MAX_TEXT_LENGTH, MAX_TEXT_SIZE, MIN_TEXT_BOX_WIDTH, MIN_TEXT_SIZE, normalizeText, sanitizeDrawing, sanitizeTextStyle } from '../../src/shared/drawings';
import { makeDrawing as make, makeText } from './helpers';

const makeDrawing: typeof make = (overrides = {}) => make({ id: 'd-1', ...overrides });

describe('sanitizeDrawing', () => {
  it('keeps a valid drawing, built from the known fields only', () => {
    const raw = { ...makeDrawing({ textModelHash: 'abc' }), extra: 'dropped', style: { evil: true } };
    expect(sanitizeDrawing(raw)).toEqual(makeDrawing({ textModelHash: 'abc' }));
  });

  it('accepts every tool, ink and width', () => {
    for (const tool of ['pen', 'line', 'arrow', 'rect', 'ellipse'] as const) {
      for (const color of ['black', 'gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const) {
        for (const width of ['thin', 'medium', 'thick'] as const) {
          expect(sanitizeDrawing(makeDrawing({ tool, color, width }))?.tool).toBe(tool);
        }
      }
    }
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
  it('keep a valid text box, built from the known fields only', () => {
    const text = makeText({ id: 't-1', color: '#336699', size: 18, bold: true, align: 'justify', boxWidth: 200, textModelHash: 'h' });
    expect(sanitizeDrawing({ ...text, width: 'thick', extra: 1 })).toEqual(text);
  });

  it('fill in a missing style with the defaults, and refuse a wrong color', () => {
    const { size: _s, bold: _b, italic: _i, underline: _u, align: _a, ...bare } = makeText({ id: 't-2' });
    expect(sanitizeDrawing(bare)).toMatchObject({ size: 12, bold: false, italic: false, underline: false, align: 'left' });
    expect(sanitizeDrawing({ ...makeText(), align: 'middle', bold: 'yes' })).toMatchObject({ align: 'left', bold: false });
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
