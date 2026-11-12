// Resolving every annotation of a document against one render: highlights, the reading marker,
// drawings and text boxes. Pure orchestration (no DOM, no vscode), so the viewer and the tests
// run the same code.
//
// One run per render and annotation set: starting a new one cancels the one in flight, and only a
// run that completes delivers results. A failing annotation is orphaned as `invalid` and logged
// with its id; it never stops the others.
import type { PageGeometry } from '../shared/drawingGeometry';
import { isTextDrawing, type Drawing } from '../shared/drawings';
import { createAnchor, type AnchorState, type OrphanReason, type ResolutionKind, type TextAnchor } from './anchor';
import { inferBinding, pageState, placeDrawing, resolveBinding, type BindingFlag, type DrawingBinding, type Placement } from './binding';
import type { CopyHint, DiffOptions } from './diff';
import { boxHeight, boxWidth, type Box, type DocumentLayout } from './layout';
import { categoryOf, needsFuzzy, resolveAnchor, type ResolveContext, type Resolution } from './resolve';
import { TEXT_MODEL_VERSION, type TextModel } from './textModel';
import { pathBounds, shapePath, toPageSpace, type PdfPoint } from '../shared/drawingGeometry';
import { INK_WIDTH_PT, drawingShape } from '../shared/drawings';

export interface RunDocument {
  renderId: number;
  model: TextModel;
  layout: DocumentLayout;
  /** A render of unsaved text: its results are shown but not stored. */
  provisional?: boolean;
  /** Which of two identical neighbors is the copy, from the editor's change events. */
  hints?: readonly CopyHint[];
}

export interface HighlightInput {
  id: string;
  anchor: TextAnchor;
  state?: AnchorState;
}

export interface MarkerInput {
  /** Where the reader placed it: page (0-based) and fraction of the page height. */
  page: number;
  y: number;
  /** Text at the start of the marked line (or the nearest line before it, with `rel`). */
  anchor?: TextAnchor;
  /** For a mark on a spot without text: pages after the anchor's page, and points below its line. */
  rel?: { pages: number; dy: number };
  state?: AnchorState;
}

export interface DrawingInput {
  drawing: Drawing;
  binding?: DrawingBinding;
  states?: (AnchorState | undefined)[];
}

export interface RunInput {
  highlights: HighlightInput[];
  marker?: MarkerInput;
  drawings: DrawingInput[];
}

export interface MarkerResult {
  status: 'anchored' | 'orphaned';
  kind?: ResolutionKind;
  reason?: OrphanReason;
  /** Where it is shown. `stored` is true when that is just the stored position (its text is not in this version). */
  page: number;
  y: number;
  stored: boolean;
  /** Its line is gone: it stands where the line was. */
  approximate: boolean;
  /** The text offset it stands at, when it stands at text. */
  offset?: number;
  state?: AnchorState;
}

export interface DrawingResult {
  status: 'anchored' | 'orphaned';
  kind?: ResolutionKind;
  reason?: OrphanReason;
  flags: BindingFlag[];
  /** The drawing as it is shown (the stored one itself when nothing moved); undefined for orphans. */
  shown?: Drawing;
  tombstone?: { page: number; y: number };
  states: (AnchorState | undefined)[];
  /** A binding inferred in this run (the drawing had none, or it belonged to another version of the drawing). */
  binding?: DrawingBinding;
}

export interface RunSummary {
  moved: number;
  edited: number;
  partial: number;
  restored: number;
  orphaned: Partial<Record<OrphanReason, number>>;
  /** Annotations orphaned now, and how many there are. */
  orphanedNow: number;
  total: number;
  /** More than half of at least three annotations went missing in this render. */
  massOrphan: boolean;
}

export interface RunResult {
  renderId: number;
  hash: string;
  provisional: boolean;
  highlights: Map<string, Resolution>;
  /** Anchors widened with more context (highlights made by earlier versions, found unchanged). */
  upgraded: Map<string, TextAnchor>;
  marker?: MarkerResult;
  drawings: Map<string, DrawingResult>;
  summary: RunSummary;
  /** Annotations still being searched for (the slow search runs after the first results). */
  pending: Set<string>;
}

