// Drawings and text boxes in the viewer: one SVG per page whose content is in PDF units (zoom and
// resize never recompute anything), draw mode, text mode and select mode (a capture surface above
// every page layer), typing text, selecting, moving and resizing, and hit-testing. The selection
// is kept here for everything on the pages: drawings and text boxes, and highlights (which the
// select tool, or a click with Ctrl or Shift, can select with them). The eraser of draw mode rubs
// out the part of a drawing it goes over. The App records undo steps and talks to the host.
import type { AnchorState } from '../src/anchoring/anchor';
import type { BindingFlag, DrawingBinding } from '../src/anchoring/binding';
import type { DrawingInput, DrawingResult } from '../src/anchoring/runs';
import { inkShades, type Ink } from '../src/shared/colors';
import {
  clampToPage,
  flattenPath,
  linesTouchRect,
  pageGeometry,
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
import { eraseShape } from '../src/shared/erase';
import { sameSpans, sanitizeSpans, type CharStyle, type CharStyleName } from '../src/shared/richText';
import { MAX_CLIP_ITEMS, clampGroupMove, detached, rangeBetween, refKey, toPdfDelta, type ClipItem, type Ref } from '../src/shared/selection';
import {
  DEFAULT_DRAW_TOOL,
  DEFAULT_INK,
  DEFAULT_INK_WIDTH,
  DEFAULT_TEXT_STYLE,
  INK_WIDTH_PT,
  MAX_DRAWINGS,
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
  type TextBoxStyle,
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
/** How far from a stroke (pixels, beyond half its width) a click still hits it. */
const HIT_PX = 5;
/** How far the dashed box of a selected drawing stands off its stroke (points). */
const SELECTION_PAD = 3;
/** Radius (pixels) of the eraser of draw mode, by its size: it rubs out what is under the ring that follows the pointer. */
export const RUBBER_PX: Record<InkWidth, number> = { thin: 4, medium: 8, thick: 16 };
/** What the rubber leaves is dropped when it is shorter than this (pixels): crumbs. */
const CRUMB_PX = 2.5;
/** Size of the resize handles of a selected text box, and how far around them a press still grabs them (pixels). */
const HANDLE_PX = 8;
const HANDLE_REACH_PX = 6;
/** A new text box keeps this far from the page's right edge (points). */
const TEXT_EDGE_MARGIN = 6;
/** A text box made by a click gets at least this much room on the page before it wraps (points). */
const TEXT_MIN_ROOM = 72;
/** Fallback page geometry (US Letter) for thumbnails of pages PDF.js has not fetched yet. */
const FALLBACK_PAGE = pageGeometry([0, 0, 612, 792]);

export type DrawingMode = 'off' | 'draw' | 'text' | 'select';

/** What is selected: drawings and text boxes, and highlights. */
export interface Selection {
  drawings: string[];
  highlights: string[];
}

export interface DrawingEvents {
  /** A shape was drawn (already shown). */
  drawn(drawing: InkDrawing): void;
  /**
   * The eraser of draw mode rubbed out parts of drawings in one gesture (already shown): the
   * drawings it touched are gone, and what is left of them are new drawings.
   */
  rubbed(removed: InkDrawing[], added: InkDrawing[]): void;
  /** Drawings and text boxes were dragged to a new place, one or several at once (already shown there). */
  moved(before: Drawing[], after: Drawing[]): void;
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
  /**
   * The selection changed. `id`: the drawing or text box that is selected alone, if so. `popover`:
   * one thing is selected, by a click: show its popover (`at`: where the click was, in client
   * coordinates, when it was on a highlight).
   */
  selectionChanged(id: string | undefined, popover: boolean, at?: [number, number]): void;
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

/** The eraser of draw mode: rubs out the parts of the drawings it goes over, as it goes. */
interface RubGesture {
  kind: 'rub';
  pointerId: number;
  pageIndex: number;
  /** The drawings touched, as they were before the gesture (they are not shown any more). */
  originals: Map<string, InkDrawing>;
  /** What is left of them now (drawings made during this gesture). */
  pieces: Set<string>;
  last?: PdfPoint;
  full: boolean;
  client: [number, number];
}

interface PressGesture {
  kind: 'press';
  pointerId: number;
  /** The page of the one that was pressed. */
  pageIndex: number;
  id: string;
  /** What a drag moves: the one pressed, or everything selected when it is one of several. */
  ids: string[];
  /** Where the press was on its page as shown (points from its top left corner). */
  start: PdfPoint;
  startClient: [number, number];
  /** The move so far, on the page as shown (points; the same on every page). */
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

/** The select tool: a press on anything but a drawing or text box, and the rectangle a drag from there opens. */
interface MarqueeGesture {
  kind: 'marquee';
  pointerId: number;
  /** Not on one page (-1). */
  pageIndex: number;
  /** Where the press was, in the scrolled content of the viewer: that corner stays on the page while the pages scroll. */
  start: [number, number];
  /** What was selected when it started (Esc brings it back). */
  before: Selection;
  /** With Ctrl or Shift held, what the rectangle takes joins what was selected. */
  adding: boolean;
  /** The press was on a highlight: a click without a drag selects it. */
  click?: Ref;
  moving: boolean;
  client: [number, number];
}

/** A click with Ctrl or Shift on an annotation (it changed the selection when it was pressed): only the click that follows is left to take. */
interface TapGesture {
  kind: 'tap';
  pointerId: number;
  pageIndex: number;
  client: [number, number];
}

type Gesture = DrawGesture | RubGesture | PressGesture | CreateGesture | ResizeGesture | MarqueeGesture | TapGesture;

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
    sameSpans(a.spans, b.spans) &&
    a.size === b.size &&
    a.align === b.align &&
    a.color === b.color &&
    a.boxWidth === b.boxWidth &&
    a.points[0][0] === b.points[0][0] &&
    a.points[0][1] === b.points[0][1]
  );
}

/** Binds a drawing to what it covers in the document shown (see AnchoringController). */
export interface DrawingBinder {
  bind(drawing: Drawing, prefer?: 'text' | 'image' | 'page'): Promise<DrawingBinding | undefined>;
  /** Hash of the text of the document shown. */
  hash(): string | undefined;
}

function withoutAnchoring<T extends Drawing>(drawing: T): T {
  const { binding: _binding, anchorStates: _states, ...rest } = drawing;
  return rest as T;
}

/** Whether two versions of a drawing are at the same place with the same shape (their look may differ). */
function sameGeometry(a: Drawing, b: Drawing): boolean {
  if (a.pageIndex !== b.pageIndex || a.points.length !== b.points.length) return false;
  if (isTextDrawing(a) && isTextDrawing(b) && (a.boxWidth ?? -1) !== (b.boxWidth ?? -1)) return false;
  return a.points.every((p, i) => Math.abs(p[0] - b.points[i][0]) <= 0.011 && Math.abs(p[1] - b.points[i][1]) <= 0.011);
}

export class DrawingController {
  /**
   * The drawings as they are shown: where their content is in the document on screen. Everything
   * the reader does with the pointer works on these.
   */
  private readonly drawings = new Map<string, Drawing>();
  /** The drawings as the reader placed them, with what they are bound to: what is stored. */
  private readonly stored = new Map<string, Drawing>();
  /** What the last resolving run showed, to tell a move from a change of color. */
  private readonly resolvedShown = new Map<string, Drawing>();
  private readonly results = new Map<string, DrawingResult>();
  /** Anchor states from a render of unsaved text: used for the next run, never stored. */
  private readonly liveStates = new Map<string, (AnchorState | undefined)[]>();
  private binder?: DrawingBinder;
  private idleWaiters: (() => void)[] = [];
  private readonly outlines = new Map<string, Outline>();
  private readonly geometries = new WeakMap<object, PageGeometry>();
  private readonly measurer = new TextMeasurer();
  private readonly editor: TextEditor;
  private modeValue: DrawingMode = 'off';
  private toolValue: DrawTool = DEFAULT_DRAW_TOOL;
  private colorValue: Ink = DEFAULT_INK;
  private widthValue: InkWidth = DEFAULT_INK_WIDTH;
  private eraserWidthValue: InkWidth = DEFAULT_INK_WIDTH;
  /** The ring that shows what the eraser of draw mode rubs out: it follows the pointer, also while the button is down. */
  private readonly ring = document.createElement('div');
  /** Where the pointer was last seen over the pages (client coordinates). */
  private pointerAt?: [number, number];
  private textStyleValue: TextStyle = { ...DEFAULT_TEXT_STYLE };
  /** The selected drawings and text boxes. */
  private readonly picked = new Set<string>();
  /** The selected highlights. */
  private readonly pickedHighlights = new Set<string>();
  /** The last one clicked: Shift+click selects from it. */
  private anchor?: Ref;
  /** The rectangle of the select tool. */
  private readonly marquee = document.createElement('div');
  private marqueeFrame = 0;
  private gesture?: Gesture;
  private edit?: TextEdit;
  private preview?: SVGPathElement;
  private previewFrame = 0;
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
    this.editor = new TextEditor(c, {
      input: () => this.onEditorInput(),
      selection: () => this.events.editingChanged(this.editing),
      finish: () => this.commitEditing(),
      notice: (message) => this.events.notice(message),
    });
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => {
      if (e.pointerId === this.gesture?.pointerId) this.cancelGesture();
    });
    const pointerLeft = () => {
      this.pointerAt = undefined;
      this.placeRing();
    };
    c.addEventListener('pointerleave', pointerLeft);
    // The pointer can also leave the whole viewer in one step (to another part of VS Code).
    document.documentElement.addEventListener('pointerleave', pointerLeft);
    window.addEventListener('blur', pointerLeft);
    this.ring.className = 'mpv-rubber-ring';
    this.ring.hidden = true;
    this.marquee.className = 'mpv-marquee';
    this.marquee.hidden = true;
    document.body.append(this.ring, this.marquee);
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

  /**
   * Replaces every drawing (initial load, a reload after a rename or Reattach). Nothing is shown
   * until a resolving run says where each one is in the document on screen.
   */
  setDrawings(list: Drawing[]): void {
    this.commitEditing();
    this.cancelGesture();
    this.stored.clear();
    this.clearShown();
    for (const d of list) this.stored.set(d.id, structuredClone(d));
    this.events.changed();
  }

  private clearShown(): void {
    this.drawings.clear();
    this.resolvedShown.clear();
    this.results.clear();
    this.liveStates.clear();
    this.outlines.clear();
    if (this.picked.size > 0) this.setSelection([], this.pickedHighlights);
    this.layers.redraw(LAYER);
  }

  setBinder(binder: DrawingBinder): void {
    this.binder = binder;
  }

  /** What the resolver works on: the drawings as stored, each with its binding. */
  inputs(): DrawingInput[] {
    return [...this.stored.values()].map((d) => ({ drawing: withoutAnchoring(d), binding: d.binding, states: this.liveStates.get(d.id) ?? d.anchorStates }));
  }

  /** Takes over where a resolving run put every drawing (or that it has no place in this version). */
  applyResults(results: Map<string, DrawingResult>, provisional: boolean): void {
    const editing = this.edit?.draft.id;
    for (const [id, stored] of this.stored) {
      const r = results.get(id);
      if (!r) continue;
      this.results.set(id, r);
      if (r.binding) {
        stored.binding = r.binding;
        delete stored.anchorStates;
      }
      if (provisional) {
        this.liveStates.set(id, r.states);
      } else {
        this.liveStates.delete(id);
        if (stored.binding) stored.anchorStates = r.states;
      }
      this.outlines.delete(id);
      if (r.status === 'anchored' && r.shown) {
        const shown = withoutAnchoring(structuredClone(r.shown));
        this.resolvedShown.set(id, structuredClone(shown));
        // A text box being typed in stays as the reader sees it; it is stored when the typing ends.
        if (id !== editing) this.drawings.set(id, shown);
      } else {
        this.resolvedShown.delete(id);
        if (id !== editing) this.drawings.delete(id);
        this.unpick(id);
      }
    }
    this.layers.redraw(LAYER);
    this.events.changed();
  }

  /** What the host stores of the last run. */
  resolvedPayload(): { id: string; states: (AnchorState | undefined)[]; binding?: DrawingBinding }[] {
    return [...this.results].map(([id, r]) => ({ id, states: r.states, ...(r.binding ? { binding: r.binding } : {}) }));
  }

  /** A drawing as it is stored (where the reader placed it, with its binding). */
  storedOf(id: string): Drawing | undefined {
    const drawing = this.stored.get(id);
    return drawing ? structuredClone(drawing) : undefined;
  }

  get allStored(): Drawing[] {
    return [...this.stored.values()].map((d) => structuredClone(d));
  }

  /** Drawings and text boxes whose content is not in the document shown: kept, listed, not drawn. */
  orphans(): { drawing: Drawing; result: DrawingResult }[] {
    const out: { drawing: Drawing; result: DrawingResult }[] = [];
    for (const [id, drawing] of this.stored) {
      const result = this.results.get(id);
      if (result?.status === 'orphaned') out.push({ drawing: structuredClone(drawing), result });
    }
    return out;
  }

  /** What to tell the reader about a shown drawing: it was pinned, moved back into the page, or bound by guessing. */
  flagsOf(id: string): BindingFlag[] {
    return this.results.get(id)?.flags ?? [];
  }

  bindingOf(id: string): DrawingBinding | undefined {
    return this.stored.get(id)?.binding;
  }

  /**
   * The reader made or changed a drawing (it is shown already): returns what to store for it.
   * A change of look keeps where the reader placed it and what it is bound to. A new place or
   * shape is taken as it is shown and bound again to what it covers there (`prefer`: what the
   * reader asked for from its menu).
   */
  async adopt(shown: Drawing, prefer?: 'text' | 'image' | 'page', rebase = false): Promise<Drawing> {
    const clean = withoutAnchoring(structuredClone(shown));
    const stored = this.stored.get(clean.id);
    const base = this.resolvedShown.get(clean.id);
    let next: Drawing;
    if (stored && base && !prefer && !rebase && sameGeometry(clean, base)) {
      next = { ...clean, pageIndex: stored.pageIndex, points: stored.points.map((p): PdfPoint => [p[0], p[1]]) };
      if (stored.binding) next.binding = { ...stored.binding, for: clean.updatedAt };
      if (stored.anchorStates) next.anchorStates = stored.anchorStates;
    } else {
      const hash = this.binder?.hash();
      next = hash ? { ...clean, textModelHash: hash } : clean;
      const kept = stored?.binding?.manual ? (stored.binding.mode === 'block' ? 'image' : stored.binding.mode === 'page' ? 'page' : 'text') : undefined;
      const binding = await this.binder?.bind(next, prefer ?? kept);
      if (binding) next.binding = { ...binding, for: next.updatedAt };
      this.results.set(clean.id, { status: 'anchored', kind: 'exact', flags: [], states: [], shown: clean });
      this.liveStates.delete(clean.id);
    }
    this.stored.set(clean.id, next);
    this.resolvedShown.set(clean.id, withoutAnchoring(structuredClone(clean)));
    this.events.changed();
    return structuredClone(next);
  }

  /**
   * An orphaned drawing put on a page again (by the reader): on `pageIndex`, with its top at `top`
   * (points from the top of the page as shown; default: where it was on its own page), moved
   * inside the page if needed. Returns it as it would be shown; nothing is stored here.
   */
  placedAt(id: string, pageIndex: number, top?: number): Drawing | undefined {
    const stored = this.stored.get(id);
    const g = this.geometry(pageIndex);
    if (!stored || !g) return undefined;
    // Its shape, in points of the page it was on (or of this page, if that one is unknown).
    const frame = stored.binding?.frame;
    const from = stored.binding ? { ...g, transform: frame as PageGeometry['transform'] } : (this.geometry(stored.pageIndex) ?? g);
    let points = stored.points.map((p) => toPageSpace(from, p));
    const size = isTextDrawing(stored) ? this.measurer.size(stored) : undefined;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const box = size ? [points[0][0], points[0][1], points[0][0] + size.width, points[0][1] + size.height] : [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const fit = (low: number, high: number, limit: number): number => (high - low >= limit ? -low : low < 0 ? -low : high > limit ? limit - high : 0);
    const dy = top === undefined ? fit(box[1], box[3], g.height) : fit(top, top + box[3] - box[1], g.height) + top - box[1];
    const dx = fit(box[0], box[2], g.width);
    points = points.map(([x, y]): PdfPoint => [x + dx, y + dy]);
    const placed = withoutAnchoring(structuredClone(stored));
    placed.pageIndex = pageIndex;
    placed.points = points.map((p): PdfPoint => {
      const [x, y] = toPdfSpace(g, p);
      return [round2(x), round2(y)];
    });
    if ((placed.tool === 'rect' || placed.tool === 'ellipse') && placed.points.length === 2) {
      const [[ax, ay], [bx, by]] = placed.points;
      placed.points = [
        [Math.min(ax, bx), Math.min(ay, by)],
        [Math.max(ax, bx), Math.max(ay, by)],
      ];
    }
    placed.updatedAt = new Date().toISOString();
    this.put(placed);
    return structuredClone(placed);
  }

  /** Puts back a stored drawing (undo and redo). It is shown once the next resolving run placed it. */
  restore(stored: Drawing): void {
    const before = this.drawings.get(stored.id);
    this.stored.set(stored.id, structuredClone(stored));
    this.results.delete(stored.id);
    this.liveStates.delete(stored.id);
    this.resolvedShown.delete(stored.id);
    this.outlines.delete(stored.id);
    if (before) {
      this.drawings.delete(stored.id);
      this.redraw(before.pageIndex);
    }
    this.events.changed();
  }

  /** Resolves when no gesture is in progress (a stroke being drawn is finished first). */
  idle(): Promise<void> {
    if (!this.gesture) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private gestureEnded(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** The size of a text box on the page, in points. */
  textSizeOf(drawing: Drawing): BoxSize | undefined {
    return isTextDrawing(drawing) ? this.measurer.size(drawing) : undefined;
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

  /** Removes a drawing: what is shown and what is stored. */
  remove(id: string): void {
    const had = this.stored.delete(id);
    this.results.delete(id);
    this.liveStates.delete(id);
    this.resolvedShown.delete(id);
    const drawing = this.drawings.get(id);
    if (!drawing) {
      if (had) this.events.changed();
      return;
    }
    this.drawings.delete(id);
    this.outlines.delete(id);
    this.unpick(id);
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

  /**
   * Drawings and text boxes for a download: as they are shown (where their content is in this
   * version), and how the text boxes are laid out. `orphaned` counts those left out because their
   * content is not in this version.
   */
  exportData(): { drawings: Drawing[]; textLayouts: TextLayout[]; skipped: number; orphaned: number } {
    this.commitEditing();
    const pages = this.viewer.pagesCount;
    const all = [...this.drawings.values()];
    const drawings = all.filter((d) => d.pageIndex < pages).map((d) => structuredClone(d));
    const textLayouts = drawings.filter(isTextDrawing).map((d) => this.measurer.layout(d));
    return { drawings, textLayouts, skipped: all.length - drawings.length, orphaned: this.orphans().length };
  }

  /** Ends what the reader is in the middle of (typing in a text box, a gesture) before the document is replaced. */
  settle(): void {
    this.commitEditing();
    this.cancelGesture();
  }

  /**
   * The viewer switched to another PDF: what was shown belonged to the previous one and is
   * dropped at once. The next resolving run shows every drawing where its content is now.
   */
  documentChanged(): void {
    this.settle();
    this.clearShown();
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

  /** The select tool is on. */
  get selecting(): boolean {
    return this.modeValue === 'select';
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
    // A mode starts, and ends, with nothing selected (typing leaves its box selected while in text mode).
    this.setSelection([], []);
    // (Text mode and the select tool set the pointer's shape on the surface under it.)
    for (const surface of document.querySelectorAll<HTMLElement>(`.${CAPTURE}`)) surface.style.cursor = '';
    document.body.classList.toggle('mpv-draw-mode', mode === 'draw');
    document.body.classList.toggle('mpv-text-mode', mode === 'text');
    document.body.classList.toggle('mpv-select-mode', mode === 'select');
    document.body.dataset.drawTool = this.toolValue;
    this.placeRing();
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

  /** The size of the eraser of draw mode. */
  get eraserWidth(): InkWidth {
    return this.eraserWidthValue;
  }

  setTool(tool: DrawTool): void {
    this.toolValue = tool;
    document.body.dataset.drawTool = tool;
    this.placeRing();
  }

  setColor(color: Ink): void {
    this.colorValue = color;
  }

  setWidth(width: InkWidth): void {
    this.widthValue = width;
  }

  setEraserWidth(width: InkWidth): void {
    this.eraserWidthValue = width;
    this.placeRing();
  }

  /**
   * Shows the eraser's ring at the pointer (as large as what it rubs out), or hides it: it is
   * there while the eraser of draw mode is over a page, and for the whole of a rubbing gesture.
   */
  private placeRing(): void {
    const at = this.gesture?.kind === 'rub' ? this.gesture.client : this.pointerAt;
    const rubbing = this.gesture?.kind === 'rub';
    const erasing = this.modeValue === 'draw' && this.toolValue === 'eraser';
    const overPage = at !== undefined && (rubbing || document.elementFromPoint(at[0], at[1])?.closest(`.${CAPTURE}`) != null);
    document.body.classList.toggle('mpv-rubbing', rubbing);
    if (!erasing || !at || !overPage) {
      this.ring.hidden = true;
      return;
    }
    const size = 2 * RUBBER_PX[this.eraserWidthValue];
    this.ring.style.width = `${size}px`;
    this.ring.style.height = `${size}px`;
    this.ring.style.transform = `translate(${at[0] - size / 2}px, ${at[1] - size / 2}px)`;
    this.ring.hidden = false;
  }

  /** The style new text boxes get. */
  get textStyle(): TextStyle {
    return { ...this.textStyleValue };
  }

  setTextStyle(style: TextStyle): void {
    this.textStyleValue = { ...style };
  }

  // ---------- Selection ----------

  /** The drawing or text box that is selected alone: it has a popover, and a text box its handles. */
  get selectedId(): string | undefined {
    if (this.picked.size !== 1 || this.pickedHighlights.size > 0) return undefined;
    return [...this.picked][0];
  }

  /** Everything that is selected. */
  get selection(): Selection {
    return { drawings: [...this.picked], highlights: [...this.pickedHighlights] };
  }

  get selectionCount(): number {
    return this.picked.size + this.pickedHighlights.size;
  }

  /** Selects one drawing or text box and nothing else, or nothing. */
  select(id: string | undefined, popover = true): void {
    this.setSelection(id ? [id] : [], [], popover);
  }

  /**
   * Selects these drawings, text boxes and highlights, and nothing else. `popover`: when that is
   * one thing, show its popover (`at`: where the click was, in client coordinates).
   */
  setSelection(drawings: Iterable<string>, highlights: Iterable<string> = [], popover = false, at?: [number, number]): void {
    const next = new Set([...drawings].filter((id) => this.drawings.has(id)));
    const nextHighlights = new Set([...highlights].filter((id) => this.highlights.get(id) !== undefined));
    const alone = this.selectedId;
    const changed = next.size !== this.picked.size || [...next].some((id) => !this.picked.has(id));
    // Everything that was or is selected is drawn again: the outlines, and the handles of a text box selected alone.
    const pages = new Set<number>();
    for (const id of [...this.picked, ...next]) {
      const page = this.drawings.get(id)?.pageIndex;
      if (page !== undefined) pages.add(page);
    }
    this.picked.clear();
    for (const id of next) this.picked.add(id);
    this.pickedHighlights.clear();
    for (const id of nextHighlights) this.pickedHighlights.add(id);
    if (changed || alone !== this.selectedId) for (const page of pages) this.redraw(page);
    this.highlights.setSelected(nextHighlights);
    if (this.anchor && !this.isPicked(this.anchor)) this.anchor = undefined;
    this.events.selectionChanged(this.selectedId, popover && this.selectionCount === 1, at);
  }

  clearSelection(): void {
    if (this.selectionCount > 0) this.setSelection([], []);
  }

  /** Every drawing, text box and highlight that is shown. */
  selectAll(): void {
    this.setSelection(
      this.drawings.keys(),
      this.highlights.places().map((place) => place.id),
    );
  }

  /** A highlight was removed (or is not shown any more): it leaves the selection. */
  highlightsChanged(): void {
    if ([...this.pickedHighlights].some((id) => this.highlights.get(id)?.data.status !== 'anchored')) {
      this.setSelection(
        this.picked,
        [...this.pickedHighlights].filter((id) => this.highlights.get(id)?.data.status === 'anchored'),
      );
    }
  }

  /**
   * A highlight was clicked outside the select tool (the App finds those clicks: they are clicks
   * on the text). Alone it becomes the selection and gets its popover at the click; with `toggle`
   * (Ctrl, or the command key) it joins or leaves the selection.
   */
  highlightClicked(id: string, toggle: boolean, at: [number, number]): void {
    this.clickOn({ kind: 'highlight', id }, toggle ? 'toggle' : 'set', at);
  }

  private isPicked(ref: Ref): boolean {
    return ref.kind === 'drawing' ? this.picked.has(ref.id) : this.pickedHighlights.has(ref.id);
  }

  /** A drawing or text box is gone: it leaves the selection. */
  private unpick(id: string): void {
    if (!this.picked.has(id)) return;
    this.setSelection(
      [...this.picked].filter((other) => other !== id),
      this.pickedHighlights,
    );
  }

  /**
   * A click on an annotation. Alone ('set') it becomes the selection. With Ctrl ('toggle') it
   * joins or leaves the selection. With Shift ('range') everything from the last one clicked to
   * it is selected, in reading order.
   */
  private clickOn(ref: Ref, how: 'set' | 'toggle' | 'range', at?: [number, number]): void {
    const ids = (refs: Ref[], kind: Ref['kind']) => refs.filter((r) => r.kind === kind).map((r) => r.id);
    if (how === 'range') {
      const from = this.anchor;
      // On one page: what lies between the two, whichever way that goes. Over several pages: in reading order.
      const range = (from ? this.between(from, ref) : undefined) ?? rangeBetween(this.order(), refKey, from ? refKey(from) : undefined, refKey(ref));
      this.setSelection(ids(range, 'drawing'), ids(range, 'highlight'));
      this.anchor = from && this.isPicked(from) ? from : ref;
      return;
    }
    if (how === 'toggle') {
      const drawings = new Set(this.picked);
      const highlights = new Set(this.pickedHighlights);
      const set = ref.kind === 'drawing' ? drawings : highlights;
      if (!set.delete(ref.id)) set.add(ref.id);
      this.setSelection(drawings, highlights);
      if (this.isPicked(ref)) this.anchor = ref;
      return;
    }
    this.setSelection(ids([ref], 'drawing'), ids([ref], 'highlight'), true, at);
    this.anchor = ref;
  }

  /**
   * Shift+click on the page of the last one clicked: everything the rectangle around the two
   * touches, so it works to the left and to the right, upwards and downwards. Undefined when the
   * two are on different pages (or one of them is not laid out): then the reading order decides.
   */
  private between(a: Ref, b: Ref): Ref[] | undefined {
    const place = (ref: Ref): { page: number; rect: { left: number; top: number; right: number; bottom: number } } | undefined => {
      const page = ref.kind === 'drawing' ? this.drawings.get(ref.id)?.pageIndex : this.highlights.places().find((p) => p.id === ref.id)?.page;
      const rect = ref.kind === 'drawing' ? this.clientRectOf(ref.id) : this.highlights.clientRectOf(ref.id);
      return page !== undefined && rect ? { page, rect } : undefined;
    };
    const from = place(a);
    const to = place(b);
    const box = from ? this.pageBox(from.page) : undefined;
    if (!from || !to || !box || from.page !== to.page) return undefined;
    const rect: [number, number, number, number] = [
      Math.min(from.rect.left, to.rect.left),
      Math.min(from.rect.top, to.rect.top),
      Math.max(from.rect.right, to.rect.right),
      Math.max(from.rect.bottom, to.rect.bottom),
    ];
    const found = new Map<string, Ref>();
    const add = (ref: Ref) => found.set(refKey(ref), ref);
    for (const drawing of this.drawings.values()) {
      if (drawing.pageIndex === from.page && this.inRect(drawing, rect)) add({ kind: 'drawing', id: drawing.id });
    }
    const frac: [number, number, number, number] = [
      (rect[0] - box.left) / box.width,
      (rect[1] - box.top) / box.height,
      (rect[2] - box.left) / box.width,
      (rect[3] - box.top) / box.height,
    ];
    for (const id of this.highlights.touching((pageIndex) => (pageIndex === from.page ? frac : undefined))) add({ kind: 'highlight', id });
    add(a);
    add(b);
    return [...found.values()];
  }

  /** Everything that can be selected, in reading order: by page, then from the top of the page, then from the left. */
  private order(): Ref[] {
    const items: { ref: Ref; page: number; top: number; left: number }[] = [];
    for (const drawing of this.drawings.values()) {
      const g = this.geometry(drawing.pageIndex) ?? FALLBACK_PAGE;
      const [x0, y0] = this.pageRectOf(drawing, g);
      items.push({ ref: { kind: 'drawing', id: drawing.id }, page: drawing.pageIndex, top: y0 / g.height, left: x0 / g.width });
    }
    for (const place of this.highlights.places()) items.push({ ref: { kind: 'highlight', id: place.id }, page: place.page, top: place.top, left: place.left });
    return items.sort((a, b) => a.page - b.page || a.top - b.top || a.left - b.left).map((item) => item.ref);
  }

  /** The selection in reading order. */
  selectionInOrder(): Ref[] {
    return this.order().filter((ref) => this.isPicked(ref));
  }

  /** The annotation under a point (client coordinates): a drawing or text box (the smallest, where they overlap), else the highlight there. */
  private itemAt(clientX: number, clientY: number): Ref | undefined {
    const pageIndex = this.viewer.pageIndexAt(clientX, clientY);
    const box = pageIndex === undefined ? undefined : this.pageBox(pageIndex);
    if (pageIndex === undefined || !box) return undefined;
    const p = this.toPdf(pageIndex, clientX, clientY, false);
    // A stroke or a text box right under the point; else the dashed box of a selected drawing
    // (the whole box can be dragged); else a highlight.
    const id = p ? (this.hitsAt(pageIndex, p, HIT_PX)[0] ?? this.boxAt(pageIndex, p)) : undefined;
    if (id) return { kind: 'drawing', id };
    const highlight = this.highlights.hitTestOnPage(pageIndex, (clientX - box.left) / box.width, (clientY - box.top) / box.height);
    return highlight ? { kind: 'highlight', id: highlight } : undefined;
  }

  /** The selected drawing whose dashed box holds a point (PDF units of the page); the smallest, where boxes overlap. */
  private boxAt(pageIndex: number, p: PdfPoint): string | undefined {
    let best: { id: string; area: number } | undefined;
    for (const id of this.picked) {
      const drawing = this.drawings.get(id);
      if (!drawing || drawing.pageIndex !== pageIndex || isTextDrawing(drawing)) continue;
      const [x0, y0, x1, y1] = this.outline(drawing).bounds;
      const pad = INK_WIDTH_PT[drawing.width] / 2 + SELECTION_PAD;
      if (p[0] < x0 - pad || p[0] > x1 + pad || p[1] < y0 - pad || p[1] > y1 + pad) continue;
      const area = (x1 - x0 + 2 * pad) * (y1 - y0 + 2 * pad);
      if (!best || area < best.area) best = { id, area };
    }
    return best?.id;
  }

  // ---------- Copy and paste ----------

  /** The selected drawings and text boxes as Copy takes them, in reading order. */
  clipItems(): ClipItem[] {
    const items: ClipItem[] = [];
    for (const ref of this.selectionInOrder()) {
      const drawing = ref.kind === 'drawing' ? this.drawings.get(ref.id) : undefined;
      const g = drawing ? this.geometry(drawing.pageIndex) : undefined;
      if (!drawing || !g || items.length >= MAX_CLIP_ITEMS) continue;
      const page = drawing.points.map((p): PdfPoint => {
        const [x, y] = toPageSpace(g, p);
        return [round2(x), round2(y)];
      });
      items.push({ drawing: detached(drawing), page });
    }
    return items;
  }

  /**
   * Puts copies of copied drawings and text boxes on the pages (they are shown; the App stores
   * them). The first page of what was copied lands on `ontoPage`, and the rest as many pages
   * after it as they were. Each copy is where the original was on its page, `offset` points
   * further down and to the right, and inside the page.
   */
  paste(items: ClipItem[], ontoPage: number, offset: number): Drawing[] {
    const pages = this.viewer.pagesCount;
    if (items.length === 0 || pages === 0) return [];
    if (this.drawings.size + items.length > MAX_DRAWINGS) {
      this.events.notice(`This file can have ${MAX_DRAWINGS} drawings and text boxes at most. Delete some to paste more.`);
      return [];
    }
    const first = Math.min(...items.map((item) => item.drawing.pageIndex));
    const now = new Date().toISOString();
    const hash = this.highlights.textModel?.hash;
    const placed: Drawing[] = [];
    for (const item of items) {
      const pageIndex = Math.min(pages - 1, Math.max(0, item.drawing.pageIndex - first + ontoPage));
      const g = this.geometry(pageIndex);
      if (!g) continue;
      const copy = detached(item.drawing);
      copy.id = crypto.randomUUID();
      copy.pageIndex = pageIndex;
      copy.createdAt = now;
      copy.updatedAt = now;
      if (hash) copy.textModelHash = hash;
      const size = isTextDrawing(copy) ? this.measurer.size(copy) : undefined;
      const [x0, y0, x1, y1] = size ? [item.page[0][0], item.page[0][1], item.page[0][0] + size.width, item.page[0][1] + size.height] : pointsBounds(item.page);
      // Back inside the page when the offset (or a smaller page) put it over an edge.
      const fit = (low: number, high: number, limit: number): number => (high - low >= limit || low < 0 ? -low : high > limit ? limit - high : 0);
      const dx = offset + fit(x0 + offset, x1 + offset, g.width);
      const dy = offset + fit(y0 + offset, y1 + offset, g.height);
      copy.points = item.page.map(([x, y]): PdfPoint => {
        const [px, py] = toPdfSpace(g, [x + dx, y + dy]);
        return [round2(px), round2(py)];
      });
      if ((copy.tool === 'rect' || copy.tool === 'ellipse') && copy.points.length === 2) {
        const [bx0, by0, bx1, by1] = pointsBounds(copy.points);
        copy.points = [
          [bx0, by0],
          [bx1, by1],
        ];
      }
      this.drawings.set(copy.id, copy);
      placed.push(structuredClone(copy));
    }
    for (const page of new Set(placed.map((d) => d.pageIndex))) this.redraw(page);
    if (placed.length > 0) this.events.changed();
    return placed;
  }

  /** True once after a press on a drawing ended: the click that follows is ours. */
  consumeClick(): boolean {
    const consumed = this.clickConsumed;
    this.clickConsumed = false;
    return consumed;
  }

  /** The click that follows the release of the button is ours. */
  private takeClick(): void {
    this.clickConsumed = true;
    setTimeout(() => (this.clickConsumed = false), 0);
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

  /** What has to stay inside the page when a drawing or text box moves: its points (a text box: its box), on the page as shown. */
  private moveRect(drawing: Drawing, g: PageGeometry): [number, number, number, number] {
    if (isTextDrawing(drawing)) return this.pageRectOf(drawing, g);
    return pointsBounds(drawing.points.map((p) => toPageSpace(g, p)));
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
    // A move in progress: what moves is drawn where it is now.
    const moving = gesture?.kind === 'press' && gesture.moving ? gesture.ids : [];
    const move = gesture?.kind === 'press' && gesture.moving ? toPdfDelta(g.transform, gesture.delta) : [0, 0];
    const moved = `translate(${move[0]} ${move[1]})`;
    for (const drawing of this.drawings.values()) {
      if (drawing.pageIndex !== pageIndex) continue;
      if (isTextDrawing(drawing)) {
        texts.append(this.textElement(drawing, g));
        continue;
      }
      const el = this.drawingElement(drawing);
      if (moving.includes(drawing.id)) el.setAttribute('transform', moved);
      root.append(el);
    }
    const alone = this.selectedId;
    for (const id of this.picked) {
      const selected = this.drawings.get(id);
      if (!selected || selected.pageIndex !== pageIndex || this.edit?.draft.id === id) continue;
      if (isTextDrawing(selected)) {
        texts.append(this.textSelectionElement(selected, g, pageIndex, alone === id));
        continue;
      }
      const outline = this.selectionElement(selected);
      if (moving.includes(id)) outline.setAttribute('transform', moved);
      root.append(outline);
    }
    if (gesture?.kind === 'draw' && gesture.pageIndex === pageIndex) root.append(this.previewElement(gesture));
    if (gesture?.kind === 'create' && gesture.pageIndex === pageIndex) texts.append(this.createPreview(gesture));
    layer.append(svg);
  }

  private drawingElement(drawing: InkDrawing): SVGGElement {
    const group = svgEl('g', { class: 'mpv-drawing', 'data-id': drawing.id, 'data-tool': drawing.tool });
    setInk(group, drawing.color);
    if (this.flashing === drawing.id) group.classList.add('mpv-flash');
    if (this.picked.has(drawing.id)) group.classList.add('mpv-selected');
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
    if (gesture?.kind === 'press' && gesture.moving && gesture.ids.includes(text.id)) return [x + gesture.delta[0], y + gesture.delta[1]];
    return [x, y];
  }

  private textElement(stored: TextDrawing, g: PageGeometry): SVGGElement {
    const text = this.shownText(stored);
    const { width, height } = this.textSize(text);
    const [x, y] = this.textOrigin(text, g);
    const group = svgEl('g', { class: 'mpv-drawing mpv-textbox', 'data-id': text.id, 'data-tool': 'text', transform: `translate(${x} ${y})` });
    if (this.flashing === text.id) group.classList.add('mpv-flash');
    if (this.picked.has(text.id)) group.classList.add('mpv-selected');
    if (this.edit?.draft.id === text.id) group.classList.add('mpv-editing');
    const object = svgEl('foreignObject', { x: '0', y: '0', width: String(width + 1), height: String(height + 1) });
    object.append(textContentElement(text));
    group.append(svgEl('rect', { class: 'mpv-text-hit', x: '0', y: '0', width: String(width), height: String(height) }), object);
    return group;
  }

  /** The dashed outline around a selected drawing. */
  private selectionElement(drawing: InkDrawing): SVGRectElement {
    const [x0, y0, x1, y1] = pathBounds(shapePath(drawingShape(drawing)));
    const pad = INK_WIDTH_PT[drawing.width] / 2 + SELECTION_PAD;
    return svgEl('rect', {
      class: 'mpv-drawing-selection',
      'data-for': drawing.id,
      x: String(x0 - pad),
      y: String(y0 - pad),
      width: String(x1 - x0 + 2 * pad),
      height: String(y1 - y0 + 2 * pad),
    });
  }

  /** The dashed outline around a selected text box; selected alone (`handles`), with a handle on each side to change its width. */
  private textSelectionElement(stored: TextDrawing, g: PageGeometry, pageIndex: number, handles: boolean): SVGGElement {
    const text = this.shownText(stored);
    const { width, height } = this.textSize(text);
    const [x, y] = this.textOrigin(text, g);
    const group = svgEl('g', { class: 'mpv-text-selection', transform: `translate(${x} ${y})` });
    group.append(svgEl('rect', { class: 'mpv-drawing-selection', x: '0', y: '0', width: String(width), height: String(height) }));
    if (!handles) return group;
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
    const lineHeight = this.lineHeight();
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
    if (target && this.editor.element.contains(target)) return;
    const client: [number, number] = [e.clientX, e.clientY];
    if (this.modeValue === 'select') {
      this.selectPointerDown(e, target, client);
      return;
    }
    if (this.modeValue === 'draw') {
      const pageIndex = this.pageUnder(target);
      const p = pageIndex === undefined ? undefined : this.toPdf(pageIndex, e.clientX, e.clientY);
      if (pageIndex === undefined || !p) return;
      e.preventDefault();
      this.viewer.container.focus({ preventScroll: true });
      if (this.toolValue === 'eraser') {
        const gesture: RubGesture = { kind: 'rub', pointerId: e.pointerId, pageIndex, originals: new Map(), pieces: new Set(), full: false, client };
        this.gesture = gesture;
        this.pointerAt = client;
        this.placeRing();
        this.rubTo(gesture, e.clientX, e.clientY);
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
    // A drawing or text box itself, or the dashed box of a selected drawing (the whole box can be dragged).
    const hitId = (target?.closest?.('.mpv-drawing') as SVGElement | null)?.dataset.id ?? (target?.closest?.('.mpv-drawing-selection') as SVGElement | null)?.dataset.for;
    const toggle = e.ctrlKey || e.metaKey;
    if (!hitId) {
      // (With Ctrl held, the click may be on a highlight, which then joins the selection: the App sees to that.)
      if (!toggle) this.clearSelection();
      if (target?.closest('.textLayer')) this.textSelectionStarted();
      return;
    }
    const id = this.pick(e.clientX, e.clientY) ?? hitId;
    if (toggle || e.shiftKey) {
      // Ctrl+click adds it to the selection (or takes it out); Shift+click selects up to it.
      e.preventDefault();
      this.viewer.container.focus({ preventScroll: true });
      this.clickOn({ kind: 'drawing', id }, e.shiftKey ? 'range' : 'toggle');
      this.gesture = { kind: 'tap', pointerId: e.pointerId, pageIndex: -1, client };
      this.capture(e.pointerId);
      return;
    }
    this.startPress(e, id, false);
  }

  /**
   * The select tool. A press on a drawing or text box selects it, and a drag moves it with
   * everything else that is selected. A press anywhere else starts a rectangle that selects what
   * it touches. Ctrl adds to the selection (or takes out of it), Shift selects a range.
   */
  private selectPointerDown(e: PointerEvent, target: Element | null, client: [number, number]): void {
    const c = this.viewer.container;
    // (A press on the scrollbar of the pages is not a press on them.)
    if (target === c && (e.offsetX >= c.clientWidth || e.offsetY >= c.clientHeight)) return;
    if (target && !c.contains(target)) return;
    e.preventDefault();
    c.focus({ preventScroll: true });
    const toggle = e.ctrlKey || e.metaKey;
    const adding = toggle || e.shiftKey;
    const pageIndex = this.viewer.pageIndexAt(e.clientX, e.clientY);
    if (pageIndex !== undefined && !adding) {
      const handle = this.handleAt(pageIndex, e.clientX, e.clientY);
      if (handle && this.startResize(e, handle.id, handle.side)) return;
    }
    const hit = this.itemAt(e.clientX, e.clientY);
    if (hit && adding) {
      this.clickOn(hit, e.shiftKey ? 'range' : 'toggle');
      this.gesture = { kind: 'tap', pointerId: e.pointerId, pageIndex: -1, client };
      this.capture(e.pointerId);
      return;
    }
    if (hit?.kind === 'drawing') {
      this.startPress(e, hit.id, false);
      return;
    }
    this.gesture = {
      kind: 'marquee',
      pointerId: e.pointerId,
      pageIndex: -1,
      start: [e.clientX + c.scrollLeft, e.clientY + c.scrollTop],
      before: this.selection,
      adding,
      click: hit,
      moving: false,
      client,
    };
    this.capture(e.pointerId);
  }

  /**
   * A press on the text of a page starts a text selection. Until the button is released, drawings
   * and text boxes let the pointer through: a selection dragged across one would otherwise jump
   * to the end of the page (they are above the text, and after it in the document).
   */
  private textSelectionStarted(): void {
    document.body.classList.add('mpv-selecting-text');
    const done = () => {
      document.body.classList.remove('mpv-selecting-text');
      window.removeEventListener('pointerup', done, true);
      window.removeEventListener('pointercancel', done, true);
      window.removeEventListener('blur', done);
    };
    window.addEventListener('pointerup', done, true);
    window.addEventListener('pointercancel', done, true);
    window.addEventListener('blur', done);
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
    this.clearSelection();
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
    const start = drawing ? this.toPage(drawing.pageIndex, e.clientX, e.clientY) : undefined;
    if (!drawing || !start) return;
    e.preventDefault();
    this.viewer.container.focus({ preventScroll: true });
    this.gesture = {
      kind: 'press',
      pointerId: e.pointerId,
      pageIndex: drawing.pageIndex,
      id,
      // A press on one of several selected things moves them all.
      ids: this.picked.has(id) && this.picked.size > 1 ? [...this.picked] : [id],
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
    this.pointerAt = [e.clientX, e.clientY];
    if (this.modeValue === 'draw' && this.toolValue === 'eraser' && (!g || e.pointerId === g.pointerId)) {
      if (g) g.client = [e.clientX, e.clientY];
      this.placeRing();
    }
    if (!g) {
      if (this.modeValue === 'select' && e.buttons === 0) this.hoverSelect(e);
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
    if (g.kind === 'rub') this.rubTo(g, x, y);
    else if (g.kind === 'press') this.pressMove(g, x, y);
    else if (g.kind === 'create') this.createMove(g, x, y);
    else if (g.kind === 'resize') this.resizeMove(g, x, y);
    else if (g.kind === 'marquee') this.marqueeMove(g, x, y);
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
    // A finger or a pen that lifts leaves no pointer over the page.
    this.pointerAt = e.pointerType === 'mouse' ? [e.clientX, e.clientY] : undefined;
    this.placeRing();
    queueMicrotask(() => this.gestureEnded());
    if (g.kind === 'draw') {
      if (g.tool !== 'pen') g.shift = e.shiftKey;
      this.finishDrawing(g);
    } else if (g.kind === 'rub') {
      this.finishRubbing(g);
    } else if (g.kind === 'press') {
      this.finishPress(g, e.clientX, e.clientY);
    } else if (g.kind === 'create') {
      this.finishCreate(g);
    } else if (g.kind === 'resize') {
      this.finishResize(g);
    } else if (g.kind === 'marquee') {
      this.finishMarquee(g);
    } else {
      this.takeClick();
    }
  }

  /** Esc, a lost pointer, a new document: drops the gesture in progress. True if there was one. */
  cancelGesture(): boolean {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = undefined;
    this.gestureEnded();
    this.release(g.pointerId);
    this.placeRing();
    this.preview = undefined;
    if (g.kind === 'rub') {
      // What was rubbed out comes back.
      for (const id of g.pieces) {
        this.drawings.delete(id);
        this.outlines.delete(id);
      }
      for (const drawing of g.originals.values()) this.drawings.set(drawing.id, drawing);
    }
    if (g.kind === 'marquee') {
      this.hideMarquee();
      this.setSelection(g.before.drawings, g.before.highlights);
    }
    // What was moving goes back to where it was.
    if (g.kind === 'press') for (const page of this.pagesOf(g.ids)) this.redraw(page);
    if (g.pageIndex >= 0) this.redraw(g.pageIndex);
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

  // ---------- Hit-testing ----------

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
    const alone = this.selectedId;
    const selected = alone ? this.drawings.get(alone) : undefined;
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

  // ---------- The rectangle of the select tool ----------

  /** The rectangle on screen (client coordinates): from where the press is now (the pages may have scrolled) to the pointer. */
  private marqueeRect(g: MarqueeGesture): [number, number, number, number] {
    const c = this.viewer.container;
    const sx = g.start[0] - c.scrollLeft;
    const sy = g.start[1] - c.scrollTop;
    return [Math.min(sx, g.client[0]), Math.min(sy, g.client[1]), Math.max(sx, g.client[0]), Math.max(sy, g.client[1])];
  }

  private marqueeMove(g: MarqueeGesture, clientX: number, clientY: number): void {
    g.client = [clientX, clientY];
    const [x0, y0, x1, y1] = this.marqueeRect(g);
    if (!g.moving) {
      if (Math.hypot(x1 - x0, y1 - y0) < CLICK_SLOP_PX) return;
      g.moving = true;
    }
    // Shown inside the area of the pages only (its first corner may have scrolled out of it).
    const c = this.viewer.container;
    const area = c.getBoundingClientRect();
    const left = Math.max(area.left, x0);
    const top = Math.max(area.top, y0);
    const right = Math.min(area.left + c.clientWidth, x1);
    const bottom = Math.min(area.top + c.clientHeight, y1);
    this.marquee.style.transform = `translate(${left}px, ${top}px)`;
    this.marquee.style.width = `${Math.max(0, right - left)}px`;
    this.marquee.style.height = `${Math.max(0, bottom - top)}px`;
    this.marquee.hidden = false;
    // What it takes is worked out once per frame.
    if (this.marqueeFrame) return;
    this.marqueeFrame = requestAnimationFrame(() => {
      this.marqueeFrame = 0;
      if (this.gesture === g) this.marqueeSelect(g);
    });
  }

  private hideMarquee(): void {
    this.marquee.hidden = true;
    if (this.marqueeFrame) cancelAnimationFrame(this.marqueeFrame);
    this.marqueeFrame = 0;
  }

  /** Selects what the rectangle touches: the stroke of a drawing, the box of a text box, a line of a highlight. */
  private marqueeSelect(g: MarqueeGesture): void {
    const rect = this.marqueeRect(g);
    const boxes = new Map<number, DOMRect | undefined>();
    /** The page's box on screen, if the rectangle reaches it. */
    const reached = (pageIndex: number): DOMRect | undefined => {
      if (!boxes.has(pageIndex)) boxes.set(pageIndex, this.pageBox(pageIndex));
      const box = boxes.get(pageIndex);
      return box && box.right >= rect[0] && box.left <= rect[2] && box.bottom >= rect[1] && box.top <= rect[3] ? box : undefined;
    };
    const drawings = new Set(g.adding ? g.before.drawings : []);
    for (const drawing of this.drawings.values()) {
      if (reached(drawing.pageIndex) && this.inRect(drawing, rect)) drawings.add(drawing.id);
    }
    const highlights = new Set(g.adding ? g.before.highlights : []);
    const touched = this.highlights.touching((pageIndex) => {
      const box = reached(pageIndex);
      return box ? [(rect[0] - box.left) / box.width, (rect[1] - box.top) / box.height, (rect[2] - box.left) / box.width, (rect[3] - box.top) / box.height] : undefined;
    });
    for (const id of touched) highlights.add(id);
    // (Only when it changed: every change draws pages again.)
    const same =
      drawings.size === this.picked.size &&
      highlights.size === this.pickedHighlights.size &&
      [...drawings].every((id) => this.picked.has(id)) &&
      [...highlights].every((id) => this.pickedHighlights.has(id));
    if (!same) this.setSelection(drawings, highlights);
  }

  /** Whether a rectangle on screen (client coordinates) touches a drawing (its stroke) or a text box (its box). */
  private inRect(drawing: Drawing, rect: [number, number, number, number]): boolean {
    const g = this.geometry(drawing.pageIndex);
    const a = this.toPage(drawing.pageIndex, rect[0], rect[1]);
    const b = this.toPage(drawing.pageIndex, rect[2], rect[3]);
    if (!g || !a || !b) return false;
    if (isTextDrawing(drawing)) {
      const [x0, y0, x1, y1] = this.pageRectOf(drawing, g);
      return x0 <= b[0] && x1 >= a[0] && y0 <= b[1] && y1 >= a[1];
    }
    const p = toPdfSpace(g, a);
    const q = toPdfSpace(g, b);
    return linesTouchRect(this.outline(drawing).lines, [p[0], p[1], q[0], q[1]], INK_WIDTH_PT[drawing.width] / 2);
  }

  private finishMarquee(g: MarqueeGesture): void {
    this.hideMarquee();
    this.takeClick();
    if (g.moving) {
      this.marqueeSelect(g);
      // The first one it took is where a Shift+click continues from.
      this.anchor = this.selectionInOrder()[0];
      return;
    }
    // A click: on a highlight, it is selected; on nothing, nothing is.
    if (g.click) this.clickOn(g.click, 'set', g.client);
    else if (!g.adding) this.clearSelection();
  }

  /** The select tool: the pointer says what a press would do (resize, move what is selected, select). */
  private hoverSelect(e: PointerEvent): void {
    const capture = (e.target as Element | null)?.closest?.(`.${CAPTURE}`) as HTMLElement | null;
    if (!capture) return;
    const pageIndex = this.pageUnder(capture);
    let cursor = '';
    if (pageIndex !== undefined && this.handleAt(pageIndex, e.clientX, e.clientY)) {
      cursor = 'ew-resize';
    } else {
      const hit = this.itemAt(e.clientX, e.clientY);
      if (hit) cursor = hit.kind === 'drawing' && this.picked.has(hit.id) ? 'move' : 'pointer';
    }
    capture.style.cursor = cursor;
  }

  // ---------- Rubbing out (the eraser of draw mode) ----------

  private rubTo(g: RubGesture, clientX: number, clientY: number): void {
    const p = this.toPdf(g.pageIndex, clientX, clientY, false);
    if (!p) return;
    const from = g.last ?? p;
    g.last = p;
    const px = this.pxPerUnit(g.pageIndex);
    const radius = RUBBER_PX[this.eraserWidthValue] / px;
    // Discs close together along the way from the last position stand in for the swept path.
    const steps = Math.min(400, Math.ceil(Math.hypot(p[0] - from[0], p[1] - from[1]) / (radius / 3)));
    let changed = false;
    for (let i = steps === 0 ? 0 : 1; i <= steps; i++) {
      const t = steps === 0 ? 1 : i / steps;
      if (this.rubAt(g, [from[0] + t * (p[0] - from[0]), from[1] + t * (p[1] - from[1])], radius, px)) changed = true;
    }
    if (changed) this.redraw(g.pageIndex);
  }

  /** Rubs out what is within `radius` of a point (PDF units). True if something changed. */
  private rubAt(g: RubGesture, at: PdfPoint, radius: number, px: number): boolean {
    let changed = false;
    for (const drawing of [...this.drawings.values()]) {
      if (drawing.pageIndex !== g.pageIndex || isTextDrawing(drawing)) continue;
      // The round end of what is left stops at the eraser's edge.
      const reach = radius + INK_WIDTH_PT[drawing.width] / 2;
      const [x0, y0, x1, y1] = this.outline(drawing).bounds;
      if (at[0] < x0 - reach || at[0] > x1 + reach || at[1] < y0 - reach || at[1] > y1 + reach) continue;
      const left = eraseShape(drawingShape(drawing), at, reach, CRUMB_PX / px);
      if (!left) continue;
      const pieces = left.map((points) => this.pieceOf(drawing, points)).filter((piece): piece is InkDrawing => piece !== undefined);
      if (this.drawings.size - 1 + pieces.length > MAX_DRAWINGS) {
        if (!g.full) this.events.notice(`This file has ${MAX_DRAWINGS} drawings and text boxes, the most it can have, so the eraser cannot split this one.`);
        g.full = true;
        continue;
      }
      changed = true;
      this.drawings.delete(drawing.id);
      this.outlines.delete(drawing.id);
      if (!g.pieces.delete(drawing.id)) g.originals.set(drawing.id, drawing);
      for (const piece of pieces) {
        this.drawings.set(piece.id, piece);
        g.pieces.add(piece.id);
      }
    }
    return changed;
  }

  /** What the eraser left of a drawing, as a drawing of its own: straight lines through the points. */
  private pieceOf(from: InkDrawing, raw: PdfPoint[]): InkDrawing | undefined {
    const rounded = raw.map(([x, y]): PdfPoint => [round2(x), round2(y)]).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    if (rounded.length < 2) return undefined;
    const piece: InkDrawing = {
      id: crypto.randomUUID(),
      tool: 'pen',
      color: from.color,
      width: from.width,
      pageIndex: from.pageIndex,
      points: fitStroke(rounded).points,
      polyline: true,
      createdAt: from.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (from.textModelHash) piece.textModelHash = from.textModelHash;
    return piece;
  }

  private finishRubbing(g: RubGesture): void {
    const removed = [...g.originals.values()];
    if (removed.length === 0) return;
    const added = [...g.pieces].map((id) => this.drawings.get(id)).filter((d): d is InkDrawing => d !== undefined && !isTextDrawing(d));
    for (const id of g.originals.keys()) this.unpick(id);
    this.events.rubbed(
      removed.map((d) => structuredClone(d)),
      added.map((d) => structuredClone(d)),
    );
    this.events.changed();
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

  private pagesOf(ids: string[]): Set<number> {
    const pages = new Set<number>();
    for (const id of ids) {
      const page = this.drawings.get(id)?.pageIndex;
      if (page !== undefined) pages.add(page);
    }
    return pages;
  }

  private pressMove(g: PressGesture, clientX: number, clientY: number): void {
    if (!g.moving) {
      if (Math.hypot(clientX - g.startClient[0], clientY - g.startClient[1]) < CLICK_SLOP_PX) return;
      g.moving = true;
      // Selected while it moves (the dashed outline), without its popover.
      if (!this.picked.has(g.id)) this.setSelection([g.id]);
      else this.events.selectionChanged(this.selectedId, false);
    }
    const p = this.toPage(g.pageIndex, clientX, clientY);
    if (!p) return;
    // Everything that moves stays on its page, and the group keeps its shape.
    const across: [number, number][] = [];
    const down: [number, number][] = [];
    for (const id of g.ids) {
      const drawing = this.drawings.get(id);
      const geometry = drawing ? this.geometry(drawing.pageIndex) : undefined;
      if (!drawing || !geometry) continue;
      const [x0, y0, x1, y1] = this.moveRect(drawing, geometry);
      across.push([-x0, geometry.width - x1]);
      down.push([-y0, geometry.height - y1]);
    }
    g.delta = [clampGroupMove(p[0] - g.start[0], across), clampGroupMove(p[1] - g.start[1], down)];
    this.showMove(g);
  }

  /** Shows a move in progress. Drawings: by a transform on what is on the page already. A page where a text box moves is drawn again. */
  private showMove(g: PressGesture): void {
    for (const pageIndex of this.pagesOf(g.ids)) {
      const moving = g.ids.map((id) => this.drawings.get(id)).filter((d): d is Drawing => d?.pageIndex === pageIndex);
      const geometry = this.geometry(pageIndex);
      const layer = this.viewer.pageView(pageIndex)?.div.querySelector(`:scope > .${LAYER}`);
      if (!geometry || !layer || moving.some(isTextDrawing)) {
        this.redraw(pageIndex);
        continue;
      }
      const [dx, dy] = toPdfDelta(geometry.transform, g.delta);
      const transform = `translate(${dx} ${dy})`;
      for (const drawing of moving) {
        const group = layer.querySelector(`.mpv-drawing[data-id="${CSS.escape(drawing.id)}"]`);
        if (!group) {
          this.redraw(pageIndex);
          break;
        }
        group.setAttribute('transform', transform);
        layer.querySelector(`.mpv-drawing-selection[data-for="${CSS.escape(drawing.id)}"]`)?.setAttribute('transform', transform);
      }
    }
  }

  private finishPress(g: PressGesture, clientX: number, clientY: number): void {
    const drawing = this.drawings.get(g.id);
    if (!drawing) return;
    this.takeClick();
    const [dx, dy] = g.delta;
    if (!g.moving || (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005)) {
      for (const page of this.pagesOf(g.ids)) this.redraw(page);
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
        // (A click on one of several selected things leaves it selected alone.)
        this.clickOn({ kind: 'drawing', id: g.id }, 'set');
      }
      return;
    }
    const before: Drawing[] = [];
    const after: Drawing[] = [];
    const updatedAt = new Date().toISOString();
    const pages = new Set<number>();
    for (const id of g.ids) {
      const from = this.drawings.get(id);
      const geometry = from ? this.geometry(from.pageIndex) : undefined;
      if (!from || !geometry) continue;
      const [mx, my] = toPdfDelta(geometry.transform, g.delta);
      const to: Drawing = { ...from, points: from.points.map(([x, y]): PdfPoint => [round2(x + mx), round2(y + my)]), updatedAt };
      this.drawings.set(id, to);
      this.outlines.delete(id);
      pages.add(from.pageIndex);
      before.push(structuredClone(from));
      after.push(structuredClone(to));
    }
    for (const page of pages) this.redraw(page);
    // What moved stays selected; one thing alone gets its popover back (not in text mode, which has the text tray).
    this.events.selectionChanged(this.selectedId, this.modeValue !== 'text' && this.selectionCount === 1);
    this.events.moved(before, after);
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
    const lineHeight = this.lineHeight();
    // The click is at the middle of the first line.
    if (!dragged) y -= lineHeight / 2;
    y = Math.min(Math.max(0, y), geometry.height - lineHeight);
    x = Math.max(0, x);
    const anchor = toPdfSpace(geometry, [x, y]);
    const now = new Date().toISOString();
    const style = this.textStyleValue;
    const draft: TextDrawing = {
      id: crypto.randomUUID(),
      tool: 'text',
      pageIndex: g.pageIndex,
      points: [[round2(anchor[0]), round2(anchor[1])]],
      text: '',
      size: style.size,
      align: style.align,
      color: style.color,
      createdAt: now,
      updatedAt: now,
    };
    if (boxWidth !== undefined) draft.boxWidth = round2(boxWidth);
    const hash = this.highlights.textModel?.hash;
    if (hash) draft.textModelHash = hash;
    // What is typed gets the bold, italic and underline picked in the text bar.
    this.openEditor({ draft }, undefined, { bold: style.bold, italic: style.italic, underline: style.underline });
  }

  /** The height of one line of new text (points). */
  private lineHeight(): number {
    const { size, align, color } = this.textStyleValue;
    return this.measurer.measure({ size, align, color, text: '', boxWidth: undefined }).height;
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
    return edit ? this.withContent(edit.draft) : undefined;
  }

  /** A text box with the editor's text and styled parts. */
  private withContent(draft: TextDrawing): TextDrawing {
    const text: TextDrawing = { ...draft, text: this.editor.value };
    const spans = this.editor.spans;
    if (spans) text.spans = spans;
    else delete text.spans;
    return text;
  }

  /** Whether the keyboard is in the text box editor. */
  get editorFocused(): boolean {
    return this.edit !== undefined && document.activeElement === this.editor.element;
  }

  /** Bold, italic and underline where the reader is typing: at the caret (what is typed next), or of the selection. */
  get editingCharStyle(): CharStyle | undefined {
    return this.edit ? this.editor.charStyle : undefined;
  }

  /** Whether part of the text being typed is selected. */
  get editingSelection(): boolean {
    return this.edit !== undefined && this.editor.hasSelection;
  }

  /** Bold, italic or underline on the selected text, or for what is typed next. Returns the new state. */
  toggleEditingStyle(name: CharStyleName): boolean | undefined {
    return this.edit ? this.editor.toggle(name) : undefined;
  }

  /** Undo and redo while typing: the changes made in this text box since typing started. */
  editorUndo(): boolean {
    return this.edit !== undefined && this.editor.undo();
  }

  editorRedo(): boolean {
    return this.edit !== undefined && this.editor.redo();
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

  private openEditor(edit: TextEdit, caret?: number, typing?: CharStyle): void {
    this.cancelGesture();
    if (this.selectedId !== edit.draft.id) this.clearSelection();
    this.edit = edit;
    this.editor.show(edit.draft, caret, typing);
    this.placeEditor();
    this.redraw(edit.draft.pageIndex);
    this.events.editingChanged(this.editing);
  }

  /** Changes the size, alignment or color of the text box being typed in (part of the same edit). */
  setEditingStyle(patch: Partial<TextBoxStyle>): void {
    const edit = this.edit;
    if (!edit) return;
    const draft = this.withContent(edit.draft);
    if (patch.size !== undefined) draft.size = patch.size;
    if (patch.align !== undefined) draft.align = patch.align;
    if (patch.color !== undefined) draft.color = patch.color;
    edit.draft = draft;
    this.editor.restyle(draft);
    this.fitEditor();
    this.events.editingChanged(this.editing);
  }

  private onEditorInput(): void {
    const edit = this.edit;
    if (!edit) return;
    edit.draft = this.withContent(edit.draft);
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
    // The editor sizes itself to its text; an empty one still has room for the caret.
    this.editor.place(left, top, edit.draft.size * 0.6 + 2 * TEXT_PAD_X, scale);
  }

  /** Ends typing: stores the box (or drops it, if it has no text), and keeps it selected. */
  commitEditing(): void {
    const edit = this.edit;
    if (!edit) return;
    const value = this.editor.value;
    const styled = this.editor.spans;
    this.edit = undefined;
    this.editor.hide();
    const text = normalizeText(value);
    // (Styled parts count characters: they hold as long as the cleaned text is the start of what was typed.)
    const spans = value.startsWith(text) ? sanitizeSpans(styled, text.length) : undefined;
    const before = edit.before;
    const pageIndex = edit.draft.pageIndex;
    if (!text) {
      if (before && this.drawings.has(before.id)) {
        this.drawings.delete(before.id);
        this.unpick(before.id);
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
    if (spans) after.spans = spans;
    else delete after.spans;
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
