import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  arrowHead,
  arrowHeadLength,
  clampMove,
  clampToPage,
  flattenPath,
  pageGeometry,
  pathBounds,
  pdfPathOps,
  polylineDistance,
  shapePath,
  simplifyPoints,
  snapAngle,
  squareCorner,
  svgPathData,
  toPageSpace,
  toPdfSpace,
  tooSmall,
  type PdfPoint,
} from '../../src/shared/drawingGeometry';
import { MAX_STROKE_POINTS, fitStroke } from '../../src/shared/drawings';

/** A deterministic pseudo-random generator, so failures can be reproduced. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomWalk(n: number, seed: number): PdfPoint[] {
  const next = random(seed);
  const points: PdfPoint[] = [[100, 100]];
  for (let i = 1; i < n; i++) {
    const [x, y] = points[i - 1];
    points.push([x + (next() - 0.5) * 4, y + (next() - 0.5) * 4]);
  }
  return points;
}

describe('viewport ↔ PDF units', () => {
  // Pages as PDF.js shows them: every /Rotate, and crop boxes whose origin is not (0, 0).
  const pages = [
    { rotate: 0 },
    { rotate: 90 },
    { rotate: 180 },
    { rotate: 270 },
    { rotate: 0, crop: [40, 70, 300, 400] },
    { rotate: 90, crop: [50, 100, 400, 500] },
    { rotate: 270, crop: [-30, 20, 500, 600] },
  ] as const;

  async function loadPages() {
    const doc = await PDFDocument.create();
    for (const spec of pages) {
      const page = doc.addPage([600, 800]);
      page.setRotation(degrees(spec.rotate));
      if ('crop' in spec) {
        const [x, y, width, height] = spec.crop;
        page.setCropBox(x, y, width, height);
      }
    }
    const loaded = await pdfjs.getDocument({ data: await doc.save() }).promise;
    const out = [];
    for (let i = 1; i <= loaded.numPages; i++) out.push(await loaded.getPage(i));
    return out;
  }

  it('match PDF.js for /Rotate 0, 90, 180, 270 and offset crop boxes', async () => {
    const samples: PdfPoint[] = [
      [0, 0],
      [50, 100],
      [123.45, 678.9],
      [450, 600],
      [599, 1],
    ];
    for (const page of await loadPages()) {
      const viewport = page.getViewport({ scale: 1 });
      const g = pageGeometry(page.view, page.rotate, page.userUnit);
      expect(g.width).toBeCloseTo(viewport.width, 9);
      expect(g.height).toBeCloseTo(viewport.height, 9);
      g.transform.forEach((v, i) => expect(v).toBeCloseTo(viewport.transform[i], 9));
      for (const p of samples) {
        const [vx, vy] = viewport.convertToViewportPoint(p[0], p[1]);
        const [px, py] = toPageSpace(g, p);
        expect(px).toBeCloseTo(vx, 9);
        expect(py).toBeCloseTo(vy, 9);
        const [bx, by] = viewport.convertToPdfPoint(vx, vy);
        const back = toPdfSpace(g, [vx, vy]);
        expect(back[0]).toBeCloseTo(bx, 9);
        expect(back[1]).toBeCloseTo(by, 9);
        expect(back[0]).toBeCloseTo(p[0], 9);
        expect(back[1]).toBeCloseTo(p[1], 9);
      }
    }
  });

  it('put the page corners at the corners of the shown page', async () => {
    for (const page of await loadPages()) {
      const g = pageGeometry(page.view, page.rotate);
      const [x0, y0, x1, y1] = g.view;
      const shown = [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ].map((p) => toPageSpace(g, p as PdfPoint).map((v) => Math.round(v * 1e6) / 1e6 + 0));
      const xs = shown.map(([x]) => x).sort((a, b) => a - b);
      const ys = shown.map(([, y]) => y).sort((a, b) => a - b);
      expect([xs[0], xs[3], ys[0], ys[3]]).toEqual([0, g.width, 0, g.height]);
    }
  });

  it('turn the top-left of a 90° page into the crop box origin', () => {
    const g = pageGeometry([50, 100, 450, 600], 90);
    expect(g.width).toBe(500);
    expect(g.height).toBe(400);
    const [x, y] = toPdfSpace(g, [0, 0]);
    expect(x).toBeCloseTo(50, 9);
    expect(y).toBeCloseTo(100, 9);
  });

  it('clamp points to the page box', () => {
    const g = pageGeometry([40, 70, 340, 470], 0);
    expect(clampToPage(g, [10, 500])).toEqual([40, 470]);
    expect(clampToPage(g, [100, 100])).toEqual([100, 100]);
  });
});

describe('Shift constraints', () => {
  it('snap lines and arrows to 15° steps, keeping their length', () => {
    const next = random(7);
    for (let i = 0; i < 200; i++) {
      const start: PdfPoint = [next() * 500, next() * 700];
      const end: PdfPoint = [start[0] + (next() - 0.5) * 300, start[1] + (next() - 0.5) * 300];
      const snapped = snapAngle(start, end);
      const angle = (Math.atan2(snapped[1] - start[1], snapped[0] - start[0]) * 180) / Math.PI;
      expect(Math.abs(angle / 15 - Math.round(angle / 15))).toBeLessThan(1e-9);
      expect(Math.hypot(snapped[0] - start[0], snapped[1] - start[1])).toBeCloseTo(Math.hypot(end[0] - start[0], end[1] - start[1]), 9);
      // The nearest step: never more than 7.5° away.
      const raw = (Math.atan2(end[1] - start[1], end[0] - start[0]) * 180) / Math.PI;
      const diff = Math.abs(((angle - raw + 540) % 360) - 180);
      expect(diff).toBeLessThanOrEqual(7.5 + 1e-9);
    }
  });

  it('keep exact angles as they are', () => {
    expect(snapAngle([0, 0], [10, 0])).toEqual([10, 0]);
    const diagonal = snapAngle([0, 0], [10, 10.4]);
    expect(diagonal[0]).toBeCloseTo(diagonal[1], 9);
  });

  it('make rectangles and ellipses square, toward the pointer', () => {
    expect(squareCorner([10, 10], [40, 20])).toEqual([40, 40]);
    expect(squareCorner([10, 10], [0, -30])).toEqual([-30, -30]);
    expect(squareCorner([10, 10], [-15, 25])).toEqual([-15, 35]);
  });
});

describe('minimum shape size', () => {
  it('drops drags under the minimum', () => {
    expect(tooSmall([0, 0], [2, 2], 3)).toBe(true);
    expect(tooSmall([0, 0], [3, 0], 3)).toBe(false);
    expect(tooSmall([5, 5], [5, 5], 0.1)).toBe(true);
  });
});

describe('simplification', () => {
  it('keeps every original point within its tolerance', () => {
    for (const [seed, tolerance] of [
      [1, 0.25],
      [2, 0.5],
      [3, 2],
    ] as const) {
      const points = randomWalk(3000, seed);
      const simplified = simplifyPoints(points, tolerance);
      expect(simplified.length).toBeLessThan(points.length);
      expect(simplified[0]).toEqual(points[0]);
      expect(simplified[simplified.length - 1]).toEqual(points[points.length - 1]);
      // A subsequence of the original points…
      let j = 0;
      for (const p of simplified) {
        while (j < points.length && points[j] !== p) j++;
        expect(j).toBeLessThan(points.length);
      }
      // …that stays within the tolerance of every point it drops.
      const worst = Math.max(...points.map((p) => polylineDistance(p, [simplified])));
      expect(worst).toBeLessThanOrEqual(tolerance + 1e-9);
    }
  });

  it('reduces a straight line to its ends', () => {
    const line = Array.from({ length: 100 }, (_, i): PdfPoint => [i, 2 * i + 1]);
    expect(simplifyPoints(line, 0.01)).toEqual([line[0], line[99]]);
  });

  it('fits a very long stroke under the point limit, saying so', () => {
    const noisy = randomWalk(20_000, 9).map(([x, y], i): PdfPoint => [x + i * 0.05, y + (i % 2 ? 3 : -3)]);
    const fitted = fitStroke(noisy, 0.01);
    expect(fitted.simplified).toBe(true);
    expect(fitted.points.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    expect(fitted.points[0]).toEqual(noisy[0]);
    const short = randomWalk(50, 4);
    expect(fitStroke(short)).toEqual({ points: short, simplified: false });
  });
});

describe('paths', () => {
  it('draw a dot for a single pen point and pass through both ends of a stroke', () => {
    expect(svgPathData(shapePath({ tool: 'pen', points: [[10, 20]], widthPt: 2 }))).toBe('M10 20L10.01 20');
    const points: PdfPoint[] = [
      [0, 0],
      [10, 5],
      [20, -5],
      [30, 0],
    ];
    const path = shapePath({ tool: 'pen', points, widthPt: 2 });
    expect(path[0]).toEqual({ op: 'M', p: [0, 0] });
    expect(path[path.length - 1]).toEqual({ op: 'L', p: [30, 0] });
    // The smoothed curve stays near the stroke.
    for (const line of flattenPath(path)) for (const p of line) expect(polylineDistance(p, [points])).toBeLessThan(5);
  });

  it('give arrows an open head at the end, sized to the stroke width', () => {
    const start: PdfPoint = [0, 0];
    const end: PdfPoint = [100, 0];
    for (const width of [1, 2, 4]) {
      const [left, right] = arrowHead(start, end, width);
      expect(Math.hypot(left[0] - 100, left[1])).toBeCloseTo(arrowHeadLength(width), 9);
      expect(left[0]).toBeCloseTo(right[0], 9);
      expect(left[1]).toBeCloseTo(-right[1], 9);
      expect((Math.atan2(Math.abs(left[1]), 100 - left[0]) * 180) / Math.PI).toBeCloseTo(28, 6);
    }
    expect(arrowHeadLength(4)).toBeGreaterThan(arrowHeadLength(1));
    // A short arrow gets a smaller head.
    const [l] = arrowHead([0, 0], [5, 0], 4);
    expect(Math.hypot(l[0] - 5, l[1])).toBeCloseTo(3, 9);
    const path = shapePath({ tool: 'arrow', points: [start, end], widthPt: 2 });
    expect(pdfPathOps(path)).toMatch(/^0 0 m\n100 0 l\n91\.171 -4\.695 m\n100 0 l\n91\.171 4\.695 l$/);
  });

  it('draw rectangles along their box and ellipses inside it', () => {
    const box: PdfPoint[] = [
      [10, 20],
      [110, 70],
    ];
    expect(pathBounds(shapePath({ tool: 'rect', points: box, widthPt: 1 }))).toEqual([10, 20, 110, 70]);
    const ellipse = shapePath({ tool: 'ellipse', points: box, widthPt: 1 });
    expect(pathBounds(ellipse)).toEqual([10, 20, 110, 70]);
    for (const line of flattenPath(ellipse, 24)) {
      for (const [x, y] of line) {
        const value = ((x - 60) / 50) ** 2 + ((y - 45) / 25) ** 2;
        expect(Math.abs(value - 1)).toBeLessThan(0.002);
      }
    }
  });

  it('measure the distance to a stroke', () => {
    const lines = flattenPath(shapePath({ tool: 'line', points: [[0, 0], [10, 0]], widthPt: 1 }));
    expect(polylineDistance([5, 3], lines)).toBeCloseTo(3, 9);
    expect(polylineDistance([13, 4], lines)).toBeCloseTo(5, 9);
    // Inside a rectangle is far from its outline.
    const rect = flattenPath(shapePath({ tool: 'rect', points: [[0, 0], [100, 100]], widthPt: 1 }));
    expect(polylineDistance([50, 50], rect)).toBeCloseTo(50, 9);
  });

  it('keep a moved drawing inside its page', () => {
    const view: [number, number, number, number] = [0, 0, 600, 800];
    expect(clampMove([10, 10, 60, 60], view, -50, 0)).toEqual([-10, 0]);
    expect(clampMove([10, 10, 60, 60], view, 1000, 1000)).toEqual([540, 740]);
    expect(clampMove([10, 10, 60, 60], view, 5, -3)).toEqual([5, -3]);
  });
});
