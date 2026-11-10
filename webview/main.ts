// Viewer webview entry point. './pdfjs' must stay the first import (see pdfjs.ts).
import { startWorker } from './pdfjs';
import { Viewer, type ViewLocation } from './viewer';
import { HighlightController } from './highlights';
import { ReadingMarkerController } from './marker';
import { DarkPages } from './darkPages';
import { PageLayers } from './pageLayers';
import { FileLinkLayer } from './fileLinks';
import { Toolbar } from './toolbar';
import { Banner, HighlightPopover, MOD_KEY, MarkerPopover, NoteTooltip, SelectionBar, Sidebar, StatusOverlay, Toast } from './panels';
import { UndoStack, type EditOp, type HighlightChanges } from './undo';
import { ReadingSounds, canPlaySounds, type SoundSource } from './sounds';
import { h } from './dom';
import { getState, log, post, setState } from './vscodeApi';
import type { HostToViewer, ViewerCommand } from '../src/shared/messages';
import { DEFAULT_SOUND, DEFAULT_VOLUME } from '../src/shared/sounds';
import { DEFAULT_COLOR, DEFAULT_ZOOM, type DocumentKind, type HighlightColor, type PageTheme, type ReadingMarker, type ZoomValue } from '../src/shared/types';

interface Config {
  kind?: DocumentKind;
  worker: string;
  cmaps: string;
  standardFonts: string;
  wasm: string;
  /** Reading sounds included in this build. */
  sounds?: SoundSource[];
}

