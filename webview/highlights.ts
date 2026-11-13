// Highlights in the viewer: anchoring stored quotes in the rendered PDF, drawing them over the
// PDF.js text layer (plus a badge in the margin for highlights with a note), creating them from a
// selection, and producing rectangles for export.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdfjs';
import { createAnchor, type AnchorState, type TextAnchor } from '../src/anchoring/anchor';
import { extractPage, type TextContentLike } from '../src/anchoring/extract';
import { createSelectors } from '../src/anchoring/match';
import type { Resolution } from '../src/anchoring/resolve';
import type { HighlightInput } from '../src/anchoring/runs';
import { TEXT_MODEL_VERSION, type TextModel, trimRange, type PageInput, type PageSegments } from '../src/anchoring/textModel';
import { pageGeometry, toPdfSpace, type PageGeometry } from '../src/shared/drawingGeometry';
import type { ExportHighlight } from '../src/shared/messages';
import { HIGHLIGHT_HEX, type Highlight, type HighlightColor, type PageRects, type PdfRect } from '../src/shared/types';
import { legacyAnchor, type ResolvedHighlight } from '../src/store/resolutions';
import type { PageLayers } from './pageLayers';
import type { PageViewLike, Viewer } from './viewer';

/** Rectangle as fractions of the page box, origin top-left: [x1, y1, x2, y2]. */
export type Frac = [number, number, number, number];

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

export interface PageData {
  view: number[];
  /** The page as shown at scale 1 (its /Rotate and crop box applied). */
  geometry: PageGeometry;
  rotate: number;
  textContent: { items: TextItemLike[]; styles: Record<string, unknown>; lang?: string | null };
  /** Indices (into textContent.items) of the items that have a `str`, i.e. TextLayer.textDivs order. */
  strItems: TextItemLike[];
}

/** Pages read at once from a PDF. */
const READ_BATCH = 8;

/** Reads the text of every page of a PDF (a few pages at a time, in parallel). `stale` stops it early. */
export async function readPages(doc: PDFDocumentProxy, stale: () => boolean): Promise<{ pages: PageData[]; inputs: PageInput[] } | undefined> {
  const pages: PageData[] = new Array(doc.numPages);
  const inputs: PageInput[] = new Array(doc.numPages);
  for (let first = 1; first <= doc.numPages; first += READ_BATCH) {
    const batch = Array.from({ length: Math.min(READ_BATCH, doc.numPages - first + 1) }, (_, k) => first + k);
    await Promise.all(
      batch.map(async (number) => {
        const page = await doc.getPage(number);
        const { input, textContent } = await extractPage(page as never);
        const content = textContent as TextContentLike as PageData['textContent'];
        pages[number - 1] = {
          view: page.view,
          geometry: pageGeometry(page.view, page.rotate ?? 0, page.userUnit ?? 1),
          rotate: page.rotate ?? 0,
          textContent: content,
          strItems: content.items.filter((it) => typeof it.str === 'string'),
        };
        inputs[number - 1] = input;
      }),
    );
    if (stale()) return undefined;
  }
  return { pages, inputs };
}

interface LiveLayer {
  layer: HTMLElement;
  divs: (HTMLElement | undefined)[];
}

interface Runtime {
  data: Highlight;
  start?: number;
  end?: number;
  /** Per page index: rectangles as fractions of the page. Only ever for the document that is shown. */
  pages: Map<number, Frac[]>;
  /** What the last resolving run found (undefined until the first one). */
  resolution?: Resolution;
  /** The state from a render of unsaved text: used for the next run, never stored. */
  liveState?: AnchorState;
}

export type HighlightRuntime = Runtime;

export interface HighlightEvents {
  created(highlight: Highlight): void;
  changed(): void;
  /** A highlight was added or brought back: it has to be found in the document. */
  needsResolve(): void;
}

const HL_LAYER = 'mpv-hl-layer';
const BADGE_LAYER = 'mpv-badge-layer';

function uuid(): string {
  return crypto.randomUUID();
}

function mergeLines(rects: Frac[]): Frac[] {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const lines: Frac[] = [];
  for (const r of sorted) {
    const h = r[3] - r[1];
    const line = lines.find((l) => {
      const overlap = Math.min(l[3], r[3]) - Math.max(l[1], r[1]);
      return overlap > 0.5 * Math.min(h, l[3] - l[1]);
    });
    if (line) {
      line[0] = Math.min(line[0], r[0]);
      line[1] = Math.min(line[1], r[1]);
      line[2] = Math.max(line[2], r[2]);
      line[3] = Math.max(line[3], r[3]);
    } else {
      lines.push([...r] as Frac);
    }
  }
  return lines;
}