export interface RunOptions {
  /** Text of earlier versions by hash (memory or snapshots). */
  oldText(hash: string): string | undefined;
  /** Image boxes of a page, in page space. */
  images?(page: number): Promise<Box[]> | Box[];
  /** PDF files: maps a page of the last stored version to its page now. */
  pageMap?(page: number): number | undefined;
  /** PDF files: the page that has this fingerprint now, if any. */
  findPage?(print: string): number | undefined;
  /** The size of a text box on the page (points), to keep all of it inside the page. */
  textSize?(drawing: Drawing): { width: number; height: number } | undefined;
  /** Gives the event loop a turn between chunks. */
  pause?(): Promise<void>;
  /** Called with the results of the quick pass when the slow search still has work. */
  onQuick?(result: RunResult): void;
  log?(message: string): void;
  diffOptions?: DiffOptions;
  /** Annotations resolved between two pauses. */
  chunk?: number;
  /** Whether this is the first run for this document in this viewer (a banner may be due even without a change). */
  first?: boolean;
}

const MARKER_QUOTE_LENGTH = 48;

/** The anchor of the line start at a text offset (what the reading marker stores). */
export function markerAnchor(model: TextModel, index: number, lineEnd = model.text.length): TextAnchor | undefined {
  const text = model.text;
  if (index < 0 || index >= text.length) return undefined;
  // Only text of the marked line: a short line (a heading) must not borrow from the next one.
  const limit = Math.min(text.length, Math.max(index + 1, lineEnd));
  let end = Math.min(limit, index + MARKER_QUOTE_LENGTH);
  const space = text.lastIndexOf(' ', end);
  if (end < limit && space > index + 12) end = space;
  while (end > index && text[end - 1] === ' ') end--;
  return end > index ? createAnchor(text, model.hash, index, end) : undefined;
}

