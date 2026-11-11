// The eraser of draw mode: cutting the part under the eraser out of a drawing.
import { describe, expect, it } from 'vitest';
import { polylineDistance, shapePath, svgPathData, type PdfPoint, type Shape } from '../../src/shared/drawingGeometry';
import { eraseDisc, eraseShape, flattenFine } from '../../src/shared/erase';

function length(points: PdfPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

describe('erasing part of a line', () => {
  const line: PdfPoint[] = [
    [0, 0],
    [100, 0],
  ];

  it('leaves it alone when the eraser does not touch it', () => {
    expect(eraseDisc(line, [50, 20], 10)).toBeUndefined();
    expect(eraseDisc(line, [120, 0], 10)).toBeUndefined();
  });

  it('cuts the middle out, leaving both ends', () => {
    const pieces = eraseDisc(line, [50, 0], 10);
    expect(pieces).toEqual([
      [
        [0, 0],
        [40, 0],
      ],
      [
        [60, 0],
        [100, 0],
      ],
    ]);
  });

  it('shortens it from an end', () => {
    expect(eraseDisc(line, [0, 0], 10)).toEqual([
      [
        [10, 0],
        [100, 0],
      ],
    ]);
    expect(eraseDisc(line, [100, 0], 25)?.[0][1][0]).toBeCloseTo(75, 6);
  });

  it('removes it when the eraser covers all of it, and drops crumbs', () => {
    expect(eraseDisc(line, [50, 0], 60)).toEqual([]);
    // 3 units are left at the start: dropped when shorter than the least length.
    expect(eraseDisc(line, [53, 0], 50, 5)).toEqual([]);
    expect(eraseDisc(line, [53, 0], 50, 2)).toHaveLength(1);
  });

  it('cuts where the eraser only grazes the line', () => {
    const pieces = eraseDisc(line, [50, 6], 10);
    // The chord of a circle of radius 10 at distance 6 is 16 long.
    expect(pieces?.[0][1][0]).toBeCloseTo(42, 6);
    expect(pieces?.[1][0][0]).toBeCloseTo(58, 6);
  });

  it('removes a dot under the eraser', () => {
    expect(eraseDisc([[5, 5]], [6, 5], 2)).toEqual([]);
    expect(eraseDisc([[5, 5]], [16, 5], 2)).toBeUndefined();
  });
});

describe('erasing part of a shape', () => {
  it('opens a rectangle where the eraser crosses a side: one piece going around, corners kept', () => {
    const rect: Shape = { tool: 'rect', points: [[0, 0], [100, 60]], widthPt: 2 };
    const left = eraseShape(rect, [50, 0], 10);
    expect(left).toHaveLength(1);
    const piece = left![0];
    // It starts and ends at the cut, and still goes through the four corners.
    expect(piece[0]).toEqual([60, 0]);
    expect(piece[piece.length - 1]).toEqual([40, 0]);
    for (const corner of [[100, 0], [100, 60], [0, 60], [0, 0]]) expect(piece).toContainEqual(corner);
    expect(length(piece)).toBeCloseTo(320 - 20, 6);
  });

  it('cuts a rectangle in two when the eraser crosses two sides', () => {
    const rect: Shape = { tool: 'rect', points: [[0, 0], [100, 60]], widthPt: 2 };
    let pieces = eraseShape(rect, [50, 0], 5)!;
    expect(pieces).toHaveLength(1);
    // Rub the opposite side of what is left.
    pieces = pieces.flatMap((points) => eraseShape({ tool: 'pen', points, widthPt: 2, polyline: true }, [50, 60], 5) ?? [points]);
    expect(pieces).toHaveLength(2);
    expect(pieces.reduce((sum, p) => sum + length(p), 0)).toBeCloseTo(320 - 20, 6);
  });

  it('keeps the head of an arrow whose shaft is cut', () => {
    const arrow: Shape = { tool: 'arrow', points: [[0, 0], [100, 0]], widthPt: 2 };
    const pieces = eraseShape(arrow, [40, 0], 6)!;
    expect(pieces).toHaveLength(3);
    // Two parts of the shaft, and the head (three points, the tip in the middle).
    const head = pieces.find((p) => p.length === 3)!;
    expect(head[1]).toEqual([100, 0]);
  });

  it('leaves the rest of an ellipse on the ellipse', () => {
    const ellipse: Shape = { tool: 'ellipse', points: [[0, 0], [200, 120]], widthPt: 2 };
    const outline = flattenFine(shapePath(ellipse), 0.01);
    const pieces = eraseShape(ellipse, [200, 60], 15)!;
    expect(pieces).toHaveLength(1);
    // Every point left is on the ellipse, and no point is inside the eraser.
    for (const p of pieces[0]) {
      expect(polylineDistance(p, outline)).toBeLessThan(0.05);
      expect(Math.hypot(p[0] - 200, p[1] - 60)).toBeGreaterThanOrEqual(15 - 1e-6);
    }
    // And the ellipse is still within a small distance of what is left, away from the eraser.
    for (const p of outline[0]) {
      if (Math.hypot(p[0] - 200, p[1] - 60) < 16) continue;
      expect(polylineDistance(p, pieces)).toBeLessThan(0.08);
    }
  });

  it('keeps a smooth pen stroke where it was, away from the eraser', () => {
    const pen: Shape = { tool: 'pen', points: [[0, 0], [30, 40], [60, 0], [90, 40], [120, 0]], widthPt: 2 };
    const curve = flattenFine(shapePath(pen), 0.01);
    const pieces = eraseShape(pen, [60, 5], 8)!;
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) for (const p of piece) expect(polylineDistance(p, curve)).toBeLessThan(0.05);
    for (const p of curve[0]) {
      if (Math.hypot(p[0] - 60, p[1] - 5) < 9) continue;
      expect(polylineDistance(p, pieces)).toBeLessThan(0.08);
    }
  });

  it('draws what is left with straight lines through its points', () => {
    const piece: Shape = { tool: 'pen', points: [[0, 0], [50, 0], [50, 30]], widthPt: 2, polyline: true };
    expect(svgPathData(shapePath(piece))).toBe('M0 0L50 0L50 30');
    // The same points as a pen stroke are a curve.
    expect(svgPathData(shapePath({ ...piece, polyline: false }))).toContain('C');
  });

  it('says nothing changed when the eraser misses the shape', () => {
    expect(eraseShape({ tool: 'line', points: [[0, 0], [10, 10]], widthPt: 1 }, [50, 50], 5)).toBeUndefined();
  });
});
