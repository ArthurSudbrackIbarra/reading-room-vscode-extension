// Keeps every annotation on its content: reads a new PDF before it is shown, resolves highlights,
// the reading marker, drawings and text boxes against it (src/anchoring), hands the results to
// their controllers and reports what a saved render did to the host.
//
// One resolving run at a time: a new PDF, new annotation data or a brought-back annotation starts
// a new run, which cancels the one in flight. Results are only ever applied to the document they
// were computed for.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AnchorState } from '../src/anchoring/anchor';
import type { DrawingBinding } from '../src/anchoring/binding';
import type { CopyHint } from '../src/anchoring/diff';
import { pageImages } from '../src/anchoring/extract';
import { DocumentLayout, type Box } from '../src/anchoring/layout';
import { alignPages, differenceHash, pageTextHash, parseSignature, samePage, signatureKey, type PageSignature } from '../src/anchoring/pageAlign';
import { ResolverRuns, bindDrawing, type RunInput, type RunResult } from '../src/anchoring/runs';
import { TextModel } from '../src/anchoring/textModel';
import type { Drawing } from '../src/shared/drawings';
import type { ViewerToHost } from '../src/shared/messages';
import type { DocumentKind } from '../src/shared/types';
import type { DrawingBinder, DrawingController } from './drawings';
import { readPages, type HighlightController, type PageData } from './highlights';
import type { ReadingMarkerController } from './marker';
import { pdfjsLib } from './pdfjs';
import type { OpenedPdf } from './viewer';

export interface AnchoringHost {
  kind: DocumentKind;
  post(message: ViewerToHost): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** A run finished: tells the reader what changed (a line at the bottom, a banner). */
  report(result: RunResult): void;
}

export interface RenderInfo {
  renderId: number;
  provisional: boolean;
  hints: CopyHint[];
  /** Hashes of the earlier versions of the text the host keeps. */
  snapshots: string[];
}

export interface PreparedDocument {
  doc: PDFDocumentProxy;
  renderId: number;
  provisional: boolean;
  hints: CopyHint[];
  pages: PageData[];
  model: TextModel;
  layout: DocumentLayout;
  /** Image boxes by page, read when first needed. */
  images: Map<number, Promise<Box[]>>;
  /** PDF files: the signatures of the pages, and where the pages of the last stored version are now. */
  signatures?: PageSignature[];
  /** The signatures were given to the host. */
  signaturesSent?: boolean;
  pageMap?: (number | undefined)[];
  result?: RunResult & { version: number };
}

/** Texts of earlier versions kept in memory. */
const MAX_TEXTS = 6;
/** Earlier versions asked from the host for one run. */
const MAX_SNAPSHOT_REQUEST = 8;
const SNAPSHOT_TIMEOUT_MS = 5000;
/** Pages without text that get a picture hash (PDF files). */
const MAX_IMAGE_PAGES = 120;

export class AnchoringController implements DrawingBinder {
  private current?: PreparedDocument;
  private readonly runs = new ResolverRuns();
  private readonly texts = new Map<string, string>();
  private hostSnapshots = new Set<string>();
  private readonly waiters = new Map<number, (texts: Record<string, string>) => void>();
  private requestSeq = 0;
  private storedPages: string[] = [];
  private firstRun = true;
  /** Counts changes of the annotation data: results for an older count are not applied. */
  private version = 0;
  private applySeq = 0;
  private scheduled = false;
  /** Whether texts of earlier versions are kept on disk (the textSnapshots setting). */
  keepSnapshots = true;

  constructor(
    private readonly highlights: HighlightController,
    private readonly marker: ReadingMarkerController,
    private readonly drawings: DrawingController,
    private readonly host: AnchoringHost,
  ) {
    drawings.setBinder(this);
  }

  get layout(): DocumentLayout | undefined {
    return this.current?.layout;
  }

  get renderId(): number {
    return this.current?.renderId ?? -1;
  }

