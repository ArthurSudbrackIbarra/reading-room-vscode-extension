// Test helpers for anchoring: a deterministic text layout with exact geometry, a scenario builder
// that runs the engine the viewer uses, and the invariants every scenario must keep.
import { expect } from 'vitest';
import type { AnchorState, TextAnchor } from '../../../src/anchoring/anchor';
import { createAnchor } from '../../../src/anchoring/anchor';
import type { DrawingBinding } from '../../../src/anchoring/binding';
import type { CopyHint } from '../../../src/anchoring/diff';
import { DocumentLayout, unionBox, type Box } from '../../../src/anchoring/layout';
import { ResolverRuns, bindDrawing, drawingBox, markerAnchor, type MarkerInput, type RunDocument, type RunResult } from '../../../src/anchoring/runs';
import { TextModel, type PageInput, type TextItemInput } from '../../../src/anchoring/textModel';
import { toPdfSpace, type PdfPoint } from '../../../src/shared/drawingGeometry';
import { sanitizeDrawing, type Drawing } from '../../../src/shared/drawings';

export interface LayoutOptions {
  charsPerLine?: number;
  linesPerPage?: number;
  /** Text repeated in the top / bottom margin of every page (excluded from the text model). */
  header?: string;
  footer?: string;
  /** One text item per word instead of one per line (PDF.js splits text differently between renders). */
  splitWords?: boolean;
  /** Page size in points. */
  page?: [number, number];
  rotate?: number;
}

export interface LaidOut {
  pages: PageInput[];
  /** Image boxes per page, in page space. */
  images: Box[][];
}

export const CHAR_WIDTH = 6;
export const LINE_HEIGHT = 14;
export const FONT_SIZE = 10;
export const LEFT = 60;
const GRID_LEFT = LEFT;
export const TOP = 72;
export const TEST_MARGINS = { top: 51, bottom: 57 };

/**
 * Lays text out on a monospace grid: paragraphs are separated by blank lines, words wrap at
 * `charsPerLine`, pages break after `linesPerPage` lines. A paragraph `[image WxH]` reserves room
 * for an image of that size (in points) and records its box.
 */
export function layoutText(text: string, options: LayoutOptions = {}): LaidOut {
  const charsPerLine = options.charsPerLine ?? 60;
  const linesPerPage = options.linesPerPage ?? 40;
  const [pageWidth, pageHeight] = options.page ?? [595, 842];
  type Row = { text: string } | { image: [number, number] } | { blank: true };
  const rows: Row[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const image = /^\[image (\d+)x(\d+)\]$/.exec(trimmed);
    if (image) {
      rows.push({ image: [Number(image[1]), Number(image[2])] });
    } else {
      for (const hard of trimmed.split('\n')) {
        let line = '';
        for (const word of hard.split(/\s+/).filter(Boolean)) {
          if (line && line.length + 1 + word.length > charsPerLine) {
            rows.push({ text: line });
            line = word;
          } else {
            line = line ? `${line} ${word}` : word;
          }
        }
        if (line) rows.push({ text: line });
      }
    }
    rows.push({ blank: true });
  }
  const pages: PageInput[] = [];
  const images: Box[][] = [];
  let items: TextItemInput[] = [];
  let pageImages: Box[] = [];
  let line = 0;
  const item = (str: string, x: number, top: number, hasEOL: boolean, size = FONT_SIZE): TextItemInput => ({
    str,
    hasEOL,
    // Page space y (down) to PDF y (up); the baseline sits 80 % of the height below the top.
    transform: [size, 0, 0, size, x, pageHeight - top - 0.8 * LINE_HEIGHT],
    width: str.length * CHAR_WIDTH,
    height: LINE_HEIGHT,
  });
  const flush = () => {
    if (options.header) items.unshift(item(options.header, LEFT, 20, true));
    if (options.footer) items.push(item(options.footer, pageWidth / 2, pageHeight - 40, false));
    pages.push({ items, view: [0, 0, pageWidth, pageHeight], ...(options.rotate ? { rotate: options.rotate } : {}) });
    images.push(pageImages);
    items = [];
    pageImages = [];
    line = 0;
  };
  for (const row of rows) {
    if ('blank' in row) {
      if (line > 0) line++;
      continue;
    }
    const needed = 'image' in row ? Math.ceil(row.image[1] / LINE_HEIGHT) : 1;
    if (line > 0 && line + needed > linesPerPage) flush();
    const top = TOP + line * LINE_HEIGHT;
    if ('image' in row) {
      pageImages.push([LEFT, top, LEFT + row.image[0], top + row.image[1]]);
      line += needed;
      continue;
    }
    if (options.splitWords) {
      const words = row.text.split(' ');
      let x = LEFT;
      words.forEach((word, i) => {
        items.push(item(word, x, top, false));
        x += word.length * CHAR_WIDTH;
        if (i < words.length - 1) {
          items.push(item(' ', x, top, false));
          x += CHAR_WIDTH;
        }
      });
      items[items.length - 1].hasEOL = true;
    } else {
      items.push(item(row.text, LEFT, top, true));
    }
    line++;
  }
  if (items.length > 0 || pageImages.length > 0 || pages.length === 0) flush();
  return { pages, images };
}

