// Dark pages for PDF files, which cannot be re-rendered in a dark theme like converted documents:
// the page image is inverted with a CSS filter (see styles.css), and the areas where the PDF draws
// pictures are inverted back, so photos and figures keep their real colors. A picture covering
// most of a page is probably a scanned page of text and stays inverted.
import type { PageLayers } from './pageLayers';
import type { Viewer } from './viewer';

const LAYER = 'mpv-image-layer';
const SCAN_AREA = 0.6;
const MIN_AREA = 0.0005;

export class DarkPages {
  private enabled = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly layers: PageLayers,
  ) {
    layers.register({ className: LAYER, placement: 'above-canvas', fill: (layer, i) => this.fill(layer, i) });
    // Image positions are known once a page has been drawn the first time.
    viewer.eventBus.on('pagerendered', (evt: { pageNumber: number }) => {
      if (this.enabled) this.layers.redraw(LAYER, evt.pageNumber - 1);
    });
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.layers.redraw(LAYER);
  }

  private fill(layer: HTMLElement, pageIndex: number): void {
    layer.replaceChildren();
    if (!this.enabled) return;
    const coords = this.viewer.pageView(pageIndex)?.imageCoordinates;
    if (!coords) return;
    for (let i = 0; i + 5 < coords.length; i += 6) {
      const x1 = coords[i];
      const y1 = coords[i + 1];
      const x2 = coords[i + 2];
      const y2 = coords[i + 3];
      const x3 = coords[i + 4];
      const y3 = coords[i + 5];
      // Three corners of a parallelogram; the fourth follows.
      const xs = [x1, x2, x3, x2 + x3 - x1];
      const ys = [y1, y2, y3, y2 + y3 - y1];
      const left = Math.max(0, Math.min(...xs));
      const right = Math.min(1, Math.max(...xs));
      const top = Math.max(0, Math.min(...ys));
      const bottom = Math.min(1, Math.max(...ys));
      const area = (right - left) * (bottom - top);
      if (!(area > MIN_AREA) || area > SCAN_AREA) continue;
      const box = document.createElement('div');
      box.className = 'mpv-image-fix';
      box.style.left = `${(left * 100).toFixed(4)}%`;
      box.style.top = `${(top * 100).toFixed(4)}%`;
      box.style.width = `${((right - left) * 100).toFixed(4)}%`;
      box.style.height = `${((bottom - top) * 100).toFixed(4)}%`;
      layer.append(box);
    }
  }
}