  hash(): string | undefined {
    return this.current?.model.hash;
  }

  /** The signatures of the pages of the last stored version (PDF files). */
  setStoredPages(pages: string[] | undefined): void {
    this.storedPages = Array.isArray(pages) ? pages : [];
  }

  /** The host answered a request for texts of earlier versions. */
  onSnapshots(requestId: number, texts: Record<string, string>): void {
    this.waiters.get(requestId)?.(texts ?? {});
    this.waiters.delete(requestId);
  }

  // ---------- Documents ----------

  /**
   * Reads a PDF that is not shown yet and resolves everything against it. Undefined when a newer
   * PDF arrived meanwhile.
   */
  async prepare(opened: OpenedPdf, info: RenderInfo): Promise<PreparedDocument | undefined> {
    const read = await readPages(opened.doc, opened.stale);
    if (!read || opened.stale()) return undefined;
    const model = new TextModel(read.inputs, { marginsPt: this.highlights.margins });
    const prepared: PreparedDocument = {
      doc: opened.doc,
      renderId: info.renderId,
      provisional: info.provisional,
      hints: info.hints,
      pages: read.pages,
      model,
      layout: new DocumentLayout(read.inputs, model),
      images: new Map(),
    };
    this.hostSnapshots = new Set(info.snapshots);
    prepared.result = await this.resolve(prepared);
    return opened.stale() ? undefined : prepared;
  }

  /**
   * The viewer shows the prepared document now. What was computed for the previous one is dropped
   * in the same step, and the prepared results are applied (or computed again, if annotations
   * changed while the document was being prepared).
   */
  commit(prepared: PreparedDocument): void {
    this.current = prepared;
    this.highlights.setDocument(prepared.doc, prepared.renderId, prepared.pages, prepared.model);
    this.marker.documentChanged();
    this.drawings.documentChanged();
    if (prepared.result && prepared.result.version === this.version) this.apply(prepared, prepared.result);
    else void this.run();
  }