export interface TestDocument extends RunDocument {
  images: Box[][];
  text: string;
  /** Where the text starts on the left (for marks made in the margin); default: the grid's. */
  left?: number;
}

/** Makes the document a source text renders to (the monospace grid, or a real converter). */
export type Renderer = (source: string, options: LayoutOptions, renderId: number) => TestDocument | Promise<TestDocument>;

export function makeDocument(source: string, options: LayoutOptions = {}, renderId = 1, extra: Partial<RunDocument> = {}): TestDocument {
  const laid = layoutText(source, options);
  const model = new TextModel(laid.pages, { marginsPt: TEST_MARGINS });
  return { renderId, model, layout: new DocumentLayout(laid.pages, model), images: laid.images, text: model.text, ...extra };
}

function find(text: string, needle: string, occurrence = 0): [number, number] {
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`"${needle}" is not in the text`);
  return [at, at + needle.length];
}

/** The page and union box of a piece of text (which must be on one page). */
export function boxOfText(doc: TestDocument, needle: string, occurrence = 0): { page: number; box: Box; boxes: Box[] } {
  const [start, end] = find(doc.text, needle, occurrence);
  const parts = doc.layout.rangeBoxes(start, end);
  if (parts.length === 0) throw new Error(`"${needle}" has no boxes`);
  return { page: parts[0].page, box: parts[0].boxes.reduce(unionBox), boxes: parts[0].boxes };
}

export type DrawSpec =
  | { shape: 'ellipse' | 'rect'; around: string; occurrence?: number }
  | { shape: 'underline'; under: string; occurrence?: number }
  | { shape: 'bracket'; beside: [string, string] }
  | { shape: 'arrow'; from: string; to: string }
  | { shape: 'margin'; beside: string }
  | { shape: 'text'; over: string; content?: string }
  | { shape: 'note'; beside: string; content?: string }
  | { shape: 'rect'; onImage: number; page?: number }
  | { shape: 'rect'; at: Box; page: number };

let drawingSeq = 0;