export class HighlightController {
  private doc?: PDFDocumentProxy;
  private renderId = -1;
  private model?: TextModel;
  private pages: PageData[] = [];
  private readonly live = new Map<number, LiveLayer>();
  private readonly spanInfo = new WeakMap<HTMLElement, { page: number; item: number }>();
  private readonly runtimes = new Map<string, Runtime>();
  private offscreenHost?: HTMLDivElement;
  private ready: Promise<void> = Promise.resolve();
  private marginsPt = { top: 51, bottom: 57 };
  private flashTimer?: ReturnType<typeof setTimeout>;
  /** The selected highlights (the one whose popover is open, those picked with the select tool): Delete deletes them. */
  private selected = new Set<string>();

  constructor(
    private readonly viewer: Viewer,
    private readonly layers: PageLayers,
    private readonly events: HighlightEvents,
  ) {
    layers.register({ className: HL_LAYER, placement: 'above-canvas', fill: (layer, i) => this.fillLayer(layer, i) });
    layers.register({ className: BADGE_LAYER, placement: 'top', fill: (layer, i) => this.fillBadges(layer, i) });
    viewer.eventBus.on('textlayerrendered', (evt: { pageNumber: number }) => this.onTextLayer(evt.pageNumber - 1));
  }

  setMargins(margins: { top: number; bottom: number }): void {
    this.marginsPt = margins;
  }

  // ---------- Data ----------

  /** Replaces every highlight. Nothing is drawn until they are resolved (see AnchoringController). */
  setHighlights(list: Highlight[]): void {
    this.runtimes.clear();
    for (const h of list) this.runtimes.set(h.id, this.runtimeOf(h));
    this.redrawAll();
    this.events.changed();
  }

  private runtimeOf(highlight: Highlight): Runtime {
    const data = structuredClone(highlight);
    // Highlights of earlier versions carry no anchor: their stored quote is it.
    if (!data.anchor) data.anchor = legacyAnchor(data);
    return { data, pages: new Map() };
  }

  /** What the resolver works on. */
  inputs(): HighlightInput[] {
    return [...this.runtimes.values()].map((rt) => ({ id: rt.data.id, anchor: rt.data.anchor as TextAnchor, state: rt.liveState ?? rt.data.state }));
  }

  /**
   * Takes over the results of a resolving run: where every highlight is in the document shown,
   * or why it is not. Rectangles are computed from the text layers (as they render).
   */
  applyResolutions(resolutions: Map<string, Resolution>, upgraded: Map<string, TextAnchor>, provisional: boolean): void {
    for (const rt of this.runtimes.values()) {
      const r = resolutions.get(rt.data.id);
      if (!r) continue;
      rt.resolution = r;
      rt.pages.clear();
      rt.start = r.status === 'anchored' ? r.start : undefined;
      rt.end = r.status === 'anchored' ? r.end : undefined;
      rt.data.status = r.status;
      if (provisional) {
        rt.liveState = r.state;
      } else {
        rt.liveState = undefined;
        rt.data.state = r.state;
        const wider = upgraded.get(rt.data.id);
        if (wider && !rt.data.anchor?.fingerprint) rt.data.anchor = wider;
        if (r.status === 'anchored' && this.model) {
          rt.data.target.selector[1] = { type: 'TextPositionSelector', start: r.start!, end: r.end! };
          rt.data.target.hints.textModelHash = this.model.hash;
        }
      }
      for (const seg of this.segmentsOf(rt)) {
        const live = this.live.get(seg.page);
        if (live?.layer.isConnected) this.computePageRects(rt, seg.page, live);
      }
    }
    this.redrawAll();
    this.events.changed();
  }

  /** Computes the rectangles still missing (pages PDF.js has not rendered), then draws. */
  async completeRects(): Promise<void> {
    const missing = [...this.runtimes.values()].filter((rt) => rt.data.status === 'anchored' && this.segmentsOf(rt).some((s) => !rt.pages.has(s.page)));
    if (missing.length === 0) return;
    await this.computeRects(missing);
    this.redrawAll();
  }

  /** What the host stores of the last run: states, positions and rectangles. */
  resolvedPayload(upgraded: Map<string, TextAnchor>): ResolvedHighlight[] {
    const out: ResolvedHighlight[] = [];
    for (const rt of this.runtimes.values()) {
      if (!rt.resolution) continue;
      const anchor = upgraded.get(rt.data.id);
      out.push({ id: rt.data.id, state: rt.resolution.state, ...(rt.data.status === 'anchored' ? { pages: this.pdfRects(rt) } : {}), ...(anchor ? { anchor } : {}) });
    }
    return out;
  }