  /** Annotations were added, replaced or brought back: resolve again (once, however many changed). */
  requestRun(): void {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.run();
    });
  }

  /** Resolves everything against the document shown and applies the results. */
  run(): Promise<void> {
    const current = this.current;
    if (!current) return Promise.resolve();
    const task = (async () => {
      const result = await this.resolve(current);
      if (result && this.current === current && result.version === this.version) this.apply(current, result);
    })().catch((err: unknown) => this.host.log('error', `Resolving the annotations failed: ${String(err)}`));
    this.highlights.track(task);
    return task;
  }

  // ---------- Resolving ----------

  private async resolve(p: PreparedDocument): Promise<(RunResult & { version: number }) | undefined> {
    const version = this.version;
    const input: RunInput = { highlights: this.highlights.inputs(), marker: this.marker.input(), drawings: this.drawings.inputs() };
    await this.fetchSnapshots(p, input);
    if (this.host.kind === 'pdf') await this.alignPages(p, input);
    const result = await this.runs.run({ renderId: p.renderId, model: p.model, layout: p.layout, provisional: p.provisional, hints: p.hints }, input, {
      oldText: (hash) => this.texts.get(hash),
      images: (page) => this.imagesOf(p, page),
      pageMap: p.pageMap ? (page) => p.pageMap![page] : undefined,
      findPage: p.signatures ? (print) => this.findPage(p, print) : undefined,
      textSize: (drawing) => this.drawings.textSizeOf(drawing),
      pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
      onQuick: (quick) => {
        // What was found so far is shown while the slow search goes on.
        if (this.current === p && version === this.version) this.show(p, quick);
      },
      log: (message) => this.host.log('warn', message),
      first: this.firstRun,
    });
    if (!result) return undefined;
    this.remember(p.model.hash, p.model.text);
    return Object.assign(result, { version });
  }

  private remember(hash: string, text: string): void {
    this.texts.delete(hash);
    this.texts.set(hash, text);
    while (this.texts.size > MAX_TEXTS) this.texts.delete(this.texts.keys().next().value as string);
  }

  /** Asks the host for the texts of the versions annotations were last found in, when it has them. */
  private async fetchSnapshots(p: PreparedDocument, input: RunInput): Promise<void> {
    const wanted = new Set<string>();
    const consider = (state: AnchorState | undefined) => {
      const hash = state?.found?.hash;
      if (hash && hash !== p.model.hash && !this.texts.has(hash) && this.hostSnapshots.has(hash)) wanted.add(hash);
    };
    for (const h of input.highlights) consider(h.state);
    consider(input.marker?.state);
    for (const d of input.drawings) for (const s of d.states ?? []) consider(s);
    if (wanted.size === 0) return;
    const requestId = ++this.requestSeq;
    const texts = await new Promise<Record<string, string>>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({});
      }, SNAPSHOT_TIMEOUT_MS);
      this.waiters.set(requestId, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.host.post({ type: 'requestSnapshots', requestId, hashes: [...wanted].slice(0, MAX_SNAPSHOT_REQUEST) });
    });
    for (const [hash, text] of Object.entries(texts)) if (typeof text === 'string') this.remember(hash, text);
  }

  private imagesOf(p: PreparedDocument, page: number): Promise<Box[]> {
    let boxes = p.images.get(page);
    if (!boxes) {
      boxes = (async () => pageImages((await p.doc.getPage(page + 1)) as never, pdfjsLib.OPS))().catch((err: unknown) => {
        this.host.log('warn', `Reading the images of page ${page + 1} failed: ${String(err)}`);
        return [];
      });
      p.images.set(page, boxes);
    }
    return boxes;
  }

  // ---------- PDF files: pages ----------

  /** A small picture hash of a page (for pages without text). */
  private async imageHash(doc: PDFDocumentProxy, index: number): Promise<string | undefined> {
    const page = await doc.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 72 / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(9, Math.ceil(viewport.width));
    canvas.height = Math.max(8, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas } as never).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const sums = new Float64Array(72);
    const counts = new Float64Array(72);
    for (let y = 0; y < canvas.height; y++) {
      const row = Math.min(7, Math.floor((y * 8) / canvas.height));
      for (let x = 0; x < canvas.width; x++) {
        const cell = row * 9 + Math.min(8, Math.floor((x * 9) / canvas.width));
        const i = (y * canvas.width + x) * 4;
        sums[cell] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        counts[cell]++;
      }
    }
    return differenceHash(Array.from(sums, (sum, i) => sum / Math.max(1, counts[i])));
  }

  private async signaturesOf(p: PreparedDocument): Promise<PageSignature[]> {
    if (p.signatures) return p.signatures;
    const signatures: PageSignature[] = p.pages.map((page, i) => ({
      text: pageTextHash(p.model.text.slice(p.model.pageStart[i], p.model.pageStart[i + 1])),
      width: page.geometry.width,
      height: page.geometry.height,
      rotate: page.rotate,
    }));
    let pictures = 0;
    for (let i = 0; i < signatures.length && pictures < MAX_IMAGE_PAGES; i++) {
      if (signatures[i].text) continue;
      pictures++;
      const image = await this.imageHash(p.doc, i).catch(() => undefined);
      if (image) signatures[i].image = image;
    }
    p.signatures = signatures;
    return signatures;
  }

  /**
   * Finds where the pages of the last stored version are in this one, when something is bound to
   * a page (a drawing on a scanned page, a marker on a page without text).
   */
  private async alignPages(p: PreparedDocument, input: RunInput): Promise<void> {
    if (p.pageMap || p.signatures) return;
    const pageBound = input.drawings.some((d) => !d.binding || d.binding.mode === 'page') || (input.marker !== undefined && !input.marker.anchor);
    if (!pageBound) return;
    const now = await this.signaturesOf(p);
    const before = this.storedPages.map(parseSignature);
    if (before.length === 0 || before.some((s) => s === undefined)) return;
    const old = before as PageSignature[];
    const map = alignPages(old, now);
    // Pages that cannot be told apart keep their number when no page was added or removed.
    if (old.length === now.length) {
      map.forEach((to, i) => {
        if (to === undefined && !old[i].text && !old[i].image) map[i] = i;
      });
    }
    p.pageMap = map;
  }

  private findPage(p: PreparedDocument, print: string): number | undefined {
    const wanted = parseSignature(print);
    if (!wanted || !p.signatures) return undefined;
    const index = p.signatures.findIndex((s) => samePage(wanted, s));
    return index >= 0 ? index : undefined;
  }

  // ---------- Binding ----------

  /** Binds a drawing to what it covers in the document shown. */
  async bind(drawing: Drawing, prefer?: 'text' | 'image' | 'page'): Promise<DrawingBinding | undefined> {
    const p = this.current;
    if (!p) return undefined;
    let pagePrint: string | undefined;
    if (this.host.kind === 'pdf') {
      const signatures = await this.signaturesOf(p);
      const signature = signatures[drawing.pageIndex];
      if (signature) pagePrint = signatureKey(signature);
      // The host keeps the signatures of this version: the next version's pages are matched against them.
      if (!p.signaturesSent && this.current === p) {
        p.signaturesSent = true;
        this.storedPages = signatures.map(signatureKey);
        this.host.post({ type: 'resolved', renderId: p.renderId, hash: p.model.hash, highlights: [], drawings: [], pages: this.storedPages });
      }
    }
    return bindDrawing(drawing, p, { images: (page) => this.imagesOf(p, page), textSize: (d) => this.drawings.textSizeOf(d), prefer, pagePrint });
  }

  // ---------- Results ----------

  private show(p: PreparedDocument, result: RunResult): void {
    this.highlights.applyResolutions(result.highlights, result.upgraded, p.provisional);
    void this.marker.applyResult(result.marker, p.provisional);
    this.drawings.applyResults(result.drawings, p.provisional);
  }

  private apply(p: PreparedDocument, result: RunResult): void {
    this.show(p, result);
    this.firstRun = false;
    this.host.report(result);
    const seq = ++this.applySeq;
    // Rectangles of pages that are not rendered are computed in the background; then the host
    // gets everything in one message.
    const done = this.highlights.completeRects().then(() => {
      if (seq !== this.applySeq || this.current !== p || p.provisional) return;
      const signatures = p.signatures?.map(signatureKey);
      this.host.post({
        type: 'resolved',
        renderId: p.renderId,
        hash: p.model.hash,
        highlights: this.highlights.resolvedPayload(result.upgraded),
        marker: { state: result.marker?.state },
        drawings: this.drawings.resolvedPayload(),
        ...(signatures ? { pages: signatures } : {}),
      });
      if (signatures) {
        this.storedPages = signatures;
        p.signaturesSent = true;
      }
      this.keepSnapshot(p, result);
    });
    this.highlights.track(done);
  }

  /** Sends the text of a saved render to the host when annotations were found in it and it is not kept yet. */
  private keepSnapshot(p: PreparedDocument, result: RunResult): void {
    const hash = p.model.hash;
    if (!this.keepSnapshots || this.hostSnapshots.has(hash) || p.model.text.length === 0) return;
    const foundHere = (state: AnchorState | undefined) => state?.found?.hash === hash;
    const any =
      [...result.highlights.values()].some((r) => foundHere(r.state)) || foundHere(result.marker?.state) || [...result.drawings.values()].some((r) => r.states.some(foundHere));
    if (!any) return;
    this.hostSnapshots.add(hash);
    this.host.post({ type: 'saveSnapshot', renderId: p.renderId, hash, text: p.model.text });
  }
}