/** Builds a drawing from a description, in PDF units of its page. */
export function makeShape(doc: TestDocument, id: string, spec: DrawSpec): Drawing {
  const now = new Date(Date.UTC(2026, 10, 11, 12, 0, ++drawingSeq)).toISOString();
  let page: number;
  let tool: Drawing['tool'];
  let points: PdfPoint[] = [];
  let text: string | undefined;
  const ink = (...p: PdfPoint[]) => (points = p);
  const LEFT = doc.left ?? GRID_LEFT;
  if ('around' in spec) {
    const at = boxOfText(doc, spec.around, spec.occurrence);
    page = at.page;
    tool = spec.shape;
    ink([at.box[0] - 3, at.box[3] + 2], [at.box[2] + 3, at.box[1] - 2]);
  } else if ('under' in spec) {
    const at = boxOfText(doc, spec.under, spec.occurrence);
    page = at.page;
    tool = 'line';
    ink([at.box[0], at.box[3] + 1], [at.box[2], at.box[3] + 1]);
  } else if (spec.shape === 'bracket') {
    const a = boxOfText(doc, spec.beside[0]);
    const b = boxOfText(doc, spec.beside[1]);
    page = a.page;
    tool = 'pen';
    ink([LEFT - 14, a.box[1]], [LEFT - 18, a.box[1] + 4], [LEFT - 18, b.box[3] - 4], [LEFT - 14, b.box[3]]);
  } else if (spec.shape === 'arrow') {
    const a = boxOfText(doc, spec.from);
    const b = boxOfText(doc, spec.to);
    page = a.page;
    tool = 'arrow';
    ink([(a.box[0] + a.box[2]) / 2, (a.box[1] + a.box[3]) / 2], [(b.box[0] + b.box[2]) / 2, (b.box[1] + b.box[3]) / 2]);
  } else if (spec.shape === 'margin') {
    const at = boxOfText(doc, spec.beside);
    page = at.page;
    tool = 'pen';
    ink([LEFT - 30, at.box[1] + 3], [LEFT - 24, at.box[1] + 7], [LEFT - 30, at.box[1] + 11]);
  } else if (spec.shape === 'text') {
    const at = boxOfText(doc, spec.over);
    page = at.page;
    tool = 'text';
    text = spec.content ?? 'A note';
    ink([at.box[0] + 2, at.box[1] + 2]);
  } else if (spec.shape === 'note') {
    const at = boxOfText(doc, spec.beside);
    page = at.page;
    tool = 'text';
    text = spec.content ?? 'A note';
    ink([LEFT - 52, at.box[1]]);
  } else if ('onImage' in spec) {
    page = spec.page ?? doc.images.findIndex((list) => list.length > spec.onImage);
    const image = doc.images[page][spec.onImage];
    tool = 'rect';
    ink([image[0] + 10, image[3] - 10], [image[2] - 10, image[1] + 10]);
  } else {
    page = spec.page;
    tool = 'rect';
    ink([spec.at[0], spec.at[3]], [spec.at[2], spec.at[1]]);
  }
  const geometry = doc.layout.geometry(page)!;
  const base = { id, pageIndex: page, points: points.map((p) => toPdfSpace(geometry, p)), createdAt: now, updatedAt: now, textModelHash: doc.model.hash };
  const raw = tool === 'text' ? { ...base, tool, text, size: 10, align: 'left', color: 'black' } : { ...base, tool, color: 'red', width: 'thin' };
  const drawing = sanitizeDrawing(raw);
  if (!drawing) throw new Error(`could not build drawing ${id}`);
  return drawing;
}

/** The size the tests give text boxes on the page. */
export const TEXT_BOX_SIZE = { width: 40, height: 12.5 };

interface HighlightRecord {
  anchor: TextAnchor;
  state?: AnchorState;
}
interface DrawingRecord {
  drawing: Drawing;
  binding?: DrawingBinding;
  states?: (AnchorState | undefined)[];
  /** Offset of the drawing's box from its text when it was made (for `follows`). */
}

export interface HighlightExpectation {
  status?: 'anchored' | 'orphaned';
  kind?: string;
  reason?: string;
  text?: string;
  page?: number;
  /** Text of the candidate that replaced it. */
  candidate?: string;
}

export interface DrawingExpectation {
  status?: 'anchored' | 'orphaned';
  reason?: string;
  mode?: string;
  page?: number;
  flags?: string[];
  /** The shown drawing's box covers this text (within a few points). */
  boxCovers?: string;
  /** The shown drawing runs right under this text, from its start to its end. */
  underlines?: string;
  /** The shown drawing's box starts this far (points) from the top left of this text; default: as when it was made. */
  follows?: string;
  /** The shown drawing's box is inside this image of its page. */
  insideImage?: number;
  /** Both ends of a two-point drawing are near these words. */
  endsNear?: [string, string];
}

export interface MarkerExpectation {
  status?: 'anchored' | 'orphaned';
  reason?: string;
  page?: number;
  lineStartsWith?: string;
  approximate?: boolean;
  stored?: boolean;
}

type Step =
  | { kind: 'edit'; edit: (text: string) => string; options: StepOptions }
  | { kind: 'expect'; id: string; expectation: HighlightExpectation | DrawingExpectation | MarkerExpectation }
  | { kind: 'check'; check: (world: World) => void };

export interface StepOptions {
  layout?: LayoutOptions;
  provisional?: boolean;
  /** Forget the texts of earlier versions before this render. */
  noSnapshots?: boolean;
  hints?: CopyHint[];
}

/** Everything a viewer and its host would hold for one document. */
export class World {
  source: string;
  layoutOptions: LayoutOptions;
  doc: TestDocument;
  readonly highlights = new Map<string, HighlightRecord>();
  readonly drawings = new Map<string, DrawingRecord>();
  marker?: MarkerInput;
  readonly texts = new Map<string, string>();
  readonly runs = new ResolverRuns();
  last?: RunResult;
  private renderSeq = 0;
  /** What the reader made, as first stored: no automatic process may change it. */
  private intent = '';
  readonly made = new Map<string, { text: string; dx: number; dy: number }>();
  readonly log: string[] = [];
  private renderer?: Renderer;

