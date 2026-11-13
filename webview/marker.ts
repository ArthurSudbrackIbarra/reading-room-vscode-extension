// The reading marker: one "I stopped reading here" line per document, placed by the reader.
// It is anchored to the text at the start of the marked line, so it follows edits of converted
// documents; the page position is the fallback (and the only anchor on pages without text).
// What the reader placed (page, position, text) is never changed here: where the marker is in
// the current version of the document is derived by each resolving run.
import type { AnchorState } from '../src/anchoring/anchor';
import type { DocumentLayout } from '../src/anchoring/layout';
import { createSelectors } from '../src/anchoring/match';
import { markerAnchor, type MarkerInput, type MarkerResult } from '../src/anchoring/runs';
import type { ReadingMarker } from '../src/shared/types';
import type { HighlightController } from './highlights';
import type { PageLayers } from './pageLayers';
import type { Viewer } from './viewer';

const LAYER = 'mpv-marker-layer';
export interface MarkerEvents {
  /** The reader picked a line while placing the marker. */
  placed(marker: ReadingMarker): void;
  /** The marker's tab was clicked (client coordinates of the tab). */
  tabClicked(x: number, y: number): void;
  /** Placement mode started or ended. */
  placingChanged(placing: boolean): void;
  /** The marker was set or replaced: it has to be found in the document. */
  needsResolve(): void;
  changed(): void;
}

