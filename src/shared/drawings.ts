// Drawings: pen strokes, simple shapes and text boxes on a page. The data model, its limits and
// its validation, shared by the host (storage, export) and the viewer. No runtime dependencies.
// Text boxes are drawings too: they share the list, the storage, selecting, moving and undo.
import { sanitizeState, type AnchorState } from '../anchoring/anchor';
import { sanitizeBinding, type DrawingBinding } from '../anchoring/binding';
import { DEFAULT_INK, isInk, sanitizeInk, type Ink } from './colors';
import { round2, simplifyPoints, type PdfPoint, type Shape } from './drawingGeometry';
import { CHAR_STYLES, rangeStyle, sanitizeSpans, styleRange, type CharStyle, type TextSpan } from './richText';

export type { PdfPoint } from './drawingGeometry';
export type { Ink } from './colors';

export const DRAWING_TOOLS = ['pen', 'line', 'arrow', 'rect', 'ellipse'] as const;
/** The tools that draw with ink. */
export type DrawingTool = (typeof DRAWING_TOOLS)[number];
/** What a drag does in draw mode: draw with one of the tools, or erase. */
export type DrawTool = DrawingTool | 'eraser';
export const DRAW_TOOLS: readonly DrawTool[] = [...DRAWING_TOOLS, 'eraser'];
export const DEFAULT_DRAW_TOOL: DrawTool = 'pen';

/** Names shown in the list and in messages. */
export const TOOL_NAMES: Record<DrawingTool | 'text', string> = {
  pen: 'Freehand',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text box',
};

export const INK_WIDTHS = ['thin', 'medium', 'thick'] as const;
export type InkWidth = (typeof INK_WIDTHS)[number];
export const DEFAULT_INK_WIDTH: InkWidth = 'medium';
/** Stroke widths in PDF points; they scale with the zoom like the rest of the page. */
export const INK_WIDTH_PT: Record<InkWidth, number> = { thin: 1, medium: 2, thick: 4 };
export const WIDTH_NAMES: Record<InkWidth, string> = { thin: 'Thin', medium: 'Medium', thick: 'Thick' };

/** Most points kept for one pen stroke; longer strokes are simplified further (never cut). */
export const MAX_STROKE_POINTS = 2000;
/** Most drawings (text boxes included) one document can have. */
export const MAX_DRAWINGS = 5000;
/** Coordinates beyond this are not a page position. */
const MAX_COORDINATE = 1e6;

// ---------- Text boxes ----------

export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export const ALIGN_NAMES: Record<TextAlign, string> = { left: 'Align left', center: 'Center', right: 'Align right', justify: 'Justify' };

/** The look of a whole text box. */
export interface TextBoxStyle {
  /** Font size in PDF points. */
  size: number;
  align: TextAlign;
  color: Ink;
}

/**
 * A text style as the text bar shows and sets it: the box's own, plus bold, italic and underline,
 * which belong to the characters (of a box: whether all of its text has them; for new text:
 * whether what is typed next gets them).
 */
export interface TextStyle extends TextBoxStyle, CharStyle {}

export const DEFAULT_TEXT_STYLE: TextStyle = { size: 12, bold: false, italic: false, underline: false, align: 'left', color: 'black' };
/** The sizes offered in the size menu (any size in the range can be stored). */
export const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72] as const;
export const MIN_TEXT_SIZE = 4;
export const MAX_TEXT_SIZE = 200;
/** Most characters in one text box. */
export const MAX_TEXT_LENGTH = 10_000;
/** Inside a text box, in points: the space around the text. */
export const TEXT_PAD_X = 2;
export const TEXT_PAD_Y = 1;
/** Line height, in ems. */
export const TEXT_LINE_HEIGHT = 1.25;
/** The narrowest a text box can be made, in points. */
export const MIN_TEXT_BOX_WIDTH = 12;
const MAX_TEXT_BOX_WIDTH = 100_000;

/**
 * Where the first baseline sits under the top of a line, in ems, for the font the viewer uses
 * (Arial, Helvetica's metric twin: ascent 0.905, descent 0.212, centered in the line height the
 * way CSS does it). The export puts PDF text on the same baselines.
 */
export const TEXT_BASELINE = (TEXT_LINE_HEIGHT - (0.905 + 0.212)) / 2 + 0.905;

