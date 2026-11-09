// Viewer webview entry point. './pdfjs' must stay the first import (see pdfjs.ts).
import { startWorker } from './pdfjs';
import { Viewer, type ViewLocation } from './viewer';
import { HighlightController } from './highlights';
import { FileLinkLayer } from './fileLinks';
import { Toolbar } from './toolbar';
import { Banner, HighlightPopover, SelectionBar, Sidebar, StatusOverlay } from './panels';
import { h } from './dom';
import { getState, log, post, setState } from './vscodeApi';
import type { HostToViewer, ViewerCommand } from '../src/shared/messages';
import { DEFAULT_COLOR, DEFAULT_ZOOM, type HighlightColor, type PageTheme, type ZoomValue } from '../src/shared/types';

interface Config {
  worker: string;
  cmaps: string;
  standardFonts: string;
  wasm: string;
}

class App {
  private readonly toolbar: Toolbar;
  private readonly sidebar: Sidebar;
  private readonly banner = new Banner();
  private readonly status = new StatusOverlay();
  private readonly progress = h('div', { class: 'mpv-progress', hidden: true });
  private readonly container: HTMLDivElement;
  private readonly viewer: Viewer;
  private readonly highlights: HighlightController;
  private readonly popover: HighlightPopover;
  private readonly selectionBar: SelectionBar;

  private uri = '';
  private color: HighlightColor = DEFAULT_COLOR;
  private theme: PageTheme = 'light';
  private toolActive = false;
  private persistedZoom: ZoomValue = DEFAULT_ZOOM;
  private zoomTimer?: ReturnType<typeof setTimeout>;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private hasDocument = false;
  private loading: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly early: HostToViewer[] = [];