export interface MarkerOptions {
  /** The layout of the document shown (undefined while none is). */
  layout(): DocumentLayout | undefined;
  /** A converted document (Markdown, text): a mark on a spot without text follows the text before it. */
  converted: boolean;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export class ReadingMarkerController {
  private marker: ReadingMarker | null = null;
  private position?: { pageIndex: number; y: number };
  private placingMode = false;
  private ghost?: { pageIndex: number; y: number };
  private resolveSeq = 0;
  /** What the last resolving run found. */
  private result?: MarkerResult;
  /** The state from a render of unsaved text: used for the next run, never stored. */
  private liveState?: AnchorState;

  constructor(
    private readonly viewer: Viewer,
    private readonly layers: PageLayers,
    private readonly highlights: HighlightController,
    private readonly events: MarkerEvents,
    private readonly options: MarkerOptions,
  ) {
    layers.register({ className: LAYER, placement: 'top', fill: (layer, i) => this.fill(layer, i) });
    const container = viewer.container;
    container.addEventListener('pointermove', (e) => this.onPointerMove(e));
    container.addEventListener('pointerleave', () => this.setGhost(undefined));
    // Capture phase: while placing, a click must not open links or highlight popovers.
    container.addEventListener('click', (e) => this.onClick(e), true);
  }

  get value(): ReadingMarker | null {
    return this.marker ? structuredClone(this.marker) : null;
  }

  /** Page index (0-based) where the marker currently is. */
  get pageIndex(): number | undefined {
    return this.position?.pageIndex;
  }

  get placing(): boolean {
    return this.placingMode;
  }

  /** The day the marker was placed, for the reader. */
  static day(marker: ReadingMarker): string {
    const date = new Date(marker.createdAt);
    if (Number.isNaN(date.getTime()) || date.getTime() === 0) return '';
    return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  static describe(marker: ReadingMarker): string {
    const date = formatDate(marker.createdAt);
    return date ? `You stopped reading here (${date})` : 'You stopped reading here';
  }

  /** What to tell the reader when the marker is not on its own line, or undefined when it is. */
  get caveat(): string | undefined {
    const r = this.result;
    if (!r) return undefined;
    if (r.approximate) return 'The line you marked is not in this version of the file. The marker stands where it was.';
    if (r.stored && r.status === 'orphaned') return 'The text you marked is not in this version of the file. The marker stands at the place it had on the page.';
    return undefined;
  }

  /**
   * Replaces the marker (initial load, undo/redo, placement). A marker the reader just placed
   * (`placed`) is drawn where they put it; any other waits for the resolving run to say where it
   * is in the document shown.
   */
  set(marker: ReadingMarker | null, placed = false): void {
    this.resolveSeq++;
    this.marker = marker ? structuredClone(marker) : null;
    this.result = undefined;
    this.liveState = undefined;
    this.position = marker && placed ? { pageIndex: marker.pageIndex, y: marker.y } : undefined;
    this.redraw();
    this.events.changed();
    if (marker) this.events.needsResolve();
  }

  /** The viewer switched to another PDF: the position computed for the previous one is dropped. */
  documentChanged(): void {
    this.resolveSeq++;
    this.position = undefined;
    this.result = undefined;
    this.redraw();
  }

  /** What the resolver works on. */
  input(): MarkerInput | undefined {
    const m = this.marker;
    if (!m) return undefined;
    return { page: m.pageIndex, y: m.y, ...(m.anchor ? { anchor: m.anchor } : {}), ...(m.rel ? { rel: m.rel } : {}), state: this.liveState ?? m.state };
  }

  /** The state the last saved render left, for the host. */
  get resolvedState(): AnchorState | undefined {
    return this.result?.state;
  }

  /**
   * Takes over where a resolving run found the marker. On a rendered page the top of the line is
   * measured in the text layer, like when the reader placed it.
   */
  async applyResult(result: MarkerResult | undefined, provisional: boolean): Promise<void> {
    const marker = this.marker;
    if (!marker || !result) return;
    const seq = ++this.resolveSeq;
    this.result = result;
    if (provisional) {
      this.liveState = result.state;
    } else {
      this.liveState = undefined;
      if (result.state) marker.state = result.state;
    }
    this.position = { pageIndex: result.page, y: result.y };
    this.redraw();
    this.events.changed();
    if (result.offset === undefined || marker.rel) return;
    const pages = await this.highlights.rangeRects(result.offset, result.offset + 1);
    if (seq !== this.resolveSeq || this.marker !== marker) return;
    const first = pages[0];
    if (!first || first.rects.length === 0) return;
    this.position = { pageIndex: first.pageIndex, y: Math.min(...first.rects.map((r) => r[1])) };
    this.redraw();
    this.events.changed();
  }

  /** Scrolls the marker a quarter of the way down the visible area and makes it pulse. */
  goTo(): boolean {
    if (!this.position) return false;
    const ok = this.viewer.scrollToFraction(this.position.pageIndex, this.position.y, 0.25);
    if (ok) setTimeout(() => this.pulse(), 60);
    return ok;
  }

  isVisible(): boolean {
    const el = document.querySelector('.mpv-marker');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const box = this.viewer.container.getBoundingClientRect();
    return r.top >= box.top && r.top <= box.bottom;
  }

  pulse(): void {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.mpv-marker'))) {
      el.classList.remove('mpv-pulse');
      void el.offsetWidth;
      el.classList.add('mpv-pulse');
    }
  }

  // ---------- Placing ----------

  startPlacing(): void {
    if (this.placingMode) return;
    this.placingMode = true;
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('mpv-placing-marker');
    this.events.placingChanged(true);
  }

  stopPlacing(): void {
    if (!this.placingMode) return;
    this.placingMode = false;
    document.body.classList.remove('mpv-placing-marker');
    this.setGhost(undefined);
    this.events.placingChanged(false);
  }

  /** A marker for the text line under (or nearest to) a point. */
  markerAt(clientX: number, clientY: number): ReadingMarker | undefined {
    const pageIndex = this.viewer.pageIndexAt(clientX, clientY);
    if (pageIndex === undefined) return undefined;
    const line = this.highlights.lineAt(pageIndex, clientY);
    return line ? this.build(pageIndex, line.top, line.index) : undefined;
  }

  /** A marker at the line where the current selection starts. */
  markerAtSelection(): ReadingMarker | undefined {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const rect = Array.from(selection.getRangeAt(0).getClientRects()).find((r) => r.width > 0 && r.height > 0);
    if (!rect) return undefined;
    const y = rect.top + rect.height / 2;
    const pageIndex = this.viewer.pageIndexAt(rect.left + 1, y);
    if (pageIndex === undefined) return undefined;
    const line = this.highlights.lineAt(pageIndex, y);
    if (!line) return undefined;
    const range = this.highlights.selectionRange();
    return this.build(pageIndex, line.top, range?.[0] ?? line.index);
  }

  private build(pageIndex: number, y: number, index?: number): ReadingMarker {
    const marker: ReadingMarker = { pageIndex, y: Math.min(1, Math.max(0, y)), createdAt: new Date().toISOString() };
    const model = this.highlights.textModel;
    const layout = this.options.layout();
    if (model && index !== undefined && index < model.text.length) {
      // The start of the marked line, and only text of that line.
      const anchor = markerAnchor(model, index, layout?.lineOf(index)?.line.end);
      const start = anchor?.createdIn?.start;
      if (anchor && start !== undefined) {
        marker.anchor = anchor;
        marker.selector = createSelectors(model.text, start, start + anchor.exact.length);
      }
    } else if (model && layout && this.options.converted) {
      // A spot without text (a picture, the space under a heading): it follows the line before it.
      const height = layout.pageSize(pageIndex)?.[1] ?? 0;
      for (let page = pageIndex; page >= Math.max(0, pageIndex - 3) && !marker.anchor; page--) {
        const lines = layout.lines(page).filter((l) => page < pageIndex || l.box[1] <= marker.y * height);
        const line = lines[lines.length - 1];
        const anchor = line ? markerAnchor(model, line.start, line.end) : undefined;
        if (!line || !anchor) continue;
        marker.anchor = anchor;
        marker.rel = { pages: pageIndex - page, dy: page === pageIndex ? Math.round((marker.y * height - line.box[1]) * 100) / 100 : 0 };
      }
    }
    return marker;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.placingMode) return;
    const pageIndex = this.viewer.pageIndexAt(e.clientX, e.clientY);
    const line = pageIndex === undefined ? undefined : this.highlights.lineAt(pageIndex, e.clientY);
    this.setGhost(pageIndex !== undefined && line ? { pageIndex, y: line.top } : undefined);
  }