const LOADING_MESSAGE: Record<DocumentKind, string> = {
  markdown: 'Converting Markdown to PDF…',
  text: 'Converting the text file to PDF…',
  pdf: 'Opening the PDF…',
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color'].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

function narrowPanel(): boolean {
  return window.matchMedia('(max-width: 760px)').matches;
}

class App {
  private readonly kind: DocumentKind;
  private readonly toolbar: Toolbar;
  private readonly sidebar: Sidebar;
  private readonly banner = new Banner();
  private readonly status = new StatusOverlay();
  private readonly toast = new Toast();
  private readonly progress = h('div', { class: 'mpv-progress', hidden: true });
  private readonly container: HTMLDivElement;
  private readonly viewer: Viewer;
  private readonly layers: PageLayers;
  private readonly darkPages?: DarkPages;
  private readonly highlights: HighlightController;
  private readonly marker: ReadingMarkerController;
  private readonly popover: HighlightPopover;
  private readonly markerPopover: MarkerPopover;
  private readonly noteTooltip = new NoteTooltip();
  private readonly selectionBar: SelectionBar;
  private readonly undoStack = new UndoStack();
  private readonly sounds?: ReadingSounds;

  private uri = '';
  private fileName = '';
  private color: HighlightColor = DEFAULT_COLOR;
  private theme: PageTheme = 'light';
  private toolActive = false;
  private persistedZoom: ZoomValue = DEFAULT_ZOOM;
  private zoomTimer?: ReturnType<typeof setTimeout>;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private hasDocument = false;
  private restoredLocation = false;
  private passwordCancelled = false;
  private loading: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly early: HostToViewer[] = [];

  constructor(
    root: HTMLElement,
    private readonly config: Config,
  ) {
    this.kind = config.kind ?? 'markdown';
    document.body.dataset.kind = this.kind;
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
      placeMarker: () => this.toggleMarkerPlacement(),
      goToMarker: () => this.goToMarker(),
      removeMarker: () => this.removeMarker(),
      toggleSounds: (anchor) => this.sounds?.toggle(anchor),
      toggleTheme: () => this.command('toggleTheme'),
      refresh: () => this.command('refresh'),
      toggleFullView: () => this.command('toggleFullView'),
      download: (withHighlights) => this.command(withHighlights ? 'download' : 'downloadWithoutHighlights'),
    });
    this.toolbar.setKind(this.kind);
    const soundSources = config.sounds ?? [];
    if (soundSources.length > 0 && !canPlaySounds()) {
      log('warn', 'Reading sounds are hidden: this webview cannot play Ogg Vorbis audio.');
    } else if (soundSources.length > 0) {
      this.sounds = new ReadingSounds(
        soundSources,
        { sound: DEFAULT_SOUND, volume: DEFAULT_VOLUME, playing: false, owner: false },
        {
          request: (request) => post({ type: 'sound', ...request }),
          stateChanged: (state) => this.toolbar.setSoundState(state),
          openChanged: (open) => this.toolbar.setSoundsOpen(open),
          notify: (message) => this.toast.show(message, { action: { label: 'Show Log', run: () => this.command('showLog') } }),
          hint: (message) => this.toast.show(message, { durationMs: 8000 }),
          log: (level, message) => log(level, message),
        },
      );
    }
    this.toolbar.setSoundsAvailable(this.sounds !== undefined);
    this.sidebar = new Sidebar({
      reveal: (id) => {
        // When the list floats over the pages (narrow panel), get it out of the way.
        if (narrowPanel()) this.setListOpen(false, false);
        this.highlights.reveal(id);
      },
      remove: (id) => this.removeHighlight(id),
      copy: (text) => post({ type: 'copyText', text }),
      editNote: (id) => this.editNoteOf(id),
      goToMarker: () => this.goToMarker(),
      removeMarker: () => this.removeMarker(),
      close: () => this.setListOpen(false, true),
    });

    const viewerElement = h('div', { id: 'viewer', class: 'pdfViewer' });
    this.container = h('div', { id: 'viewerContainer', class: 'mpv-viewer-container', tabindex: 0 }, viewerElement);
    const main = h('main', { class: 'mpv-main' }, this.sidebar.element, this.container, this.status.element, this.toast.element);
    root.append(this.toolbar.element, this.progress, this.banner.element, main);

    this.viewer = new Viewer(this.container, viewerElement, config, main, { recordImages: this.kind === 'pdf' });
    this.viewer.onPassword = (incorrect) => this.askPassword(incorrect);
    this.layers = new PageLayers(this.viewer);
    // Layer order matters: the image fix sits right above the page image, highlights above it.
    if (this.kind === 'pdf') this.darkPages = new DarkPages(this.viewer, this.layers);
    this.highlights = new HighlightController(this.viewer, this.layers, {
      created: (highlight) => {
        post({ type: 'createHighlight', highlight });
        this.undoStack.record({ kind: 'create', highlight }, 'Highlight');
      },
      changed: () => this.renderList(),
      anchored: (results) => post({ type: 'anchorsResolved', renderId: this.highlights.currentRenderId, results }),
    });
    this.marker = new ReadingMarkerController(this.viewer, this.layers, this.highlights, {
      placed: (marker) => this.setMarker(marker, 'Mark reading position'),
      tabClicked: (x, y) => this.showMarkerPopover(x, y),
      placingChanged: (placing) => this.onPlacingChanged(placing),
      resolved: (marker) => post({ type: 'setMarker', marker }),
      changed: () => {
        this.toolbar.setMarkerState(this.marker.value !== null, this.marker.placing);
        this.renderList();
      },
    });
    this.popover = new HighlightPopover({
      setColor: (id, color) => this.changeHighlight(id, { color }, 'Change highlight color'),
      remove: (id) => this.removeHighlight(id),
      copy: (id) => {
        const text = this.highlights.get(id)?.data.target.selector[0].exact;
        if (text) post({ type: 'copyText', text });
      },
      saveNote: (id, note) => this.changeHighlight(id, { note }, note ? 'Edit note' : 'Delete note'),
    });
    this.markerPopover = new MarkerPopover({
      move: () => this.marker.startPlacing(),
      remove: () => this.removeMarker(),
    });
    new FileLinkLayer(this.viewer, (href) => post({ type: 'openLink', href }));
    this.selectionBar = new SelectionBar({
      pick: (color) => {
        this.selectionBar.hide();
        this.pickColor(color, false);
        this.highlights.createFromSelection(color);
      },
      note: () => this.highlightWithNote(),
      marker: () => this.markSelection(),
    });

    this.viewer.onScaleChange = (zoom, scale) => {
      this.toolbar.setZoom(zoom, scale);
      this.hideFloating(true);
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
      this.hideFloating(true);
      clearTimeout(this.stateTimer);
      this.stateTimer = setTimeout(() => this.saveState(), 300);
    };

    this.bindDiagnostics();
    this.bindPointer();
    this.bindKeys();
    this.bindFocus();
    window.addEventListener('message', (event: MessageEvent<HostToViewer>) => this.onMessage(event.data));
    // A PDF that arrived while the tab was in the background was laid out for the old size.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') setTimeout(() => this.viewer.refit(), 50);
    });
  }

  async start(): Promise<void> {
    try {
      await startWorker(this.config.worker);
    } catch (err) {
      this.status.error('The viewer could not start', String(err), []);
      log('error', `Worker start failed: ${String(err)}`);
      return;
    }
    this.status.loading(LOADING_MESSAGE[this.kind]);
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
        this.fileName = init.fileName;
        this.color = init.color;
        this.persistedZoom = init.zoom;
        this.applyTheme(init.theme);
        this.viewer.setInitialZoom(init.zoom);
        this.highlights.setMargins(init.marginsPt);
        this.highlights.setHighlights(init.highlights);
        void this.marker.set(init.marker);
        this.toolbar.setColor(init.color);
        this.toolbar.setFullView(init.fullView);
        this.setTool(init.toolActive, false);
        if (init.sound) this.sounds?.apply(init.sound);
        // In a narrow panel the list would cover the pages; open it only on request there.
        this.setListOpen(init.listOpen && !narrowPanel(), false);
        document.title = init.fileName;
        this.saveState();
        for (const queued of this.early.splice(0)) this.onMessage(queued);
        break;
      }
      case 'rendering':
        if (this.hasDocument) this.progress.hidden = false;
        else this.status.loading(LOADING_MESSAGE[this.kind]);
        break;
      case 'pdf':
        this.loading = this.loadPdf(msg).catch((err: unknown) => {
          this.progress.hidden = true;
          if (this.passwordCancelled) {
            this.passwordCancelled = false;
            if (!this.hasDocument) {
              this.status.error(`${this.fileName || 'This PDF'} is password-protected`, 'Enter its password to view it.', [
                { label: 'Enter Password', run: () => this.command('refresh') },
              ]);
            }
            return;
          }
          log('error', `Loading the PDF failed: ${String(err)}`);
          if (!this.hasDocument) this.status.error(this.errorTitle, String(err), [{ label: 'Retry', run: () => this.command('refresh') }]);
          else this.banner.show('error', `The PDF could not be reloaded: ${String(err)}`);
        });
        break;
      case 'renderError':
        this.progress.hidden = true;
        if (!this.hasDocument) {
          this.status.error(this.errorTitle, msg.message, [
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
        void this.marker.set(msg.marker);
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
        this.applyTheme(msg.theme);
        break;
      case 'document':
        this.uri = msg.uri;
        this.fileName = msg.fileName;
        document.title = msg.fileName;
        this.saveState();
        break;
      case 'requestExport':
        void this.answerExport(msg.requestId);
        break;
      case 'undo':
      case 'redo':
        if (isTextField(document.activeElement)) document.execCommand(msg.type);
        else if (msg.type === 'undo') void this.undo();
        else void this.redo();
        break;
      case 'deleteAll':
        this.deleteAll();
        break;
      case 'marker':
        if (msg.action === 'place') this.toggleMarkerPlacement();
        else if (msg.action === 'goto') this.goToMarker();
        else this.removeMarker();
        break;
      case 'sound':
        this.sounds?.apply(msg.state);
        break;
    }
  }

  private get errorTitle(): string {
    return this.kind === 'pdf' ? 'The PDF could not be opened' : 'The PDF could not be created';
  }

  private applyTheme(theme: PageTheme): void {
    this.theme = theme;
    this.toolbar.setTheme(theme);
    // Converted documents get a dark render from the host; PDF files are recolored here.
    if (this.kind === 'pdf' || !this.hasDocument) document.body.dataset.pageTheme = theme;
    this.darkPages?.setEnabled(theme === 'dark');
  }

  private async loadPdf(msg: Extract<HostToViewer, { type: 'pdf' }>): Promise<void> {
    const raw = msg.data as unknown;
    const data =
      raw instanceof Uint8Array
        ? raw
        : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
          ? new Uint8Array((raw as { data: number[] }).data) // a serialized Node Buffer
          : new Uint8Array(raw as ArrayLike<number>);
    if (data.byteLength === 0) throw new Error('The viewer received an empty PDF.');
    const saved = getState();
    const restore: ViewLocation | undefined =
      !this.hasDocument && saved?.pageNumber ? { pageNumber: saved.pageNumber, fraction: saved.fraction ?? 0 } : undefined;
    if (restore) this.restoredLocation = true;
    this.hideFloating();
    this.layers.reset();
    const doc = await this.viewer.load(data, restore);
    if (!doc) return;
    const firstLoad = !this.hasDocument;
    this.hasDocument = true;
    this.status.hide();
    this.progress.hidden = true;
    document.body.dataset.pageTheme = this.kind === 'pdf' ? this.theme : msg.theme;
    if (msg.warnings.length > 0) {
      const first = msg.warnings[0].message;
      const more = msg.warnings.length > 1 ? ` (and ${msg.warnings.length - 1} more)` : '';
      this.banner.show('warning', `${first}${more}`, [{ label: 'Show Log', run: () => this.command('showLog') }]);
    } else {
      this.banner.hide();
    }
    await this.highlights.documentLoaded(doc, msg.renderId);
    await this.marker.resolve();
    // Opening a document (not restoring a panel): continue where the reader stopped.
    if (firstLoad && !this.restoredLocation && this.marker.value && this.marker.goTo()) {
      this.toast.show(`Continuing where you stopped reading (page ${(this.marker.pageIndex ?? 0) + 1}).`);
    }
  }

  private async answerExport(requestId: number): Promise<void> {
    try {
      await this.loading;
      const data = await this.highlights.exportData();
      post({ type: 'exportData', requestId, highlights: data.highlights, orphaned: data.orphaned, password: this.viewer.password });
    } catch (err) {
      post({ type: 'exportData', requestId, highlights: [], orphaned: 0, error: String(err) });
    }
  }

  private async askPassword(incorrect: boolean): Promise<string | undefined> {
    this.progress.hidden = true;
    const password = await this.status.password(this.fileName || 'This PDF', incorrect);
    if (password === undefined) this.passwordCancelled = true;
    else this.status.loading(LOADING_MESSAGE[this.kind]);
    return password;
  }

  // ---------- Edits (all undoable) ----------

  private async apply(op: EditOp): Promise<void> {
    switch (op.kind) {
      case 'create':
        post({ type: 'createHighlight', highlight: op.highlight });
        await this.highlights.add(op.highlight);
        break;
      case 'delete':
        if (this.popover.highlightId === op.highlight.id) this.popover.hide(false);
        this.highlights.remove(op.highlight.id);
        post({ type: 'deleteHighlight', id: op.highlight.id });
        break;
      case 'update':
        if (op.after.color) this.highlights.setColor(op.id, op.after.color);
        if (op.after.note !== undefined) this.highlights.setNote(op.id, op.after.note);
        post({ type: 'updateHighlight', id: op.id, ...op.after });
        break;
      case 'marker':
        post({ type: 'setMarker', marker: op.after });
        await this.marker.set(op.after);
        break;
      case 'batch':
        for (const child of op.ops) await this.apply(child);
        break;
    }
  }

  /** Brings an undone/redone change into view if it is off-screen. */
  private revealChange(op: EditOp): void {
    const first = op.kind === 'batch' ? op.ops.find((o) => o.kind !== 'delete') : op;
    if (!first) return;
    if (first.kind === 'marker') {
      if (first.after && !this.marker.isVisible()) this.marker.goTo();
      return;
    }
    const id = first.kind === 'update' ? first.id : first.kind === 'create' ? first.highlight.id : undefined;
    if (!id) return;
    if (this.highlights.isVisible(id)) this.highlights.flash(id);
    else this.highlights.reveal(id);
  }

  private async undo(): Promise<void> {
    const step = this.undoStack.undo();
    if (!step) {
      this.toast.show('Nothing to undo.');
      return;
    }
    this.hideFloating();
    await this.apply(step.op);
    this.revealChange(step.op);
    this.toast.show(`Undone: ${step.label}.`, { action: { label: 'Redo', run: () => void this.redo() } });
  }

  private async redo(): Promise<void> {
    const step = this.undoStack.redo();
    if (!step) {
      this.toast.show('Nothing to redo.');
      return;
    }
    this.hideFloating();
    await this.apply(step.op);
    this.revealChange(step.op);
    this.toast.show(`Redone: ${step.label}.`, { action: { label: 'Undo', run: () => void this.undo() } });
  }

  private undoAction(): { label: string; run(): void } {
    return { label: `Undo (${MOD_KEY}+Z)`, run: () => void this.undo() };
  }

  private changeHighlight(id: string, wanted: HighlightChanges, label: string): void {
    const rt = this.highlights.get(id);
    if (!rt) return;
    const before: HighlightChanges = {};
    const after: HighlightChanges = {};
    if (wanted.color !== undefined && wanted.color !== rt.data.color) {
      before.color = rt.data.color;
      after.color = wanted.color;
    }
    if (wanted.note !== undefined && wanted.note !== (rt.data.note ?? '')) {
      before.note = rt.data.note ?? '';
      after.note = wanted.note;
    }
    if (after.color === undefined && after.note === undefined) return;
    const op: EditOp = { kind: 'update', id, before, after };
    void this.apply(op);
    this.undoStack.record(op, label);
  }

  private removeHighlight(id: string): void {
    const highlight = this.highlights.snapshot(id);
    if (!highlight) return;
    const op: EditOp = { kind: 'delete', highlight };
    void this.apply(op);
    this.undoStack.record(op, 'Delete highlight');
    this.toast.show(highlight.note ? 'Highlight and its note deleted.' : 'Highlight deleted.', { action: this.undoAction() });
  }

  private deleteAll(): void {
    const ops: EditOp[] = this.highlights.all.map((highlight) => ({ kind: 'delete', highlight }));
    if (ops.length === 0) return;
    const op: EditOp = { kind: 'batch', ops };
    void this.apply(op);
    this.undoStack.record(op, 'Delete all highlights');
    this.toast.show(`Deleted ${ops.length} highlight${ops.length === 1 ? '' : 's'}.`, { action: this.undoAction() });
  }

  private setMarker(marker: ReadingMarker | null, label: string): void {
    const op: EditOp = { kind: 'marker', before: this.marker.value, after: marker };
    void this.apply(op);
    this.undoStack.record(op, label);
    this.toast.show(marker ? 'Reading position saved. The document opens here next time.' : 'Reading marker removed.', { action: this.undoAction() });
  }

  // ---------- Reading marker ----------

  private toggleMarkerPlacement(): void {
    if (this.marker.placing) {
      this.marker.stopPlacing();
      return;
    }
    if (!this.hasDocument) return;
    this.hideFloating();
    this.marker.startPlacing();
  }

  private onPlacingChanged(placing: boolean): void {
    this.toolbar.setMarkerState(this.marker.value !== null, placing);
    if (placing) this.toast.show('Click the line where you stopped reading. Esc cancels.', { sticky: true });
    else this.toast.hide();
  }

  private goToMarker(): void {
    if (!this.marker.value) {
      this.toast.show('No reading marker yet. Use the bookmark button, then click the line where you stopped.');
      return;
    }
    if (narrowPanel()) this.setListOpen(false, false);
    this.marker.goTo();
  }

  private removeMarker(): void {
    if (this.marker.value) this.setMarker(null, 'Remove reading marker');
  }

  private markSelection(): void {
    const marker = this.marker.markerAtSelection();
    this.selectionBar.hide();
    window.getSelection()?.removeAllRanges();
    if (marker) this.setMarker(marker, 'Mark reading position');
  }

  private showMarkerPopover(x: number, y: number): void {
    const marker = this.marker.value;
    if (!marker) return;
    this.noteTooltip.hide();
    this.markerPopover.show(ReadingMarkerController.describe(marker), x, y);
  }

  // ---------- Notes ----------

  private highlightWithNote(): void {
    const [x, y] = this.selectionBar.position;
    this.selectionBar.hide();
    const created = this.highlights.createFromSelection(this.color);
    if (created) this.popover.show(created.id, { color: created.color }, x, y + 30, { editNote: true });
  }

  private editNoteOf(id: string): void {
    if (narrowPanel()) this.setListOpen(false, false);
    this.highlights.reveal(id);
    setTimeout(() => {
      const rt = this.highlights.get(id);
      if (!rt) return;
      const r = this.highlights.clientRectOf(id);
      const x = r ? (r.left + r.right) / 2 : window.innerWidth / 2;
      const y = r ? r.bottom : window.innerHeight / 3;
      this.popover.show(id, rt.data, x, y, { editNote: true });
    }, 150);
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
    const marker = this.marker?.value;
    this.sidebar.render(
      this.highlights.list().map((rt) => ({ data: rt.data, page: this.highlights.firstPageOf(rt.data.id) })),
      marker ? { marker, page: this.marker.pageIndex ?? marker.pageIndex } : null,
    );
  }

  /** Hides popovers and tooltips. On scroll/zoom (`passive`) a note being edited stays open. */
  private hideFloating(passive = false): void {
    if (!passive || !this.popover.editing) this.popover.hide();
    // The sounds panel hangs from the toolbar, so scrolling and zooming leave it open.
    if (!passive) this.sounds?.hide();
    this.selectionBar.hide();
    this.markerPopover.hide();
    this.noteTooltip.hide();
  }

  private saveState(): void {
    if (!this.uri) return;
    const location = this.viewer.captureLocation();
    setState({ uri: this.uri, pageNumber: location?.pageNumber, fraction: location?.fraction });
  }

  // ---------- Pointer and keyboard ----------

  private bindPointer(): void {
    const c = this.container;
    // Links in the PDF: internal destinations stay in PDF.js; everything else goes to the host.
    c.addEventListener(
      'click',
      (e) => {
        if (this.marker.placing) return;
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
      if (e.button !== 0 || this.marker.placing) return;
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
      const badge = (e.target as Element | null)?.closest?.('.mpv-note-badge') as HTMLElement | null;
      if (badge?.dataset.id) {
        const rt = this.highlights.get(badge.dataset.id);
        const r = badge.getBoundingClientRect();
        this.noteTooltip.hide();
        if (rt) this.popover.show(rt.data.id, rt.data, r.left + r.width / 2, r.bottom);
        return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if ((e.target as Element | null)?.closest?.('.annotationLayer a, .annotationLayer section, .mpv-marker-tab')) return;
      const id = this.highlights.hitTest(e.clientX, e.clientY);
      if (!id) {
        this.popover.hide();
        return;
      }
      const rt = this.highlights.get(id);
      this.noteTooltip.hide();
      if (rt) this.popover.show(id, rt.data, e.clientX, e.clientY);
    });

    let frame = 0;
    c.addEventListener('pointermove', (e) => {
      if (frame || e.buttons !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (this.marker.placing) {
          this.noteTooltip.hide();
          return;
        }
        const badge = (e.target as Element | null)?.closest?.('.mpv-note-badge') as HTMLElement | null;
        const id = badge?.dataset.id ?? this.highlights.hitTest(e.clientX, e.clientY);
        c.classList.toggle('mpv-over-highlight', !!id && !badge);
        const note = id ? this.highlights.get(id)?.data.note : undefined;
        if (id && note && !this.popover.visible) this.noteTooltip.schedule(id, note, e.clientX, e.clientY);
        else this.noteTooltip.hide();
      });
    });
    c.addEventListener('pointerleave', () => this.noteTooltip.hide());

    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) this.selectionBar.hide();
    });
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (!this.popover.element.contains(target)) this.popover.hide();
      if (!this.selectionBar.element.contains(target)) this.selectionBar.hide();
      if (!this.markerPopover.element.contains(target)) this.markerPopover.hide();
      this.noteTooltip.hide();
    });
  }

  private bindKeys(): void {
    // Undo/redo of highlights, notes and the reading marker. Text fields keep their own undo.
    // Capture phase: handled here, VS Code never sees these keys while the viewer has focus.
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (!mod || e.altKey) return;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : '';
        const undo = key === 'z' && !e.shiftKey;
        const redo = (key === 'z' && e.shiftKey) || (!isMac && key === 'y' && !e.shiftKey);
        if (!undo && !redo) return;
        if (isTextField(document.activeElement)) {
          // Undo the typing in the note box: keep the key from VS Code (which would route it to
          // its own undo and cancel the browser's), and let the browser handle it.
          e.stopImmediatePropagation();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if (undo) void this.undo();
        else void this.redo();
      },
      true,
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.marker.placing) this.marker.stopPlacing();
      this.hideFloating();
      if (this.toolbar.element.contains(document.activeElement)) this.container.focus();
    });
  }

  private bindDiagnostics(): void {
    // Anything the strict CSP blocks ends up in the extension's log ("Document Viewer: Show Log").
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
  const app = new App(root, config);
  // For diagnostics from the webview developer tools (only this extension's code runs here).
  (window as unknown as { documentViewer: App }).documentViewer = app;
  void app.start();
}