export interface InkDrawing {
  id: string;
  tool: DrawingTool;
  color: Ink;
  width: InkWidth;
  /** The page it was drawn on (0-based). It stays there; points beyond the page edge were clamped to it. */
  pageIndex: number;
  /**
   * Geometry in PDF user units (the page's own coordinates, y up), rounded to 0.01:
   * pen: the simplified stroke (one point for a dot); line and arrow: start and end;
   * rect and ellipse: the box, as its lower-left and upper-right corners.
   */
  points: PdfPoint[];
  /**
   * Pen only: the points are joined by straight lines instead of a smooth curve. What the eraser
   * leaves of a drawing is stored like this, so the rest keeps its exact shape (a corner of a
   * rectangle stays a corner).
   */
  polyline?: true;
  createdAt: string;
  updatedAt: string;
  /** Hash of the text model of the render it was drawn on (for re-anchoring it later). */
  textModelHash?: string;
  /** What it is attached to (see anchoring/binding). Stored in the anchors file, not with the drawing. */
  binding?: DrawingBinding;
  /** Derived: where the binding's anchors were last found. Stored in the anchors file. */
  anchorStates?: (AnchorState | undefined)[];
}

export interface TextDrawing extends TextBoxStyle {
  id: string;
  tool: 'text';
  pageIndex: number;
  /**
   * One point: the top left corner of the box as the page is shown (whatever its /Rotate), in PDF
   * user units. The text always runs left to right on the screen.
   */
  points: PdfPoint[];
  /** The text; lines are separated by "\n". Never empty. */
  text: string;
  /** The bold, italic and underlined parts of the text. Absent: none. */
  spans?: TextSpan[];
  /** Width of the box in points: lines wrap to fit. Absent: as wide as the longest line. */
  boxWidth?: number;
  createdAt: string;
  updatedAt: string;
  textModelHash?: string;
  binding?: DrawingBinding;
  anchorStates?: (AnchorState | undefined)[];
}

export type Drawing = InkDrawing | TextDrawing;

/** The fields of a drawing this version knows; anything else in a stored drawing is kept as it is. */
const KNOWN_FIELDS = new Set([
  'id', 'tool', 'color', 'width', 'pageIndex', 'points', 'polyline', 'createdAt', 'updatedAt', 'textModelHash', 'binding', 'anchorStates',
  'text', 'spans', 'boxWidth', 'size', 'align', 'bold', 'italic', 'underline',
]);
const MAX_UNKNOWN_FIELDS = 16;

/** Copies the fields a newer version may have added (a few, JSON only), so a round trip through this one loses nothing. */
function keepUnknown(from: Record<string, unknown>, to: Drawing): void {
  let kept = 0;
  for (const key of Object.keys(from)) {
    if (KNOWN_FIELDS.has(key) || kept >= MAX_UNKNOWN_FIELDS) continue;
    const value = from[key];
    if (value === undefined || typeof value === 'function') continue;
    (to as unknown as Record<string, unknown>)[key] = value;
    kept++;
  }
}

/** The binding and anchor states of a stored drawing, cleaned. */
function attachAnchoring(from: Record<string, unknown>, to: Drawing): void {
  const binding = sanitizeBinding(from.binding);
  if (binding) to.binding = binding;
  if (binding && Array.isArray(from.anchorStates)) to.anchorStates = from.anchorStates.slice(0, 2).map((s) => sanitizeState(s));
}

/** A text box laid out by the viewer, for the download: its lines as shown, and its size in points. */
export interface TextLayout {
  id: string;
  lines: string[];
  width: number;
  height: number;
}

export function isTextDrawing(drawing: Drawing): drawing is TextDrawing {
  return drawing.tool === 'text';
}

export function isInkDrawing(drawing: Drawing): drawing is InkDrawing {
  return drawing.tool !== 'text';
}

/** What the path of an ink drawing is built from (see shapePath). */
export function drawingShape(drawing: Pick<InkDrawing, 'tool' | 'points' | 'width' | 'polyline'>): Shape {
  const shape: Shape = { tool: drawing.tool, points: drawing.points, widthPt: INK_WIDTH_PT[drawing.width] };
  if (drawing.polyline && drawing.tool === 'pen') shape.polyline = true;
  return shape;
}