  private onClick(e: MouseEvent): void {
    if (!this.placingMode || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const marker = this.markerAt(e.clientX, e.clientY);
    if (!marker) return;
    this.stopPlacing();
    this.events.placed(marker);
  }

  private setGhost(ghost: { pageIndex: number; y: number } | undefined): void {
    const before = this.ghost;
    if (before?.pageIndex === ghost?.pageIndex && before?.y === ghost?.y) return;
    this.ghost = ghost;
    if (before) this.layers.redraw(LAYER, before.pageIndex);
    if (ghost && ghost.pageIndex !== before?.pageIndex) this.layers.redraw(LAYER, ghost.pageIndex);
  }

  redraw(): void {
    this.layers.redraw(LAYER);
  }

  // ---------- Drawing ----------

  private fill(layer: HTMLElement, pageIndex: number): void {
    layer.replaceChildren();
    if (this.marker && this.position?.pageIndex === pageIndex) layer.append(this.markerElement(this.marker, this.position.y));
    if (this.ghost?.pageIndex === pageIndex) {
      const ghost = document.createElement('div');
      ghost.className = 'mpv-marker mpv-marker-ghost';
      ghost.style.top = `${(this.ghost.y * 100).toFixed(4)}%`;
      const tab = Object.assign(document.createElement('span'), { className: 'mpv-marker-tab' });
      tab.append(Object.assign(document.createElement('span'), { className: 'codicon codicon-bookmark' }));
      ghost.append(Object.assign(document.createElement('div'), { className: 'mpv-marker-line' }), tab);
      layer.append(ghost);
    }
  }

  private markerElement(marker: ReadingMarker, y: number): HTMLElement {
    const el = document.createElement('div');
    const caveat = this.caveat;
    el.className = caveat ? 'mpv-marker mpv-marker-approximate' : 'mpv-marker';
    el.style.top = `${(y * 100).toFixed(4)}%`;
    const line = document.createElement('div');
    line.className = 'mpv-marker-line';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'mpv-marker-tab';
    tab.title = `${ReadingMarkerController.describe(marker)}. ${caveat ? `${caveat} ` : ''}Click for options.`;
    tab.setAttribute('aria-label', caveat ? `${ReadingMarkerController.describe(marker)}. ${caveat}` : ReadingMarkerController.describe(marker));
    const glyph = document.createElement('span');
    glyph.className = 'codicon codicon-bookmark';
    glyph.setAttribute('aria-hidden', 'true');
    tab.append(glyph);
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = tab.getBoundingClientRect();
      this.events.tabClicked(r.left + r.width / 2, r.bottom);
    });
    const label = document.createElement('span');
    label.className = 'mpv-marker-label';
    label.textContent = caveat ? 'You stopped about here' : 'You stopped here';
    el.append(line, tab, label);
    return el;
  }
}
