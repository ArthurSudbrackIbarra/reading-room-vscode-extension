// Erasing part of a drawing, like an eraser on paper: the drawing's path is turned into fine
// polylines, the stretch under the eraser is cut out, and what is left becomes new strokes.
// Pure geometry, no runtime dependencies.
import { shapePath, simplifyPoints, type PathCommand, type PdfPoint, type Shape } from './drawingGeometry';

/** How far the polylines may be from the true curves, in PDF units. */
const FLATNESS = 0.04;

function cubicAt(a: PdfPoint, b: PdfPoint, c: PdfPoint, d: PdfPoint, t: number): PdfPoint {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
}

/** The subpaths of a path as polylines within `tolerance` of it; a closed one ends on its first point. */
export function flattenFine(path: PathCommand[], tolerance = FLATNESS): PdfPoint[][] {
  const lines: PdfPoint[][] = [];
  let line: PdfPoint[] | undefined;
  for (const cmd of path) {
    if (cmd.op === 'M') {
      line = [cmd.p];
      lines.push(line);
    } else if (!line) {
      continue;
    } else if (cmd.op === 'L') {
      line.push(cmd.p);
    } else if (cmd.op === 'C') {
      const from = line[line.length - 1];
      // The usual bound: the curve bends at most as much as its control polygon's second differences.
      const bend = Math.max(
        Math.hypot(from[0] - 2 * cmd.c1[0] + cmd.c2[0], from[1] - 2 * cmd.c1[1] + cmd.c2[1]),
        Math.hypot(cmd.c1[0] - 2 * cmd.c2[0] + cmd.p[0], cmd.c1[1] - 2 * cmd.c2[1] + cmd.p[1]),
      );
      const steps = Math.min(200, Math.max(1, Math.ceil(Math.sqrt((0.75 * bend) / tolerance))));
      for (let i = 1; i <= steps; i++) line.push(i === steps ? cmd.p : cubicAt(from, cmd.c1, cmd.c2, cmd.p, i / steps));
    } else {
      line.push(line[0]);
    }
  }
  return lines;
}

function polylineLength(points: PdfPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}

/** The part of segment a→b inside the disc, as [from, to] in 0..1, if any. */
function insideInterval(a: PdfPoint, b: PdfPoint, center: PdfPoint, radius: number): [number, number] | undefined {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - center[0];
  const fy = a[1] - center[1];
  const A = dx * dx + dy * dy;
  const C = fx * fx + fy * fy - radius * radius;
  if (A === 0) return C <= 0 ? [0, 1] : undefined;
  const B = 2 * (fx * dx + fy * dy);
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return undefined;
  const root = Math.sqrt(disc);
  const from = Math.max(0, (-B - root) / (2 * A));
  const to = Math.min(1, (-B + root) / (2 * A));
  return to > from ? [from, to] : undefined;
}

/**
 * What is left of a polyline after erasing the disc: its pieces, in order. A closed polyline (one
 * that ends on its first point) cut once is one piece going around. Undefined when the disc does
 * not touch it. Pieces shorter than `minLength` are dropped (crumbs).
 */
export function eraseDisc(line: PdfPoint[], center: PdfPoint, radius: number, minLength = 0): PdfPoint[][] | undefined {
  if (line.length === 0) return undefined;
  const inside = (p: PdfPoint) => Math.hypot(p[0] - center[0], p[1] - center[1]) <= radius;
  if (line.length === 1) return inside(line[0]) ? [] : undefined;
  const pieces: PdfPoint[][] = [];
  let current: PdfPoint[] | undefined = inside(line[0]) ? undefined : [line[0]];
  let touched = current === undefined;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const cut = insideInterval(a, b, center, radius);
    if (!cut) {
      if (current) current.push(b);
      else current = [a, b];
      continue;
    }
    touched = true;
    const at = (t: number): PdfPoint => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    if (current) {
      if (cut[0] > 0) current.push(at(cut[0]));
      pieces.push(current);
    }
    current = cut[1] < 1 ? [at(cut[1]), b] : undefined;
  }
  if (current) pieces.push(current);
  if (!touched) return undefined;
  const first = line[0];
  const last = line[line.length - 1];
  const closed = line.length > 2 && first[0] === last[0] && first[1] === last[1];
  if (closed && pieces.length > 1 && pieces[0][0] === first && pieces[pieces.length - 1][pieces[pieces.length - 1].length - 1] === last) {
    // The seam of a closed path was not erased: the last and the first piece are one.
    const tail = pieces.pop()!;
    pieces[0] = [...tail, ...pieces[0].slice(1)];
  }
  return pieces.filter((piece) => piece.length > 1 && polylineLength(piece) >= minLength);
}

/**
 * What is left of a shape after the eraser (a disc) went over it: polylines to draw with straight
 * lines. Undefined when the eraser does not touch it. `radius` should include half the stroke
 * width, so the round ends of what is left stop at the eraser's edge.
 */
export function eraseShape(shape: Shape, center: PdfPoint, radius: number, minLength = 0): PdfPoint[][] | undefined {
  const lines = flattenFine(shapePath(shape));
  let touched = false;
  const left: PdfPoint[][] = [];
  for (const line of lines) {
    const pieces = eraseDisc(line, center, radius, minLength);
    if (pieces) {
      touched = true;
      left.push(...pieces);
    } else {
      left.push(line);
    }
  }
  if (!touched) return undefined;
  // Curves were cut into many short lines: keep only the points that shape them.
  return left.map((piece) => simplifyPoints(piece, FLATNESS / 2));
}