  constructor(
    root: HTMLElement,
    private readonly config: Config,
  ) {
    this.toolbar = new Toolbar({
      toggleList: () => this.setListOpen(!this.sidebar.open, true),
      previousPage: () => this.viewer.previousPage(),
      nextPage: () => this.viewer.nextPage(),
      goToPage: (n) => this.viewer.goToPage(n),
      zoomIn: () => this.viewer.zoomIn(),
      zoomOut: () => this.viewer.zoomOut(),
      resetZoom: () => this.viewer.resetZoom(),
      setZoom: (z) => this.viewer.applyZoom(z),
      toggleTool: () => this.setTool(!this.toolActive, true),
      setColor: (c) => this.pickColor(c),
      toggleTheme: () => this.command('toggleTheme'),
      refresh: () => this.command('refresh'),
      toggleFullView: () => this.command('toggleFullView'),
      download: (withHighlights) => this.command(withHighlights ? 'download' : 'downloadWithoutHighlights'),
    });
    this.sidebar = new Sidebar({
      reveal: (id) => {
        // When the list floats over the pages (narrow panel), get it out of the way.
        if (window.matchMedia('(max-width: 760px)').matches) this.setListOpen(false, false);
        this.highlights.reveal(id);
      },
      remove: (id) => this.removeHighlight(id),
      copy: (text) => post({ type: 'copyText', text }),
      close: () => this.setListOpen(false, true),
    });

    const viewerElement = h('div', { id: 'viewer', class: 'pdfViewer' });
    this.container = h('div', { id: 'viewerContainer', class: 'mpv-viewer-container', tabindex: 0 }, viewerElement);
    const main = h('main', { class: 'mpv-main' }, this.sidebar.element, this.container, this.status.element);
    root.append(this.toolbar.element, this.progress, this.banner.element, main);

    this.viewer = new Viewer(this.container, viewerElement, config, main);
    this.highlights = new HighlightController(this.viewer, {
      created: (highlight) => post({ type: 'createHighlight', highlight }),
      changed: () => this.renderList(),
      anchored: (results) => post({ type: 'anchorsResolved', renderId: this.highlights.currentRenderId, results }),
    });
    this.popover = new HighlightPopover({
      setColor: (id, color) => {
        this.highlights.setColor(id, color);
        post({ type: 'updateHighlight', id, color });
      },
      remove: (id) => this.removeHighlight(id),
      copy: (id) => {
        const text = this.highlights.get(id)?.data.target.selector[0].exact;
        if (text) post({ type: 'copyText', text });
      },
    });
    new FileLinkLayer(this.viewer, (href) => post({ type: 'openLink', href }));
    this.selectionBar = new SelectionBar((color) => {
      this.selectionBar.hide();
      this.pickColor(color, false);
      this.highlights.createFromSelection(color);
    });

    this.viewer.onScaleChange = (zoom, scale) => {
      this.toolbar.setZoom(zoom, scale);
      this.hideFloating();
      clearTimeout(this.zoomTimer);
      this.zoomTimer = setTimeout(() => {
        if (zoom !== this.persistedZoom) {
          this.persistedZoom = zoom;
          post({ type: 'viewChanged', zoom });
        }
      }, 500);
    };
    this.viewer.onPageChange = (page, count) => this.toolbar.setPage(page, count);
    this.viewer.onScroll = () => {
      this.hideFloating();
      clearTimeout(this.stateTimer);
      this.stateTimer = setTimeout(() => this.saveState(), 300);
    };

    this.bindDiagnostics();
    this.bindPointer();
    this.bindFocus();
    window.addEventListener('message', (event: MessageEvent<HostToViewer>) => this.onMessage(event.data));
    // A PDF that arrived while the tab was in the background was laid out for the old size.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') setTimeout(() => this.viewer.refit(), 50);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideFloating();
        if (this.toolbar.element.contains(document.activeElement)) this.container.focus();
      }
    });
  }

  async start(): Promise<void> {
    try {
      await startWorker(this.config.worker);
    } catch (err) {
      this.status.error(`The PDF viewer could not start: ${String(err)}`, []);
      log('error', `Worker start failed: ${String(err)}`);
      return;
    }
    this.status.loading('Converting Markdown to PDF…');
    post({ type: 'ready' });
  }

  // ---------- Host messages ----------

  private onMessage(msg: HostToViewer): void {
    if (!msg || typeof msg !== 'object') return;
    if (!this.initialized && msg.type !== 'init') {
      this.early.push(msg);
      return;
    }
    switch (msg.type) {
      case 'init': {
        const init = msg.init;
        this.initialized = true;
        this.uri = init.uri;
        this.color = init.color;
        this.theme = init.theme;
        this.persistedZoom = init.zoom;
        document.body.dataset.pageTheme = init.theme;
        this.viewer.setInitialZoom(init.zoom);
        this.highlights.setMargins(init.marginsPt);
        this.highlights.setHighlights(init.highlights);
        this.toolbar.setColor(init.color);
        this.toolbar.setTheme(init.theme);
        this.toolbar.setFullView(init.fullView);
        this.setTool(init.toolActive, false);
        // In a narrow panel the list would cover the pages; open it only on request there.
        this.setListOpen(init.listOpen && !window.matchMedia('(max-width: 760px)').matches, false);
        document.title = init.fileName;
        this.saveState();
        for (const queued of this.early.splice(0)) this.onMessage(queued);
        break;
      }
      case 'rendering':
        if (this.hasDocument) this.progress.hidden = false;
        else this.status.loading('Converting Markdown to PDF…');
        break;
      case 'pdf':
        this.loading = this.loadPdf(msg).catch((err: unknown) => {
          log('error', `Loading the PDF failed: ${String(err)}`);
          this.progress.hidden = true;
          if (!this.hasDocument) this.status.error(String(err), [{ label: 'Retry', run: () => this.command('refresh') }]);
        });
        break;
      case 'renderError':
        this.progress.hidden = true;
        if (!this.hasDocument) {
          this.status.error(msg.message, [
            { label: 'Retry', run: () => this.command('refresh') },
            { label: 'Show Log', run: () => this.command('showLog') },
          ]);
        } else {
          this.banner.show('error', `The PDF could not be updated: ${msg.message}`, [
            { label: 'Retry', run: () => this.command('refresh') },
            { label: 'Show Log', run: () => this.command('showLog') },
          ]);
        }
        break;
      case 'zoom':
        if (msg.action === 'in') this.viewer.zoomIn();
        else if (msg.action === 'out') this.viewer.zoomOut();
        else this.viewer.resetZoom();
        break;
      case 'highlights':
        this.highlights.setHighlights(msg.highlights);
        break;
      case 'toggleList':
        this.setListOpen(!this.sidebar.open, true);
        break;
      case 'toggleTool':
        this.setTool(!this.toolActive, true);
        break;
      case 'fullView':
        this.toolbar.setFullView(msg.full);
        break;
      case 'theme':
        this.theme = msg.theme;
        this.toolbar.setTheme(msg.theme);
        break;
      case 'document':
        this.uri = msg.uri;
        document.title = msg.fileName;
        this.saveState();
        break;
      case 'requestExport':
        void this.answerExport(msg.requestId);
        break;
    }
  }

  private async loadPdf(msg: Extract<HostToViewer, { type: 'pdf' }>): Promise<void> {
    const data = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data as ArrayLike<number>);
    const saved = getState();
    const restore: ViewLocation | undefined =
      !this.hasDocument && saved?.pageNumber ? { pageNumber: saved.pageNumber, fraction: saved.fraction ?? 0 } : undefined;
    this.hideFloating();
    const doc = await this.viewer.load(data, restore);
    if (!doc) return;
    this.hasDocument = true;
    this.status.hide();
    this.progress.hidden = true;
    document.body.dataset.pageTheme = msg.theme;
    if (msg.warnings.length > 0) {
      const first = msg.warnings[0].message;
      const more = msg.warnings.length > 1 ? ` (and ${msg.warnings.length - 1} more)` : '';
      this.banner.show('warning', `${first}${more}`, [{ label: 'Show Log', run: () => this.command('showLog') }]);
    } else {
      this.banner.hide();
    }
    await this.highlights.documentLoaded(doc, msg.renderId);
  }

  private async answerExport(requestId: number): Promise<void> {
    try {
      await this.loading;
      const data = await this.highlights.exportData();
      post({ type: 'exportData', requestId, highlights: data.highlights, orphaned: data.orphaned });
    } catch (err) {
      post({ type: 'exportData', requestId, highlights: [], orphaned: 0, error: String(err) });
    }
  }

  // ---------- UI state ----------

  private command(command: ViewerCommand): void {
    post({ type: 'command', command });
  }

  private setTool(active: boolean, notify: boolean): void {
    this.toolActive = active;
    document.body.classList.toggle('mpv-tool-active', active);
    this.toolbar.setTool(active);
    if (notify) post({ type: 'toolChanged', active });
    if (active && this.highlights.selectionRange()) this.highlights.createFromSelection(this.color);
  }

  private pickColor(color: HighlightColor, createFromSelection = true): void {
    this.color = color;
    this.toolbar.setColor(color);
    post({ type: 'colorChanged', color });
    if (createFromSelection && this.highlights.selectionRange()) this.highlights.createFromSelection(color);
  }

  private setListOpen(open: boolean, notify: boolean): void {
    this.sidebar.open = open;
    this.toolbar.setListOpen(open);
    if (open) this.renderList();
    if (notify) post({ type: 'listChanged', open });
  }

  private renderList(): void {
    if (!this.sidebar.open) return;
    this.sidebar.render(this.highlights.list().map((rt) => ({ data: rt.data, page: this.highlights.firstPageOf(rt.data.id) })));
  }

  private removeHighlight(id: string): void {
    this.highlights.remove(id);
    post({ type: 'deleteHighlight', id });
  }

  private hideFloating(): void {
    this.popover.hide();
    this.selectionBar.hide();
  }

  private saveState(): void {
    if (!this.uri) return;
    const location = this.viewer.captureLocation();
    setState({ uri: this.uri, pageNumber: location?.pageNumber, fraction: location?.fraction });
  }

  // ---------- Pointer handling: selections, clicks on highlights, links ----------

  private bindPointer(): void {
    const c = this.container;
    // Links in the PDF: internal destinations stay in PDF.js; everything else goes to the host.
    c.addEventListener(
      'click',
      (e) => {
        const link = (e.target as Element | null)?.closest?.('.annotationLayer a[href]') as HTMLAnchorElement | null;
        if (!link) return;
        const href = link.getAttribute('href') ?? '';
        if (href.startsWith('#') || link.classList.contains('internalLink')) return;
        e.preventDefault();
        e.stopPropagation();
        post({ type: 'openLink', href: link.href });
      },
      true,
    );

    c.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      // Let the selection settle first.
      setTimeout(() => {
        const range = this.highlights.selectionRange();
        if (!range) return;
        if (this.toolActive) {
          this.highlights.createFromSelection(this.color);
        } else {
          this.selectionBar.show(e.clientX, e.clientY);
        }
      }, 0);
    });

    c.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if ((e.target as Element | null)?.closest?.('.annotationLayer a, .annotationLayer section')) return;
      const id = this.highlights.hitTest(e.clientX, e.clientY);
      if (!id) {
        this.popover.hide();
        return;
      }
      const rt = this.highlights.get(id);
      if (rt) this.popover.show(id, rt.data.color, e.clientX, e.clientY);
    });

    let frame = 0;
    c.addEventListener('pointermove', (e) => {
      if (frame || e.buttons !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        c.classList.toggle('mpv-over-highlight', !!this.highlights.hitTest(e.clientX, e.clientY));
      });
    });

    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) this.selectionBar.hide();
    });
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (!this.popover.element.contains(target)) this.popover.hide();
      if (!this.selectionBar.element.contains(target)) this.selectionBar.hide();
    });
  }

  private bindDiagnostics(): void {
    // Anything the strict CSP blocks ends up in the extension's log (Markdown PDF: Show Log).
    document.addEventListener('securitypolicyviolation', (e) => {
      log('warn', `CSP blocked ${e.blockedURI || 'inline content'} (${e.effectiveDirective})`);
    });
    window.addEventListener('error', (e) => log('error', `${e.message} (${e.filename}:${e.lineno})`));
    window.addEventListener('unhandledrejection', (e) => log('error', `Unhandled: ${String(e.reason)}`));
  }

  private bindFocus(): void {
    window.addEventListener('focus', () => post({ type: 'focus', focused: true }));
    window.addEventListener('blur', () => post({ type: 'focus', focused: false }));
    if (document.hasFocus()) post({ type: 'focus', focused: true });
  }
}

const root = document.getElementById('app');
if (root) {
  const config = JSON.parse(root.dataset.config ?? '{}') as Config;
  void new App(root, config).start();
}
