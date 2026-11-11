// Geometry of drawings, shared by the viewer (screen) and the export (PDF annotations), so a
// downloaded stroke looks like the one on screen. Pure functions, no runtime dependencies.
//
// Coordinates:
//  - PDF user units: the page's own coordinate system (y up), what drawings store.
//  - Page space: the page as shown at scale 1 (origin top-left, y down, /Rotate applied), the
//    same frame as PDF.js's `page.getViewport({ scale: 1 })`. Screen positions are fractions of it.

export type PdfPoint = [number, number];
/** An affine transform [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export interface PageGeometry {
  /** The page box in PDF user units: [x0, y0, x1, y1] (PDF.js's `page.view`). */
  view: [number, number, number, number];
  /** Size of the page in page space. */
  width: number;
  height: number;
  /** PDF user units → page space. */
  transform: Matrix;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The page's geometry at scale 1, computed exactly like PDF.js's PageViewport (display_utils.js),
 * so conversions match what PDF.js draws for any /Rotate and crop box.
 */
export function pageGeometry(view: readonly number[], rotate = 0, userUnit = 1): PageGeometry {
  const [x0, y0, x1, y1] = [Math.min(view[0], view[2]), Math.min(view[1], view[3]), Math.max(view[0], view[2]), Math.max(view[1], view[3])];
  const scale = userUnit > 0 && Number.isFinite(userUnit) ? userUnit : 1;
  const centerX = (x1 + x0) / 2;
  const centerY = (y1 + y0) / 2;
  let rotation = Math.round(rotate) % 360;
  if (rotation < 0) rotation += 360;
  let [a, b, c, d] = [1, 0, 0, -1];
  if (rotation === 90) [a, b, c, d] = [0, 1, 1, 0];
  else if (rotation === 180) [a, b, c, d] = [-1, 0, 0, 1];
  else if (rotation === 270) [a, b, c, d] = [0, -1, -1, 0];
  let offsetX: number;
  let offsetY: number;
  let width: number;
  let height: number;
  if (a === 0) {
    offsetX = Math.abs(centerY - y0) * scale;
    offsetY = Math.abs(centerX - x0) * scale;
    width = (y1 - y0) * scale;
    height = (x1 - x0) * scale;
  } else {
    offsetX = Math.abs(centerX - x0) * scale;
    offsetY = Math.abs(centerY - y0) * scale;
    width = (x1 - x0) * scale;
    height = (y1 - y0) * scale;
  }
  const transform: Matrix = [
    a * scale,
    b * scale,
    c * scale,
    d * scale,
    offsetX - a * scale * centerX - c * scale * centerY,
    offsetY - b * scale * centerX - d * scale * centerY,
  ];
  return { view: [x0, y0, x1, y1], width, height, transform };
}

export function applyMatrix(m: Matrix, [x, y]: PdfPoint): PdfPoint {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** PDF user units → page space. */
export function toPageSpace(page: PageGeometry, p: PdfPoint): PdfPoint {
  return applyMatrix(page.transform, p);
}

/** Page space → PDF user units. */
export function toPdfSpace(page: PageGeometry, p: PdfPoint): PdfPoint {
  return applyMatrix(invertMatrix(page.transform), p);
}

/** Keeps a point inside the page box. */
export function clampToPage(page: PageGeometry, [x, y]: PdfPoint): PdfPoint {
  const [x0, y0, x1, y1] = page.view;
  return [Math.min(x1, Math.max(x0, x)), Math.min(y1, Math.max(y0, y))];
}

// ---------- Paths ----------

export type PathCommand = { op: 'M' | 'L'; p: PdfPoint } | { op: 'C'; c1: PdfPoint; c2: PdfPoint; p: PdfPoint } | { op: 'Z' };

/** What a path is built from: a drawing, or a shape being drawn. */
export interface Shape {
  tool: 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse';
  points: PdfPoint[];
  /** Stroke width in PDF units (sizes the arrowhead). */
  widthPt: number;
  /** Pen only: straight lines through the points instead of a smooth curve. */
  polyline?: boolean;
}

const KAPPA = 0.5522847498307936;
const HEAD_ANGLE = (28 * Math.PI) / 180;

/** Length of an arrowhead's sides for a stroke width, in PDF units. */
export function arrowHeadLength(widthPt: number): number {
  return 4 + 3 * widthPt;
}

/** The two outer ends of an open arrowhead at `end`. */
export function arrowHead(start: PdfPoint, end: PdfPoint, widthPt: number): [PdfPoint, PdfPoint] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return [end, end];
  const size = Math.min(arrowHeadLength(widthPt), length * 0.6);
  const ux = dx / length;
  const uy = dy / length;
  const side = (angle: number): PdfPoint => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [end[0] - size * (ux * cos - uy * sin), end[1] - size * (ux * sin + uy * cos)];
  };
  return [side(HEAD_ANGLE), side(-HEAD_ANGLE)];
}