/** The page-space box of a drawing (stroke included); a text box is just its corner unless its size is given. */
export function drawingBox(drawing: Drawing, geometry: PageGeometry, size?: { width: number; height: number }): Box {
  if (isTextDrawing(drawing)) {
    const [x, y] = toPageSpace(geometry, drawing.points[0]);
    return [x, y, x + (size?.width ?? drawing.boxWidth ?? drawing.size * 4), y + (size?.height ?? drawing.size * 1.25)];
  }
  const [x0, y0, x1, y1] = pathBounds(shapePath(drawingShape(drawing)));
  const half = INK_WIDTH_PT[drawing.width] / 2;
  const corners = (
    [
      [x0 - half, y0 - half],
      [x1 + half, y0 - half],
      [x0 - half, y1 + half],
      [x1 + half, y1 + half],
    ] as PdfPoint[]
  ).map((p) => toPageSpace(geometry, p));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Infers the binding of a drawing as it stands on its page in this document. */
export async function bindDrawing(
  drawing: Drawing,
  doc: Pick<RunDocument, 'layout'>,
  options: Pick<RunOptions, 'images' | 'textSize'> & { prefer?: 'text' | 'image' | 'page'; pagePrint?: string } = {},
): Promise<DrawingBinding | undefined> {
  const geometry = doc.layout.geometry(drawing.pageIndex);
  if (!geometry) return undefined;
  const images = options.images ? await options.images(drawing.pageIndex) : [];
  const made = inferBinding(
    {
      tool: drawing.tool,
      page: drawing.pageIndex,
      box: drawingBox(drawing, geometry, options.textSize?.(drawing)),
      points: isTextDrawing(drawing) ? undefined : drawing.points.map((p) => toPageSpace(geometry, p)),
    },
    doc.layout,
    { images, prefer: options.prefer, pagePrint: options.pagePrint },
  );
  return made ? { ...made, for: drawing.updatedAt } : undefined;
}

function emptySummary(): RunSummary {
  return { moved: 0, edited: 0, partial: 0, restored: 0, orphaned: {}, orphanedNow: 0, total: 0, massOrphan: false };
}

function tally(
  summary: RunSummary,
  before: Pick<AnchorState, 'status' | 'kind' | 'reason'> | undefined,
  after: Pick<AnchorState, 'status' | 'kind' | 'reason'>,
  counters: { newly: number },
): void {
  summary.total++;
  if (after.status === 'orphaned') summary.orphanedNow++;
  const was = categoryOf(before);
  const is = categoryOf(after);
  if (was === is && is !== 'moved') return;
  if (after.status === 'orphaned') {
    // Only going missing is news: an orphan whose reason changes later (text typed where its
    // text was) is not reported again.
    if (before?.status === 'orphaned') return;
    const reason = after.reason ?? 'not-found';
    summary.orphaned[reason] = (summary.orphaned[reason] ?? 0) + 1;
    counters.newly++;
  } else if (before?.status === 'orphaned') summary.restored++;
  else if (is === 'moved') summary.moved++;
  else if (is === 'edited') summary.edited++;
  else if (is === 'partial') summary.partial++;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const REASON_TEXT: Record<OrphanReason, [string, string]> = {
  deleted: ['its text was deleted', 'their text was deleted'],
  replaced: ['its text was replaced', 'their text was replaced'],
  'not-found': ['its text is not in this version', 'their text is not in this version'],
  'page-missing': ['its page is gone', 'their pages are gone'],
  invalid: ['its data could not be read', 'their data could not be read'],
};

/** One line about what a render did to the annotations, or undefined when nothing changed category. */
export function summaryMessage(summary: RunSummary): string | undefined {
  const parts: string[] = [];
  if (summary.moved > 0) parts.push(`${plural(summary.moved, 'annotation')} moved with ${summary.moved === 1 ? 'its' : 'their'} text`);
  if (summary.edited > 0) parts.push(`${plural(summary.edited, 'annotation')} ${summary.edited === 1 ? 'is' : 'are'} on text that changed`);
  if (summary.partial > 0) parts.push(`${plural(summary.partial, 'annotation')} shrank: part of ${summary.partial === 1 ? 'its' : 'their'} text was deleted`);
  if (summary.restored > 0) parts.push(`${plural(summary.restored, 'annotation')} ${summary.restored === 1 ? 'is' : 'are'} back`);
  for (const reason of Object.keys(summary.orphaned) as OrphanReason[]) {
    const n = summary.orphaned[reason] ?? 0;
    if (n > 0) parts.push(`${n} orphaned: ${REASON_TEXT[reason][n === 1 ? 0 : 1]}`);
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : undefined;
}

export function massOrphanMessage(summary: RunSummary): string {
  return `${summary.orphanedNow} of ${summary.total} annotations aren't in this version of the file. They're kept and come back if the text returns.`;
}

/** Remembers the page a found anchor is on (for "was on page N" once it is orphaned). */
function notePage(r: Resolution, model: TextModel): void {
  if (r.status === 'anchored' && r.state.found && r.start !== undefined) r.state.found.page = model.pageOf(r.start);
}

function invalid(previous: AnchorState | undefined, hash: string): Resolution {
  const state: AnchorState = { status: 'orphaned', reason: 'invalid', resolvedIn: hash };
  if (previous?.found) state.found = previous.found;
  return { status: 'orphaned', reason: 'invalid', confidence: 0, via: 'none', state };
}

function resolveMarker(marker: MarkerInput, ctx: ResolveContext, doc: RunDocument, options: RunOptions, fuzzy: boolean): MarkerResult {
  const { layout, model } = doc;
  const lastPage = Math.max(0, layout.pageCount - 1);
  const stored = (extra: Partial<MarkerResult> = {}): MarkerResult => {
    // Where it was last (else where it was placed), clamped for display only: nothing stored is overwritten.
    const last = marker.state?.found?.page ?? marker.page;
    const mapped = options.pageMap ? options.pageMap(last) : last;
    return { status: 'anchored', page: Math.min(mapped ?? last, lastPage), y: marker.y, stored: true, approximate: mapped === undefined, ...extra };
  };
  if (!marker.anchor) {
    // A marker on a page without text follows its page (PDF files: through inserted and removed pages).
    const last = marker.state?.found?.page ?? marker.page;
    const mapped = options.pageMap ? options.pageMap(last) : last;
    if (mapped === undefined || mapped > lastPage) return stored({ kind: 'exact', approximate: true });
    const kind = mapped === last ? 'exact' : 'shifted';
    return { status: 'anchored', kind, page: mapped, y: marker.y, stored: true, approximate: false, state: pageState(model.hash, mapped, kind) };
  }
  const r = resolveAnchor(marker.anchor, marker.state, ctx, { fuzzy });
  let offset: number | undefined;
  let approximate = false;
  if (r.status === 'anchored') offset = r.start;
  else if (r.reason === 'replaced' && r.candidate) offset = r.candidate.start;
  else if (r.tombstone !== undefined) {
    // The line is gone: stand at the text that follows where it was.
    offset = r.tombstone;
    while (offset < model.text.length && model.text[offset] === ' ') offset++;
    if (offset >= model.text.length) offset = Math.max(0, model.text.length - 1);
    approximate = true;
  }
  const at = offset === undefined || model.text.length === 0 ? undefined : layout.lineOf(offset);
  if (!at) return stored({ status: r.status, kind: r.kind, reason: r.reason, state: r.state });
  const size = layout.pageSize(at.page) ?? [1, 1];
  let page = at.page;
  let y = at.line.box[1] / size[1];
  if (marker.rel) {
    page = Math.min(lastPage, at.page + marker.rel.pages);
    y = marker.rel.pages === 0 ? (at.line.box[1] + marker.rel.dy) / size[1] : marker.y;
  }
  if (r.status === 'anchored' && r.state.found) r.state.found.page = page;
  return {
    status: r.status,
    kind: r.kind,
    reason: r.reason,
    page,
    y: Math.min(1, Math.max(0, y)),
    stored: false,
    approximate,
    offset,
    state: r.state,
  };
}

/** Starts and cancels resolving runs. One instance per viewer. */
export class ResolverRuns {
  private generation = 0;

  /** Cancels the run in flight, if any. */
  cancel(): void {
    this.generation++;
  }

  /**
   * Resolves everything against a document. Resolves to undefined when a newer run (or `cancel`)
   * superseded this one: its results must not be used.
   */
  async run(doc: RunDocument, input: RunInput, options: RunOptions): Promise<RunResult | undefined> {
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    const pause = options.pause ?? (() => Promise.resolve());
    const chunk = Math.max(1, options.chunk ?? 50);
    const { model, layout } = doc;
    const ctx: ResolveContext = {
      current: { text: model.text, hash: model.hash },
      oldText: options.oldText,
      hints: doc.hints,
      diffOptions: options.diffOptions,
      diffs: new Map(),
    };
    const result: RunResult = {
      renderId: doc.renderId,
      hash: model.hash,
      provisional: doc.provisional === true,
      highlights: new Map(),
      upgraded: new Map(),
      drawings: new Map(),
      summary: emptySummary(),
      pending: new Set(),
    };

    // Quick pass: everything except the slow approximate search.
    let done = 0;
    for (const h of input.highlights) {
      let r: Resolution;
      try {
        r = resolveAnchor(h.anchor, h.state, ctx, { fuzzy: false });
      } catch (err) {
        options.log?.(`Resolving highlight ${h.id} failed: ${String(err)}`);
        r = invalid(h.state, model.hash);
      }
      notePage(r, model);
      result.highlights.set(h.id, r);
      if (needsFuzzy(r)) result.pending.add(h.id);
      // A highlight of an earlier version (a short context, no fingerprint) whose quote stands
      // unchanged gets the wider anchor of where it stands.
      if (r.status === 'anchored' && (r.kind === 'exact' || r.kind === 'shifted') && !h.anchor.fingerprint) {
        result.upgraded.set(h.id, createAnchor(model.text, model.hash, r.start!, r.end!));
      }
      if (++done % chunk === 0) {
        await pause();
        if (!live()) return undefined;
      }
    }
    if (input.marker) {
      try {
        result.marker = resolveMarker(input.marker, ctx, doc, options, false);
      } catch (err) {
        options.log?.(`Resolving the reading marker failed: ${String(err)}`);
        result.marker = {
          status: 'orphaned',
          reason: 'invalid',
          page: Math.min(input.marker.page, Math.max(0, layout.pageCount - 1)),
          y: input.marker.y,
          stored: true,
          approximate: false,
        };
      }
    }
    for (const d of input.drawings) {
      try {
        result.drawings.set(d.drawing.id, await this.resolveDrawing(d, ctx, doc, options));
      } catch (err) {
        options.log?.(`Resolving drawing ${d.drawing.id} failed: ${String(err)}`);
        result.drawings.set(d.drawing.id, { status: 'orphaned', reason: 'invalid', flags: [], states: d.states ? [...d.states] : [] });
      }
      if (!live()) return undefined;
      if (++done % chunk === 0) {
        await pause();
        if (!live()) return undefined;
      }
    }

    // Slow pass: approximate search for what the quick pass did not find.
    if (result.pending.size > 0) {
      this.summarize(result, input, options);
      options.onQuick?.(result);
      for (const h of input.highlights) {
        if (!result.pending.has(h.id)) continue;
        await pause();
        if (!live()) return undefined;
        try {
          const found = resolveAnchor(h.anchor, h.state, ctx, { fuzzy: true });
          notePage(found, model);
          result.highlights.set(h.id, found);
        } catch (err) {
          options.log?.(`Searching for highlight ${h.id} failed: ${String(err)}`);
        }
        result.pending.delete(h.id);
      }
    }
    if (input.marker && result.marker?.status === 'orphaned' && result.marker.reason === 'not-found') {
      try {
        result.marker = resolveMarker(input.marker, ctx, doc, options, true);
      } catch (err) {
        options.log?.(`Searching for the reading marker failed: ${String(err)}`);
      }
    }
    if (!live()) return undefined;
    this.summarize(result, input, options);
    return result;
  }

  private async resolveDrawing(d: DrawingInput, ctx: ResolveContext, doc: RunDocument, options: RunOptions): Promise<DrawingResult> {
    const { layout, model } = doc;
    let binding = d.binding;
    let states = d.states ?? [];
    let inferred: DrawingBinding | undefined;
    if (!binding || binding.for !== d.drawing.updatedAt) {
      // No binding yet (a drawing of an earlier version), or one made for another version of the
      // drawing: bind it as it stands on its page now.
      const made = await bindDrawing(d.drawing, doc, options);
      if (!made) return { status: 'orphaned', reason: 'page-missing', flags: [], states: [] };
      // Drawn on another version of the text than this one: where it belongs is a guess.
      if (d.drawing.textModelHash !== undefined && d.drawing.textModelHash !== model.hash && made.mode !== 'page') made.review = true;
      binding = made;
      inferred = made;
      states = [];
    }
    const placement: Placement = await resolveBinding(binding, states, ctx, layout, { images: options.images, pageMap: options.pageMap, findPage: options.findPage });
    const out: DrawingResult = {
      status: placement.status,
      kind: placement.kind,
      reason: placement.reason,
      flags: [...placement.flags],
      states: placement.states,
      ...(placement.tombstone ? { tombstone: placement.tombstone } : {}),
      ...(inferred ? { binding: inferred } : {}),
    };
    if (placement.status !== 'anchored' || placement.page === undefined) return out;
    const target = layout.geometry(placement.page);
    if (!target) return { ...out, status: 'orphaned', reason: 'page-missing' };
    const placed = placeDrawing(d.drawing, binding, placement, target, isTextDrawing(d.drawing) ? options.textSize?.(d.drawing) : undefined);
    if (placed.clipped && !out.flags.includes('clipped')) out.flags.push('clipped');
    const box = drawingBox(placed.drawing, target);
    if (![...box, ...placed.drawing.points.flat()].every(Number.isFinite) || boxWidth(box) < 0 || boxHeight(box) < 0) {
      return { ...out, status: 'orphaned', reason: 'invalid' };
    }
    out.shown = placed.drawing;
    return out;
  }

  private summarize(result: RunResult, input: RunInput, options: RunOptions): void {
    const summary = emptySummary();
    const counters = { newly: 0 };
    for (const h of input.highlights) {
      const r = result.highlights.get(h.id);
      if (r) tally(summary, h.state, r.state, counters);
    }
    if (input.marker && result.marker && input.marker.anchor) {
      const m = result.marker;
      tally(summary, input.marker.state, { status: m.status, kind: m.kind, reason: m.reason }, counters);
    }
    for (const d of input.drawings) {
      const r = result.drawings.get(d.drawing.id);
      if (!r) continue;
      const before = d.states?.[0];
      tally(summary, d.binding && before ? before : d.binding ? { status: 'anchored', kind: 'exact' } : undefined, { status: r.status, kind: r.kind, reason: r.reason }, counters);
    }
    summary.massOrphan = summary.total >= 3 && summary.orphanedNow > summary.total / 2 && (counters.newly > 0 || options.first === true);
    result.summary = summary;
  }
}

/** The state a highlight made by an earlier version starts from: its stored position is only a hint. */
export function legacyState(status: 'anchored' | 'orphaned', start: number, end: number, hash: string | undefined): AnchorState | undefined {
  if (status !== 'anchored' || start < 0 || end <= start || !hash) return undefined;
  return { status: 'anchored', kind: 'exact', found: { hash, v: TEXT_MODEL_VERSION, length: -1, start, end } };
}