  /** The text a highlight is on now (differs from its quote when the passage was edited). */
  currentText(id: string): string | undefined {
    const rt = this.runtimes.get(id);
    return rt && this.model && rt.start !== undefined && rt.end !== undefined ? this.model.text.slice(rt.start, rt.end) : undefined;
  }

  /** The text that replaced an orphaned highlight's text, if any. */
  candidateOf(id: string): { start: number; end: number; text: string } | undefined {
    const c = this.runtimes.get(id)?.resolution?.candidate;
    return c && this.model ? { ...c, text: this.model.text.slice(c.start, c.end) } : undefined;
  }

  /**
   * A highlight rebased by the reader: on the text it is on now (Accept), or on another range
   * (Attach). Returns the version before and after; the caller stores it and records the undo.
   */
  rebase(id: string, range?: [number, number]): { before: Highlight; after: Highlight } | undefined {
    const rt = this.runtimes.get(id);
    const model = this.model;
    if (!rt || !model) return undefined;
    const start = range?.[0] ?? rt.start;
    const end = range?.[1] ?? rt.end;
    if (start === undefined || end === undefined || end <= start) return undefined;
    const before = structuredClone(rt.data);
    const after = structuredClone(rt.data);
    after.anchor = createAnchor(model.text, model.hash, start, end);
    after.target.selector = createSelectors(model.text, start, end);
    after.status = 'anchored';
    after.state = { status: 'anchored', kind: 'exact', resolvedIn: model.hash, found: { hash: model.hash, v: TEXT_MODEL_VERSION, length: model.text.length, start, end } };
    after.updatedAt = new Date().toISOString();
    return { before, after };
  }

  /** Replaces a highlight's data (a rebase, or its undo); it is resolved again by the caller. */
  replace(highlight: Highlight): void {
    const old = this.runtimes.get(highlight.id);
    this.runtimes.set(highlight.id, this.runtimeOf(highlight));
    if (old) this.drawPagesOf(old);
    this.events.needsResolve();
  }

  /** Highlights in document order, orphans last. */
  list(): Runtime[] {
    return [...this.runtimes.values()].sort((a, b) => {
      const ao = a.data.status === 'orphaned' ? 1 : 0;
      const bo = b.data.status === 'orphaned' ? 1 : 0;
      return ao - bo || (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER) || a.data.createdAt.localeCompare(b.data.createdAt);
    });
  }

  get(id: string): Runtime | undefined {
    return this.runtimes.get(id);
  }

  /** A copy of the stored data of a highlight (for undo). */
  snapshot(id: string): Highlight | undefined {
    const rt = this.runtimes.get(id);
    return rt ? structuredClone(rt.data) : undefined;
  }

  get all(): Highlight[] {
    return [...this.runtimes.values()].map((rt) => structuredClone(rt.data));
  }

  firstPageOf(id: string): number | undefined {
    const rt = this.runtimes.get(id);
    if (!rt || rt.start === undefined || !this.model) return undefined;
    return this.model.pageOf(rt.start);
  }

  /** The text model of the current document (undefined while it is being built). */
  get textModel(): TextModel | undefined {
    return this.model;
  }

  // ---------- Document lifecycle ----------

  /** The margins inside which text is header or footer (not part of the text model). */
  get margins(): { top: number; bottom: number } {
    return this.marginsPt;
  }

  /**
   * The viewer switched to a new PDF whose text was read already. Everything computed for the
   * previous one is dropped at once: positions and rectangles are only ever those of the
   * document on screen.
   */
  setDocument(doc: PDFDocumentProxy, renderId: number, pages: PageData[], model: TextModel): void {
    this.doc = doc;
    this.renderId = renderId;
    this.pages = pages;
    this.model = model;
    this.live.clear();
    for (const rt of this.runtimes.values()) {
      rt.pages.clear();
      rt.start = undefined;
      rt.end = undefined;
      rt.resolution = undefined;
    }
    // Text layers that rendered before this was called.
    for (let i = 0; i < doc.numPages; i++) {
      const view = this.viewer.pageView(i);
      if (view?.textLayer?.div?.childElementCount) this.onTextLayer(i);
    }
    this.redrawAll();
  }

