// Selecting several annotations at once, and copying drawings and text boxes: what does not need
// the DOM (the order of a Shift+click range, moving a group, the clipboard format), so it is
// unit-testable. Shared by the viewer; no runtime dependencies.
import type { Matrix, PdfPoint } from './drawingGeometry';
import { sanitizeDrawing, type Drawing } from './drawings';

/** One selectable annotation: a drawing or text box, or a highlight. */
export interface Ref {
  kind: 'drawing' | 'highlight';
  id: string;
}

export function refKey(ref: Ref): string {
  return `${ref.kind === 'drawing' ? 'd' : 'h'}:${ref.id}`;
}

/**
 * Shift+click: everything from the last one clicked (`anchor`) to `target`, both included, in
 * reading order (`order`). Without an anchor (or with one that is gone), just the target.
 */
export function rangeBetween<T>(order: T[], key: (item: T) => string, anchor: string | undefined, target: string): T[] {
  const to = order.findIndex((item) => key(item) === target);
  if (to < 0) return [];
  const from = anchor === undefined ? -1 : order.findIndex((item) => key(item) === anchor);
  if (from < 0) return [order[to]];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * How far a group may move along one axis: every member has its own limits (it stays on its
 * page), and the group moves as one, so the move is cut to what all of them allow. When they
 * allow nothing in common (a member wider than its page), the group stays where it is.
 */
export function clampGroupMove(want: number, limits: [low: number, high: number][]): number {
  let low = -Infinity;
  let high = Infinity;
  for (const [l, h] of limits) {
    // A member larger than its page has no room at all: it does not move, and neither does the group.
    if (l > h) return 0;
    low = Math.max(low, l);
    high = Math.min(high, h);
  }
  if (low > high) return 0;
  return Math.min(high, Math.max(low, want));
}

/** A move on the page as shown (points, y down) as a move in the page's own units: the inverse of the page transform, without its offset. */
export function toPdfDelta(transform: Matrix, [px, py]: [number, number]): [number, number] {
  const [a, b, c, d] = transform;
  const det = a * d - b * c;
  if (det === 0) return [0, 0];
  return [(d * px - c * py) / det, (a * py - b * px) / det];
}

/** A move in the page's own units as a move on the page as shown. */
export function toPageDelta(transform: Matrix, [dx, dy]: [number, number]): [number, number] {
  const [a, b, c, d] = transform;
  return [a * dx + c * dy, b * dx + d * dy];
}

// ---------- Clipboard ----------

/** The clipboard format of copied drawings and text boxes (next to their text as plain text). */
export const CLIP_MIME = 'application/x-reading-room-annotations';
const CLIP_VERSION = 1;
/** More than this is not pasted at once. */
export const MAX_CLIP_ITEMS = 500;

export interface ClipItem {
  /** The drawing or text box as it was shown, without what it was bound to. */
  drawing: Drawing;
  /**
   * Its points on the page as shown (points from the page's top left corner, y down), so it can
   * be put on a page of another size or rotation, or of another document.
   */
  page: PdfPoint[];
}

function isPagePoint(value: unknown): value is PdfPoint {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6);
}

/** A copy of a drawing without what ties it to the document it was on. */
export function detached<T extends Drawing>(drawing: T): T {
  const { binding: _binding, anchorStates: _states, textModelHash: _hash, ...rest } = drawing;
  return structuredClone(rest) as T;
}

export function encodeClip(items: ClipItem[]): string {
  return JSON.stringify({ app: 'reading-room', v: CLIP_VERSION, items: items.slice(0, MAX_CLIP_ITEMS).map((item) => ({ drawing: detached(item.drawing), page: item.page })) });
}

/** Reads what Copy wrote. Anything else (other text, a newer format, broken items) gives no items. */
export function decodeClip(text: string): ClipItem[] {
  if (!text || text.length > 20_000_000) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const clip = parsed as { app?: unknown; v?: unknown; items?: unknown };
  if (clip.app !== 'reading-room' || clip.v !== CLIP_VERSION || !Array.isArray(clip.items)) return [];
  const items: ClipItem[] = [];
  for (const raw of clip.items.slice(0, MAX_CLIP_ITEMS) as ({ drawing?: unknown; page?: unknown } | null)[]) {
    const drawing = sanitizeDrawing(raw?.drawing);
    const page = raw?.page;
    if (!drawing || !Array.isArray(page) || !page.every(isPagePoint)) continue;
    // (Cleaning may drop repeated points of a pen stroke: then the page points do not match any more.)
    if (page.length !== drawing.points.length) continue;
    items.push({ drawing: detached(drawing), page: page.map(([x, y]): PdfPoint => [x, y]) });
  }
  return items;
}
