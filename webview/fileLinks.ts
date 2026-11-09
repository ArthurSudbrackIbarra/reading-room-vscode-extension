// PDF.js only turns http(s)/mailto/ftp/tel URIs into clickable links (it treats others as unsafe).
// Links to local files (relative .md links become file:/// URLs in the PDF) are therefore not
// rendered by its annotation layer. This adds clickable areas for them, handled by the host.
import type { Viewer } from './viewer';

interface LinkAnnotationLike {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: unknown;
  action?: unknown;
  unsafeUrl?: string;
}

export class FileLinkLayer {
  constructor(
    private readonly viewer: Viewer,
    private readonly open: (href: string) => void,
  ) {
    viewer.eventBus.on('annotationlayerrendered', (evt: { pageNumber: number }) => void this.render(evt.pageNumber - 1));
  }

  private async render(pageIndex: number): Promise<void> {
    const view = this.viewer.pageView(pageIndex) as (ReturnType<Viewer['pageView']> & { pdfPage?: { view: number[]; getAnnotations(o: object): Promise<LinkAnnotationLike[]> } }) | undefined;
    const pdfPage = view?.pdfPage;
    if (!view?.div || !pdfPage) return;
    const annotations = await pdfPage.getAnnotations({ intent: 'display' });
    const links = annotations.filter(
      (a) => a.subtype === 'Link' && !a.url && !a.dest && !a.action && typeof a.unsafeUrl === 'string' && /^file:/i.test(a.unsafeUrl) && a.rect,
    );
    view.div.querySelector(':scope > .mpv-link-layer')?.remove();
    if (links.length === 0) return;
    const [x0, y0, x1, y1] = pdfPage.view;
    const width = x1 - x0;
    const height = y1 - y0;
    const layer = document.createElement('div');
    layer.className = 'mpv-link-layer';
    for (const link of links) {
      const [rx1, ry1, rx2, ry2] = link.rect!;
      const a = document.createElement('a');
      a.className = 'mpv-file-link';
      a.href = link.unsafeUrl!;
      a.title = decodeURI(link.unsafeUrl!).replace(/^file:\/\/\//i, '');
      a.style.left = `${((Math.min(rx1, rx2) - x0) / width) * 100}%`;
      a.style.top = `${((y1 - Math.max(ry1, ry2)) / height) * 100}%`;
      a.style.width = `${(Math.abs(rx2 - rx1) / width) * 100}%`;
      a.style.height = `${(Math.abs(ry2 - ry1) / height) * 100}%`;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.open(link.unsafeUrl!);
      });
      layer.append(a);
    }
    view.div.append(layer);
  }
}
