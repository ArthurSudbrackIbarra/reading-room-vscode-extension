// Our own layers inside PDF.js page elements (highlights, note badges, the reading marker, the
// dark-mode image fix). PDF.js removes unknown children when it resets a page (zoom, scrolling far
// away), so each layer is re-inserted and re-filled when that happens.
import type { Viewer } from './viewer';

export interface LayerSpec {
  className: string;
  /** 'above-canvas': right above the page image (in registration order); 'top': above everything. */
  placement: 'above-canvas' | 'top';
  fill(layer: HTMLElement, pageIndex: number): void;
}

export class PageLayers {
  private readonly specs: LayerSpec[] = [];
  private readonly observers = new Map<HTMLElement, MutationObserver>();

  constructor(private readonly viewer: Viewer) {
    viewer.eventBus.on('pagerendered', (evt: { pageNumber: number }) => this.ensure(evt.pageNumber - 1));
  }

  register(spec: LayerSpec): void {
    this.specs.push(spec);
  }

  /** Forgets the pages of the previous document. */
  reset(): void {
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
  }

  /** Inserts (and fills) the layers missing on a page. Returns the page element, if it exists. */
  ensure(pageIndex: number): HTMLElement | undefined {
    const div = this.viewer.pageView(pageIndex)?.div;
    if (!div) return undefined;
    for (const spec of this.specs) {
      if (div.querySelector(`:scope > .${spec.className}`)) continue;
      const layer = document.createElement('div');
      layer.className = spec.className;
      this.insert(div, layer, spec);
      spec.fill(layer, pageIndex);
    }
    if (!this.observers.has(div)) {
      const observer = new MutationObserver(() => {
        if (this.specs.some((s) => !div.querySelector(`:scope > .${s.className}`))) this.ensure(pageIndex);
      });
      observer.observe(div, { childList: true });
      this.observers.set(div, observer);
    }
    return div;
  }

  private insert(div: HTMLElement, layer: HTMLElement, spec: LayerSpec): void {
    if (spec.placement === 'top') {
      div.append(layer);
      return;
    }
    // After the canvas and after our earlier 'above-canvas' layers, so registration order is paint order.
    const earlier = this.specs.slice(0, this.specs.indexOf(spec)).filter((s) => s.placement === 'above-canvas');
    for (let i = earlier.length - 1; i >= 0; i--) {
      const previous = div.querySelector(`:scope > .${earlier[i].className}`);
      if (previous) {
        previous.after(layer);
        return;
      }
    }
    const canvas = div.querySelector(':scope > .canvasWrapper');
    if (canvas) canvas.after(layer);
    else div.prepend(layer);
  }

  /** Re-fills one layer (or all of ours) on one page, or on every page that has them. */
  redraw(className?: string, pageIndex?: number): void {
    const pages = pageIndex === undefined ? [...Array(this.viewer.pagesCount).keys()] : [pageIndex];
    for (const index of pages) {
      const div = this.viewer.pageView(index)?.div;
      if (!div) continue;
      for (const spec of this.specs) {
        if (className && spec.className !== className) continue;
        const layer = div.querySelector<HTMLElement>(`:scope > .${spec.className}`);
        if (layer) spec.fill(layer, index);
        else if (div.querySelector('.canvasWrapper, .textLayer')) this.ensure(index);
      }
    }
  }
}
