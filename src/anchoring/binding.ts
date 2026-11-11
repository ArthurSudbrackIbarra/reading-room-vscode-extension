// What a drawing or text box is attached to, and where it goes when that content moves.
//
// A binding is inferred from what the drawing covers when the reader makes, moves or resizes it
// (or chosen by the reader). The stored points never change by themselves: the binding remembers
// where its content was then, and the viewer maps the points to where the content is now.
import { applyMatrix, invertMatrix, round2, type Matrix, type PageGeometry, type PdfPoint } from '../shared/drawingGeometry';
import type { Drawing } from '../shared/drawings';
import { createAnchor, sanitizeAnchor, type AnchorState, type OrphanReason, type ResolutionKind, type TextAnchor } from './anchor';
import { boxCenter, boxHeight, boxWidth, overlapArea, unionBox, type Box, type DocumentLayout, type LineBox } from './layout';
import { resolveAnchor, type ResolveContext, type Resolution } from './resolve';
import { TEXT_MODEL_VERSION } from './textModel';

export const BINDING_MODES = ['text-stretch', 'text-pin', 'span', 'line', 'block', 'page'] as const;
export type BindingMode = (typeof BINDING_MODES)[number];
export type BindingFlag = 'reflowed' | 'clipped' | 'needs-review';

/** Beyond this ratio between horizontal and vertical stretch a drawing is pinned instead of stretched. */
export const STRETCH_MAX = 3;
/** Characters of a line kept as the anchor of a drawing bound to that line. */
export const LINE_QUOTE_LENGTH = 48;
/** Share of a drawing that must be over an image for it to be bound to the image. */
export const BLOCK_MIN_SHARE = 0.5;
/** How far (points) an end of a line or arrow may be from a word to be attached to it. */
export const SPAN_REACH = 14;
/** Characters (not counting spaces) from which a piece of text is long enough to be found again. */
export const TELLING_LENGTH = 12;
/** Change of an image's aspect ratio from which a drawing on it is flagged for review. */
export const ASPECT_TOLERANCE = 0.05;

export interface DrawingBinding {
  mode: BindingMode;
  /** The reader chose the mode; inferring again keeps it. */
  manual?: true;
  /** Text the drawing follows: one anchor (stretch, pin, line), two (span), the text after and before an image (block). */
  anchors: TextAnchor[];
  /** Where that content was when the drawing was bound, in page space of `page`. */
  ref: Box[];
  /** The page it was bound on, its size, and how its PDF units map to page space. */
  page: number;
  pageSize: [number, number];
  frame: Matrix;
  /**
   * Span: a mark beside lines (a margin bracket) follows them up and down only and is stretched
   * between the top of its first line and the bottom of its last; without this, both ends follow
   * their words in every direction (an arrow from one word to another).
   */
  beside?: true;
  /** Block: which image (its place among the page's images) and its width / height. */
  image?: { ordinal: number; aspect: number };
  /** Page: fingerprint of the page (PDF files). */
  pagePrint?: string;
  /** Bound against another version of the document than the one it was drawn on: worth a look. */
  review?: true;
  /** `updatedAt` of the drawing these numbers belong to. */
  for: string;
}

export interface BindTarget {
  tool: Drawing['tool'];
  page: number;
  /** Bounding box in page space. */
  box: Box;
  /** Page-space points of an ink drawing. */
  points?: PdfPoint[];
}

export interface BindOptions {
  /** Image boxes of the page, in the order they are drawn. */
  images?: Box[];
  /** What the reader asked for from the drawing's menu. */
  prefer?: 'text' | 'image' | 'page';
  pagePrint?: string;
}

function area(b: Box): number {
  return Math.max(0, boxWidth(b)) * Math.max(0, boxHeight(b));
}