type StyledText = Pick<TextDrawing, 'size' | 'align' | 'color' | 'text' | 'spans'>;

/** The style of a text box as the text bar shows it: bold (and so on) when all of its text is. */
export function textStyleOf(text: StyledText): TextStyle {
  return { size: text.size, align: text.align, color: text.color, ...rangeStyle(text.text, text.spans, 0, text.text.length) };
}

/** A text box with a style change applied: bold, italic and underline go to all of its text. */
export function applyTextStyle<T extends StyledText>(text: T, patch: Partial<TextStyle>): T {
  const next = { ...text };
  if (patch.size !== undefined) next.size = patch.size;
  if (patch.align !== undefined) next.align = patch.align;
  if (patch.color !== undefined) next.color = patch.color;
  const chars: Partial<CharStyle> = {};
  for (const name of CHAR_STYLES) if (patch[name] !== undefined) chars[name] = patch[name];
  if (Object.keys(chars).length > 0) {
    const spans = styleRange(text.spans, text.text.length, 0, text.text.length, chars);
    if (spans) next.spans = spans;
    else delete next.spans;
  }
  return next;
}

export function isDrawingTool(value: unknown): value is DrawingTool {
  return typeof value === 'string' && (DRAWING_TOOLS as readonly string[]).includes(value);
}

export function isDrawTool(value: unknown): value is DrawTool {
  return value === 'eraser' || isDrawingTool(value);
}

export function isInkWidth(value: unknown): value is InkWidth {
  return typeof value === 'string' && (INK_WIDTHS as readonly string[]).includes(value);
}

export function isTextAlign(value: unknown): value is TextAlign {
  return typeof value === 'string' && (TEXT_ALIGNS as readonly string[]).includes(value);
}

export { isInk };

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function isPoint(value: unknown): value is PdfPoint {
  return Array.isArray(value) && value.length === 2 && isCoordinate(value[0]) && isCoordinate(value[1]);
}

/** A font size in range, to the half point; undefined if it is not a number. */
export function sanitizeTextSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, Math.round(value * 2) / 2));
}

/** A whole text style from untrusted input, with the defaults for whatever is missing or wrong. */
export function sanitizeTextStyle(value: unknown, fallback: TextStyle = DEFAULT_TEXT_STYLE): TextStyle {
  const s = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<Record<keyof TextStyle, unknown>>) : {};
  return {
    size: sanitizeTextSize(s.size) ?? fallback.size,
    bold: typeof s.bold === 'boolean' ? s.bold : fallback.bold,
    italic: typeof s.italic === 'boolean' ? s.italic : fallback.italic,
    underline: typeof s.underline === 'boolean' ? s.underline : fallback.underline,
    align: isTextAlign(s.align) ? s.align : fallback.align,
    color: sanitizeInk(s.color) ?? fallback.color,
  };
}

/** Text as it may be in a text box: line breaks as "\n", tabs as four spaces, no other control characters. */
export function cleanText(value: string): string {
  return value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
}

/** The text of a text box as stored: clean (see cleanText), and without trailing white space. */
export function normalizeText(value: string): string {
  return cleanText(value).replace(/\s+$/u, '');
}

/**
 * Fits a pen stroke under MAX_STROKE_POINTS by simplifying it with a growing tolerance (in PDF
 * units). `simplified` tells that the stroke had to be approximated more than usual.
 */
export function fitStroke(points: PdfPoint[], tolerance = 0.25): { points: PdfPoint[]; simplified: boolean } {
  if (points.length <= MAX_STROKE_POINTS) return { points, simplified: false };
  let fitted = points;
  let current = tolerance;
  while (fitted.length > MAX_STROKE_POINTS) {
    fitted = simplifyPoints(points, current);
    current *= 2;
  }
  return { points: fitted, simplified: true };
}

