// PDF.js viewer components: scrolling pages, text layer, link annotations, zoom.
import { pdfjsLib } from './pdfjs';
import { EventBus, PDFLinkService, PDFViewer, LinkTarget } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, isZoomValue, type ZoomValue } from '../src/shared/types';

export interface ViewerAssets {
  cmaps: string;
  standardFonts: string;
  wasm: string;
}

export interface ViewLocation {
  pageNumber: number;
  /** Fraction of the page height scrolled past at the top of the viewport. */
  fraction: number;
}

export interface PageViewLike {
  id: number;
  div: HTMLDivElement;
  viewport: { width: number; height: number; scale: number };
  pdfPage?: { view: number[] };
  textLayer?: { div: HTMLDivElement } | null;
  /** Images drawn on the page: 6 numbers each (three corners, as fractions of the page). */
  imageCoordinates?: ArrayLike<number> | null;
}

/** Asks the reader for the password of an encrypted PDF; undefined cancels. */
export type PasswordPrompt = (incorrect: boolean) => Promise<string | undefined>;

const ZOOM_STEP = 1.1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class Viewer {
  readonly eventBus = new EventBus();
  readonly linkService: PDFLinkService;
  readonly pdfViewer: PDFViewer;
  doc?: PDFDocumentProxy;
  /** PDF.js v6 frees a document through its loading task. */
  private task?: { destroy(): Promise<void> };
  private loadSeq = 0;
  private zoom: ZoomValue = DEFAULT_ZOOM;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private lastWidth = 0;
  private lastHeight = 0;
  /** Password of the current (encrypted) PDF, reused when the file is reloaded. */
  password?: string;

  /** Called whenever the scale changes (toolbar update, persistence). */
  onScaleChange?: (zoom: ZoomValue, scale: number) => void;
  onPageChange?: (pageNumber: number, pagesCount: number) => void;
  onScroll?: () => void;
  onPassword?: PasswordPrompt;

  constructor(
    readonly container: HTMLDivElement,
    viewerElement: HTMLDivElement,
    private readonly assets: ViewerAssets,
    private readonly originElement: HTMLElement,
    options: { recordImages?: boolean } = {},
  ) {
    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: LinkTarget.NONE,
      ignoreDestinationZoom: true,
    });
    this.pdfViewer = new PDFViewer({
      container,
      viewer: viewerElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
      textLayerMode: 1,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
      enableDetailCanvas: true,
      enableAutoLinking: false,
      // Records where images are drawn (pageView.imageCoordinates), so dark pages can keep photos
      // in their real colors. The huge minimum size keeps PDF.js from adding its own image overlays.
      ...(options.recordImages ? { imagesRightClickMinSize: 1_000_000 } : {}),
    });
    this.linkService.setViewer(this.pdfViewer);

    this.eventBus.on('scalechanging', (evt: { scale: number; presetValue?: string }) => {
      const preset = evt.presetValue;
      this.zoom = preset && isZoomValue(preset) ? preset : Math.round(evt.scale * 1000) / 1000;
      this.onScaleChange?.(this.zoom, evt.scale);
    });
    this.eventBus.on('pagechanging', (evt: { pageNumber: number }) => {
      this.onPageChange?.(evt.pageNumber, this.pdfViewer.pagesCount);
    });

    container.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    container.addEventListener('scroll', () => this.onScroll?.(), { passive: true });
    new ResizeObserver((entries) => this.onResize(entries)).observe(container);
    this.watchDevicePixelRatio();
  }

  get zoomValue(): ZoomValue {
    return this.zoom;
  }

  get scale(): number {
    return this.pdfViewer.currentScale;
  }

  // ---------- Loading ----------

  /** Loads a new PDF, keeping the zoom and the reading position of the previous one. */
  async load(data: Uint8Array, restore?: ViewLocation): Promise<PDFDocumentProxy | undefined> {
    const seq = ++this.loadSeq;
    const location = this.doc ? this.captureLocation() : restore;
    const task = pdfjsLib.getDocument({
      data,
      cMapUrl: this.assets.cmaps,
      cMapPacked: true,
      standardFontDataUrl: this.assets.standardFonts,
      wasmUrl: this.assets.wasm,
      enableXfa: false,
    });
    let asked = false;
    task.onPassword = (update: (password: string) => void, reason: number) => {
      const incorrect = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      // Reuse the password typed for the previous version of this file once.
      if (!asked && !incorrect && this.password !== undefined) {
        asked = true;
        update(this.password);
        return;
      }
      asked = true;
      const prompt = this.onPassword ?? (async () => undefined);
      void prompt(incorrect || this.password !== undefined).then((password) => {
        if (password === undefined) {
          void task.destroy();
          return;
        }
        this.password = password;
        update(password);
      });
    };
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (err) {
      if (seq !== this.loadSeq) return undefined;
      throw err;
    }
    if (seq !== this.loadSeq) {
      void task.destroy();
      return undefined;
    }
    const previousTask = this.task;
    this.task = task;
    this.doc = doc;
    const pagesInit = new Promise<void>((resolve) => this.eventBus.on('pagesinit', () => resolve(), { once: true }));
    this.pdfViewer.setDocument(doc);
    this.linkService.setDocument(doc);
    await pagesInit;
    if (seq !== this.loadSeq) return undefined;
    this.applyZoom(this.zoom);
    if (location) this.restoreLocation(location);
    this.onPageChange?.(this.pdfViewer.currentPageNumber, this.pdfViewer.pagesCount);
    if (previousTask) void previousTask.destroy();
    return doc;
  }

  captureLocation(): ViewLocation | undefined {
    if (!this.doc || this.pdfViewer.pagesCount === 0) return undefined;
    const pageNumber = this.pdfViewer.currentPageNumber;
    const view = this.pdfViewer.getPageView(pageNumber - 1) as unknown as PageViewLike | undefined;
    if (!view?.div || view.div.offsetHeight === 0) return { pageNumber, fraction: 0 };
    const fraction = (this.container.scrollTop - view.div.offsetTop) / view.div.offsetHeight;
    return { pageNumber, fraction: clamp(fraction, -0.5, 1) };
  }

  restoreLocation(location: ViewLocation): void {
    const index = clamp(Math.round(location.pageNumber), 1, Math.max(1, this.pdfViewer.pagesCount)) - 1;
    const view = this.pdfViewer.getPageView(index) as unknown as PageViewLike | undefined;
    if (!view?.div) return;
    this.container.scrollTop = view.div.offsetTop + location.fraction * view.div.offsetHeight;
  }

  // ---------- Zoom ----------

  setInitialZoom(zoom: ZoomValue): void {
    this.zoom = zoom;
  }

  applyZoom(zoom: ZoomValue): void {
    this.zoom = typeof zoom === 'number' ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : zoom;
    if (!this.doc) return;
    this.pdfViewer.currentScaleValue = String(this.zoom);
  }

  private zoomBy(factor: number, origin?: [number, number], drawingDelay = -1): void {
    if (!this.doc) return;
    const current = this.pdfViewer.currentScale;
    const target = clamp(current * factor, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(target - current) < 0.0005) return;
    const at = origin ?? [this.container.offsetLeft + this.container.clientWidth / 2, this.container.offsetTop + this.container.clientHeight / 2];
    this.pdfViewer.updateScale({ scaleFactor: target / current, origin: at, drawingDelay });
  }

  /** Next "nice" step, like PDF.js: 1.1× rounded to tenths. */
  private stepFrom(scale: number, direction: 1 | -1): number {
    const raw = direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
    const rounded = direction > 0 ? Math.ceil(raw * 10) / 10 : Math.floor(raw * 10) / 10;
    return rounded === Math.round(scale * 10) / 10 ? raw : rounded;
  }

  zoomIn(): void {
    if (this.doc) this.zoomBy(this.stepFrom(this.scale, 1) / this.scale);
  }

  zoomOut(): void {
    if (this.doc) this.zoomBy(this.stepFrom(this.scale, -1) / this.scale);
  }

  resetZoom(): void {
    this.applyZoom(DEFAULT_ZOOM);
  }

  /** Ctrl+wheel and trackpad pinch (which Chromium reports as Ctrl+wheel) zoom around the pointer. */
  private onWheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!this.doc) return;
    let factor: number;
    const notch = e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
    if (notch) factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    else factor = Math.exp(-e.deltaY / 100);
    const frame = this.originElement.getBoundingClientRect();
    this.zoomBy(factor, [e.clientX - frame.left, e.clientY - frame.top], 400);
  }

  // ---------- Layout changes ----------

  private onResize(entries: ResizeObserverEntry[]): void {
    const box = entries[entries.length - 1]?.contentRect;
    if (!box || (box.width === this.lastWidth && box.height === this.lastHeight)) return;
    this.lastWidth = box.width;
    this.lastHeight = box.height;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.refit(), 100);
  }

  /** Re-applies "fit width"/"fit page" to the current container size, keeping the reading position. */
  refit(): void {
    if (!this.doc || this.container.clientWidth === 0) return;
    const location = this.captureLocation();
    const preset = this.pdfViewer.currentScaleValue;
    if (preset === 'page-width' || preset === 'page-fit' || preset === 'auto') {
      this.pdfViewer.currentScaleValue = preset;
      if (location) this.restoreLocation(location);
    } else {
      this.pdfViewer.update();
    }
  }

  /** Window zoom and moving between monitors change devicePixelRatio: re-render pages sharply. */
  private watchDevicePixelRatio(): void {
    const query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener(
      'change',
      () => {
        if (this.doc) this.pdfViewer.refresh();
        this.watchDevicePixelRatio();
      },
      { once: true },
    );
  }

  // ---------- Navigation ----------

  goToPage(pageNumber: number): void {
    if (!this.doc) return;
    this.pdfViewer.currentPageNumber = clamp(Math.round(pageNumber), 1, this.pdfViewer.pagesCount);
  }

  nextPage(): void {
    this.pdfViewer.nextPage();
  }

  previousPage(): void {
    this.pdfViewer.previousPage();
  }

  /**
   * Scrolls so that a vertical position on a page (fraction of the page height from the top) sits
   * `ratio` of the way down the visible area.
   */
  scrollToFraction(pageIndex: number, y: number, ratio = 0.25): boolean {
    const view = this.pageView(pageIndex);
    if (!this.doc || !view?.div) return false;
    const target = view.div.offsetTop + y * view.div.offsetHeight - this.container.clientHeight * ratio;
    this.container.scrollTop = Math.max(0, target);
    return true;
  }

  /** The page under a point (client coordinates), if any. */
  pageIndexAt(clientX: number, clientY: number): number | undefined {
    const page = document.elementsFromPoint(clientX, clientY).find((el) => el.classList.contains('page')) as HTMLElement | undefined;
    const n = Number(page?.dataset.pageNumber);
    return Number.isInteger(n) && n > 0 ? n - 1 : undefined;
  }

  /** Scrolls so that the point (PDF units, origin bottom-left) is near the top of the viewport. */
  scrollToPoint(pageIndex: number, x: number, y: number): void {
    if (!this.doc) return;
    this.pdfViewer.scrollPageIntoView({
      pageNumber: pageIndex + 1,
      destArray: [null, { name: 'XYZ' }, Math.max(0, x - 40), y + 60, null],
      allowNegativeOffset: true,
    });
  }

  pageView(index: number): PageViewLike | undefined {
    return this.pdfViewer.getPageView(index) as unknown as PageViewLike | undefined;
  }

  get pagesCount(): number {
    return this.pdfViewer.pagesCount;
  }
}