function median(values: number[]): number {
  if (values.length === 0) return 12;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function distanceToBox([x, y]: PdfPoint, b: Box): number {
  const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0;
  const dy = y < b[1] ? b[1] - y : y > b[3] ? y - b[3] : 0;
  return Math.hypot(dx, dy);
}

/** The anchor of the start of a line: its first words, up to LINE_QUOTE_LENGTH characters. */
function lineAnchor(layout: DocumentLayout, line: LineBox): { anchor: TextAnchor; box: Box } | undefined {
  const text = layout.model.text;
  let end = Math.min(line.end, line.start + LINE_QUOTE_LENGTH);
  const space = text.lastIndexOf(' ', end);
  if (end < line.end && space > line.start + 12) end = space;
  while (end > line.start && text[end - 1] === ' ') end--;
  if (end <= line.start) return undefined;
  // The box of these very words: it is compared later with the box the same words have then.
  const box = layout.rangeBoxes(line.start, end)[0]?.boxes[0] ?? line.box;
  return { anchor: createAnchor(text, layout.model.hash, line.start, end), box };
}

/**
 * The anchor of the words of a line under a horizontal extent (the nearest word when none is).
 * With `telling`, the anchor takes in neighboring words until it is long enough to be found again
 * (a single letter of a formula is not), or the line is used up.
 */
function wordsAnchor(layout: DocumentLayout, page: number, line: LineBox, x0: number, x1: number, telling = false): { anchor: TextAnchor; box: Box } | undefined {
  const words = layout.words(page, line);
  if (words.length === 0) return undefined;
  let first = words.findIndex((w) => boxCenter(w.box)[0] >= x0 && boxCenter(w.box)[0] <= x1);
  let last = first;
  if (first < 0) {
    const middle = (x0 + x1) / 2;
    first = last = words.reduce((best, w, i) => (Math.abs(boxCenter(w.box)[0] - middle) < Math.abs(boxCenter(words[best].box)[0] - middle) ? i : best), 0);
  } else {
    while (last + 1 < words.length && boxCenter(words[last + 1].box)[0] <= x1) last++;
  }
  const length = () => words.slice(first, last + 1).reduce((sum, w) => sum + w.end - w.start, 0);
  while (telling && length() < TELLING_LENGTH && (first > 0 || last < words.length - 1)) {
    if (last < words.length - 1) last++;
    else first--;
  }
  const covered = words.slice(first, last + 1);
  return { anchor: createAnchor(layout.model.text, layout.model.hash, covered[0].start, covered[covered.length - 1].end), box: covered.map((w) => w.box).reduce(unionBox) };
}

const REAL_WORD = /[\p{L}\p{N}]{3,}/gu;

/**
 * Whether a line reads like text that can be found again: long enough, and with at least two
 * words of three letters or more. The symbols of a formula are neither, and the browser does not
 * always write them to the PDF in the same order.
 */
function telling(layout: DocumentLayout, line: LineBox): boolean {
  const text = layout.model.text.slice(line.start, line.end);
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) !== 32) n++;
  return n >= TELLING_LENGTH && (text.match(REAL_WORD)?.length ?? 0) >= 2;
}

/** The word nearest to a point, if one is within reach. */
function wordNear(layout: DocumentLayout, page: number, p: PdfPoint, reach: number): { anchor: TextAnchor; box: Box; start: number } | undefined {
  let best: { start: number; end: number; box: Box; distance: number } | undefined;
  for (const line of layout.lines(page)) {
    if (distanceToBox(p, line.box) > reach) continue;
    for (const w of layout.words(page, line)) {
      const distance = distanceToBox(p, w.box);
      if (distance <= reach && (!best || distance < best.distance)) best = { ...w, distance };
    }
  }
  if (!best) return undefined;
  return { anchor: createAnchor(layout.model.text, layout.model.hash, best.start, best.end), box: best.box, start: best.start };
}

/**
 * Decides what a drawing or text box is attached to from what it covers on its page. `for` is
 * filled in by the caller. Returns undefined when the page is unknown.
 */
