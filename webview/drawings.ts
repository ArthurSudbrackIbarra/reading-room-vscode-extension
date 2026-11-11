// Drawings and text boxes in the viewer: one SVG per page whose content is in PDF units (zoom and
// resize never recompute anything), draw mode and text mode (a capture surface above every page
// layer), the eraser, typing text, selecting, moving and resizing, and hit-testing. The App
// records undo steps and talks to the host.
import { inkShades, type Ink } from '../src/shared/colors';
import {
  clampMove,
  clampToPage,
  flattenPath,
  pageGeometry,
  pageRectToPdf,
  pathBounds,
  polylineDistance,
  round2,
  shapePath,
  simplifyPoints,
  snapAngle,
  squareCorner,
  svgPathData,
  toPageSpace,
  toPdfSpace,
  tooSmall,
  transformPath,
  type PageGeometry,
  type PdfPoint,
  type Shape,
} from '../src/shared/drawingGeometry';
import {
  DEFAULT_DRAW_TOOL,
  DEFAULT_INK,
  DEFAULT_INK_WIDTH,
  DEFAULT_TEXT_STYLE,
  INK_WIDTH_PT,
  MAX_DRAWINGS,
  MAX_TEXT_LENGTH,
  MIN_TEXT_BOX_WIDTH,
  TEXT_PAD_X,
  drawingShape,
  fitStroke,
  isTextDrawing,
  normalizeText,
  type DrawTool,
  type Drawing,
  type DrawingTool,
  type InkDrawing,
  type InkWidth,
  type TextDrawing,
  type TextLayout,
  type TextStyle,
} from '../src/shared/drawings';
import type { HighlightController } from './highlights';
import type { PageLayers } from './pageLayers';
import { TextEditor, TextMeasurer, textContentElement, type BoxSize } from './textBoxes';
import type { Viewer } from './viewer';

const LAYER = 'mpv-draw-layer';
const CAPTURE = 'mpv-draw-capture';
const SVG_NS = 'http://www.w3.org/2000/svg';
/** A drag shorter than this (pixels) makes no shape. */
const MIN_DRAG_PX = 4;
/** A press that moves less than this (pixels) is a click, not a move. */
const CLICK_SLOP_PX = 3;
/** A pen stroke keeps every point within this distance (pixels) of what was drawn. */
const SIMPLIFY_PX = 0.6;
/** A pen that moves less than this (pixels) made a dot. */
const DOT_PX = 1.5;
/** How far from a stroke (pixels, beyond half its width) a click or the eraser still hits it. */
const HIT_PX = 5;
const ERASER_PX = 7;
/** Size of the resize handles of a selected text box, and how far around them a press still grabs them (pixels). */
const HANDLE_PX = 8;
const HANDLE_REACH_PX = 6;
/** A new text box keeps this far from the page's right edge (points). */
const TEXT_EDGE_MARGIN = 6;
/** A text box made by a click gets at least this much room on the page before it wraps (points). */
const TEXT_MIN_ROOM = 72;
/** Fallback page geometry (US Letter) for thumbnails of pages PDF.js has not fetched yet. */
const FALLBACK_PAGE = pageGeometry([0, 0, 612, 792]);

export type DrawingMode = 'off' | 'draw' | 'text';

export interface DrawingEvents {
  /** A shape was drawn (already shown). */
  drawn(drawing: InkDrawing): void;
  /** The eraser went over these drawings in one gesture (they are still shown). */
  erased(drawings: Drawing[]): void;
  /** A drawing or text box was dragged to a new place (already shown there). */
  moved(before: Drawing, after: Drawing): void;
  /** A text box was made wider or narrower (already shown so). */
  resized(before: TextDrawing, after: TextDrawing): void;
  /**
   * Typing in a text box ended: a new box (`before` undefined), a changed one, or one whose text
   * was all deleted (`after` undefined). Not called when nothing changed.
   */
  textCommitted(before: TextDrawing | undefined, after: TextDrawing | undefined): void;
  /** Typing in a text box started (`text`: the box as it is being edited) or ended (undefined). */
  editingChanged(text: TextDrawing | undefined): void;
  /** A double click on a text box outside text mode: the App turns text mode on and edits it there. */
  editRequested(id: string, clientX: number, clientY: number): void;
  /** The selection changed; `popover`: show the selected drawing's popover. */
  selectionChanged(id: string | undefined, popover: boolean): void;
  /** Drawings were added, removed or changed (for the list). */
  changed(): void;
  /** Something to tell the reader. */
  notice(message: string): void;
}

interface DrawGesture {
  kind: 'draw';
  pointerId: number;
  pageIndex: number;
  tool: DrawingTool;
  /** Pen: the points so far. Shapes: start and current end. */
  points: PdfPoint[];
  shift: boolean;
  client: [number, number];
}

interface EraseGesture {
  kind: 'erase';
  pointerId: number;
  pageIndex: number;
  erased: Set<string>;
  last?: PdfPoint;
  client: [number, number];
}

interface PressGesture {
  kind: 'press';
  pointerId: number;
  pageIndex: number;
  id: string;
  start: PdfPoint;
  startClient: [number, number];
  delta: [number, number];
  moving: boolean;
  /** Text mode: a click (without moving) on a text box types in it. */
  editOnClick: boolean;
  client: [number, number];
}

/** Text mode: a press on an empty part of a page (a click places a box, a drag sets its width). */
interface CreateGesture {
  kind: 'create';
  pointerId: number;
  pageIndex: number;
  /** Page space. */
  start: PdfPoint;
  end: PdfPoint;
  startClient: [number, number];
  client: [number, number];
}

/** Dragging a side of the selected text box. */
interface ResizeGesture {
  kind: 'resize';
  pointerId: number;
  pageIndex: number;
  id: string;
  side: 'left' | 'right';
  before: TextDrawing;
  draft: TextDrawing;
  startClient: [number, number];
  client: [number, number];
}

type Gesture = DrawGesture | EraseGesture | PressGesture | CreateGesture | ResizeGesture;

interface Outline {
  drawing: InkDrawing;
  lines: PdfPoint[][];
  bounds: [number, number, number, number];
  area: number;
}

interface TextEdit {
  /** The box being edited (new boxes are not in the drawings until they are committed). */
  draft: TextDrawing;
  before?: TextDrawing;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** Sets the ink of an element: the light and dark page shades (CSS picks one as --ink, see styles.css). */
export function setInk(el: HTMLElement | SVGElement, color: Ink): void {
  const shades = inkShades(color);
  el.classList.add('mpv-ink');
  el.style.setProperty('--ink-l', shades.light);
  el.style.setProperty('--ink-d', shades.dark);
}

function pointsBounds(points: PdfPoint[]): [number, number, number, number] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The point on start→end nearest to end that is still inside the page box (keeps angles and squares). */
function fitInside(start: PdfPoint, end: PdfPoint, view: [number, number, number, number]): PdfPoint {
  let t = 1;
  const [x0, y0, x1, y1] = view;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx > 0 && end[0] > x1) t = Math.min(t, (x1 - start[0]) / dx);
  if (dx < 0 && end[0] < x0) t = Math.min(t, (x0 - start[0]) / dx);
  if (dy > 0 && end[1] > y1) t = Math.min(t, (y1 - start[1]) / dy);
  if (dy < 0 && end[1] < y0) t = Math.min(t, (y0 - start[1]) / dy);
  t = Math.max(0, t);
  return [start[0] + t * dx, start[1] + t * dy];
}

function sameText(a: TextDrawing, b: TextDrawing): boolean {
  return (
    a.text === b.text &&
    a.size === b.size &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.align === b.align &&
    a.color === b.color &&
    a.boxWidth === b.boxWidth &&
    a.points[0][0] === b.points[0][0] &&
    a.points[0][1] === b.points[0][1]
  );
}