  constructor(source: string, layoutOptions: LayoutOptions = {}, first?: TestDocument, renderer?: Renderer) {
    this.source = source;
    this.layoutOptions = layoutOptions;
    this.renderer = renderer;
    this.renderSeq = first ? first.renderId : 0;
    this.doc = first ?? makeDocument(source, layoutOptions, ++this.renderSeq);
  }

  /** A world whose documents come from a renderer (the real converter, in the converter tests). */
  static async from(source: string, renderer: Renderer, options: LayoutOptions = {}): Promise<World> {
    return new World(source, options, await renderer(source, options, 1), renderer);
  }

  addHighlight(id: string, exact: string, occurrence = 0): void {
    const [start, end] = find(this.doc.text, exact, occurrence);
    this.highlights.set(id, { anchor: createAnchor(this.doc.text, this.doc.model.hash, start, end) });
    this.readerActed();
  }

  async addDrawing(id: string, spec: DrawSpec, prefer?: 'text' | 'image' | 'page'): Promise<void> {
    const drawing = makeShape(this.doc, id, spec);
    const binding = await bindDrawing(drawing, this.doc, { images: (p) => this.doc.images[p] ?? [], textSize: () => TEXT_BOX_SIZE, prefer });
    this.drawings.set(id, { drawing, binding });
    this.readerActed();
    const near =
      'around' in spec ? spec.around : 'under' in spec ? spec.under : 'over' in spec ? spec.over : 'beside' in spec && typeof spec.beside === 'string' ? spec.beside : undefined;
    if (near) {
      const text = boxOfText(this.doc, near);
      const box = drawingBox(drawing, this.doc.layout.geometry(drawing.pageIndex)!, TEXT_BOX_SIZE);
      this.made.set(id, { text: near, dx: box[0] - text.box[0], dy: box[1] - text.box[1] });
    }
  }

  placeMarker(lineStartingWith: string): void {
    const [start] = find(this.doc.text, lineStartingWith);
    const at = this.doc.layout.lineOf(start)!;
    const size = this.doc.layout.pageSize(at.page)!;
    this.marker = { page: at.page, y: at.line.box[1] / size[1], anchor: markerAnchor(this.doc.model, at.line.start, at.line.end) };
    this.readerActed();
  }

  /** The reader changed something on purpose: what they made is compared from here on. */
  readerActed(): void {
    this.intent = '';
  }

  private intentNow(): string {
    return JSON.stringify({
      highlights: [...this.highlights].map(([id, h]) => [id, h.anchor.exact, h.anchor.createdIn]),
      drawings: [...this.drawings].map(([id, d]) => [id, d.drawing]),
      marker: this.marker ? [this.marker.page, this.marker.y, this.marker.anchor, this.marker.rel] : null,
    });
  }

  async resolve(options: StepOptions = {}, first = false): Promise<RunResult> {
    if (options.noSnapshots) this.texts.clear();
    const input = () => ({
      highlights: [...this.highlights].map(([id, h]) => ({ id, anchor: h.anchor, state: h.state })),
      marker: this.marker,
      drawings: [...this.drawings.values()].map((d) => ({ drawing: d.drawing, binding: d.binding, states: d.states })),
    });
    const runOptions = {
      oldText: (hash: string) => this.texts.get(hash),
      images: (page: number) => this.doc.images[page] ?? [],
      textSize: () => TEXT_BOX_SIZE,
      log: (message: string) => this.log.push(message),
      first,
    };
    const doc: TestDocument = { ...this.doc, provisional: options.provisional, hints: options.hints };
    const before = this.intentNow();
    const result = await this.runs.run(doc, input(), runOptions);
    if (!result) throw new Error('the run was cancelled');
    // I5: the same inputs give the same results.
    const again = await this.runs.run(doc, input(), runOptions);
    expect(comparable(again!)).toEqual(comparable(result));
    // I3: resolving changes nothing the reader made.
    expect(this.intentNow()).toBe(before);
    if (this.intent && !options.provisional) expect(this.intentNow()).toBe(this.intent);
    this.last = result;
    assertInvariants(this, result);
    if (!result.provisional) this.store(result);
    if (!this.intent) this.intent = this.intentNow();
    return result;
  }