export function inferBinding(target: BindTarget, layout: DocumentLayout, options: BindOptions = {}): Omit<DrawingBinding, 'for'> | undefined {
  const geometry = layout.geometry(target.page);
  if (!geometry) return undefined;
  const base = { page: target.page, pageSize: [geometry.width, geometry.height] as [number, number], frame: [...geometry.transform] as Matrix };
  const manual = options.prefer ? { manual: true as const } : {};
  const pageBinding = (): Omit<DrawingBinding, 'for'> => ({ mode: 'page', ...manual, anchors: [], ref: [], ...base, ...(options.pagePrint ? { pagePrint: options.pagePrint } : {}) });
  if (options.prefer === 'page') return pageBinding();

  const { box } = target;
  const lines = layout.lines(target.page);
  const lineHeight = median(lines.map((l) => boxHeight(l.box)));
  const isText = target.tool === 'text';
  const images = options.images ?? [];
  const points = target.points ?? [];
  const sideways = layout.sideways(target.page);

  // A line or an arrow from one word to another (also across a picture between them).
  if ((target.tool === 'line' || target.tool === 'arrow') && points.length === 2 && options.prefer !== 'image' && !sideways) {
    const onImage = (p: PdfPoint) => images.some((image) => distanceToBox(p, image) === 0);
    const tail = onImage(points[0]) ? undefined : wordNear(layout, target.page, points[0], SPAN_REACH);
    const head = onImage(points[1]) ? undefined : wordNear(layout, target.page, points[1], SPAN_REACH);
    const sameLine = tail && head && Math.abs(boxCenter(tail.box)[1] - boxCenter(head.box)[1]) < 0.5 * lineHeight;
    const flat = Math.abs(points[0][1] - points[1][1]) < 0.5 * lineHeight && sameLine;
    if (tail && head && tail.start !== head.start && !flat) {
      return { mode: 'span', ...manual, anchors: [tail.anchor, head.anchor], ref: [tail.box, head.box], ...base };
    }
  }

  // An image under most of it.
  if (options.prefer !== 'text' && images.length > 0) {
    let best: { index: number; share: number; distance: number } | undefined;
    images.forEach((image, index) => {
      const share = overlapArea(box, image) / Math.max(1, area(box));
      const distance = distanceToBox(boxCenter(box), image);
      if (!best || share > best.share || (share === best.share && distance < best.distance)) best = { index, share, distance };
    });
    if (best && (best.share >= BLOCK_MIN_SHARE || options.prefer === 'image')) {
      const image = images[best.index];
      // The text right after the image and right before it tell which image it is in a later version.
      const after = lines.find((l) => l.box[1] >= image[3] - 1);
      const before = [...lines].reverse().find((l) => l.box[3] <= image[1] + 1);
      const anchors = [after, before].map((l) => (l ? lineAnchor(layout, l)?.anchor : undefined)).filter((a): a is TextAnchor => a !== undefined);
      return {
        mode: 'block',
        ...manual,
        anchors,
        ref: [image],
        ...base,
        image: { ordinal: best.index, aspect: round2(boxWidth(image) / Math.max(1, boxHeight(image))) },
      };
    }
  }
  // No text, or text that runs sideways on the page as shown (its lines are not rows): the page itself.
  if (lines.length === 0 || sideways) return pageBinding();

  // A thin, flat stroke belongs to one line: the one it strikes through or underlines.
  const thin = boxHeight(box) < 0.6 * lineHeight;
  const middle = boxCenter(box)[1];
  const reaches = (line: LineBox): boolean => {
    const h = boxHeight(line.box);
    if (thin) return middle >= line.box[1] + 0.25 * h && middle <= line.box[3] + 0.35 * h;
    return Math.min(box[3], line.box[3]) - Math.max(box[1], line.box[1]) >= 0.4 * h;
  };
  const beside = lines.filter(reaches);
  const over = beside.filter((l) => Math.min(box[2], l.box[2]) - Math.max(box[0], l.box[0]) > 0);
  /** The line nearest to the drawing; lines with enough text to be found again come first. */
  const nearestLine = (): LineBox => {
    const cy = boxCenter(box)[1];
    const nearer = (best: LineBox, l: LineBox) => (Math.abs(boxCenter(l.box)[1] - cy) < Math.abs(boxCenter(best.box)[1] - cy) ? l : best);
    const wordy = lines.filter((l) => telling(layout, l));
    return (wordy.length > 0 ? wordy : lines).reduce(nearer);
  };
  const toLine = (line: LineBox | undefined): Omit<DrawingBinding, 'for'> => {
    const made = lineAnchor(layout, line && telling(layout, line) ? line : nearestLine());
    return made ? { mode: 'line', ...manual, anchors: [made.anchor], ref: [made.box], ...base } : pageBinding();
  };
  /** Pinned to words of the first line under it that has enough text; else it follows the nearest such line. */
  const toWords = (): Omit<DrawingBinding, 'for'> => {
    const line = over.find((l) => telling(layout, l));
    const made = line ? wordsAnchor(layout, target.page, line, box[0], box[2], true) : undefined;
    return made ? { mode: 'text-pin', ...manual, anchors: [made.anchor], ref: [made.box], ...base } : toLine(over[0] ?? beside[0]);
  };

  if (isText) {
    // A text box sits on or next to what it comments on: it follows that text and never stretches.
    return over.length === 0 ? toLine(beside[0]) : toWords();
  }

  // A tall, narrow mark beside several lines: a margin bracket.
  const tall = boxHeight(box) >= 1.8 * lineHeight && boxWidth(box) <= Math.max(24, 0.35 * boxHeight(box));
  if (tall && beside.length >= 2) {
    const inText = over.reduce((sum, l) => sum + Math.max(0, Math.min(box[2], l.box[2]) - Math.max(box[0], l.box[0])), 0) / Math.max(1, over.length * Math.max(1, boxWidth(box)));
    if (over.length === 0 || inText <= 0.3) {
      const top = lineAnchor(layout, beside[0]);
      const bottom = lineAnchor(layout, beside[beside.length - 1]);
      if (top && bottom) return { mode: 'span', beside: true, ...manual, anchors: [top.anchor, bottom.anchor], ref: [top.box, bottom.box], ...base };
    }
  }
  if (over.length === 1 && boxHeight(box) <= 2.5 * lineHeight) {
    const made = wordsAnchor(layout, target.page, over[0], box[0], box[2]);
    if (made) return { mode: 'text-stretch', ...manual, anchors: [made.anchor], ref: [made.box], ...base };
  }
  if (over.length >= 1) return toWords();
  return toLine(beside[0]);
}