  /** Resolves when the work in `task` is done; exports wait for it. */
  track(task: Promise<void>): void {
    this.ready = task.catch(() => undefined);
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private segmentsOf(rt: Pick<Runtime, 'start' | 'end'>): PageSegments[] {
    if (!this.model || rt.start === undefined || rt.end === undefined) return [];
    return this.model.segments(rt.start, rt.end);
  }

  private async computeRects(runtimes: Runtime[]): Promise<void> {
    const byPage = new Map<number, Runtime[]>();
    for (const rt of runtimes) {
      for (const seg of this.segmentsOf(rt)) {
        const list = byPage.get(seg.page) ?? [];
        list.push(rt);
        byPage.set(seg.page, list);
      }
    }
    for (const [pageIndex, list] of byPage) {
      const live = this.live.get(pageIndex);
      if (live && live.layer.isConnected) {
        for (const rt of list) this.computePageRects(rt, pageIndex, live);
        continue;
      }
      const off = await this.offscreenLayer(pageIndex);
      if (!off) continue;
      try {
        for (const rt of list) this.computePageRects(rt, pageIndex, off);
      } finally {
        off.layer.parentElement?.remove();
      }
    }
  }

  private computePageRects(rt: Runtime, pageIndex: number, layer: LiveLayer): void {
    const seg = this.segmentsOf(rt).find((s) => s.page === pageIndex);
    if (!seg) return;
    const box = layer.layer.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const rects: Frac[] = [];
    const range = document.createRange();
    for (const s of seg.segments) {
      const node = layer.divs[s.item]?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const length = node.textContent?.length ?? 0;
      range.setStart(node, Math.min(s.from, length));
      range.setEnd(node, Math.min(s.to, length));
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        rects.push([(r.left - box.left) / box.width, (r.top - box.top) / box.height, (r.right - box.left) / box.width, (r.bottom - box.top) / box.height]);
      }
    }
    if (rects.length > 0) rt.pages.set(pageIndex, mergeLines(rects));
  }

  /** Rectangles of an arbitrary text range (used by the reading marker). */
  async rangeRects(start: number, end: number): Promise<{ pageIndex: number; rects: Frac[] }[]> {
    const probe: Runtime = { data: undefined as unknown as Highlight, start, end, pages: new Map() };
    await this.computeRects([probe]);
    return [...probe.pages].sort((a, b) => a[0] - b[0]).map(([pageIndex, rects]) => ({ pageIndex, rects }));
  }

