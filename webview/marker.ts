// The reading marker: one "I stopped reading here" line per document, placed by the reader.
// It is anchored to the text at the start of the marked line, so it follows edits of converted
// documents; the page position is the fallback (and the only anchor on pages without text).
import { anchorQuote, createSelectors } from '../src/anchoring/match';
import type { ReadingMarker } from '../src/shared/types';
import type { HighlightController } from './highlights';
import type { PageLayers } from './pageLayers';
import type { Viewer } from './viewer';

const LAYER = 'mpv-marker-layer';
/** Characters of text stored with the marker (plus context, see createSelectors). */
const QUOTE_LENGTH = 48;

export interface MarkerEvents {
  /** The reader picked a line while placing the marker. */
  placed(marker: ReadingMarker): void;
  /** The marker's tab was clicked (client coordinates of the tab). */
  tabClicked(x: number, y: number): void;
  /** Placement mode started or ended. */
  placingChanged(placing: boolean): void;
  /** The position was re-computed after the document changed; store it quietly. */
  resolved(marker: ReadingMarker): void;
  changed(): void;
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

  constructor(
    private readonly viewer: Viewer,
    private readonly layers: PageLayers,
    private readonly highlights: HighlightController,
    private readonly events: MarkerEvents,
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

  static describe(marker: ReadingMarker): string {
    const date = formatDate(marker.createdAt);
    return date ? `You stopped reading here (${date})` : 'You stopped reading here';
  }

  /** Replaces the marker (initial load, undo/redo, placement) and draws it. */
  async set(marker: ReadingMarker | null): Promise<void> {
    this.marker = marker ? structuredClone(marker) : null;
    this.position = marker ? { pageIndex: marker.pageIndex, y: marker.y } : undefined;
    this.redraw();
    this.events.changed();
    if (marker) await this.resolve(false);
  }

  /** Re-computes the position from the marker's text (after the document loaded or changed). */
  async resolve(report = true): Promise<void> {
    const marker = this.marker;
    if (!marker) return;
    const seq = ++this.resolveSeq;
    const lastPage = Math.max(0, this.viewer.pagesCount - 1);
    let position = { pageIndex: Math.min(marker.pageIndex, lastPage), y: marker.y };
    let start: number | undefined;
    const model = this.highlights.textModel;
    if (marker.selector && model) {
      const [quote, stored] = marker.selector;
      const match = anchorQuote(model.text, quote, stored);
      if (match) {
        const pages = await this.highlights.rangeRects(match.start, Math.min(match.end, match.start + 1));
        if (seq !== this.resolveSeq || this.marker !== marker) return;
        const first = pages[0];
        if (first && first.rects.length > 0) {
          position = { pageIndex: first.pageIndex, y: Math.min(...first.rects.map((r) => r[1])) };
          start = match.start;
        }
      }
    }
    this.position = position;
    this.redraw();
    this.events.changed();
    const moved =
      position.pageIndex !== marker.pageIndex ||
      Math.abs(position.y - marker.y) > 0.002 ||
      (start !== undefined && marker.selector !== undefined && start !== marker.selector[1].start);
    if (report && moved) {
      const updated: ReadingMarker = { ...marker, pageIndex: position.pageIndex, y: position.y };
      if (start !== undefined && updated.selector) {
        updated.selector = [updated.selector[0], { type: 'TextPositionSelector', start, end: start + updated.selector[0].exact.length }];
      }
      this.marker = updated;
      this.events.resolved(structuredClone(updated));
    }
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
    if (model && index !== undefined && index < model.text.length) {
      let end = Math.min(model.text.length, index + QUOTE_LENGTH);
      // End on a word boundary when there is one nearby.
      const space = model.text.lastIndexOf(' ', end);
      if (space > index + 12) end = space;
      if (end > index) marker.selector = createSelectors(model.text, index, end);
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
      ghost.append(Object.assign(document.createElement('div'), { className: 'mpv-marker-line' }));
      layer.append(ghost);
    }
  }

  private markerElement(marker: ReadingMarker, y: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mpv-marker';
    el.style.top = `${(y * 100).toFixed(4)}%`;
    const line = document.createElement('div');
    line.className = 'mpv-marker-line';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'mpv-marker-tab';
    tab.title = `${ReadingMarkerController.describe(marker)}. Click for options.`;
    tab.setAttribute('aria-label', ReadingMarkerController.describe(marker));
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
    label.textContent = 'You stopped here';
    el.append(line, tab, label);
    return el;
  }
}