// ---------- Resolving ----------

export interface Placement {
  status: 'anchored' | 'orphaned';
  reason?: OrphanReason;
  /** What happened to the text it follows. */
  kind?: ResolutionKind;
  page?: number;
  /** Maps page-space points of the page it was bound on to page-space points of `page`. */
  map?: (p: PdfPoint) => PdfPoint;
  flags: BindingFlag[];
  /** Orphans: where its content was, for "Place here". */
  tombstone?: { page: number; y: number };
  /** The states of its anchors, to keep for the next render. */
  states: (AnchorState | undefined)[];
}

export interface PlaceOptions {
  /** Image boxes of a page (page space), in the order they are drawn. */
  images?(page: number): Promise<Box[]> | Box[];
  /** PDF files: where a page of the last version that was stored is now (undefined: gone). */
  pageMap?(page: number): number | undefined;
  /** PDF files: the page that has this fingerprint now, if any. */
  findPage?(print: string): number | undefined;
}

/** The state that remembers which page a page-bound drawing (or marker) is on in a version. */
export function pageState(hash: string, page: number, kind: ResolutionKind): AnchorState {
  return { status: 'anchored', kind, resolvedIn: hash, found: { hash, v: TEXT_MODEL_VERSION, length: -1, start: 0, end: 1, page } };
}

const identity = (p: PdfPoint): PdfPoint => p;
const translate =
  (dx: number, dy: number) =>
  ([x, y]: PdfPoint): PdfPoint => [x + dx, y + dy];

function snap(scale: number): number {
  return Math.abs(scale - 1) < 0.005 ? 1 : scale;
}

interface Located {
  resolution: Resolution;
  page?: number;
  /** One box per line of the anchor's text, on its first page. */
  boxes?: Box[];
}

