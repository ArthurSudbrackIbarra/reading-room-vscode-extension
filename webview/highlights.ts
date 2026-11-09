// Highlights in the viewer: anchoring stored quotes in the rendered PDF, drawing them over the
// PDF.js text layer, creating them from a selection, and producing rectangles for export.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdfjs';
import { anchorQuote, createSelectors } from '../src/anchoring/match';
import { TextModel, trimRange, type PageInput, type PageSegments } from '../src/anchoring/textModel';
import type { AnchorResult, ExportHighlight } from '../src/shared/messages';
import { HIGHLIGHT_HEX, type Highlight, type HighlightColor, type PageRects, type PdfRect } from '../src/shared/types';
import type { PageViewLike, Viewer } from './viewer';

/** Rectangle as fractions of the page box, origin top-left: [x1, y1, x2, y2]. */
type Frac = [number, number, number, number];

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

interface PageData {
  view: number[];
  textContent: { items: TextItemLike[]; styles: Record<string, unknown>; lang?: string | null };
  /** Indices (into textContent.items) of the items that have a `str`, i.e. TextLayer.textDivs order. */
  strItems: TextItemLike[];
}

interface LiveLayer {
  layer: HTMLElement;
  divs: (HTMLElement | undefined)[];
}

interface Runtime {
  data: Highlight;
  start?: number;
  end?: number;
  /** Per page index: rectangles as fractions of the page. */
  pages: Map<number, Frac[]>;
}