/** Drops repeated points (they add nothing to a stroke). */
function withoutRepeats(points: PdfPoint[]): PdfPoint[] {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

/**
 * Validates a drawing or text box (from disk or from a viewer) and returns a clean copy built from
 * the known fields only, or undefined if it is not usable. Only finite coordinates, known tools,
 * colors, widths and styles pass. A pen stroke over MAX_STROKE_POINTS is simplified and a text over
 * MAX_TEXT_LENGTH is shortened, and `onAdjusted` is told so with the size before (the caller says it
 * to the reader: nothing is ever cut silently).
 */
export function sanitizeDrawing(value: unknown, onAdjusted?: (drawing: Drawing, before: number) => void): Drawing | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id.length === 0 || d.id.length > 128) return undefined;
  const color = sanitizeInk(d.color);
  if (!color) return undefined;
  if (typeof d.pageIndex !== 'number' || !Number.isInteger(d.pageIndex) || d.pageIndex < 0 || d.pageIndex > 100_000) return undefined;
  if (!Array.isArray(d.points) || !d.points.every(isPoint)) return undefined;
  let points = (d.points as PdfPoint[]).map(([x, y]): PdfPoint => [round2(x), round2(y)]);
  const createdAt = typeof d.createdAt === 'string' && d.createdAt ? d.createdAt : new Date(0).toISOString();
  const updatedAt = typeof d.updatedAt === 'string' && d.updatedAt ? d.updatedAt : createdAt;
  const hash = typeof d.textModelHash === 'string' && d.textModelHash.length > 0 && d.textModelHash.length <= 256 ? d.textModelHash : undefined;

  if (d.tool === 'text') {
    if (points.length !== 1 || typeof d.text !== 'string') return undefined;
    let text = normalizeText(d.text);
    if (text.length === 0) return undefined;
    let shortenedFrom: number | undefined;
    if (text.length > MAX_TEXT_LENGTH) {
      shortenedFrom = text.length;
      text = normalizeText(text.slice(0, MAX_TEXT_LENGTH));
    }
    const style = sanitizeTextStyle({ ...d, color });
    const drawing: TextDrawing = { id: d.id, tool: 'text', pageIndex: d.pageIndex, points, text, size: style.size, align: style.align, color: style.color, createdAt, updatedAt };
    // Spans count characters of the stored text: if cleaning the text moved them, they are dropped.
    // A box of 0.6.0 has no spans: its bold, italic and underline were the whole box's.
    const spans = Array.isArray(d.spans)
      ? d.text.startsWith(text)
        ? sanitizeSpans(d.spans, text.length)
        : undefined
      : style.bold || style.italic || style.underline
        ? styleRange(undefined, text.length, 0, text.length, { bold: style.bold, italic: style.italic, underline: style.underline })
        : undefined;
    if (spans) drawing.spans = spans;
    if (typeof d.boxWidth === 'number' && Number.isFinite(d.boxWidth)) {
      drawing.boxWidth = round2(Math.min(MAX_TEXT_BOX_WIDTH, Math.max(MIN_TEXT_BOX_WIDTH, d.boxWidth)));
    }
    if (hash) drawing.textModelHash = hash;
    attachAnchoring(d, drawing);
    keepUnknown(d, drawing);
    if (shortenedFrom !== undefined) onAdjusted?.(drawing, shortenedFrom);
    return drawing;
  }

  if (!isDrawingTool(d.tool) || !isInkWidth(d.width)) return undefined;
  let simplifiedFrom: number | undefined;
  if (d.tool === 'pen') {
    points = withoutRepeats(points);
    if (points.length === 0) return undefined;
    const fitted = fitStroke(points);
    if (fitted.simplified) {
      simplifiedFrom = points.length;
      points = fitted.points;
    }
  } else {
    if (points.length !== 2) return undefined;
    if (d.tool === 'rect' || d.tool === 'ellipse') {
      const [[ax, ay], [bx, by]] = points;
      points = [
        [Math.min(ax, bx), Math.min(ay, by)],
        [Math.max(ax, bx), Math.max(ay, by)],
      ];
    }
  }
  const drawing: InkDrawing = { id: d.id, tool: d.tool, color, width: d.width, pageIndex: d.pageIndex, points, createdAt, updatedAt };
  if (d.tool === 'pen' && d.polyline === true) drawing.polyline = true;
  if (hash) drawing.textModelHash = hash;
  attachAnchoring(d, drawing);
  keepUnknown(d, drawing);
  if (simplifiedFrom !== undefined) onAdjusted?.(drawing, simplifiedFrom);
  return drawing;
}

export { DEFAULT_INK };