function locate(anchor: TextAnchor, state: AnchorState | undefined, ctx: ResolveContext, layout: DocumentLayout): Located {
  const resolution = resolveAnchor(anchor, state, ctx);
  if (resolution.status !== 'anchored') return { resolution };
  const first = layout.rangeBoxes(resolution.start!, resolution.end!)[0];
  return first ? { resolution, page: first.page, boxes: first.boxes } : { resolution };
}

function tombstoneOf(resolution: Resolution, layout: DocumentLayout): { page: number; y: number } | undefined {
  const offset = resolution.tombstone ?? resolution.candidate?.start;
  if (offset === undefined) return undefined;
  const at = layout.lineOf(offset);
  return at ? { page: at.page, y: at.line.box[1] } : undefined;
}

/**
 * Finds where a bound drawing goes in the current document. The result carries a mapping for the
 * drawing's page-space points; it never changes the binding or the drawing.
 */
export async function resolveBinding(
  binding: DrawingBinding,
  states: readonly (AnchorState | undefined)[],
  ctx: ResolveContext,
  layout: DocumentLayout,
  options: PlaceOptions = {},
): Promise<Placement> {
  const flags: BindingFlag[] = binding.review ? ['needs-review'] : [];
  const orphan = (reason: OrphanReason, kept: (AnchorState | undefined)[], resolution?: Resolution): Placement => ({
    status: 'orphaned',
    reason,
    flags,
    states: kept,
    ...(resolution && tombstoneOf(resolution, layout) ? { tombstone: tombstoneOf(resolution, layout) } : {}),
  });

  if (binding.mode === 'page') {
    // Its page in the last stored version (the binding's own page number is from when it was bound).
    const last = states[0]?.found?.page ?? binding.page;
    let page = options.pageMap ? options.pageMap(last) : last;
    // Not where it should be: look for the page itself (it may have come back, or moved far).
    if (page === undefined && binding.pagePrint && options.findPage) page = options.findPage(binding.pagePrint);
    if (page === undefined || page < 0 || page >= layout.pageCount) return orphan('page-missing', [...states]);
    const kind = page === last ? 'exact' : 'shifted';
    return { status: 'anchored', kind, page, map: identity, flags, states: [pageState(ctx.current.hash, page, kind)] };
  }

  const located = binding.anchors.map((anchor, i) => locate(anchor, states[i], ctx, layout));
  const kept = located.map((l) => l.resolution.state);
  const ref = binding.ref;

  if (binding.mode === 'block') {
    const image = await findImage(binding, located, layout, options);
    if (!image) {
      const lost = located.find((l) => l.resolution.status === 'orphaned')?.resolution;
      return orphan(lost?.reason ?? 'deleted', kept, lost);
    }
    const from = ref[0];
    const sx = boxWidth(image.box) / Math.max(1e-6, boxWidth(from));
    const sy = boxHeight(image.box) / Math.max(1e-6, boxHeight(from));
    if (Math.abs(sx / sy - 1) > ASPECT_TOLERANCE && !flags.includes('needs-review')) flags.push('needs-review');
    const moved = image.page !== binding.page || Math.abs(image.box[0] - from[0]) > 0.01 || Math.abs(image.box[1] - from[1]) > 0.01 || snap(sx) !== 1 || snap(sy) !== 1;
    return {
      status: 'anchored',
      kind: moved ? 'shifted' : 'exact',
      page: image.page,
      map: ([x, y]) => [image.box[0] + (x - from[0]) * snap(sx), image.box[1] + (y - from[1]) * snap(sy)],
      flags,
      states: kept,
    };
  }

  const first = located[0];
  if (!first || !ref[0]) return orphan('invalid', kept);

  if (binding.mode === 'span') {
    const second = located[1];
    const a = first.boxes?.[0];
    // A bracket ends where its last line ends (the last part of that line's words, if they wrap now).
    const b = binding.beside ? second?.boxes?.[second.boxes.length - 1] : second?.boxes?.[0];
    if (!a && !b) return orphan(first.resolution.reason ?? 'not-found', kept, first.resolution);
    if (!a || !b || first.page !== second!.page || !ref[1]) {
      // One end is gone, or the two ends are on different pages now: keep it by the end that is left.
      const side = a ? 0 : 1;
      const box = (a ?? b)!;
      flags.push('reflowed');
      return {
        status: 'anchored',
        kind: located[side].resolution.kind,
        page: located[side].page,
        map: translate(box[0] - ref[side][0], box[1] - ref[side][1]),
        flags,
        states: kept,
      };
    }
    if (binding.beside) {
      // Up and down with its lines, stretched between the top of the first and the bottom of the last.
      const top = ref[0][1];
      const height = ref[1][3] - top;
      const scale = height > 0.5 ? snap((b[3] - a[1]) / height) : 1;
      const size = layout.pageSize(first.page!) ?? binding.pageSize;
      const widthChange = size[0] - binding.pageSize[0];
      return {
        status: 'anchored',
        kind: worse(first.resolution.kind, second!.resolution.kind),
        page: first.page,
        map: ([x, y]) => [x > binding.pageSize[0] / 2 ? x + widthChange : x, a[1] + (y - top) * scale],
        flags,
        states: kept,
      };
    }
    const c1 = boxCenter(ref[0]);
    const c2 = boxCenter(ref[1]);
    const d1: PdfPoint = [boxCenter(a)[0] - c1[0], boxCenter(a)[1] - c1[1]];
    const d2: PdfPoint = [boxCenter(b)[0] - c2[0], boxCenter(b)[1] - c2[1]];
    const ax = c2[0] - c1[0];
    const ay = c2[1] - c1[1];
    const length2 = ax * ax + ay * ay;
    const map =
      length2 < 1
        ? translate(d1[0], d1[1])
        : ([x, y]: PdfPoint): PdfPoint => {
            const t = Math.max(0, Math.min(1, ((x - c1[0]) * ax + (y - c1[1]) * ay) / length2));
            return [x + (1 - t) * d1[0] + t * d2[0], y + (1 - t) * d1[1] + t * d2[1]];
          };
    return { status: 'anchored', kind: worse(first.resolution.kind, second!.resolution.kind), page: first.page, map, flags, states: kept };
  }

  if (first.resolution.status !== 'anchored' || !first.boxes?.length || first.page === undefined) {
    return orphan(first.resolution.reason ?? 'not-found', kept, first.resolution);
  }
  const from = ref[0];
  const now = first.boxes[0];
  const kind = first.resolution.kind;

  if (binding.mode === 'line') {
    // It moves up and down with its line and keeps its distance from the page edge. When the page
    // got wider or narrower, what is right of the middle keeps its distance from the right edge.
    const size = layout.pageSize(first.page) ?? binding.pageSize;
    const widthChange = size[0] - binding.pageSize[0];
    const dy = now[1] - from[1];
    return {
      status: 'anchored',
      kind,
      page: first.page,
      map: ([x, y]) => [x > binding.pageSize[0] / 2 ? x + widthChange : x, y + dy],
      flags,
      states: kept,
    };
  }

  if (binding.mode === 'text-stretch' && first.boxes.length === 1) {
    const sx = snap(boxWidth(now) / Math.max(1e-6, boxWidth(from)));
    const sy = snap(boxHeight(now) / Math.max(1e-6, boxHeight(from)));
    if (Math.max(sx / sy, sy / sx) <= STRETCH_MAX) {
      return { status: 'anchored', kind, page: first.page, map: ([x, y]) => [now[0] + (x - from[0]) * sx, now[1] + (y - from[1]) * sy], flags, states: kept };
    }
    flags.push('reflowed');
  } else if (binding.mode === 'text-stretch') {
    // Its words wrap onto more lines now: keep it on the first part.
    flags.push('reflowed');
  }
  return { status: 'anchored', kind, page: first.page, map: translate(now[0] - from[0], now[1] - from[1]), flags, states: kept };
}