function mid(a: PdfPoint, b: PdfPoint): PdfPoint {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** A quadratic Bézier (from `from`, control `q`, to `to`) as the equivalent cubic. */
function quadratic(from: PdfPoint, q: PdfPoint, to: PdfPoint): PathCommand {
  return {
    op: 'C',
    c1: [from[0] + (2 / 3) * (q[0] - from[0]), from[1] + (2 / 3) * (q[1] - from[1])],
    c2: [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])],
    p: to,
  };
}

/** A smooth curve near the points: quadratic Béziers between the midpoints, through both ends. */
function smoothStroke(points: PdfPoint[]): PathCommand[] {
  if (points.length === 1) {
    // A dot: a tiny segment, which every renderer draws as a round cap.
    const [x, y] = points[0];
    return [
      { op: 'M', p: [x, y] },
      { op: 'L', p: [x + 0.01, y] },
    ];
  }
  if (points.length === 2) {
    return [
      { op: 'M', p: points[0] },
      { op: 'L', p: points[1] },
    ];
  }
  const path: PathCommand[] = [{ op: 'M', p: points[0] }];
  let current = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const to = mid(points[i], points[i + 1]);
    path.push(quadratic(current, points[i], to));
    current = to;
  }
  path.push({ op: 'L', p: points[points.length - 1] });
  return path;
}

function ellipse([[x0, y0], [x1, y1]]: PdfPoint[]): PathCommand[] {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return [
    { op: 'M', p: [cx + rx, cy] },
    { op: 'C', c1: [cx + rx, cy + ky], c2: [cx + kx, cy + ry], p: [cx, cy + ry] },
    { op: 'C', c1: [cx - kx, cy + ry], c2: [cx - rx, cy + ky], p: [cx - rx, cy] },
    { op: 'C', c1: [cx - rx, cy - ky], c2: [cx - kx, cy - ry], p: [cx, cy - ry] },
    { op: 'C', c1: [cx + kx, cy - ry], c2: [cx + rx, cy - ky], p: [cx + rx, cy] },
    { op: 'Z' },
  ];
}

/** The path a drawing is stroked along, in its own (PDF) units. Used on screen and in exports. */
export function shapePath(shape: Shape): PathCommand[] {
  const { points } = shape;
  if (points.length === 0) return [];
  switch (shape.tool) {
    case 'pen':
      return shape.polyline && points.length > 1 ? points.map((p, i): PathCommand => ({ op: i === 0 ? 'M' : 'L', p })) : smoothStroke(points);
    case 'line':
      return [
        { op: 'M', p: points[0] },
        { op: 'L', p: points[1] ?? points[0] },
      ];
    case 'arrow': {
      const start = points[0];
      const end = points[1] ?? points[0];
      const [left, right] = arrowHead(start, end, shape.widthPt);
      return [
        { op: 'M', p: start },
        { op: 'L', p: end },
        { op: 'M', p: left },
        { op: 'L', p: end },
        { op: 'L', p: right },
      ];
    }
    case 'rect': {
      const [[x0, y0], [x1, y1]] = [points[0], points[1] ?? points[0]];
      return [
        { op: 'M', p: [x0, y0] },
        { op: 'L', p: [x1, y0] },
        { op: 'L', p: [x1, y1] },
        { op: 'L', p: [x0, y1] },
        { op: 'Z' },
      ];
    }
    case 'ellipse':
      return ellipse([points[0], points[1] ?? points[0]]);
  }
}

export function transformPath(path: PathCommand[], m: Matrix): PathCommand[] {
  return path.map((cmd) => {
    if (cmd.op === 'Z') return cmd;
    if (cmd.op === 'C') return { op: 'C', c1: applyMatrix(m, cmd.c1), c2: applyMatrix(m, cmd.c2), p: applyMatrix(m, cmd.p) };
    return { op: cmd.op, p: applyMatrix(m, cmd.p) };
  });
}

function num(n: number, decimals: number): string {
  const f = 10 ** decimals;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? '0' : String(v);
}

/** SVG path data. */
export function svgPathData(path: PathCommand[], decimals = 2): string {
  const p = (pt: PdfPoint) => `${num(pt[0], decimals)} ${num(pt[1], decimals)}`;
  return path.map((cmd) => (cmd.op === 'Z' ? 'Z' : cmd.op === 'C' ? `C${p(cmd.c1)} ${p(cmd.c2)} ${p(cmd.p)}` : `${cmd.op}${p(cmd.p)}`)).join('');
}