  /** What the host does with the results of a saved render. */
  private store(result: RunResult): void {
    let found = false;
    for (const [id, r] of result.highlights) {
      const h = this.highlights.get(id)!;
      h.state = r.state;
      const upgraded = result.upgraded.get(id);
      if (upgraded && !h.anchor.fingerprint) h.anchor = upgraded;
      if (r.status === 'anchored') found = true;
    }
    for (const [id, r] of result.drawings) {
      const d = this.drawings.get(id)!;
      if (r.binding) d.binding = r.binding;
      d.states = r.states;
      if (r.status === 'anchored') found = true;
    }
    if (this.marker && result.marker) {
      this.marker = { ...this.marker, state: result.marker.state ?? this.marker.state };
      if (result.marker.status === 'anchored') found = true;
    }
    if (found) this.texts.set(result.hash, this.doc.text);
  }

  async edit(edit: (text: string) => string, options: StepOptions = {}): Promise<RunResult> {
    this.source = edit(this.source);
    if (options.layout) this.layoutOptions = { ...this.layoutOptions, ...options.layout };
    const renderId = ++this.renderSeq;
    this.doc = this.renderer ? await this.renderer(this.source, this.layoutOptions, renderId) : makeDocument(this.source, this.layoutOptions, renderId);
    return this.resolve(options);
  }

  // ---------- Expectations ----------

  checkHighlight(id: string, e: HighlightExpectation): void {
    const r = this.last!.highlights.get(id);
    if (!r) throw new Error(`no highlight ${id}`);
    const label = `highlight ${id}`;
    if (e.status) expect(r.status, label).toBe(e.status);
    if (e.kind) expect(r.kind, label).toBe(e.kind);
    if (e.reason) expect(r.reason, label).toBe(e.reason);
    if (e.text !== undefined) expect(this.doc.text.slice(r.start, r.end), label).toBe(e.text);
    if (e.page !== undefined) expect(this.doc.model.pageOf(r.start!), label).toBe(e.page);
    if (e.candidate !== undefined) expect(r.candidate && this.doc.text.slice(r.candidate.start, r.candidate.end), label).toBe(e.candidate);
  }

  shownBox(id: string): { page: number; box: Box } | undefined {
    const r = this.last!.drawings.get(id);
    if (!r?.shown) return undefined;
    return { page: r.shown.pageIndex, box: drawingBox(r.shown, this.doc.layout.geometry(r.shown.pageIndex)!, TEXT_BOX_SIZE) };
  }

  checkDrawing(id: string, e: DrawingExpectation): void {
    const r = this.last!.drawings.get(id);
    if (!r) throw new Error(`no drawing ${id}`);
    const label = `drawing ${id}`;
    if (e.status) expect(r.status, label).toBe(e.status);
    if (e.reason) expect(r.reason, label).toBe(e.reason);
    if (e.mode) expect(this.drawings.get(id)!.binding?.mode, label).toBe(e.mode);
    if (e.flags) expect([...r.flags].sort(), label).toEqual([...e.flags].sort());
    const shown = this.shownBox(id);
    if (e.page !== undefined) expect(shown?.page, label).toBe(e.page);
    if (e.boxCovers !== undefined) {
      const text = boxOfText(this.doc, e.boxCovers);
      expect(shown?.page, `${label} page`).toBe(text.page);
      const [x0, y0, x1, y1] = shown!.box;
      const slack = 3.5;
      expect(
        x0 <= text.box[0] + slack && y0 <= text.box[1] + slack && x1 >= text.box[2] - slack && y1 >= text.box[3] - slack,
        `${label} box ${JSON.stringify(shown!.box)} covers ${JSON.stringify(text.box)}`,
      ).toBe(true);
      // And not much more than it.
      expect(x1 - x0, `${label} width`).toBeLessThanOrEqual(text.box[2] - text.box[0] + 16);
    }
    if (e.underlines !== undefined) {
      const text = boxOfText(this.doc, e.underlines);
      expect(shown?.page, `${label} page`).toBe(text.page);
      const [x0, y0, x1, y1] = shown!.box;
      expect(
        Math.abs(x0 - text.box[0]) <= 3.5 && Math.abs(x1 - text.box[2]) <= 3.5 && y0 >= text.box[3] - 3 && y1 <= text.box[3] + 5,
        `${label} box ${JSON.stringify(shown!.box)} underlines ${JSON.stringify(text.box)}`,
      ).toBe(true);
    }
    if (e.follows !== undefined) {
      const made = this.made.get(id)!;
      const text = boxOfText(this.doc, e.follows);
      expect(shown?.page, `${label} page`).toBe(text.page);
      expect(shown!.box[1] - text.box[1], `${label} dy`).toBeCloseTo(made.dy, 1);
      if (this.drawings.get(id)!.binding?.mode !== 'line') expect(shown!.box[0] - text.box[0], `${label} dx`).toBeCloseTo(made.dx, 1);
    }
    if (e.insideImage !== undefined) {
      const image = this.doc.images[shown!.page][e.insideImage];
      const [x0, y0, x1, y1] = shown!.box;
      expect(
        x0 >= image[0] - 1 && y0 >= image[1] - 1 && x1 <= image[2] + 1 && y1 <= image[3] + 1,
        `${label} box ${JSON.stringify(shown!.box)} inside ${JSON.stringify(image)}`,
      ).toBe(true);
    }
    if (e.endsNear) {
      const geometry = this.doc.layout.geometry(r.shown!.pageIndex)!;
      r.shown!.points.forEach((p, i) => {
        const text = boxOfText(this.doc, e.endsNear![i]);
        const [x, y] = [
          geometry.transform[0] * p[0] + geometry.transform[2] * p[1] + geometry.transform[4],
          geometry.transform[1] * p[0] + geometry.transform[3] * p[1] + geometry.transform[5],
        ];
        const dx = x < text.box[0] ? text.box[0] - x : x > text.box[2] ? x - text.box[2] : 0;
        const dy = y < text.box[1] ? text.box[1] - y : y > text.box[3] ? y - text.box[3] : 0;
        expect(Math.hypot(dx, dy), `${label} end ${i} near "${e.endsNear![i]}"`).toBeLessThanOrEqual(4);
      });
    }
  }