function worse(a: ResolutionKind | undefined, b: ResolutionKind | undefined): ResolutionKind | undefined {
  const order: (ResolutionKind | undefined)[] = ['exact', 'shifted', 'moved', 'edited', 'partial'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** Finds the image a drawing was on: by the text after it, the text before it, then its place on the page. */
async function findImage(binding: DrawingBinding, located: Located[], layout: DocumentLayout, options: PlaceOptions): Promise<{ page: number; box: Box } | undefined> {
  const imagesOf = async (page: number): Promise<Box[]> => (page >= 0 && page < layout.pageCount && options.images ? await options.images(page) : []);
  const wanted = binding.image?.aspect;
  // The text around it says which image it is; its shape only rules out a very different one.
  const fits = (box: Box): boolean => {
    if (wanted === undefined) return true;
    const ratio = boxWidth(box) / Math.max(1, boxHeight(box)) / wanted;
    return ratio >= 0.5 && ratio <= 2;
  };
  const [after, before] = located;
  // Of several images side by side (the boxes of a diagram), the one that is where this one was
  // from left to right.
  const was = binding.ref[0];
  const across = (box: Box): number => (was ? Math.abs(boxCenter(box)[0] - boxCenter(was)[0]) : 0);
  /** The nearest row of images (by `edge`: 3 for bottoms going up, 1 for tops going down), then the one in the same place across. */
  const nearest = (boxes: Box[], edge: 1 | 3): Box | undefined => {
    const sorted = boxes.filter(fits).sort((a, b) => (edge === 3 ? b[3] - a[3] : a[1] - b[1]));
    if (sorted.length === 0) return undefined;
    const row = sorted.filter((b) => Math.abs(b[edge] - sorted[0][edge]) <= 4);
    return row.reduce((best, b) => (across(b) < across(best) ? b : best));
  };
  /** Whether no line of text stands between two heights of a page: the image is right next to its text. */
  const clear = (page: number, from: number, to: number): boolean => !layout.lines(page).some((l) => l.box[1] >= from - 1 && l.box[3] <= to + 1);
  // The text after the image: the image right above that line (or at the end of the page before).
  if (after?.resolution.status === 'anchored' && after.page !== undefined && after.boxes?.length) {
    const top = after.boxes[0][1];
    const page = after.page;
    const above = nearest((await imagesOf(page)).filter((b) => b[3] <= top + 2 && clear(page, b[3], top)), 3);
    if (above) return { page, box: above };
    if (clear(page, 0, top)) {
      const previous = nearest((await imagesOf(page - 1)).filter((b) => clear(page - 1, b[3], Number.MAX_SAFE_INTEGER)), 3);
      if (previous) return { page: page - 1, box: previous };
    }
  }
  // The text before it: the image right below that line (or at the start of the page after).
  if (before?.resolution.status === 'anchored' && before.page !== undefined && before.boxes?.length) {
    const bottom = before.boxes[before.boxes.length - 1][3];
    const page = before.page;
    const below = nearest((await imagesOf(page)).filter((b) => b[1] >= bottom - 2 && clear(page, bottom, b[1])), 1);
    if (below) return { page, box: below };
    if (clear(page, bottom, Number.MAX_SAFE_INTEGER)) {
      const next = nearest((await imagesOf(page + 1)).filter((b) => clear(page + 1, 0, b[1])), 1);
      if (next) return { page: page + 1, box: next };
    }
  }
  // No text around it to go by (a page of images): the same place among the images of the same page.
  if (located.every((l) => l.resolution.status !== 'anchored')) {
    const page = options.pageMap ? options.pageMap(binding.page) : binding.page;
    if (page === undefined || located.length > 0) return undefined;
    const same = (await imagesOf(page))[binding.image?.ordinal ?? 0];
    if (same && fits(same)) return { page, box: same };
  }
  return undefined;
}

/**
 * The drawing as it is shown: its points mapped to where its content is now. Returns the drawing
 * itself when nothing moved. `size` is a text box's size on the page, to keep all of it inside.
 */
export function placeDrawing<T extends Drawing>(
  drawing: T,
  binding: DrawingBinding,
  placement: Placement,
  target: PageGeometry,
  size?: { width: number; height: number },
): { drawing: T; clipped: boolean } {
  if (placement.status !== 'anchored' || placement.page === undefined || !placement.map) return { drawing, clipped: false };
  let mapped = drawing.points.map((p) => placement.map!(applyMatrix(binding.frame, p)));
  const xs = mapped.map((p) => p[0]);
  const ys = mapped.map((p) => p[1]);
  const box: Box = size ? [mapped[0][0], mapped[0][1], mapped[0][0] + size.width, mapped[0][1] + size.height] : [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const shift = (low: number, high: number, limit: number): number => (high - low >= limit ? -low : low < 0 ? -low : high > limit ? limit - high : 0);
  const dx = shift(box[0], box[2], target.width);
  const dy = shift(box[1], box[3], target.height);
  const clipped = Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01;
  if (clipped) mapped = mapped.map(([x, y]): PdfPoint => [x + dx, y + dy]);
  const back = invertMatrix(target.transform);
  let points = mapped.map((p): PdfPoint => {
    const [x, y] = applyMatrix(back, p);
    return [round2(x), round2(y)];
  });
  if ((drawing.tool === 'rect' || drawing.tool === 'ellipse') && points.length === 2) {
    const [[ax, ay], [bx, by]] = points;
    points = [
      [Math.min(ax, bx), Math.min(ay, by)],
      [Math.max(ax, bx), Math.max(ay, by)],
    ];
  }
  const same = placement.page === drawing.pageIndex && points.length === drawing.points.length && points.every((p, i) => Math.abs(p[0] - drawing.points[i][0]) <= 0.011 && Math.abs(p[1] - drawing.points[i][1]) <= 0.011);
  if (same) return { drawing, clipped };
  return { drawing: { ...drawing, pageIndex: placement.page, points }, clipped };
}

// ---------- Storage ----------

function isBox(value: unknown): value is Box {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7);
}

/** A clean copy of a binding from untrusted input, or undefined if it is not usable. */
export function sanitizeBinding(value: unknown): DrawingBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const b = value as Record<string, unknown>;
  if (typeof b.mode !== 'string' || !(BINDING_MODES as readonly string[]).includes(b.mode)) return undefined;
  if (typeof b.page !== 'number' || !Number.isInteger(b.page) || b.page < 0 || b.page > 100_000) return undefined;
  const frame = b.frame;
  if (!Array.isArray(frame) || frame.length !== 6 || !frame.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  if (Math.abs(frame[0] * frame[3] - frame[1] * frame[2]) < 1e-9) return undefined;
  const size = b.pageSize;
  if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return undefined;
  const anchors = (Array.isArray(b.anchors) ? b.anchors : []).map(sanitizeAnchor).filter((a): a is TextAnchor => a !== undefined).slice(0, 2);
  const ref = (Array.isArray(b.ref) ? b.ref : []).filter(isBox).slice(0, 2);
  const mode = b.mode as BindingMode;
  const needed = mode === 'page' ? 0 : mode === 'span' ? 2 : 1;
  if (ref.length < needed || (mode !== 'block' && anchors.length < needed)) return undefined;
  const binding: DrawingBinding = {
    mode,
    anchors,
    ref: ref.map((r) => [...r] as Box),
    page: b.page,
    pageSize: [size[0], size[1]],
    frame: [...frame] as Matrix,
    for: typeof b.for === 'string' ? b.for : '',
  };
  if (b.manual === true) binding.manual = true;
  if (b.beside === true && mode === 'span') binding.beside = true;
  if (b.review === true) binding.review = true;
  if (typeof b.pagePrint === 'string') binding.pagePrint = b.pagePrint.slice(0, 128);
  const image = b.image as Record<string, unknown> | undefined;
  if (image && typeof image.ordinal === 'number' && Number.isInteger(image.ordinal) && image.ordinal >= 0 && typeof image.aspect === 'number' && image.aspect > 0 && Number.isFinite(image.aspect)) {
    binding.image = { ordinal: image.ordinal, aspect: image.aspect };
  }
  return binding;
}
