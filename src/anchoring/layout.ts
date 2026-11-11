// Where text is on the pages, computed from the PDF's text items alone (no DOM): the boxes of
// lines and of text ranges, in page space. Drawings and text boxes are bound to content with it,
// and it gives the same answer whatever the zoom and whichever pages are rendered.
//
// Positions inside an item are interpolated by character count, which is exact for the item as a
// whole and close enough inside it for attaching a drawing to words.
import { applyMatrix, pageGeometry, type PageGeometry, type PdfPoint } from '../shared/drawingGeometry';
import type { PageInput, TextItemInput, TextModel } from './textModel';

/** [x0, y0, x1, y1] in page space: points from the top left corner of the page as shown, y down. */
export type Box = [number, number, number, number];

export interface LineBox {
  /** Normalized text range of the line. */
  start: number;
  end: number;
  box: Box;
  /** The items on the line, left to right. */
  items: number[];
}

/** Share of an item's height above its baseline. */
const ASCENT = 0.8;

export function boxWidth(b: Box): number {
  return b[2] - b[0];
}

export function boxHeight(b: Box): number {
  return b[3] - b[1];
}

export function unionBox(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function boxCenter(b: Box): [number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** Area two boxes share. */
export function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

function boundsOf(points: PdfPoint[]): Box {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export class DocumentLayout {
  private readonly geometries: PageGeometry[];
  private readonly lineCache = new Map<number, LineBox[]>();

  constructor(
    private readonly pages: PageInput[],
    readonly model: TextModel,
  ) {
    this.geometries = pages.map((p) => pageGeometry(p.view, p.rotate ?? 0, p.userUnit ?? 1));
  }

  get pageCount(): number {
    return this.pages.length;
  }

  geometry(page: number): PageGeometry | undefined {
    return this.geometries[page];
  }

  pageSize(page: number): [number, number] | undefined {
    const g = this.geometries[page];
    return g ? [g.width, g.height] : undefined;
  }

  private itemSize(item: TextItemInput): { width: number; height: number; ux: number; uy: number; nx: number; ny: number } {
    const [a = 1, b = 0, c = 0, d = 1] = item.transform;
    const along = Math.hypot(a, b) || 1;
    const across = Math.hypot(c, d) || 1;
    const height = item.height && item.height > 0 ? item.height : across;
    const width = item.width && item.width > 0 ? item.width : item.str.length * 0.5 * height;
    return { width, height, ux: a / along, uy: b / along, nx: c / across, ny: d / across };
  }

  /** The page-space box of the characters [from, to) of an item. */
  private partBox(page: number, itemIndex: number, from: number, to: number): Box | undefined {
    const item = this.pages[page]?.items[itemIndex];
    const g = this.geometries[page];
    if (!item || !g) return undefined;
    const { width, height, ux, uy, nx, ny } = this.itemSize(item);
    const length = Math.max(1, item.str.length);
    const t0 = (Math.max(0, Math.min(from, length)) / length) * width;
    const t1 = (Math.max(0, Math.min(to, length)) / length) * width;
    const [e = 0, f = 0] = [item.transform[4], item.transform[5]];
    const corner = (t: number, h: number): PdfPoint => applyMatrix(g.transform, [e + ux * t + nx * h, f + uy * t + ny * h]);
    return boundsOf([corner(t0, -(1 - ASCENT) * height), corner(t1, -(1 - ASCENT) * height), corner(t0, ASCENT * height), corner(t1, ASCENT * height)]);
  }

  /**
   * Whether the text of a page runs sideways as the page is shown (a page turned by /Rotate whose
   * text was not turned with it). Lines cannot be told apart by their height there.
   */
  sideways(page: number): boolean {
    const g = this.geometries[page];
    if (!g) return false;
    let across = 0;
    let along = 0;
    for (const item of this.pages[page]?.items ?? []) {
      if (!item.str.trim()) continue;
      const [a = 1, b = 0] = item.transform;
      // The direction of the text in page space.
      const dx = g.transform[0] * a + g.transform[2] * b;
      const dy = g.transform[1] * a + g.transform[3] * b;
      if (Math.abs(dy) > Math.abs(dx)) across += item.str.length;
      else along += item.str.length;
    }
    return across > along;
  }

  /** The text lines of a page, top to bottom. */
  lines(page: number): LineBox[] {
    const cached = this.lineCache.get(page);
    if (cached) return cached;
    const lines: LineBox[] = [];
    const items = this.pages[page]?.items ?? [];
    items.forEach((item, index) => {
      if (!item.str.trim()) return;
      const range = this.model.itemRange(page, index);
      if (!range || range[1] <= range[0]) return;
      const box = this.partBox(page, index, 0, item.str.length);
      if (!box || boxWidth(box) <= 0 || boxHeight(box) <= 0) return;
      const line = lines.find((l) => Math.min(l.box[3], box[3]) - Math.max(l.box[1], box[1]) > 0.5 * Math.min(boxHeight(l.box), boxHeight(box)));
      if (line) {
        line.box = unionBox(line.box, box);
        line.start = Math.min(line.start, range[0]);
        line.end = Math.max(line.end, range[1]);
        line.items.push(index);
      } else {
        lines.push({ start: range[0], end: range[1], box, items: [index] });
      }
    });
    lines.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    this.lineCache.set(page, lines);
    return lines;
  }

  /** The line a text offset is on. */
  lineOf(offset: number): { page: number; line: LineBox } | undefined {
    const source = this.model.source(Math.max(0, Math.min(offset, this.model.text.length - 1)));
    if (!source) return undefined;
    const lines = this.lines(source.page);
    const line = lines.find((l) => l.items.includes(source.item)) ?? lines.find((l) => offset >= l.start && offset < l.end);
    return line ? { page: source.page, line } : undefined;
  }

  /** The boxes of a text range: one per line it touches, per page. */
  rangeBoxes(start: number, end: number): { page: number; boxes: Box[] }[] {
    const out: { page: number; boxes: Box[] }[] = [];
    for (const { page, segments } of this.model.segments(start, end)) {
      const boxes: Box[] = [];
      for (const seg of segments) {
        const part = this.partBox(page, seg.item, seg.from, seg.to);
        if (!part || boxWidth(part) <= 0) continue;
        const line = boxes.find((b) => Math.min(b[3], part[3]) - Math.max(b[1], part[1]) > 0.5 * Math.min(boxHeight(b), boxHeight(part)));
        if (line) line.splice(0, 4, ...unionBox(line, part));
        else boxes.push(part);
      }
      boxes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      if (boxes.length > 0) out.push({ page, boxes });
    }
    return out;
  }

  /** The text offset nearest to a horizontal position on a line. */
  offsetAt(page: number, line: LineBox, x: number): number {
    let best: { index: number; distance: number } | undefined;
    for (const index of line.items) {
      const item = this.pages[page].items[index];
      const box = this.partBox(page, index, 0, item.str.length);
      if (!box) continue;
      const distance = x < box[0] ? box[0] - x : x > box[2] ? x - box[2] : 0;
      if (!best || distance < best.distance) best = { index, distance };
    }
    if (!best) return line.start;
    const item = this.pages[page].items[best.index];
    const box = this.partBox(page, best.index, 0, item.str.length)!;
    const t = boxWidth(box) > 0 ? Math.max(0, Math.min(1, (x - box[0]) / boxWidth(box))) : 0;
    const offset = Math.round(t * item.str.length);
    return this.model.indexAt(page, best.index, offset, 'start') ?? line.start;
  }

  /** The words of a line with their boxes. */
  words(page: number, line: LineBox): { start: number; end: number; box: Box }[] {
    const text = this.model.text;
    const out: { start: number; end: number; box: Box }[] = [];
    let i = line.start;
    while (i < line.end) {
      while (i < line.end && text[i] === ' ') i++;
      let j = i;
      while (j < line.end && text[j] !== ' ') j++;
      if (j > i) {
        const boxes = this.rangeBoxes(i, j).find((p) => p.page === page)?.boxes;
        if (boxes?.length) out.push({ start: i, end: j, box: boxes.reduce(unionBox) });
      }
      i = j;
    }
    return out;
  }
}
