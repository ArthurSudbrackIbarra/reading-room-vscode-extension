// What the host does with a viewer's resolving results, and how records of earlier versions get
// their anchors. Pure functions over a record (no vscode, no disk), so they are unit-testable.
//
// Everything written here is derived: statuses, positions, rectangles, states, and bindings
// inferred for drawings that had none. Nothing the reader made changes, and no `updatedAt` moves,
// so these changes never win a merge between windows.
import { sanitizeAnchor, sanitizeState, type AnchorState, type TextAnchor } from '../anchoring/anchor';
import { sanitizeBinding, type DrawingBinding } from '../anchoring/binding';
import { legacyState } from '../anchoring/runs';
import type { Highlight, PageRects, PdfRect, ReadingMarker, StoredRecord } from '../shared/types';

export interface ResolvedHighlight {
  id: string;
  /** The state to keep: where it was found, or why it was not. */
  state: AnchorState;
  /** Rectangles in PDF units, for anchored highlights. */
  pages?: PageRects[];
  /** A wider anchor for a highlight of an earlier version that was found unchanged. */
  anchor?: TextAnchor;
}

export interface ResolvedDrawing {
  id: string;
  states: (AnchorState | undefined)[];
  /** A binding inferred because the drawing had none (or one for another version of it). */
  binding?: DrawingBinding;
}

export interface ResolvedPayload {
  /** Hash of the text the results are for. */
  hash: string;
  highlights: ResolvedHighlight[];
  marker?: { state?: AnchorState };
  drawings: ResolvedDrawing[];
  /** PDF files: signatures of the pages of this version. */
  pages?: string[];
}

function isPdfRect(value: unknown): value is PdfRect {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function sanitizePages(value: unknown): PageRects[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PageRects[] = [];
  for (const page of value as Partial<PageRects>[]) {
    if (!page || typeof page.pageIndex !== 'number' || !Number.isInteger(page.pageIndex) || page.pageIndex < 0 || !Array.isArray(page.rects)) continue;
    const rects = page.rects.filter(isPdfRect);
    if (rects.length > 0) out.push({ pageIndex: page.pageIndex, rects });
  }
  return out;
}

/** The anchor a highlight of an earlier version starts with: its stored quote and context. */
export function legacyAnchor(h: Highlight): TextAnchor {
  const [quote] = h.target.selector;
  return { exact: quote.exact, prefix: quote.prefix ?? '', suffix: quote.suffix ?? '' };
}

/**
 * Gives every annotation of a record what the viewer resolves it with: highlights and a marker
 * made by earlier versions get an anchor from their stored quote, and a state from their stored
 * position (a hint). Lossless and idempotent: what is already there is left alone.
 */
export function prepareRecord(record: StoredRecord): void {
  for (const h of record.highlights) {
    if (h.anchor && h.anchor.exact === h.target.selector[0].exact) continue;
    h.anchor = legacyAnchor(h);
    const position = h.target.selector[1];
    const state = legacyState(h.status, position.start, position.end, h.target.hints.textModelHash);
    if (state) h.state = state;
    else delete h.state;
  }
  const marker = record.marker;
  if (marker && !marker.anchor && marker.selector) {
    const [quote, position] = marker.selector;
    marker.anchor = { exact: quote.exact, prefix: quote.prefix ?? '', suffix: quote.suffix ?? '' };
    delete marker.rel;
    delete marker.state;
    // The stored position was where the marker stood in some earlier render: only a hint.
    if (position.start >= 0) marker.anchor.createdIn = { hash: '', v: 0, start: position.start };
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Stores the results of resolving a saved render. Returns whether anything changed. The payload
 * comes from a webview: everything in it is checked.
 */
export function applyResolved(record: StoredRecord, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Partial<ResolvedPayload>;
  const hash = typeof p.hash === 'string' ? p.hash.slice(0, 64) : '';
  let changed = false;

  const highlights = new Map<string, Partial<ResolvedHighlight>>();
  for (const r of Array.isArray(p.highlights) ? p.highlights : []) if (r && typeof r.id === 'string') highlights.set(r.id, r);
  for (const h of record.highlights) {
    const r = highlights.get(h.id);
    if (!r) continue;
    const state = sanitizeState(r.state);
    if (!state) continue;
    const before = JSON.stringify([h.status, h.target.selector[1], h.target.hints, h.state, h.anchor]);
    h.status = state.status;
    if (state.status === 'anchored' && state.found && state.found.hash === hash) {
      h.target.selector[1] = { type: 'TextPositionSelector', start: state.found.start, end: state.found.end };
      const pages = sanitizePages(r.pages);
      if (pages && pages.length > 0) h.target.hints.pages = pages;
      // The version it was last found in: left alone while it is orphaned.
      h.target.hints.textModelHash = hash;
    }
    h.state = state;
    const wider = sanitizeAnchor(r.anchor);
    if (wider && h.anchor && !h.anchor.fingerprint && wider.exact === h.anchor.exact) h.anchor = wider;
    if (JSON.stringify([h.status, h.target.selector[1], h.target.hints, h.state, h.anchor]) !== before) changed = true;
  }

  const marker: ReadingMarker | undefined = record.marker;
  if (marker && p.marker && typeof p.marker === 'object') {
    const state = sanitizeState(p.marker.state);
    if (state && !sameJson(state, marker.state)) {
      marker.state = state;
      changed = true;
    }
  }

  const drawings = new Map<string, Partial<ResolvedDrawing>>();
  for (const r of Array.isArray(p.drawings) ? p.drawings : []) if (r && typeof r.id === 'string') drawings.set(r.id, r);
  for (const d of record.drawings) {
    const r = drawings.get(d.id);
    if (!r) continue;
    const binding = sanitizeBinding(r.binding);
    if (binding && binding.for === d.updatedAt && (!d.binding || d.binding.for !== d.updatedAt)) {
      d.binding = binding;
      delete d.anchorStates;
      changed = true;
    }
    if (!d.binding || !Array.isArray(r.states)) continue;
    const states = r.states.slice(0, 2).map((s) => sanitizeState(s));
    if (!sameJson(states, d.anchorStates)) {
      d.anchorStates = states;
      changed = true;
    }
  }

  if (Array.isArray(p.pages)) {
    const pages = p.pages.filter((s): s is string => typeof s === 'string' && s.length <= 200).slice(0, 100_000);
    if (!sameJson(pages, record.pages ?? [])) {
      if (pages.length > 0) record.pages = pages;
      else delete record.pages;
      changed = true;
    }
  }
  return changed;
}
