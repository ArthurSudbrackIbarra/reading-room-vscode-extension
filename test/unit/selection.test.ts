import { describe, expect, it } from 'vitest';
import { linesTouchRect, pageGeometry, type PdfPoint } from '../../src/shared/drawingGeometry';
import type { Drawing } from '../../src/shared/drawings';
import { CLIP_MIME, clampGroupMove, decodeClip, detached, encodeClip, rangeBetween, refKey, toPageDelta, toPdfDelta, type ClipItem } from '../../src/shared/selection';

const NOW = '2026-11-13T10:00:00.000Z';

function rect(id: string, extra: Record<string, unknown> = {}): Drawing {
  return {
    id,
    tool: 'rect',
    color: 'red',
    width: 'medium',
    pageIndex: 0,
    points: [
      [100, 600],
      [200, 700],
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  } as Drawing;
}

describe('Shift+click range', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  const same = (s: string) => s;

  it('takes everything between the last one clicked and the target, in reading order', () => {
    expect(rangeBetween(order, same, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, same, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeBetween(order, same, 'c', 'c')).toEqual(['c']);
  });

  it('takes just the target without an anchor, or when the anchor is gone', () => {
    expect(rangeBetween(order, same, undefined, 'd')).toEqual(['d']);
    expect(rangeBetween(order, same, 'zz', 'd')).toEqual(['d']);
  });

  it('takes nothing when the target is not there', () => {
    expect(rangeBetween(order, same, 'a', 'zz')).toEqual([]);
  });

  it('keys drawings and highlights apart', () => {
    expect(refKey({ kind: 'drawing', id: 'x' })).toBe('d:x');
    expect(refKey({ kind: 'highlight', id: 'x' })).toBe('h:x');
  });
});

describe('moving a group', () => {
  it('moves as far as every member allows', () => {
    expect(
      clampGroupMove(50, [
        [-100, 80],
        [-20, 30],
      ]),
    ).toBe(30);
    expect(
      clampGroupMove(-50, [
        [-100, 80],
        [-20, 30],
      ]),
    ).toBe(-20);
    expect(clampGroupMove(10, [[-100, 80]])).toBe(10);
  });

  it('stays put when the members allow nothing in common', () => {
    expect(clampGroupMove(10, [[5, -5]])).toBe(0);
    expect(
      clampGroupMove(10, [
        [20, 30],
        [-30, -20],
      ]),
    ).toBe(0);
  });

  it('turns a move on the page as shown into the units of the page, for any rotation', () => {
    for (const rotate of [0, 90, 180, 270]) {
      const g = pageGeometry([0, 0, 612, 792], rotate);
      const pdf = toPdfDelta(g.transform, [12, -7]);
      const [px, py] = toPageDelta(g.transform, pdf);
      expect(px).toBeCloseTo(12, 6);
      expect(py).toBeCloseTo(-7, 6);
    }
    // An upright page: right is +x, down is -y.
    const upright = pageGeometry([0, 0, 612, 792]);
    const [dx, dy] = toPdfDelta(upright.transform, [10, 10]);
    expect(dx).toBeCloseTo(10, 6);
    expect(dy).toBeCloseTo(-10, 6);
  });
});

describe('a selection rectangle', () => {
  const diagonal: PdfPoint[][] = [
    [
      [0, 0],
      [100, 100],
    ],
  ];

  it('takes a stroke it crosses or holds', () => {
    expect(linesTouchRect(diagonal, [40, 40, 60, 60])).toBe(true);
    expect(linesTouchRect(diagonal, [-10, -10, 200, 200])).toBe(true);
    // Crossed without holding any of its points.
    expect(linesTouchRect(diagonal, [45, 0, 55, 100])).toBe(true);
  });

  it('leaves a stroke whose bounding box it only shares', () => {
    expect(linesTouchRect(diagonal, [70, 0, 100, 20])).toBe(false);
    expect(linesTouchRect(diagonal, [0, 70, 20, 100])).toBe(false);
  });

  it('reaches as far as the stroke is wide', () => {
    expect(linesTouchRect(diagonal, [102, 102, 110, 110])).toBe(false);
    expect(linesTouchRect(diagonal, [102, 102, 110, 110], 3)).toBe(true);
  });

  it('takes a dot', () => {
    expect(linesTouchRect([[[5, 5]]], [0, 0, 10, 10])).toBe(true);
    expect(linesTouchRect([[[50, 5]]], [0, 0, 10, 10])).toBe(false);
  });

  it('takes its corners in any order', () => {
    expect(linesTouchRect(diagonal, [60, 60, 40, 40])).toBe(true);
  });
});

describe('copied drawings and text boxes', () => {
  const page: PdfPoint[] = [
    [100, 92],
    [200, 192],
  ];

  it('come back as they were copied', () => {
    const items: ClipItem[] = [{ drawing: rect('a'), page }];
    const back = decodeClip(encodeClip(items));
    expect(back).toHaveLength(1);
    expect(back[0].drawing).toEqual(rect('a'));
    expect(back[0].page).toEqual(page);
  });

  it('leave behind what tied them to their document', () => {
    const bound = rect('a', { textModelHash: 'abc', anchorStates: [undefined] });
    expect(detached(bound)).toEqual(rect('a'));
    expect(decodeClip(encodeClip([{ drawing: bound, page }]))[0].drawing).toEqual(rect('a'));
  });

  it('keep text boxes with their text and style', () => {
    const text = { id: 't', tool: 'text', pageIndex: 2, points: [[72, 700]], text: 'A note', size: 14, align: 'center', color: 'blue', createdAt: NOW, updatedAt: NOW } as Drawing;
    const back = decodeClip(encodeClip([{ drawing: text, page: [[72, 92]] }]));
    expect(back[0].drawing).toEqual(text);
  });

  it('ignore anything that is not theirs', () => {
    expect(decodeClip('')).toEqual([]);
    expect(decodeClip('hello')).toEqual([]);
    expect(decodeClip('{"items":[]}')).toEqual([]);
    expect(decodeClip(JSON.stringify({ app: 'reading-room', v: 99, items: [{ drawing: rect('a'), page }] }))).toEqual([]);
  });

  it('drop broken items and keep the rest', () => {
    const text = JSON.stringify({
      app: 'reading-room',
      v: 1,
      items: [
        { drawing: rect('a'), page },
        { drawing: { id: 'b', tool: 'rect' }, page },
        { drawing: rect('c'), page: [[1, 2]] },
        {
          drawing: rect('d'),
          page: [
            [1, 'x'],
            [3, 4],
          ],
        },
        null,
      ],
    });
    expect(decodeClip(text).map((item) => item.drawing.id)).toEqual(['a']);
  });

  it('use a format of their own', () => {
    expect(CLIP_MIME).toMatch(/^application\/x-/);
  });
});