  /** Builds a hidden text layer for a page that PDF.js has not rendered (virtualized pages). */
  private async offscreenLayer(pageIndex: number): Promise<LiveLayer | undefined> {
    const doc = this.doc;
    const data = this.pages[pageIndex];
    if (!doc || !data) return undefined;
    if (!this.offscreenHost) {
      this.offscreenHost = document.createElement('div');
      this.offscreenHost.className = 'pdfViewer mpv-offscreen';
      this.offscreenHost.setAttribute('aria-hidden', 'true');
      document.body.append(this.offscreenHost);
    }
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page';
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    pageDiv.append(layer);
    this.offscreenHost.append(pageDiv);
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: data.textContent as never, container: layer, viewport });
    await textLayer.render();
    return { layer, divs: textLayer.textDivs as HTMLElement[] };
  }

  /**
   * The rectangles in PDF units. Fractions are of the page as shown, so they go through the
   * page's own transform: right for any /Rotate and for crop boxes that do not start at 0.
   */
  private pdfRects(rt: Runtime): PageRects[] {
    const out: PageRects[] = [];
    for (const [pageIndex, fracs] of [...rt.pages].sort((a, b) => a[0] - b[0])) {
      const g = this.pages[pageIndex]?.geometry ?? pageGeometry([0, 0, 612, 792]);
      const rects = fracs.map(([fx1, fy1, fx2, fy2]): PdfRect => {
        const a = toPdfSpace(g, [fx1 * g.width, fy1 * g.height]);
        const b = toPdfSpace(g, [fx2 * g.width, fy2 * g.height]);
        return [round2(Math.min(a[0], b[0])), round2(Math.min(a[1], b[1])), round2(Math.max(a[0], b[0])), round2(Math.max(a[1], b[1]))];
      });
      out.push({ pageIndex, rects });
    }
    return out;
  }

  // ---------- Live text layers ----------

  private onTextLayer(pageIndex: number): void {
    const view = this.viewer.pageView(pageIndex);
    const layerDiv = view?.textLayer?.div;
    const data = this.pages[pageIndex];
    if (!view || !layerDiv || !data || !this.model) return;
    const divs = this.mapTextDivs(layerDiv, data, view);
    this.live.set(pageIndex, { layer: layerDiv, divs });
    divs.forEach((div, item) => {
      if (div) this.spanInfo.set(div, { page: pageIndex, item });
    });
    for (const rt of this.runtimes.values()) {
      if (this.segmentsOf(rt).some((s) => s.page === pageIndex)) this.computePageRects(rt, pageIndex, this.live.get(pageIndex)!);
    }
    this.drawPage(pageIndex);
  }

  /** Maps text items to their spans. Non-empty items are rendered in order, so DOM order matches. */
  private mapTextDivs(layerDiv: HTMLElement, data: PageData, view: PageViewLike): (HTMLElement | undefined)[] {
    const spans = Array.from(layerDiv.querySelectorAll<HTMLElement>('span')).filter(
      (s) => !s.classList.contains('markedContent') && s.childNodes.length === 1 && s.firstChild?.nodeType === Node.TEXT_NODE,
    );
    const divs: (HTMLElement | undefined)[] = new Array(data.strItems.length).fill(undefined);
    const nonEmpty = data.strItems.map((it, i) => (it.str ? i : -1)).filter((i) => i >= 0);
    if (spans.length === nonEmpty.length) {
      nonEmpty.forEach((itemIndex, n) => (divs[itemIndex] = spans[n]));
      return divs;
    }
    // Fallback: PDF.js keeps the mapping on its find-highlighter.
    const mapped = (view as unknown as { _textHighlighter?: { textDivs?: HTMLElement[] } })._textHighlighter?.textDivs;
    if (mapped && mapped.length === data.strItems.length) return [...mapped];
    nonEmpty.slice(0, spans.length).forEach((itemIndex, n) => (divs[itemIndex] = spans[n]));
    return divs;
  }

  /**
   * The text line nearest to a vertical position on a rendered page: its top (fraction of the
   * page height) and the text index where it starts. Without text there, just the position.
   */
  lineAt(pageIndex: number, clientY: number): { top: number; index?: number } | undefined {
    const view = this.viewer.pageView(pageIndex);
    if (!view?.div) return undefined;
    const box = view.div.getBoundingClientRect();
    if (box.height === 0) return undefined;
    const fallback = { top: Math.min(1, Math.max(0, (clientY - box.top) / box.height)) };
    const live = this.live.get(pageIndex);
    const model = this.model;
    if (!live || !model || !live.layer.isConnected) return fallback;
    const lines: { top: number; bottom: number; first: { item: number; left: number } }[] = [];
    live.divs.forEach((el, item) => {
      if (!el || !el.isConnected || !model.isIncluded(pageIndex, item) || !el.textContent?.trim()) return;
      const r = el.getBoundingClientRect();
      if (r.height < 1 || r.width < 1) return;
      const line = lines.find((l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > 0.5 * Math.min(r.height, l.bottom - l.top));
      if (line) {
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
        if (r.left < line.first.left) line.first = { item, left: r.left };
      } else {
        lines.push({ top: r.top, bottom: r.bottom, first: { item, left: r.left } });
      }
    });
    if (lines.length === 0) return fallback;
    const containing = lines.find((l) => clientY >= l.top && clientY <= l.bottom);
    const line = containing ?? lines.reduce((best, l) => (Math.abs((l.top + l.bottom) / 2 - clientY) < Math.abs((best.top + best.bottom) / 2 - clientY) ? l : best));
    return { top: (line.top - box.top) / box.height, index: model.indexAt(pageIndex, line.first.item, 0, 'start') };
  }

  // ---------- Drawing ----------

  private fillLayer(layer: HTMLElement, pageIndex: number): void {
    layer.replaceChildren();
    for (const rt of this.runtimes.values()) {
      if (rt.data.status !== 'anchored') continue;
      const rects = rt.pages.get(pageIndex);
      if (!rects) continue;
      for (const [x1, y1, x2, y2] of rects) {
        const box = document.createElement('div');
        box.className = rt.data.note ? 'mpv-hl mpv-noted' : 'mpv-hl';
        box.dataset.id = rt.data.id;
        const picked = this.selected.has(rt.data.id);
        box.classList.toggle('mpv-selected', picked);
        box.style.left = `${(x1 * 100).toFixed(4)}%`;
        box.style.top = `${(y1 * 100).toFixed(4)}%`;
        box.style.width = `${((x2 - x1) * 100).toFixed(4)}%`;
        box.style.height = `${((y2 - y1) * 100).toFixed(4)}%`;
        box.style.setProperty('--hl', HIGHLIGHT_HEX[rt.data.color]);
        layer.append(box);
        if (!picked) continue;
        // A selected highlight gets the same dashed outline as a selected drawing (an element of
        // its own: the highlight itself is see-through and blended with the page).
        const outline = document.createElement('div');
        outline.className = 'mpv-hl-outline';
        outline.style.left = box.style.left;
        outline.style.top = box.style.top;
        outline.style.width = box.style.width;
        outline.style.height = box.style.height;
        layer.append(outline);
      }
    }
  }

  /** A small note marker in the right margin, level with the first line of each highlight that has a note. */
  private fillBadges(layer: HTMLElement, pageIndex: number): void {
    layer.replaceChildren();
    const items: { rt: Runtime; top: number }[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.data.status !== 'anchored' || !rt.data.note) continue;
      const first = Math.min(...rt.pages.keys());
      if (first !== pageIndex) continue;
      const rects = rt.pages.get(pageIndex) ?? [];
      if (rects.length === 0) continue;
      items.push({ rt, top: Math.min(...rects.map((r) => r[1])) });
    }
    items.sort((a, b) => a.top - b.top);
    let previousTop = -1;
    let stack = 0;
    for (const { rt, top } of items) {
      stack = Math.abs(top - previousTop) < 0.012 ? stack + 1 : 0;
      previousTop = top;
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'mpv-note-badge';
      badge.dataset.id = rt.data.id;
      badge.setAttribute('aria-label', `Note: ${rt.data.note}`);
      badge.style.top = `${(top * 100).toFixed(4)}%`;
      badge.style.setProperty('--stack', String(stack));
      badge.style.setProperty('--hl', HIGHLIGHT_HEX[rt.data.color]);
      const glyph = document.createElement('span');
      glyph.className = 'codicon codicon-comment';
      glyph.setAttribute('aria-hidden', 'true');
      badge.append(glyph);
      layer.append(badge);
    }
  }

  private drawPage(pageIndex: number): void {
    this.layers.redraw(HL_LAYER, pageIndex);
    this.layers.redraw(BADGE_LAYER, pageIndex);
  }

  private drawPagesOf(rt: Runtime, extra: Iterable<number> = []): void {
    for (const pageIndex of new Set([...rt.pages.keys(), ...extra])) this.drawPage(pageIndex);
  }

  redrawAll(): void {
    this.layers.redraw(HL_LAYER);
    this.layers.redraw(BADGE_LAYER);
  }

  /** Marks these highlights as selected (and no other). */
  setSelected(ids: Iterable<string>): void {
    const next = new Set([...ids].filter((id) => this.runtimes.has(id)));
    const changed = [...next].filter((id) => !this.selected.has(id)).concat([...this.selected].filter((id) => !next.has(id)));
    this.selected = next;
    const pages = new Set<number>();
    for (const id of changed) for (const page of this.runtimes.get(id)?.pages.keys() ?? []) pages.add(page);
    for (const page of pages) this.layers.redraw(HL_LAYER, page);
  }

  /** The anchored highlights, each with where it starts (its first page; top and left as fractions of that page), for the reading order. */
  places(): { id: string; page: number; top: number; left: number }[] {
    const out: { id: string; page: number; top: number; left: number }[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.data.status !== 'anchored') continue;
      const page = rt.pages.size > 0 ? Math.min(...rt.pages.keys()) : this.firstPageOf(rt.data.id);
      if (page === undefined) continue;
      const first = (rt.pages.get(page) ?? [])[0];
      out.push({ id: rt.data.id, page, top: first?.[1] ?? 0, left: first?.[0] ?? 0 });
    }
    return out;
  }

  /**
   * The highlights a rectangle touches. `rectOn` gives the rectangle on a page as fractions of
   * that page (x1, y1, x2, y2), or undefined for a page it does not reach.
   */
  touching(rectOn: (pageIndex: number) => Frac | undefined): string[] {
    const ids: string[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.data.status !== 'anchored') continue;
      let hit = false;
      for (const [page, rects] of rt.pages) {
        const r = rectOn(page);
        if (!r) continue;
        if (rects.some(([x1, y1, x2, y2]) => x1 <= r[2] && x2 >= r[0] && y1 <= r[3] && y2 >= r[1])) {
          hit = true;
          break;
        }
      }
      if (hit) ids.push(rt.data.id);
    }
    return ids;
  }

  flash(id: string): void {
    clearTimeout(this.flashTimer);
    document.querySelectorAll('.mpv-hl.mpv-flash').forEach((el) => el.classList.remove('mpv-flash'));
    const apply = () => document.querySelectorAll(`.mpv-hl[data-id="${CSS.escape(id)}"]`).forEach((el) => el.classList.add('mpv-flash'));
    apply();
    setTimeout(apply, 300);
    this.flashTimer = setTimeout(() => document.querySelectorAll('.mpv-hl.mpv-flash').forEach((el) => el.classList.remove('mpv-flash')), 1600);
  }

  /** Scrolls to a highlight and flashes it. */
  reveal(id: string): boolean {
    const rt = this.runtimes.get(id);
    if (!rt || rt.data.status !== 'anchored') return false;
    const [pageIndex, rects] = [...rt.pages].sort((a, b) => a[0] - b[0])[0] ?? [];
    if (pageIndex === undefined || !rects) {
      const page = this.firstPageOf(id);
      if (page === undefined) return false;
      this.viewer.goToPage(page + 1);
      return true;
    }
    const g = this.pages[pageIndex]?.geometry ?? pageGeometry([0, 0, 612, 792]);
    const top = rects.reduce((m, r) => Math.min(m, r[1]), 1);
    const left = rects.reduce((m, r) => Math.min(m, r[0]), 1);
    const [x, y] = toPdfSpace(g, [left * g.width, top * g.height]);
    this.viewer.scrollToPoint(pageIndex, x, y);
    this.flash(id);
    return true;
  }

  /** Whether any part of the highlight is inside the visible area. */
  isVisible(id: string): boolean {
    const container = this.viewer.container.getBoundingClientRect();
    return Array.from(document.querySelectorAll(`.mpv-hl[data-id="${CSS.escape(id)}"]`)).some((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > container.top && r.top < container.bottom && r.width > 0;
    });
  }

  /** Screen rectangle of the first line of a highlight, if its page is rendered. */
  clientRectOf(id: string): { left: number; top: number; right: number; bottom: number } | undefined {
    const rt = this.runtimes.get(id);
    if (!rt) return undefined;
    const [pageIndex, rects] = [...rt.pages].sort((a, b) => a[0] - b[0])[0] ?? [];
    if (pageIndex === undefined || !rects?.length) return undefined;
    const div = this.viewer.pageView(pageIndex)?.div;
    if (!div?.isConnected) return undefined;
    const box = div.getBoundingClientRect();
    const [x1, y1, x2, y2] = [...rects].sort((a, b) => a[1] - b[1])[0];
    return { left: box.left + x1 * box.width, top: box.top + y1 * box.height, right: box.left + x2 * box.width, bottom: box.top + y2 * box.height };
  }

  // ---------- Creating ----------

  /** Maps a DOM boundary point to a normalized text offset. */
  private boundaryIndex(node: Node, offset: number, edge: 'start' | 'end'): number | undefined {
    const model = this.model;
    if (!model) return undefined;
    const spans: { el: HTMLElement; page: number; item: number }[] = [];
    for (const [page, live] of [...this.live].sort((a, b) => a[0] - b[0])) {
      live.divs.forEach((el, item) => {
        if (el && el.isConnected && model.isIncluded(page, item)) spans.push({ el, page, item });
      });
    }
    if (spans.length === 0) return undefined;
    const point = document.createRange();
    try {
      point.setStart(node, offset);
    } catch {
      return undefined;
    }
    point.collapse(true);
    // Inside a text span?
    const host = node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
    const info = host ? this.spanInfo.get(host) : undefined;
    if (info && model.isIncluded(info.page, info.item)) return model.indexAt(info.page, info.item, offset, edge);

    if (edge === 'start') {
      for (const s of spans) {
        if (point.comparePoint(s.el, 0) >= 0) return model.indexAt(s.page, s.item, 0, 'start');
      }
      return undefined;
    }
    // The last span that ends at or before the point. (A selection that stops right before a
    // span, as in front of bold words, ends at that span's own offset 0: the span is not in it.)
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      if (point.comparePoint(s.el, s.el.childNodes.length) <= 0) return model.indexAt(s.page, s.item, s.el.textContent?.length ?? 0, 'end');
    }
    return undefined;
  }

  /** The normalized range covered by the current selection, if it is inside the PDF text. */
  selectionRange(): [number, number] | undefined {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !this.model) return undefined;
    const range = selection.getRangeAt(0);
    if (!this.viewer.container.contains(range.commonAncestorContainer)) return undefined;
    const start = this.boundaryIndex(range.startContainer, range.startOffset, 'start');
    const end = this.boundaryIndex(range.endContainer, range.endOffset, 'end');
    if (start === undefined || end === undefined) return undefined;
    const [s, e] = trimRange(this.model.text, start, end);
    return e > s ? [s, e] : undefined;
  }

  createFromSelection(color: HighlightColor): Highlight | undefined {
    const model = this.model;
    const range = this.selectionRange();
    if (!model || !range) return undefined;
    const [start, end] = range;
    const now = new Date().toISOString();
    const highlight: Highlight = {
      id: uuid(),
      color,
      createdAt: now,
      updatedAt: now,
      status: 'anchored',
      target: { selector: createSelectors(model.text, start, end), hints: { pages: [], textModelHash: model.hash } },
      anchor: createAnchor(model.text, model.hash, start, end),
      // Where it is in the text it was made in: the next render follows it from here.
      state: {
        status: 'anchored',
        kind: 'exact',
        resolvedIn: model.hash,
        found: { hash: model.hash, v: TEXT_MODEL_VERSION, length: model.text.length, start, end, page: model.pageOf(start) },
      },
    };
    const rt: Runtime = { data: highlight, start, end, pages: new Map() };
    this.runtimes.set(highlight.id, rt);
    for (const seg of this.segmentsOf(rt)) {
      const live = this.live.get(seg.page);
      if (live) this.computePageRects(rt, seg.page, live);
    }
    highlight.target.hints.pages = this.pdfRects(rt);
    window.getSelection()?.removeAllRanges();
    this.drawPagesOf(rt);
    this.events.created(structuredClone(highlight));
    this.events.changed();
    // Pages that were not rendered (rare: very long selections) get rects off-screen.
    const missing = this.segmentsOf(rt).filter((s) => !rt.pages.has(s.page));
    if (missing.length > 0) void this.computeRects([rt]).then(() => this.drawPagesOf(rt));
    return highlight;
  }

  /** Adds a highlight back (undo/redo). It is found again in the current document by the next resolving run. */
  add(highlight: Highlight): void {
    this.runtimes.set(highlight.id, this.runtimeOf(highlight));
    this.events.changed();
    this.events.needsResolve();
  }

  setColor(id: string, color: HighlightColor): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.data.color = color;
    rt.data.updatedAt = new Date().toISOString();
    this.drawPagesOf(rt);
    this.events.changed();
  }

  /** Sets or (with an empty string) removes the note of a highlight. */
  setNote(id: string, note: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (note.trim()) rt.data.note = note;
    else delete rt.data.note;
    rt.data.updatedAt = new Date().toISOString();
    this.drawPagesOf(rt);
    this.events.changed();
  }

  remove(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.runtimes.delete(id);
    this.drawPagesOf(rt);
    this.events.changed();
  }

  /** Finds the highlight under a point (client coordinates), preferring the smallest. */
  hitTest(clientX: number, clientY: number): string | undefined {
    const pageDiv = document.elementsFromPoint(clientX, clientY).find((el) => el.classList.contains('page')) as HTMLElement | undefined;
    if (!pageDiv) return undefined;
    const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
    const box = pageDiv.getBoundingClientRect();
    if (box.width === 0) return undefined;
    return this.hitTestOnPage(pageIndex, (clientX - box.left) / box.width, (clientY - box.top) / box.height);
  }

  /** The highlight at a point of a page (fractions of its width and height), preferring the smallest; `skip`: not these. */
  hitTestOnPage(pageIndex: number, fx: number, fy: number, skip?: Set<string>): string | undefined {
    let best: { id: string; area: number } | undefined;
    for (const rt of this.runtimes.values()) {
      if (rt.data.status !== 'anchored' || skip?.has(rt.data.id)) continue;
      for (const [x1, y1, x2, y2] of rt.pages.get(pageIndex) ?? []) {
        const padX = 0.002;
        const padY = 0.002;
        if (fx >= x1 - padX && fx <= x2 + padX && fy >= y1 - padY && fy <= y2 + padY) {
          const area = (x2 - x1) * (y2 - y1);
          if (!best || area < best.area) best = { id: rt.data.id, area };
        }
      }
    }
    return best?.id;
  }

  // ---------- Export ----------

  async exportData(): Promise<{ highlights: ExportHighlight[]; orphaned: number; orphanedNotes: number }> {
    await this.ready;
    // Make sure every anchored highlight has rectangles on every page it touches.
    const incomplete = [...this.runtimes.values()].filter((rt) => rt.data.status === 'anchored' && this.segmentsOf(rt).some((s) => !rt.pages.has(s.page)));
    if (incomplete.length > 0) await this.computeRects(incomplete);
    const highlights: ExportHighlight[] = [];
    let orphaned = 0;
    let orphanedNotes = 0;
    for (const rt of this.list()) {
      if (rt.data.status !== 'anchored') {
        orphaned++;
        if (rt.data.note) orphanedNotes++;
        continue;
      }
      const pages = this.pdfRects(rt);
      if (pages.length === 0) continue;
      // The text as it is now (a fuzzy match may differ slightly from the stored quote).
      const text = this.model && rt.start !== undefined && rt.end !== undefined ? this.model.text.slice(rt.start, rt.end) : rt.data.target.selector[0].exact;
      highlights.push({ id: rt.data.id, color: rt.data.color, text, note: rt.data.note, createdAt: rt.data.createdAt, pages });
    }
    return { highlights, orphaned, orphanedNotes };
  }

  get currentRenderId(): number {
    return this.renderId;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