/** PDF content-stream path operators (m, l, c, h), to be followed by a painting operator. */
export function pdfPathOps(path: PathCommand[]): string {
  const p = (pt: PdfPoint) => `${num(pt[0], 3)} ${num(pt[1], 3)}`;
  return path
    .map((cmd) => (cmd.op === 'Z' ? 'h' : cmd.op === 'C' ? `${p(cmd.c1)} ${p(cmd.c2)} ${p(cmd.p)} c` : `${p(cmd.p)} ${cmd.op === 'M' ? 'm' : 'l'}`))
    .join('\n');
}

/** Bounds [x0, y0, x1, y1] of every point of a path, control points included (the curve lies inside). */
export function pathBounds(path: PathCommand[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = ([x, y]: PdfPoint) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const cmd of path) {
    if (cmd.op === 'Z') continue;
    if (cmd.op === 'C') {
      add(cmd.c1);
      add(cmd.c2);
    }
    add(cmd.p);
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

function cubicAt(a: PdfPoint, b: PdfPoint, c: PdfPoint, d: PdfPoint, t: number): PdfPoint {
  const u = 1 - t;
  return [
    u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
    u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1],
  ];
}

/** The path as polylines (curves split into `steps` segments), for hit-testing. */
export function flattenPath(path: PathCommand[], steps = 12): PdfPoint[][] {
  const lines: PdfPoint[][] = [];
  let line: PdfPoint[] | undefined;
  for (const cmd of path) {
    if (cmd.op === 'M') {
      line = [cmd.p];
      lines.push(line);
    } else if (cmd.op === 'L') {
      line?.push(cmd.p);
    } else if (cmd.op === 'C') {
      if (!line) continue;
      const from = line[line.length - 1];
      for (let i = 1; i <= steps; i++) line.push(cubicAt(from, cmd.c1, cmd.c2, cmd.p, i / steps));
    } else if (line && line.length > 0) {
      line.push(line[0]);
    }
  }
  return lines;
}

/** Distance from a point to the segment a–b. */
export function segmentDistance(p: PdfPoint, a: PdfPoint, b: PdfPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from a point to the nearest part of flattened polylines. */
export function polylineDistance(p: PdfPoint, lines: PdfPoint[][]): number {
  let best = Infinity;
  for (const line of lines) {
    if (line.length === 1) best = Math.min(best, Math.hypot(p[0] - line[0][0], p[1] - line[0][1]));
    for (let i = 1; i < line.length; i++) best = Math.min(best, segmentDistance(p, line[i - 1], line[i]));
  }
  return best;
}

/**
 * Ramer–Douglas–Peucker: drops points while keeping every original point within `tolerance` of
 * the simplified polyline. Iterative, so very long strokes cannot overflow the stack.
 */
export function simplifyPoints(points: PdfPoint[], tolerance: number): PdfPoint[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let index = -1;
    let worst = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

// ---------- Shapes while drawing ----------

/** Shift on a line or an arrow: the end snapped so the angle is a multiple of `stepDeg`. */
export function snapAngle(start: PdfPoint, end: PdfPoint, stepDeg = 15): PdfPoint {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return end;
  const step = (stepDeg * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [start[0] + length * Math.cos(angle), start[1] + length * Math.sin(angle)];
}

/** Shift on a rectangle or an ellipse: the far corner moved so the box is square. */
export function squareCorner(start: PdfPoint, end: PdfPoint): PdfPoint {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return [start[0] + (dx < 0 ? -side : side), start[1] + (dy < 0 ? -side : side)];
}

/** True when a drag from a to b is too short to make a shape (`minUnits`: a few pixels, in PDF units). */
export function tooSmall(a: PdfPoint, b: PdfPoint, minUnits: number): boolean {
  return Math.hypot(b[0] - a[0], b[1] - a[1]) < minUnits;
}

/** Limits a move (dx, dy) so that `bounds` stays inside the page box. */
export function clampMove(bounds: [number, number, number, number], view: [number, number, number, number], dx: number, dy: number): [number, number] {
  const [bx0, by0, bx1, by1] = bounds;
  const [vx0, vy0, vx1, vy1] = view;
  const clamp = (d: number, low: number, high: number) => (low > high ? (low + high) / 2 : Math.min(high, Math.max(low, d)));
  return [clamp(dx, vx0 - bx0, vx1 - bx1), clamp(dy, vy0 - by0, vy1 - by1)];
}

// ---------- Text boxes ----------

/** Page-space box of a text box: its top left corner (PDF units) and its size (page space). */
export function textBoxRect(page: PageGeometry, anchor: PdfPoint, width: number, height: number): [number, number, number, number] {
  const [x, y] = toPageSpace(page, anchor);
  return [x, y, x + width, y + height];
}

/** PDF-unit bounds of a page-space rectangle (any /Rotate turns it into another axis-aligned box). */
export function pageRectToPdf(page: PageGeometry, [x0, y0, x1, y1]: [number, number, number, number]): [number, number, number, number] {
  const corners = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map((p) => toPdfSpace(page, p as PdfPoint));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