export interface HighlightEvents {
  created(highlight: Highlight): void;
  changed(): void;
  anchored(results: AnchorResult[]): void;
}

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
  private readonly layerObservers = new Map<number, MutationObserver>();
  private offscreenHost?: HTMLDivElement;
  private ready: Promise<void> = Promise.resolve();
  private marginsPt = { top: 51, bottom: 57 };
  private flashTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly viewer: Viewer,
    private readonly events: HighlightEvents,
  ) {
    viewer.eventBus.on('textlayerrendered', (evt: { pageNumber: number }) => this.onTextLayer(evt.pageNumber - 1));
    viewer.eventBus.on('pagerendered', (evt: { pageNumber: number }) => this.attachLayer(evt.pageNumber - 1));
  }

  setMargins(margins: { top: number; bottom: number }): void {
    this.marginsPt = margins;
  }

  // ---------- Data ----------

  setHighlights(list: Highlight[]): void {
    this.runtimes.clear();
    for (const h of list) this.runtimes.set(h.id, { data: structuredClone(h), pages: new Map() });
    if (this.doc) this.ready = this.anchorAll();
    else this.events.changed();
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

  firstPageOf(id: string): number | undefined {
    const rt = this.runtimes.get(id);
    if (!rt || rt.start === undefined || !this.model) return undefined;
    return this.model.pageOf(rt.start);
  }

  // ---------- Document lifecycle ----------

  /** Called after each (re)load of the PDF. Builds the text model and re-anchors every highlight. */
  documentLoaded(doc: PDFDocumentProxy, renderId: number): Promise<void> {
    this.doc = doc;
    this.renderId = renderId;
    this.model = undefined;
    this.pages = [];
    this.live.clear();
    for (const observer of this.layerObservers.values()) observer.disconnect();
    this.layerObservers.clear();
    this.ready = (async () => {
      await this.buildModel(doc);
      if (this.doc !== doc) return;
      await this.anchorAll();
    })();
    return this.ready;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private async buildModel(doc: PDFDocumentProxy): Promise<void> {
    const pages: PageData[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = (await page.getTextContent({ includeMarkedContent: true, disableNormalization: true })) as unknown as PageData['textContent'];
      const strItems = textContent.items.filter((it) => typeof it.str === 'string');
      pages.push({ view: page.view, textContent, strItems });
    }
    if (this.doc !== doc) return;
    this.pages = pages;
    const inputs: PageInput[] = pages.map((p) => ({
      view: p.view,
      items: p.strItems.map((it) => ({ str: it.str ?? '', hasEOL: !!it.hasEOL, transform: it.transform ?? [1, 0, 0, 1, 0, 0] })),
    }));
    this.model = new TextModel(inputs, { marginsPt: this.marginsPt });
    // Text layers that rendered before the model existed.
    for (let i = 0; i < doc.numPages; i++) {
      const view = this.viewer.pageView(i);
      if (view?.textLayer?.div?.childElementCount) this.onTextLayer(i);
    }
  }

  private async anchorAll(): Promise<void> {
    const model = this.model;
    if (!model) return;
    const results: AnchorResult[] = [];
    for (const rt of this.runtimes.values()) {
      const [quote, position] = rt.data.target.selector;
      const match = anchorQuote(model.text, quote, position);
      rt.pages.clear();
      if (match) {
        rt.start = match.start;
        rt.end = match.end;
        rt.data.status = 'anchored';
      } else {
        rt.start = undefined;
        rt.end = undefined;
        rt.data.status = 'orphaned';
      }
    }
    // Rectangles: from live text layers where rendered, off-screen layers elsewhere.
    await this.computeAllRects();
    if (this.model !== model) return;
    for (const rt of this.runtimes.values()) {
      const result: AnchorResult = { id: rt.data.id, status: rt.data.status, textModelHash: model.hash };
      if (rt.data.status === 'anchored') {
        result.start = rt.start;
        result.end = rt.end;
        result.pages = this.pdfRects(rt);
        rt.data.target.selector[1] = { type: 'TextPositionSelector', start: rt.start!, end: rt.end! };
        rt.data.target.hints = { pages: result.pages, textModelHash: model.hash };
      }
      results.push(result);
    }
    this.redrawAll();
    this.events.anchored(results);
    this.events.changed();
  }

  private segmentsOf(rt: Runtime): PageSegments[] {
    if (!this.model || rt.start === undefined || rt.end === undefined) return [];
    return this.model.segments(rt.start, rt.end);
  }

  private async computeAllRects(): Promise<void> {
    const byPage = new Map<number, Runtime[]>();
    for (const rt of this.runtimes.values()) {
      for (const seg of this.segmentsOf(rt)) {
        const list = byPage.get(seg.page) ?? [];
        list.push(rt);
        byPage.set(seg.page, list);
      }
    }
    for (const [pageIndex, runtimes] of byPage) {
      const live = this.live.get(pageIndex);
      if (live) {
        for (const rt of runtimes) this.computePageRects(rt, pageIndex, live);
        continue;
      }
      const off = await this.offscreenLayer(pageIndex);
      if (!off) continue;
      try {
        for (const rt of runtimes) this.computePageRects(rt, pageIndex, off);
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

  private pdfRects(rt: Runtime): PageRects[] {
    const out: PageRects[] = [];
    for (const [pageIndex, fracs] of [...rt.pages].sort((a, b) => a[0] - b[0])) {
      const [x0, y0, x1, y1] = this.pages[pageIndex]?.view ?? [0, 0, 612, 792];
      const w = x1 - x0;
      const h = y1 - y0;
      const rects = fracs.map(
        ([fx1, fy1, fx2, fy2]): PdfRect => [
          round2(x0 + fx1 * w),
          round2(y1 - fy2 * h),
          round2(x0 + fx2 * w),
          round2(y1 - fy1 * h),
        ],
      );
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
    this.attachLayer(pageIndex);
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

  // ---------- Drawing ----------

  /** Inserts our layer right above the canvas. PDF.js removes unknown children on reset, so watch for that. */
  private attachLayer(pageIndex: number): HTMLElement | undefined {
    const view = this.viewer.pageView(pageIndex);
    if (!view?.div) return undefined;
    let layer = view.div.querySelector<HTMLElement>(':scope > .mpv-hl-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'mpv-hl-layer';
      const canvas = view.div.querySelector(':scope > .canvasWrapper');
      if (canvas) canvas.after(layer);
      else view.div.prepend(layer);
      this.fillLayer(layer, pageIndex);
    }
    if (!this.layerObservers.has(pageIndex)) {
      const observer = new MutationObserver(() => {
        if (!view.div.querySelector(':scope > .mpv-hl-layer')) this.attachLayer(pageIndex);
      });
      observer.observe(view.div, { childList: true });
      this.layerObservers.set(pageIndex, observer);
    }
    return layer;
  }

  private fillLayer(layer: HTMLElement, pageIndex: number): void {
    layer.replaceChildren();
    for (const rt of this.runtimes.values()) {
      if (rt.data.status !== 'anchored') continue;
      const rects = rt.pages.get(pageIndex);
      if (!rects) continue;
      for (const [x1, y1, x2, y2] of rects) {
        const box = document.createElement('div');
        box.className = 'mpv-hl';
        box.dataset.id = rt.data.id;
        box.style.left = `${(x1 * 100).toFixed(4)}%`;
        box.style.top = `${(y1 * 100).toFixed(4)}%`;
        box.style.width = `${((x2 - x1) * 100).toFixed(4)}%`;
        box.style.height = `${((y2 - y1) * 100).toFixed(4)}%`;
        box.style.setProperty('--hl', HIGHLIGHT_HEX[rt.data.color]);
        layer.append(box);
      }
    }
  }

  private drawPage(pageIndex: number): void {
    const layer = this.attachLayer(pageIndex);
    if (layer) this.fillLayer(layer, pageIndex);
  }

  redrawAll(): void {
    for (let i = 0; i < this.viewer.pagesCount; i++) {
      const view = this.viewer.pageView(i);
      if (view?.div?.querySelector(':scope > .mpv-hl-layer') || this.live.has(i)) this.drawPage(i);
    }
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
    const [x0, , x1, y1] = this.pages[pageIndex]?.view ?? [0, 0, 612, 792];
    const [, y0] = this.pages[pageIndex]?.view ?? [0, 0];
    const top = rects.reduce((m, r) => Math.min(m, r[1]), 1);
    const left = rects.reduce((m, r) => Math.min(m, r[0]), 1);
    this.viewer.scrollToPoint(pageIndex, x0 + left * (x1 - x0), y1 - top * (y1 - y0));
    this.flash(id);
    return true;
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
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      if (point.comparePoint(s.el, 0) <= 0) return model.indexAt(s.page, s.item, s.el.textContent?.length ?? 0, 'end');
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
    };
    const rt: Runtime = { data: highlight, start, end, pages: new Map() };
    this.runtimes.set(highlight.id, rt);
    for (const seg of this.segmentsOf(rt)) {
      const live = this.live.get(seg.page);
      if (live) this.computePageRects(rt, seg.page, live);
    }
    highlight.target.hints.pages = this.pdfRects(rt);
    window.getSelection()?.removeAllRanges();
    for (const pageIndex of rt.pages.keys()) this.drawPage(pageIndex);
    this.events.created(structuredClone(highlight));
    this.events.changed();
    // Pages that were not rendered (rare: very long selections) get rects off-screen.
    const missing = this.segmentsOf(rt).filter((s) => !rt.pages.has(s.page));
    if (missing.length > 0) void this.computeAllRects().then(() => this.redrawAll());
    return highlight;
  }

  setColor(id: string, color: HighlightColor): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.data.color = color;
    rt.data.updatedAt = new Date().toISOString();
    for (const pageIndex of rt.pages.keys()) this.drawPage(pageIndex);
    this.events.changed();
  }

  remove(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.runtimes.delete(id);
    for (const pageIndex of rt.pages.keys()) this.drawPage(pageIndex);
    this.events.changed();
  }

  /** Finds the highlight under a point (client coordinates), preferring the smallest. */
  hitTest(clientX: number, clientY: number): string | undefined {
    const pageDiv = document.elementsFromPoint(clientX, clientY).find((el) => el.classList.contains('page')) as HTMLElement | undefined;
    if (!pageDiv) return undefined;
    const pageIndex = Number(pageDiv.dataset.pageNumber) - 1;
    const layer = pageDiv.querySelector<HTMLElement>(':scope > .mpv-hl-layer') ?? pageDiv;
    const box = layer.getBoundingClientRect();
    if (box.width === 0) return undefined;
    const fx = (clientX - box.left) / box.width;
    const fy = (clientY - box.top) / box.height;
    let best: { id: string; area: number } | undefined;
    for (const rt of this.runtimes.values()) {
      if (rt.data.status !== 'anchored') continue;
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

  async exportData(): Promise<{ highlights: ExportHighlight[]; orphaned: number }> {
    await this.ready;
    // Make sure every anchored highlight has rectangles on every page it touches.
    const incomplete = [...this.runtimes.values()].some(
      (rt) => rt.data.status === 'anchored' && this.segmentsOf(rt).some((s) => !rt.pages.has(s.page)),
    );
    if (incomplete) await this.computeAllRects();
    const highlights: ExportHighlight[] = [];
    let orphaned = 0;
    for (const rt of this.list()) {
      if (rt.data.status !== 'anchored') {
        orphaned++;
        continue;
      }
      const pages = this.pdfRects(rt);
      if (pages.length === 0) continue;
      // The text as it is now (a fuzzy match may differ slightly from the stored quote).
      const text = this.model && rt.start !== undefined && rt.end !== undefined ? this.model.text.slice(rt.start, rt.end) : rt.data.target.selector[0].exact;
      highlights.push({ id: rt.data.id, color: rt.data.color, text, createdAt: rt.data.createdAt, pages });
    }
    return { highlights, orphaned };
  }

  get currentRenderId(): number {
    return this.renderId;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