export class DrawingController {
  private readonly drawings = new Map<string, Drawing>();
  private readonly outlines = new Map<string, Outline>();
  private readonly geometries = new WeakMap<object, PageGeometry>();
  private readonly measurer = new TextMeasurer();
  private readonly editor: TextEditor;
  private modeValue: DrawingMode = 'off';
  private toolValue: DrawTool = DEFAULT_DRAW_TOOL;
  private colorValue: Ink = DEFAULT_INK;
  private widthValue: InkWidth = DEFAULT_INK_WIDTH;
  private textStyleValue: TextStyle = { ...DEFAULT_TEXT_STYLE };
  private selected?: string;
  private gesture?: Gesture;
  private edit?: TextEdit;
  private preview?: SVGPathElement;
  private previewFrame = 0;
  private eraseHover?: string;
  private flashing?: string;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private clickConsumed = false;
  /** The last click on a drawing (a second one soon after, on the same text box, edits it). */
  private lastClick?: { id: string; time: number; x: number; y: number };

  constructor(
    private readonly viewer: Viewer,
    private readonly layers: PageLayers,
    private readonly highlights: HighlightController,
    private readonly events: DrawingEvents,
  ) {
    layers.register({ className: LAYER, placement: 'top', fill: (layer, i) => this.fill(layer, i) });
    layers.register({ className: CAPTURE, placement: 'top', fill: () => undefined });
    const c = viewer.container;
    this.editor = new TextEditor(c, { input: () => this.onEditorInput(), finish: () => this.commitEditing() });
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => {
      if (e.pointerId === this.gesture?.pointerId) this.cancelGesture();
    });
    c.addEventListener('pointerleave', () => this.setEraseHover(undefined));
    // The page moves under a still pointer: the shape follows the pointer, not the page.
    c.addEventListener('scroll', () => this.followPointer(), { passive: true });
    new ResizeObserver(() => this.placeEditor()).observe(c);
    const shift = (e: KeyboardEvent) => {
      const g = this.gesture;
      if (e.key !== 'Shift' || g?.kind !== 'draw' || g.tool === 'pen') return;
      g.shift = e.type === 'keydown';
      this.schedulePreview();
    };
    window.addEventListener('keydown', shift, true);
    window.addEventListener('keyup', shift, true);
  }

  // ---------- Data ----------

  /** Replaces every drawing (initial load, a reload after a rename or Reattach). */
  setDrawings(list: Drawing[]): void {
    this.commitEditing();
    this.cancelGesture();
    this.drawings.clear();
    this.outlines.clear();
    for (const d of list) this.drawings.set(d.id, structuredClone(d));
    if (this.selected && !this.drawings.has(this.selected)) this.select(undefined);
    this.layers.redraw(LAYER);
    this.events.changed();
  }

  /** Adds a drawing or replaces it (undo and redo). */
  put(drawing: Drawing): void {
    const before = this.drawings.get(drawing.id);
    this.drawings.set(drawing.id, structuredClone(drawing));
    this.outlines.delete(drawing.id);
    if (before && before.pageIndex !== drawing.pageIndex) this.redraw(before.pageIndex);
    this.redraw(drawing.pageIndex);
    this.events.changed();
  }

  remove(id: string): void {
    const drawing = this.drawings.get(id);
    if (!drawing) return;
    this.drawings.delete(id);
    this.outlines.delete(id);
    if (this.eraseHover === id) this.eraseHover = undefined;
    if (this.selected === id) this.select(undefined);
    this.redraw(drawing.pageIndex);
    this.events.changed();
  }

  get(id: string): Drawing | undefined {
    const drawing = this.drawings.get(id);
    return drawing ? structuredClone(drawing) : undefined;
  }

  get all(): Drawing[] {
    return [...this.drawings.values()].map((d) => structuredClone(d));
  }

  get count(): number {
    return this.drawings.size;
  }

  /** Drawings and text boxes in reading order: by page, then from the top of the page. */
  list(): Drawing[] {
    const top = (d: Drawing) => {
      const g = this.geometry(d.pageIndex) ?? FALLBACK_PAGE;
      return Math.min(...d.points.map((p) => toPageSpace(g, p)[1]));
    };
    return [...this.drawings.values()]
      .map((d) => ({ d, top: top(d) }))
      .sort((a, b) => a.d.pageIndex - b.d.pageIndex || a.top - b.top || a.d.createdAt.localeCompare(b.d.createdAt))
      .map(({ d }) => d);
  }

  /** Drawings and text boxes for a download: those on pages the PDF has, and how the text boxes are laid out. */
  exportData(): { drawings: Drawing[]; textLayouts: TextLayout[]; skipped: number } {
    this.commitEditing();
    const pages = this.viewer.pagesCount;
    const all = [...this.drawings.values()];
    const drawings = all.filter((d) => d.pageIndex < pages).map((d) => structuredClone(d));
    const textLayouts = drawings.filter(isTextDrawing).map((d) => this.measurer.layout(d));
    return { drawings, textLayouts, skipped: all.length - drawings.length };
  }

  /** A new PDF was loaded: drawings stay at their page coordinates (those on missing pages are not shown). */
  documentLoaded(): void {
    this.commitEditing();
    this.cancelGesture();
    this.layers.redraw(LAYER);
    this.events.changed();
  }

  // ---------- Modes and styles ----------

  get mode(): DrawingMode {
    return this.modeValue;
  }

  /** Draw mode is on. */
  get active(): boolean {
    return this.modeValue === 'draw';
  }

  /** Text mode is on. */
  get textActive(): boolean {
    return this.modeValue === 'text';
  }

  /** A gesture (drawing, erasing, pressing, moving or resizing) is in progress. */
  get busy(): boolean {
    return this.gesture !== undefined;
  }

  setMode(mode: DrawingMode): void {
    if (mode === this.modeValue) return;
    this.commitEditing();
    this.cancelGesture();
    this.modeValue = mode;
    this.setEraseHover(undefined);
    // A mode starts, and ends, with nothing selected (typing leaves its box selected while in text mode).
    this.select(undefined);
    document.body.classList.toggle('mpv-draw-mode', mode === 'draw');
    document.body.classList.toggle('mpv-text-mode', mode === 'text');
    document.body.dataset.drawTool = this.toolValue;
  }

  get tool(): DrawTool {
    return this.toolValue;
  }

  get color(): Ink {
    return this.colorValue;
  }

  get width(): InkWidth {
    return this.widthValue;
  }

  setTool(tool: DrawTool): void {
    this.toolValue = tool;
    document.body.dataset.drawTool = tool;
    if (tool !== 'eraser') this.setEraseHover(undefined);
  }

  setColor(color: Ink): void {
    this.colorValue = color;
  }

  setWidth(width: InkWidth): void {
    this.widthValue = width;
  }

  /** The style new text boxes get. */
  get textStyle(): TextStyle {
    return { ...this.textStyleValue };
  }

  setTextStyle(style: TextStyle): void {
    this.textStyleValue = { ...style };
  }

  // ---------- Selection ----------

  get selectedId(): string | undefined {
    return this.selected;
  }

  select(id: string | undefined, popover = true): void {
    const before = this.selected;
    this.selected = id && this.drawings.has(id) ? id : undefined;
    if (before !== this.selected) {
      const pages = new Set([before, this.selected].map((x) => (x ? this.drawings.get(x)?.pageIndex : undefined)));
      for (const page of pages) if (page !== undefined) this.redraw(page);
    }
    this.events.selectionChanged(this.selected, popover && this.selected !== undefined);
  }

  /** True once after a press on a drawing ended: the click that follows is ours. */
  consumeClick(): boolean {
    const consumed = this.clickConsumed;
    this.clickConsumed = false;
    return consumed;
  }

  /** Screen rectangle of a drawing (with its stroke) or text box, if its page is shown. */
  clientRectOf(id: string): { left: number; top: number; right: number; bottom: number } | undefined {
    const drawing = this.drawings.get(id);
    if (!drawing) return undefined;
    const g = this.geometry(drawing.pageIndex);
    const box = this.pageBox(drawing.pageIndex);
    if (!g || !box) return undefined;
    const [x0, y0, x1, y1] = this.pageRectOf(drawing, g);
    const sx = box.width / g.width;
    const sy = box.height / g.height;
    return { left: box.left + x0 * sx, top: box.top + y0 * sy, right: box.left + x1 * sx, bottom: box.top + y1 * sy };
  }

  /** Scrolls to a drawing and flashes it. False if its page is not in the document. */
  reveal(id: string): boolean {
    const drawing = this.drawings.get(id);
    if (!drawing || drawing.pageIndex >= this.viewer.pagesCount) return false;
    const g = this.geometry(drawing.pageIndex);
    const view = this.viewer.pageView(drawing.pageIndex);
    if (g && view?.div) {
      const [x0, y0] = this.pageRectOf(drawing, g);
      const top = y0 / g.height;
      const left = x0 / g.width;
      this.viewer.scrollToFraction(drawing.pageIndex, Math.max(0, top - 0.02), 0.3);
      const container = this.viewer.container;
      const x = view.div.offsetLeft + left * view.div.offsetWidth;
      if (x < container.scrollLeft || x > container.scrollLeft + container.clientWidth - 40) container.scrollLeft = Math.max(0, x - 40);
    } else {
      this.viewer.goToPage(drawing.pageIndex + 1);
    }
    setTimeout(() => this.flash(id), 80);
    return true;
  }

  /** Whether any part of the drawing is inside the visible area. */
  isVisible(id: string): boolean {
    const r = this.clientRectOf(id);
    if (!r) return false;
    const box = this.viewer.container.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
  }

  flash(id: string): void {
    const drawing = this.drawings.get(id);
    if (!drawing) return;
    const previous = this.flashing ? this.drawings.get(this.flashing) : undefined;
    clearTimeout(this.flashTimer);
    this.flashing = id;
    if (previous && previous.pageIndex !== drawing.pageIndex) this.redraw(previous.pageIndex);
    this.redraw(drawing.pageIndex);
    this.flashTimer = setTimeout(() => {
      this.flashing = undefined;
      this.redraw(drawing.pageIndex);
    }, 1600);
  }

  // ---------- Page geometry ----------

  /**
   * The page at scale 1 as PDF.js shows it: PDF.js's own viewport (its transform turns PDF units
   * into page space for any /Rotate and crop box), or the same computation if the proxy lacks it.
   */
  private geometry(pageIndex: number): PageGeometry | undefined {
    const page = this.viewer.pageView(pageIndex)?.pdfPage;
    if (!page?.view) return undefined;
    let g = this.geometries.get(page);
    if (!g) {
      const fallback = pageGeometry(page.view, page.rotate ?? 0, page.userUnit ?? 1);
      const viewport = page.getViewport?.({ scale: 1 });
      g =
        viewport && viewport.transform.length === 6
          ? { view: fallback.view, width: viewport.width, height: viewport.height, transform: [...viewport.transform] as PageGeometry['transform'] }
          : fallback;
      this.geometries.set(page, g);
    }
    return g;
  }

  private pageBox(pageIndex: number): DOMRect | undefined {
    const div = this.viewer.pageView(pageIndex)?.div;
    if (!div?.isConnected) return undefined;
    const box = div.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? box : undefined;
  }

  /** Client coordinates → PDF units on a page, clamped to the page unless `clamp` is false. */
  private toPdf(pageIndex: number, clientX: number, clientY: number, clamp = true): PdfPoint | undefined {
    const p = this.toPage(pageIndex, clientX, clientY);
    const g = this.geometry(pageIndex);
    if (!p || !g) return undefined;
    const pdf = toPdfSpace(g, p);
    return clamp ? clampToPage(g, pdf) : pdf;
  }

  /** Client coordinates → page space (points from the page's top left corner as shown). */
  private toPage(pageIndex: number, clientX: number, clientY: number): PdfPoint | undefined {
    const g = this.geometry(pageIndex);
    const box = this.pageBox(pageIndex);
    if (!g || !box) return undefined;
    return [((clientX - box.left) / box.width) * g.width, ((clientY - box.top) / box.height) * g.height];
  }

  /** Screen pixels per PDF unit on a page. */
  private pxPerUnit(pageIndex: number): number {
    const g = this.geometry(pageIndex);
    const box = this.pageBox(pageIndex);
    if (!g || !box) return 1;
    return (box.width / g.width) * Math.hypot(g.transform[0], g.transform[1]);
  }

  /** Screen pixels per point of page space. */
  private pxPerPagePoint(pageIndex: number): number {
    const g = this.geometry(pageIndex);
    const box = this.pageBox(pageIndex);
    return g && box ? box.width / g.width : 1;
  }

  /** A text box's size on the page (points), as it is shown now. */
  private textSize(text: TextDrawing): BoxSize {
    return this.measurer.size(text);
  }

  /** The page-space rectangle of a drawing (its stroke included) or text box. */
  private pageRectOf(drawing: Drawing, g: PageGeometry): [number, number, number, number] {
    if (isTextDrawing(drawing)) {
      const { width, height } = this.textSize(drawing);
      const [x, y] = toPageSpace(g, drawing.points[0]);
      return [x, y, x + width, y + height];
    }
    const [x0, y0, x1, y1] = pathBounds(shapePath(drawingShape(drawing)));
    const half = INK_WIDTH_PT[drawing.width] / 2;
    const corners = [
      [x0 - half, y0 - half],
      [x1 + half, y0 - half],
      [x0 - half, y1 + half],
      [x1 + half, y1 + half],
    ].map((p) => toPageSpace(g, p as PdfPoint));
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /** What has to stay inside the page when a drawing or text box moves (PDF units). */
  private moveBounds(drawing: Drawing, g: PageGeometry): [number, number, number, number] {
    if (!isTextDrawing(drawing)) return pointsBounds(drawing.points);
    return pageRectToPdf(g, this.pageRectOf(drawing, g));
  }

  /** A move in PDF units, as a move on the page as shown. */
  private pageDelta(g: PageGeometry, [dx, dy]: [number, number]): [number, number] {
    const [a, b, c, d] = g.transform;
    return [a * dx + c * dy, b * dx + d * dy];
  }

  // ---------- Rendering ----------

  private redraw(pageIndex: number): void {
    this.layers.redraw(LAYER, pageIndex);
  }

  private fill(layer: HTMLElement, pageIndex: number): void {
    layer.replaceChildren();
    const g = this.geometry(pageIndex);
    if (!g) return;
    const svg = svgEl('svg', { class: 'mpv-draw-svg', viewBox: `0 0 ${g.width} ${g.height}`, preserveAspectRatio: 'none' });
    const root = svgEl('g', { transform: `matrix(${g.transform.join(' ')})` });
    // Text boxes run left to right on the page as shown, so they live in page space, above the ink.
    const texts = svgEl('g', { class: 'mpv-text-boxes' });
    svg.append(root, texts);
    const gesture = this.gesture;
    for (const drawing of this.drawings.values()) {
      if (drawing.pageIndex !== pageIndex) continue;
      if (isTextDrawing(drawing)) {
        texts.append(this.textElement(drawing, g));
        continue;
      }
      const el = this.drawingElement(drawing);
      if (gesture?.kind === 'press' && gesture.moving && gesture.id === drawing.id) el.setAttribute('transform', `translate(${gesture.delta[0]} ${gesture.delta[1]})`);
      root.append(el);
    }
    const selected = this.selected ? this.drawings.get(this.selected) : undefined;
    if (selected?.pageIndex === pageIndex && this.edit?.draft.id !== selected.id) {
      if (isTextDrawing(selected)) texts.append(this.textSelectionElement(selected, g, pageIndex));
      else root.append(this.selectionElement(selected));
    }
    if (gesture?.kind === 'draw' && gesture.pageIndex === pageIndex) root.append(this.previewElement(gesture));
    if (gesture?.kind === 'create' && gesture.pageIndex === pageIndex) texts.append(this.createPreview(gesture));
    layer.append(svg);
  }

  private drawingElement(drawing: InkDrawing): SVGGElement {
    const group = svgEl('g', { class: 'mpv-drawing', 'data-id': drawing.id, 'data-tool': drawing.tool });
    setInk(group, drawing.color);
    if (this.flashing === drawing.id) group.classList.add('mpv-flash');
    if (this.selected === drawing.id) group.classList.add('mpv-selected');
    if (this.eraseHover === drawing.id || (this.gesture?.kind === 'erase' && this.gesture.erased.has(drawing.id))) group.classList.add('mpv-erasing');
    const d = svgPathData(shapePath(drawingShape(drawing)));
    const width = INK_WIDTH_PT[drawing.width];
    group.append(
      svgEl('path', { class: 'mpv-drawing-halo', d, 'stroke-width': String(width + 3) }),
      svgEl('path', { class: 'mpv-drawing-ink', d, 'stroke-width': String(width) }),
      svgEl('path', { class: 'mpv-drawing-hit', d }),
    );
    return group;
  }

  /** The text box as shown now: while it is resized, its draft. */
  private shownText(text: TextDrawing): TextDrawing {
    const g = this.gesture;
    return g?.kind === 'resize' && g.id === text.id ? g.draft : text;
  }

  /** Where a text box's top left corner is on the page, with a move in progress applied. */
  private textOrigin(text: TextDrawing, g: PageGeometry): PdfPoint {
    const [x, y] = toPageSpace(g, text.points[0]);
    const gesture = this.gesture;
    if (gesture?.kind === 'press' && gesture.moving && gesture.id === text.id) {
      const [dx, dy] = this.pageDelta(g, gesture.delta);
      return [x + dx, y + dy];
    }
    return [x, y];
  }

  private textElement(stored: TextDrawing, g: PageGeometry): SVGGElement {
    const text = this.shownText(stored);
    const { width, height } = this.textSize(text);
    const [x, y] = this.textOrigin(text, g);
    const group = svgEl('g', { class: 'mpv-drawing mpv-textbox', 'data-id': text.id, 'data-tool': 'text', transform: `translate(${x} ${y})` });
    if (this.flashing === text.id) group.classList.add('mpv-flash');
    if (this.selected === text.id) group.classList.add('mpv-selected');
    if (this.edit?.draft.id === text.id) group.classList.add('mpv-editing');
    const object = svgEl('foreignObject', { x: '0', y: '0', width: String(width + 1), height: String(height + 1) });
    object.append(textContentElement(text));
    group.append(svgEl('rect', { class: 'mpv-text-hit', x: '0', y: '0', width: String(width), height: String(height) }), object);
    return group;
  }

  /** The dashed outline around the selected drawing. */
  private selectionElement(drawing: InkDrawing): SVGRectElement {
    const [x0, y0, x1, y1] = pathBounds(shapePath(drawingShape(drawing)));
    const pad = INK_WIDTH_PT[drawing.width] / 2 + 3;
    const rect = svgEl('rect', {
      class: 'mpv-drawing-selection',
      x: String(x0 - pad),
      y: String(y0 - pad),
      width: String(x1 - x0 + 2 * pad),
      height: String(y1 - y0 + 2 * pad),
    });
    const g = this.gesture;
    if (g?.kind === 'press' && g.moving && g.id === drawing.id) rect.setAttribute('transform', `translate(${g.delta[0]} ${g.delta[1]})`);
    return rect;
  }

  /** The dashed outline around the selected text box, with a handle on each side to change its width. */
  private textSelectionElement(stored: TextDrawing, g: PageGeometry, pageIndex: number): SVGGElement {
    const text = this.shownText(stored);
    const { width, height } = this.textSize(text);
    const [x, y] = this.textOrigin(text, g);
    const group = svgEl('g', { class: 'mpv-text-selection', transform: `translate(${x} ${y})` });
    group.append(svgEl('rect', { class: 'mpv-drawing-selection', x: '0', y: '0', width: String(width), height: String(height) }));
    const size = HANDLE_PX / this.pxPerPagePoint(pageIndex);
    for (const side of ['left', 'right'] as const) {
      const cx = side === 'left' ? 0 : width;
      group.append(
        svgEl('rect', {
          class: 'mpv-text-handle',
          'data-side': side,
          'data-id': text.id,
          x: String(cx - size / 2),
          y: String(height / 2 - size / 2),
          width: String(size),
          height: String(size),
          rx: String(size / 5),
        }),
      );
    }
    return group;
  }

  /** While dragging out a new text box: its width, as a dashed box one line high. */
  private createPreview(g: CreateGesture): SVGRectElement {
    const x0 = Math.min(g.start[0], g.end[0]);
    const x1 = Math.max(g.start[0], g.end[0]);
    const lineHeight = this.measurer.measure({ ...this.textStyleValue, text: '', boxWidth: undefined }).height;
    return svgEl('rect', { class: 'mpv-drawing-selection mpv-text-new', x: String(x0), y: String(g.start[1]), width: String(x1 - x0), height: String(lineHeight) });
  }

  private previewElement(gesture: DrawGesture): SVGGElement {
    const group = svgEl('g', { class: 'mpv-drawing mpv-drawing-preview' });
    setInk(group, this.colorValue);
    this.preview = svgEl('path', { class: 'mpv-drawing-ink' });
    this.updatePreviewPath(gesture);
    group.append(this.preview);
    return group;
  }

  private updatePreviewPath(gesture: DrawGesture): void {
    if (!this.preview) return;
    const shape = this.shapeOf(gesture);
    this.preview.setAttribute('d', svgPathData(shapePath(shape)));
    this.preview.setAttribute('stroke-width', String(shape.widthPt));
  }

  private schedulePreview(): void {
    if (this.previewFrame) return;
    this.previewFrame = requestAnimationFrame(() => {
      this.previewFrame = 0;
      const g = this.gesture;
      if (g?.kind !== 'draw') return;
      if (this.preview?.isConnected) this.updatePreviewPath(g);
      else this.redraw(g.pageIndex);
    });
  }

  /** A small picture of a drawing for the list: its own path, scaled to fit, as it looks on the page. */
  thumbnail(drawing: InkDrawing): SVGSVGElement {
    const g = this.geometry(drawing.pageIndex) ?? FALLBACK_PAGE;
    const path = transformPath(shapePath(drawingShape(drawing)), g.transform);
    const [x0, y0, x1, y1] = pathBounds(path);
    const size = Math.max(x1 - x0, y1 - y0, 6);
    const pad = size * 0.12;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const half = size / 2 + pad;
    const svg = svgEl('svg', {
      class: 'mpv-thumb-svg',
      viewBox: `${cx - half} ${cy - half} ${2 * half} ${2 * half}`,
      width: '22',
      height: '22',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    const group = svgEl('g', { 'data-width': drawing.width });
    setInk(group, drawing.color);
    group.append(svgEl('path', { class: 'mpv-thumb-ink', d: svgPathData(path, 1) }));
    svg.append(group);
    return svg;
  }

  // ---------- Pointer ----------

  private capture(pointerId: number): void {
    try {
      this.viewer.container.setPointerCapture(pointerId);
    } catch {
      // The pointer is already gone.
    }
  }

  private release(pointerId: number): void {
    try {
      if (this.viewer.container.hasPointerCapture(pointerId)) this.viewer.container.releasePointerCapture(pointerId);
    } catch {
      // Already released.
    }
  }

  /** The page under a press in draw or text mode (normally the capture surface; a page PDF.js is still rendering has none yet). */
  private pageUnder(target: Element | null): number | undefined {
    const pageDiv = target?.closest?.<HTMLElement>('.page');
    if (!pageDiv || !this.viewer.container.contains(pageDiv)) return undefined;
    const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
    return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : undefined;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.gesture) return;
    const target = e.target as Element | null;
    if (target === this.editor.textarea) return;
    const client: [number, number] = [e.clientX, e.clientY];
    if (this.modeValue === 'draw') {
      const pageIndex = this.pageUnder(target);
      const p = pageIndex === undefined ? undefined : this.toPdf(pageIndex, e.clientX, e.clientY);
      if (pageIndex === undefined || !p) return;
      e.preventDefault();
      this.viewer.container.focus({ preventScroll: true });
      if (this.toolValue === 'eraser') {
        const gesture: EraseGesture = { kind: 'erase', pointerId: e.pointerId, pageIndex, erased: new Set(), client };
        this.gesture = gesture;
        this.setEraseHover(undefined);
        this.eraseTo(gesture, e.clientX, e.clientY);
      } else {
        if (this.drawings.size >= MAX_DRAWINGS) {
          this.events.notice(`This file has ${MAX_DRAWINGS} drawings and text boxes, the most it can have. Delete some to draw more.`);
          return;
        }
        const tool = this.toolValue;
        this.gesture = { kind: 'draw', pointerId: e.pointerId, pageIndex, tool, points: tool === 'pen' ? [p] : [p, p], shift: e.shiftKey, client };
        this.redraw(pageIndex);
      }
      this.capture(e.pointerId);
      return;
    }
    if (this.modeValue === 'text') {
      this.textPointerDown(e, target, client);
      return;
    }
    // Neither drawing nor typing: a press on a drawing or text box selects it, and dragging moves it within its page.
    if (document.body.classList.contains('mpv-placing-marker')) return;
    const handle = target?.closest?.('.mpv-text-handle') as SVGElement | null;
    if (handle?.dataset.id && this.startResize(e, handle.dataset.id, handle.dataset.side === 'left' ? 'left' : 'right')) return;
    const hitId = (target?.closest?.('.mpv-drawing') as SVGElement | null)?.dataset.id;
    if (!hitId) {
      if (this.selected) this.select(undefined);
      return;
    }
    this.startPress(e, this.pick(e.clientX, e.clientY) ?? hitId, false);
  }

  /** Text mode: a press edits or moves a text box, grabs a handle, or starts a new box. */
  private textPointerDown(e: PointerEvent, target: Element | null, client: [number, number]): void {
    const pageIndex = this.pageUnder(target);
    const wasEditing = this.edit !== undefined;
    if (pageIndex === undefined) {
      this.commitEditing();
      return;
    }
    const page = this.toPage(pageIndex, e.clientX, e.clientY);
    if (!page) return;
    e.preventDefault();
    // Ends typing in another box (a click on empty page only does that).
    this.commitEditing();
    this.viewer.container.focus({ preventScroll: true });
    const handle = this.handleAt(pageIndex, e.clientX, e.clientY);
    if (handle && this.startResize(e, handle.id, handle.side)) return;
    const hit = this.textAt(pageIndex, page);
    if (hit) {
      this.startPress(e, hit, true);
      return;
    }
    if (this.selected) this.select(undefined);
    if (wasEditing) return;
    if (this.drawings.size >= MAX_DRAWINGS) {
      this.events.notice(`This file has ${MAX_DRAWINGS} drawings and text boxes, the most it can have. Delete some to add more.`);
      return;
    }
    this.gesture = { kind: 'create', pointerId: e.pointerId, pageIndex, start: page, end: page, startClient: client, client };
    this.capture(e.pointerId);
  }

  private startPress(e: PointerEvent, id: string, editOnClick: boolean): void {
    const drawing = this.drawings.get(id);
    const start = drawing ? this.toPdf(drawing.pageIndex, e.clientX, e.clientY, false) : undefined;
    if (!drawing || !start) return;
    e.preventDefault();
    this.viewer.container.focus({ preventScroll: true });
    this.gesture = {
      kind: 'press',
      pointerId: e.pointerId,
      pageIndex: drawing.pageIndex,
      id,
      start,
      startClient: [e.clientX, e.clientY],
      delta: [0, 0],
      moving: false,
      editOnClick,
      client: [e.clientX, e.clientY],
    };
    this.capture(e.pointerId);
  }

  private startResize(e: PointerEvent, id: string, side: 'left' | 'right'): boolean {
    const text = this.drawings.get(id);
    if (!text || !isTextDrawing(text)) return false;
    e.preventDefault();
    this.viewer.container.focus({ preventScroll: true });
    const g = this.geometry(text.pageIndex);
    if (!g) return false;
    const width = this.textSize(text).width;
    this.gesture = {
      kind: 'resize',
      pointerId: e.pointerId,
      pageIndex: text.pageIndex,
      id,
      side,
      before: text,
      draft: { ...text, boxWidth: round2(width) },
      startClient: [e.clientX, e.clientY],
      client: [e.clientX, e.clientY],
    };
    this.capture(e.pointerId);
    return true;
  }

  private onPointerMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g) {
      if (this.modeValue === 'draw' && this.toolValue === 'eraser' && e.buttons === 0) this.hoverEraser(e.clientX, e.clientY);
      if (this.modeValue === 'text' && e.buttons === 0) this.hoverText(e);
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    g.client = [e.clientX, e.clientY];
    if (g.kind === 'draw') {
      if (g.tool !== 'pen') g.shift = e.shiftKey;
      const samples = g.tool === 'pen' && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const sample of samples.length > 0 ? samples : [e]) this.extend(g, sample.clientX, sample.clientY);
      this.schedulePreview();
    } else {
      this.continueGesture(g, e.clientX, e.clientY);
    }
  }

  private continueGesture(g: Exclude<Gesture, DrawGesture>, x: number, y: number): void {
    if (g.kind === 'erase') this.eraseTo(g, x, y);
    else if (g.kind === 'press') this.pressMove(g, x, y);
    else if (g.kind === 'create') this.createMove(g, x, y);
    else this.resizeMove(g, x, y);
  }

  /** After a scroll, a gesture continues at the pointer's (unchanged) screen position. */
  private followPointer(): void {
    const g = this.gesture;
    if (!g) return;
    const [x, y] = g.client;
    if (g.kind === 'draw') {
      this.extend(g, x, y);
      this.schedulePreview();
    } else {
      this.continueGesture(g, x, y);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.release(g.pointerId);
    this.gesture = undefined;
    if (g.kind === 'draw') {
      if (g.tool !== 'pen') g.shift = e.shiftKey;
      this.finishDrawing(g);
    } else if (g.kind === 'erase') {
      this.finishErasing(g);
    } else if (g.kind === 'press') {
      this.finishPress(g, e.clientX, e.clientY);
    } else if (g.kind === 'create') {
      this.finishCreate(g);
    } else {
      this.finishResize(g);
    }
  }

  /** Esc, a lost pointer, a new document: drops the gesture in progress. True if there was one. */
  cancelGesture(): boolean {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = undefined;
    this.release(g.pointerId);
    this.preview = undefined;
    this.redraw(g.pageIndex);
    return true;
  }

  // ---------- Drawing ----------

  private extend(g: DrawGesture, clientX: number, clientY: number): void {
    const p = this.toPdf(g.pageIndex, clientX, clientY);
    if (!p) return;
    if (g.tool !== 'pen') {
      g.points[1] = p;
      return;
    }
    const last = g.points[g.points.length - 1];
    // Sub-pixel jitter adds points without adding shape.
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.pxPerUnit(g.pageIndex) >= 0.75) g.points.push(p);
  }

  /** The shape a gesture makes now, with Shift applied (kept inside the page). */
  private shapeOf(g: DrawGesture): Shape {
    const widthPt = INK_WIDTH_PT[this.widthValue];
    if (g.tool === 'pen') return { tool: 'pen', points: g.points, widthPt };
    const [start, rawEnd] = g.points;
    let end = rawEnd;
    if (g.shift) {
      end = g.tool === 'line' || g.tool === 'arrow' ? snapAngle(start, rawEnd) : squareCorner(start, rawEnd);
      const geometry = this.geometry(g.pageIndex);
      if (geometry) end = fitInside(start, end, geometry.view);
    }
    return { tool: g.tool, points: [start, end], widthPt };
  }

  private finishDrawing(g: DrawGesture): void {
    this.preview = undefined;
    const px = this.pxPerUnit(g.pageIndex);
    let points: PdfPoint[];
    if (g.tool === 'pen') {
      const first = g.points[0];
      // A click without moving leaves a dot.
      const dot = g.points.every((p) => Math.hypot(p[0] - first[0], p[1] - first[1]) * px < DOT_PX);
      if (dot) {
        points = [first];
      } else {
        const fitted = fitStroke(simplifyPoints(g.points, SIMPLIFY_PX / px), SIMPLIFY_PX / px);
        if (fitted.simplified) this.events.notice('That stroke was very long, so it was simplified to fit.');
        points = fitted.points;
      }
    } else {
      const shape = this.shapeOf(g);
      if (tooSmall(shape.points[0], shape.points[1], MIN_DRAG_PX / px)) {
        this.redraw(g.pageIndex);
        return;
      }
      points = shape.points;
      if (g.tool === 'rect' || g.tool === 'ellipse') {
        const [x0, y0, x1, y1] = pointsBounds(points);
        points = [
          [x0, y0],
          [x1, y1],
        ];
      }
    }
    points = points.map(([x, y]): PdfPoint => [round2(x), round2(y)]).filter((p, i, all) => i === 0 || g.tool !== 'pen' || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    const now = new Date().toISOString();
    const drawing: InkDrawing = {
      id: crypto.randomUUID(),
      tool: g.tool,
      color: this.colorValue,
      width: this.widthValue,
      pageIndex: g.pageIndex,
      points,
      createdAt: now,
      updatedAt: now,
    };
    const hash = this.highlights.textModel?.hash;
    if (hash) drawing.textModelHash = hash;
    this.drawings.set(drawing.id, drawing);
    this.redraw(g.pageIndex);
    this.events.drawn(structuredClone(drawing));
    this.events.changed();
  }

  // ---------- Erasing ----------

  private outline(drawing: InkDrawing): Outline {
    const cached = this.outlines.get(drawing.id);
    if (cached?.drawing === drawing) return cached;
    const path = shapePath(drawingShape(drawing));
    const bounds = pathBounds(path);
    const outline: Outline = { drawing, lines: flattenPath(path), bounds, area: Math.max(1, (bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) };
    this.outlines.set(drawing.id, outline);
    return outline;
  }

  /**
   * Drawings on a page within `radiusPx` (plus half their stroke) of a point, and text boxes the
   * point is in (unless `inkOnly`), smallest first.
   */
  private hitsAt(pageIndex: number, p: PdfPoint, radiusPx: number, inkOnly = false): string[] {
    const px = this.pxPerUnit(pageIndex);
    const g = this.geometry(pageIndex);
    const hits: { id: string; area: number }[] = [];
    for (const drawing of this.drawings.values()) {
      if (drawing.pageIndex !== pageIndex) continue;
      if (isTextDrawing(drawing)) {
        if (inkOnly || !g || this.edit?.draft.id === drawing.id) continue;
        const [x0, y0, x1, y1] = this.pageRectOf(drawing, g);
        const [x, y] = toPageSpace(g, p);
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) hits.push({ id: drawing.id, area: Math.max(1, (x1 - x0) * (y1 - y0)) });
        continue;
      }
      const outline = this.outline(drawing);
      const reach = radiusPx / px + INK_WIDTH_PT[drawing.width] / 2;
      const [x0, y0, x1, y1] = outline.bounds;
      if (p[0] < x0 - reach || p[0] > x1 + reach || p[1] < y0 - reach || p[1] > y1 + reach) continue;
      if (polylineDistance(p, outline.lines) <= reach) hits.push({ id: drawing.id, area: outline.area });
    }
    return hits.sort((a, b) => a.area - b.area).map((h) => h.id);
  }

  /** The drawing or text box under a point (client coordinates); where they overlap, the smallest. */
  pick(clientX: number, clientY: number): string | undefined {
    const pageIndex = this.viewer.pageIndexAt(clientX, clientY);
    if (pageIndex === undefined) return undefined;
    const p = this.toPdf(pageIndex, clientX, clientY, false);
    return p ? this.hitsAt(pageIndex, p, HIT_PX)[0] : undefined;
  }

  /** The text box at a page-space point (the smallest, where boxes overlap). */
  private textAt(pageIndex: number, page: PdfPoint): string | undefined {
    const g = this.geometry(pageIndex);
    if (!g) return undefined;
    let best: { id: string; area: number } | undefined;
    for (const drawing of this.drawings.values()) {
      if (drawing.pageIndex !== pageIndex || !isTextDrawing(drawing)) continue;
      const [x0, y0, x1, y1] = this.pageRectOf(drawing, g);
      if (page[0] < x0 || page[0] > x1 || page[1] < y0 || page[1] > y1) continue;
      const area = (x1 - x0) * (y1 - y0);
      if (!best || area < best.area) best = { id: drawing.id, area };
    }
    return best?.id;
  }

  /** The resize handle of the selected text box under a point, if any. */
  private handleAt(pageIndex: number, clientX: number, clientY: number): { id: string; side: 'left' | 'right' } | undefined {
    const selected = this.selected ? this.drawings.get(this.selected) : undefined;
    const g = this.geometry(pageIndex);
    const page = this.toPage(pageIndex, clientX, clientY);
    if (!selected || !isTextDrawing(selected) || selected.pageIndex !== pageIndex || !g || !page) return undefined;
    const [x0, y0, x1, y1] = this.pageRectOf(selected, g);
    const reach = (HANDLE_PX / 2 + HANDLE_REACH_PX) / this.pxPerPagePoint(pageIndex);
    const midY = (y0 + y1) / 2;
    if (Math.abs(page[1] - midY) > reach) return undefined;
    if (Math.abs(page[0] - x0) <= reach) return { id: selected.id, side: 'left' };
    if (Math.abs(page[0] - x1) <= reach) return { id: selected.id, side: 'right' };
    return undefined;
  }

  private eraseTo(g: EraseGesture, clientX: number, clientY: number): void {
    const p = this.toPdf(g.pageIndex, clientX, clientY, false);
    if (!p) return;
    const from = g.last ?? p;
    g.last = p;
    // Test along the way from the last position, so a fast drag cannot jump over a stroke.
    const step = Math.max(0.5, ERASER_PX / this.pxPerUnit(g.pageIndex) / 2);
    const steps = Math.min(200, Math.ceil(Math.hypot(p[0] - from[0], p[1] - from[1]) / step));
    let added = false;
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 1 : i / steps;
      const at: PdfPoint = [from[0] + t * (p[0] - from[0]), from[1] + t * (p[1] - from[1])];
      for (const id of this.hitsAt(g.pageIndex, at, ERASER_PX, true)) {
        if (g.erased.has(id)) continue;
        g.erased.add(id);
        added = true;
      }
    }
    if (added) this.redraw(g.pageIndex);
  }

  private finishErasing(g: EraseGesture): void {
    const erased = [...g.erased].map((id) => this.drawings.get(id)).filter((d): d is Drawing => d !== undefined);
    this.redraw(g.pageIndex);
    if (erased.length > 0) this.events.erased(erased.map((d) => structuredClone(d)));
  }

  /** With the eraser, the drawing under the pointer dims before a click deletes it. */
  private hoverEraser(clientX: number, clientY: number): void {
    const target = document.elementFromPoint(clientX, clientY);
    const pageIndex = target?.classList.contains(CAPTURE) ? Number(target.closest<HTMLElement>('.page')?.dataset.pageNumber) - 1 : -1;
    const p = pageIndex >= 0 ? this.toPdf(pageIndex, clientX, clientY, false) : undefined;
    this.setEraseHover(p ? this.hitsAt(pageIndex, p, ERASER_PX, true)[0] : undefined);
  }

  private setEraseHover(id: string | undefined): void {
    if (id === this.eraseHover) return;
    const pages = new Set([this.eraseHover, id].map((x) => (x ? this.drawings.get(x)?.pageIndex : undefined)));
    this.eraseHover = id;
    for (const page of pages) if (page !== undefined) this.redraw(page);
  }

  /** Text mode: the pointer says what a press would do (resize, type in a box, or start one). */
  private hoverText(e: PointerEvent): void {
    const capture = (e.target as Element | null)?.closest?.(`.${CAPTURE}`) as HTMLElement | null;
    if (!capture) return;
    const pageIndex = this.pageUnder(capture);
    const page = pageIndex === undefined ? undefined : this.toPage(pageIndex, e.clientX, e.clientY);
    let cursor = '';
    if (pageIndex !== undefined && page) {
      if (this.handleAt(pageIndex, e.clientX, e.clientY)) cursor = 'ew-resize';
      else if (this.textAt(pageIndex, page)) cursor = 'text';
    }
    capture.style.cursor = cursor;
  }

  // ---------- Selecting and moving ----------

  private pressMove(g: PressGesture, clientX: number, clientY: number): void {
    const drawing = this.drawings.get(g.id);
    const geometry = this.geometry(g.pageIndex);
    if (!drawing || !geometry) return;
    if (!g.moving) {
      if (Math.hypot(clientX - g.startClient[0], clientY - g.startClient[1]) < CLICK_SLOP_PX) return;
      g.moving = true;
      // Selected while it moves (the dashed outline), without its popover.
      if (this.selected !== g.id) this.select(g.id, false);
      else this.events.selectionChanged(g.id, false);
    }
    const p = this.toPdf(g.pageIndex, clientX, clientY, false);
    if (!p) return;
    g.delta = clampMove(this.moveBounds(drawing, geometry), geometry.view, p[0] - g.start[0], p[1] - g.start[1]);
    if (isTextDrawing(drawing)) {
      this.redraw(g.pageIndex);
      return;
    }
    const transform = `translate(${g.delta[0]} ${g.delta[1]})`;
    const layer = this.viewer.pageView(g.pageIndex)?.div.querySelector(`:scope > .${LAYER}`);
    const group = layer?.querySelector(`.mpv-drawing[data-id="${CSS.escape(g.id)}"]`);
    if (!group) {
      this.redraw(g.pageIndex);
      return;
    }
    group.setAttribute('transform', transform);
    layer?.querySelector('.mpv-drawing-selection')?.setAttribute('transform', transform);
  }

  private finishPress(g: PressGesture, clientX: number, clientY: number): void {
    const drawing = this.drawings.get(g.id);
    if (!drawing) return;
    this.clickConsumed = true;
    setTimeout(() => (this.clickConsumed = false), 0);
    const [dx, dy] = g.delta;
    if (!g.moving || (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005)) {
      this.redraw(g.pageIndex);
      // (A double click is found here: the dblclick event goes to the container, which has the pointer.)
      const now = performance.now();
      const last = this.lastClick;
      this.lastClick = { id: g.id, time: now, x: clientX, y: clientY };
      const double = last?.id === g.id && now - last.time < 500 && Math.hypot(clientX - last.x, clientY - last.y) < 6;
      if (g.editOnClick && isTextDrawing(drawing)) {
        this.startEditing(drawing.id, clientX, clientY);
      } else if (double && isTextDrawing(drawing)) {
        this.lastClick = undefined;
        window.getSelection()?.removeAllRanges();
        this.events.editRequested(drawing.id, clientX, clientY);
      } else {
        this.select(g.id);
      }
      return;
    }
    const after: Drawing = {
      ...drawing,
      points: drawing.points.map(([x, y]): PdfPoint => [round2(x + dx), round2(y + dy)]),
      updatedAt: new Date().toISOString(),
    };
    this.drawings.set(after.id, after);
    this.outlines.delete(after.id);
    this.redraw(g.pageIndex);
    this.select(g.id, this.modeValue === 'off');
    this.events.moved(structuredClone(drawing), structuredClone(after));
    this.events.changed();
  }

  // ---------- Text boxes ----------

  private createMove(g: CreateGesture, clientX: number, clientY: number): void {
    const page = this.toPage(g.pageIndex, clientX, clientY);
    const geometry = this.geometry(g.pageIndex);
    if (!page || !geometry) return;
    g.end = [Math.min(geometry.width, Math.max(0, page[0])), page[1]];
    if (Math.hypot(clientX - g.startClient[0], clientY - g.startClient[1]) >= MIN_DRAG_PX) this.redraw(g.pageIndex);
  }

  /** A click places a new box that grows with its text; a drag across sets its width. */
  private finishCreate(g: CreateGesture): void {
    const geometry = this.geometry(g.pageIndex);
    this.redraw(g.pageIndex);
    if (!geometry) return;
    const dragged = Math.hypot(g.client[0] - g.startClient[0], g.client[1] - g.startClient[1]) >= MIN_DRAG_PX;
    let x = dragged ? Math.min(g.start[0], g.end[0]) : g.start[0];
    let y = g.start[1];
    let boxWidth: number | undefined;
    if (dragged) {
      boxWidth = Math.max(MIN_TEXT_BOX_WIDTH, Math.abs(g.end[0] - g.start[0]));
      x = Math.min(x, geometry.width - boxWidth);
    } else {
      // Leave some room before the page edge (the box wraps there).
      const room = Math.min(TEXT_MIN_ROOM, geometry.width - 2 * TEXT_EDGE_MARGIN);
      x = Math.min(x, geometry.width - TEXT_EDGE_MARGIN - room);
    }
    const lineHeight = this.measurer.measure({ ...this.textStyleValue, text: '', boxWidth: undefined }).height;
    // The click is at the middle of the first line.
    if (!dragged) y -= lineHeight / 2;
    y = Math.min(Math.max(0, y), geometry.height - lineHeight);
    x = Math.max(0, x);
    const anchor = toPdfSpace(geometry, [x, y]);
    const now = new Date().toISOString();
    const draft: TextDrawing = {
      id: crypto.randomUUID(),
      tool: 'text',
      pageIndex: g.pageIndex,
      points: [[round2(anchor[0]), round2(anchor[1])]],
      text: '',
      ...this.textStyleValue,
      createdAt: now,
      updatedAt: now,
    };
    if (boxWidth !== undefined) draft.boxWidth = round2(boxWidth);
    const hash = this.highlights.textModel?.hash;
    if (hash) draft.textModelHash = hash;
    this.openEditor({ draft });
  }

  private resizeMove(g: ResizeGesture, clientX: number, clientY: number): void {
    const geometry = this.geometry(g.pageIndex);
    const page = this.toPage(g.pageIndex, clientX, clientY);
    if (!geometry || !page) return;
    const [left, top] = toPageSpace(geometry, g.before.points[0]);
    const right = left + this.textSize(g.before).width;
    let x0 = left;
    let x1 = right;
    if (g.side === 'right') x1 = Math.min(geometry.width, Math.max(left + MIN_TEXT_BOX_WIDTH, page[0]));
    else x0 = Math.max(0, Math.min(right - MIN_TEXT_BOX_WIDTH, page[0]));
    const anchor = toPdfSpace(geometry, [x0, top]);
    g.draft = { ...g.before, points: [[round2(anchor[0]), round2(anchor[1])]], boxWidth: round2(x1 - x0) };
    this.redraw(g.pageIndex);
  }

  private finishResize(g: ResizeGesture): void {
    this.clickConsumed = true;
    setTimeout(() => (this.clickConsumed = false), 0);
    const before = g.before;
    const after: TextDrawing = { ...g.draft, updatedAt: new Date().toISOString() };
    const moved = Math.hypot(g.client[0] - g.startClient[0], g.client[1] - g.startClient[1]) >= CLICK_SLOP_PX;
    if (!moved || (after.boxWidth === before.boxWidth && after.points[0][0] === before.points[0][0] && after.points[0][1] === before.points[0][1])) {
      this.redraw(g.pageIndex);
      return;
    }
    this.drawings.set(after.id, after);
    this.redraw(g.pageIndex);
    this.events.resized(structuredClone(before), structuredClone(after));
    this.events.changed();
  }

  /** A text box restyled (say, a bigger size) that would now run past the page's right edge wraps there instead. */
  fitText(text: TextDrawing): TextDrawing {
    const g = this.geometry(text.pageIndex);
    if (!g || text.boxWidth !== undefined) return text;
    const [x] = toPageSpace(g, text.points[0]);
    const room = g.width - TEXT_EDGE_MARGIN - x;
    return this.measurer.measure(text).width > room && room >= MIN_TEXT_BOX_WIDTH ? { ...text, boxWidth: round2(room) } : text;
  }

  /** The text box being typed in, as it is now. */
  get editing(): TextDrawing | undefined {
    const edit = this.edit;
    return edit ? { ...edit.draft, text: this.editor.value } : undefined;
  }

  /** Whether the keyboard is in the text box editor. */
  get editorFocused(): boolean {
    return this.edit !== undefined && document.activeElement === this.editor.textarea;
  }

  focusEditor(): void {
    this.editor.focus();
  }

  /** Starts typing in a text box; the caret goes where the pointer is (or to the end). */
  startEditing(id: string, clientX?: number, clientY?: number): boolean {
    const text = this.drawings.get(id);
    if (!text || !isTextDrawing(text)) return false;
    if (this.edit?.draft.id === id) return true;
    this.commitEditing();
    let caret: number | undefined;
    const g = this.geometry(text.pageIndex);
    if (g && clientX !== undefined && clientY !== undefined) {
      const page = this.toPage(text.pageIndex, clientX, clientY);
      const [x, y] = toPageSpace(g, text.points[0]);
      if (page) caret = this.measurer.offsetAt(text, page[0] - x, page[1] - y);
    }
    this.openEditor({ draft: { ...text }, before: text }, caret);
    return true;
  }

  private openEditor(edit: TextEdit, caret?: number): void {
    this.cancelGesture();
    if (this.selected !== edit.draft.id && this.selected) this.select(undefined);
    this.edit = edit;
    this.editor.show(edit.draft, caret);
    this.placeEditor();
    this.redraw(edit.draft.pageIndex);
    this.events.editingChanged(this.editing);
  }

  /** Changes the style of the text box being typed in (part of the same edit). */
  setEditingStyle(patch: Partial<TextStyle>): void {
    const edit = this.edit;
    if (!edit) return;
    edit.draft = { ...edit.draft, ...patch, text: this.editor.value };
    this.editor.restyle(edit.draft);
    this.fitEditor();
    this.events.editingChanged(this.editing);
  }

  private onEditorInput(): void {
    const edit = this.edit;
    if (!edit) return;
    if (this.editor.value.length > MAX_TEXT_LENGTH) {
      const caret = this.editor.textarea.selectionStart;
      this.editor.textarea.value = this.editor.value.slice(0, MAX_TEXT_LENGTH);
      this.editor.textarea.setSelectionRange(Math.min(caret, MAX_TEXT_LENGTH), Math.min(caret, MAX_TEXT_LENGTH));
      this.events.notice(`A text box holds up to ${MAX_TEXT_LENGTH.toLocaleString()} characters.`);
    }
    edit.draft = { ...edit.draft, text: this.editor.value };
    this.fitEditor();
  }

  /** A box that grows with its text wraps once it reaches the page's right edge. */
  private fitEditor(): void {
    const edit = this.edit;
    const g = edit ? this.geometry(edit.draft.pageIndex) : undefined;
    if (!edit || !g) return;
    if (edit.draft.boxWidth === undefined) {
      const [x] = toPageSpace(g, edit.draft.points[0]);
      const room = g.width - TEXT_EDGE_MARGIN - x;
      const natural = this.measurer.measure(edit.draft).width;
      if (natural > room && room >= MIN_TEXT_BOX_WIDTH) {
        edit.draft = { ...edit.draft, boxWidth: round2(room) };
        this.editor.restyle(edit.draft);
      }
    }
    this.placeEditor();
  }

  /** Puts the editor over its box (after typing, a zoom, a resize of the viewer). */
  placeEditor(): void {
    const edit = this.edit;
    if (!edit) return;
    const g = this.geometry(edit.draft.pageIndex);
    const box = this.pageBox(edit.draft.pageIndex);
    if (!g || !box) return;
    const scale = box.width / g.width;
    const [x, y] = toPageSpace(g, edit.draft.points[0]);
    const c = this.viewer.container;
    const cr = c.getBoundingClientRect();
    const left = box.left - cr.left - c.clientLeft + c.scrollLeft + x * scale;
    const top = box.top - cr.top - c.clientTop + c.scrollTop + y * scale;
    const value = this.editor.value;
    // An editor shows the empty line after a last line break: measure it too.
    const measured = this.measurer.measure({ ...edit.draft, text: value.endsWith('\n') || value === '' ? `${value}\u200b` : value });
    const minWidth = edit.draft.size * 0.6 + 2 * TEXT_PAD_X;
    const width = edit.draft.boxWidth ?? Math.max(measured.width + 1, minWidth);
    this.editor.place(left, top, { width, height: measured.height }, scale);
  }

  /** Ends typing: stores the box (or drops it, if it has no text), and keeps it selected. */
  commitEditing(): void {
    const edit = this.edit;
    if (!edit) return;
    const value = this.editor.value;
    this.edit = undefined;
    this.editor.hide();
    const text = normalizeText(value);
    const before = edit.before;
    const pageIndex = edit.draft.pageIndex;
    if (!text) {
      if (before && this.drawings.has(before.id)) {
        this.drawings.delete(before.id);
        if (this.selected === before.id) this.select(undefined);
        this.redraw(pageIndex);
        this.events.textCommitted(before, undefined);
        this.events.changed();
      } else {
        this.redraw(pageIndex);
      }
      this.events.editingChanged(undefined);
      return;
    }
    const after: TextDrawing = { ...edit.draft, text };
    if (before && sameText(before, after)) {
      this.redraw(pageIndex);
      this.select(after.id, false);
      this.events.editingChanged(undefined);
      return;
    }
    after.updatedAt = new Date().toISOString();
    this.drawings.set(after.id, after);
    this.redraw(pageIndex);
    this.select(after.id, false);
    this.events.textCommitted(before, structuredClone(after));
    this.events.changed();
    this.events.editingChanged(undefined);
  }
}