  checkMarker(e: MarkerExpectation): void {
    const m = this.last!.marker;
    if (!m) throw new Error('no marker');
    if (e.status) expect(m.status, 'marker').toBe(e.status);
    if (e.reason) expect(m.reason, 'marker').toBe(e.reason);
    if (e.page !== undefined) expect(m.page, 'marker').toBe(e.page);
    if (e.approximate !== undefined) expect(m.approximate, 'marker').toBe(e.approximate);
    if (e.stored !== undefined) expect(m.stored, 'marker').toBe(e.stored);
    if (e.lineStartsWith !== undefined) {
      const line = this.doc.layout.lines(m.page).find((l) => Math.abs(l.box[1] / this.doc.layout.pageSize(m.page)![1] - m.y) < 1e-6);
      expect(line && this.doc.text.slice(line.start, line.end), 'marker line').toMatch(new RegExp(`^${e.lineStartsWith.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
  }
}

function comparable(result: RunResult): unknown {
  return JSON.parse(
    JSON.stringify({
      highlights: [...result.highlights],
      upgraded: [...result.upgraded],
      marker: result.marker,
      drawings: [...result.drawings],
      summary: result.summary,
    }),
  );
}

/**
 * The invariants of one resolved render:
 *  I2: every annotation is anchored (valid offsets, existing page, finite geometry inside its page)
 *      or orphaned (with a reason and nothing to draw), never in between;
 *  I6: no result is missing, whatever the others were.
 */
export function assertInvariants(world: World, result: RunResult): void {
  const { doc } = world;
  const length = doc.text.length;
  expect([...result.highlights.keys()].sort()).toEqual([...world.highlights.keys()].sort());
  expect([...result.drawings.keys()].sort()).toEqual([...world.drawings.keys()].sort());
  for (const [id, r] of result.highlights) {
    const label = `highlight ${id}`;
    if (r.status === 'anchored') {
      expect(r.kind, label).toBeDefined();
      expect(
        Number.isInteger(r.start) && Number.isInteger(r.end) && r.start! >= 0 && r.end! > r.start! && r.end! <= length,
        `${label} range ${r.start}-${r.end} of ${length}`,
      ).toBe(true);
      const parts = doc.layout.rangeBoxes(r.start!, r.end!);
      expect(parts.length, `${label} has boxes`).toBeGreaterThan(0);
      for (const part of parts) {
        const size = doc.layout.pageSize(part.page)!;
        expect(part.page >= 0 && part.page < doc.layout.pageCount, label).toBe(true);
        for (const b of part.boxes)
          expect(b.every(Number.isFinite) && b[0] >= -0.01 && b[1] >= -0.01 && b[2] <= size[0] + 0.01 && b[3] <= size[1] + 0.01, `${label} box ${JSON.stringify(b)}`).toBe(true);
      }
      expect(r.state.found?.hash, label).toBe(result.hash);
    } else {
      expect(r.reason, label).toBeDefined();
      expect(r.start, label).toBeUndefined();
      expect(r.end, label).toBeUndefined();
      if (r.tombstone !== undefined) expect(r.tombstone >= 0 && r.tombstone <= length, label).toBe(true);
    }
    expect(r.state.status, label).toBe(r.status);
  }
  for (const [id, r] of result.drawings) {
    const label = `drawing ${id}`;
    if (r.status === 'anchored') {
      expect(r.shown, label).toBeDefined();
      const page = r.shown!.pageIndex;
      expect(page >= 0 && page < doc.layout.pageCount, `${label} page ${page}`).toBe(true);
      const geometry = doc.layout.geometry(page)!;
      const box = drawingBox(r.shown!, geometry, TEXT_BOX_SIZE);
      expect(box.every(Number.isFinite), `${label} box`).toBe(true);
      expect(box[0] >= -1.5 && box[1] >= -1.5 && box[2] <= geometry.width + 1.5 && box[3] <= geometry.height + 1.5, `${label} box ${JSON.stringify(box)} inside the page`).toBe(
        true,
      );
      // What is shown is still a valid drawing.
      expect(sanitizeDrawing(structuredClone(r.shown)), label).toBeDefined();
    } else {
      expect(r.reason, label).toBeDefined();
      expect(r.shown, label).toBeUndefined();
    }
  }
  if (result.marker) {
    const m = result.marker;
    expect(m.page >= 0 && m.page < Math.max(1, doc.layout.pageCount), 'marker page').toBe(true);
    expect(Number.isFinite(m.y) && m.y >= 0 && m.y <= 1, 'marker y').toBe(true);
    if (m.status === 'orphaned') expect(m.reason, 'marker').toBeDefined();
  }
}

/** A scenario: annotations on a document, edits, and what is expected after each of them. */
export class Scenario {
  private source = '';
  private options: LayoutOptions = {};
  private readonly setup: ((world: World) => void | Promise<void>)[] = [];
  private readonly steps: Step[] = [];

  constructor(readonly name: string) {}

  doc(source: string): this {
    this.source = source;
    return this;
  }

  layout(options: LayoutOptions): this {
    this.options = options;
    return this;
  }

  highlight(id: string, exact: string, occurrence = 0): this {
    this.setup.push((w) => w.addHighlight(id, exact, occurrence));
    return this;
  }

  draw(id: string, spec: DrawSpec, prefer?: 'text' | 'image' | 'page'): this {
    this.setup.push((w) => w.addDrawing(id, spec, prefer));
    return this;
  }

  marker(_id: string, spec: { lineStartingWith: string }): this {
    this.setup.push((w) => w.placeMarker(spec.lineStartingWith));
    return this;
  }

  edit(edit: (text: string) => string, options: StepOptions = {}): this {
    this.steps.push({ kind: 'edit', edit, options });
    return this;
  }

  /** A new render of the same text with another layout (page size, line length, page numbers). */
  relayout(layout: LayoutOptions): this {
    return this.edit((t) => t, { layout });
  }

  expect(id: string, expectation: HighlightExpectation | DrawingExpectation | MarkerExpectation): this {
    this.steps.push({ kind: 'expect', id, expectation });
    return this;
  }

  check(check: (world: World) => void): this {
    this.steps.push({ kind: 'check', check });
    return this;
  }

  async run(): Promise<World> {
    const world = new World(this.source, this.options);
    for (const add of this.setup) await add(world);
    await world.resolve({}, true);
    for (const step of this.steps) {
      if (step.kind === 'edit') await world.edit(step.edit, step.options);
      else if (step.kind === 'check') step.check(world);
      else if (world.highlights.has(step.id)) world.checkHighlight(step.id, step.expectation as HighlightExpectation);
      else if (world.drawings.has(step.id)) world.checkDrawing(step.id, step.expectation as DrawingExpectation);
      else world.checkMarker(step.expectation as MarkerExpectation);
    }
    return world;
  }
}

export function scenario(name: string): Scenario {
  return new Scenario(name);
}
