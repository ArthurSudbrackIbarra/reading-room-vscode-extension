// Viewer webview entry point. './pdfjs' must stay the first import (see pdfjs.ts).
import { startWorker } from './pdfjs';
import { Viewer, type ViewLocation } from './viewer';
import { HighlightController } from './highlights';
import { ReadingMarkerController } from './marker';
import { AnchoringController, type PreparedDocument } from './anchoring';
import { massOrphanMessage, summaryMessage, type RunResult } from '../src/anchoring/runs';
import { DarkPages } from './darkPages';
import { PageLayers } from './pageLayers';
import { FileLinkLayer } from './fileLinks';
import { Toolbar } from './toolbar';
import { Banner, DrawingPopover, HighlightPopover, MOD_KEY, MarkerPopover, NoteTooltip, SelectionBar, Sidebar, StatusOverlay, TextPopover, Toast } from './panels';
import { UndoStack, type EditOp, type HighlightChanges } from './undo';
import { ReadingSounds, canPlaySounds, type SoundSource } from './sounds';
import { DrawingController, type DrawingMode } from './drawings';
import { DrawingBar, TOOL_KEYS, TextBar } from './drawingBar';
import { ColorPicker } from './colorPicker';
import { h } from './dom';
import { getState, log, post, setState } from './vscodeApi';
import type { DrawStyle, HostToViewer, ViewerCommand } from '../src/shared/messages';
import {
  DEFAULT_TEXT_STYLE,
  TOOL_NAMES,
  applyTextStyle,
  isInkDrawing,
  isTextDrawing,
  textStyleOf,
  type Drawing,
  type DrawingTool,
  type InkDrawing,
  type TextBoxStyle,
  type TextDrawing,
  type TextStyle,
} from '../src/shared/drawings';
import { CHAR_STYLES, PLAIN } from '../src/shared/richText';
import type { Highlight } from '../src/shared/types';
import { DEFAULT_CHOICES, DEFAULT_SOUND, DEFAULT_VOLUME } from '../src/shared/sounds';
import { DEFAULT_COLOR, DEFAULT_ZOOM, type DocumentKind, type HighlightColor, type PageTheme, type ReadingMarker, type ZoomValue } from '../src/shared/types';

interface Config {
  kind?: DocumentKind;
  worker: string;
  cmaps: string;
  standardFonts: string;
  wasm: string;
  /** Built-in reading sounds included in this build. */
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

/** What an undo step of a text style change says. */
function formatLabel(patch: Partial<TextStyle>): string {
  if (patch.color !== undefined) return 'Change text color';
  if (patch.size !== undefined) return 'Change text size';
  if (patch.align !== undefined) return 'Align text';
  if (patch.bold !== undefined) return patch.bold ? 'Bold text' : 'Remove bold';
  if (patch.italic !== undefined) return patch.italic ? 'Italicize text' : 'Remove italics';
  if (patch.underline !== undefined) return patch.underline ? 'Underline text' : 'Remove underline';
  return 'Format text box';
}

/** "Draw a rectangle", "Draw an arrow", "Draw freehand": what an undo step of a new drawing undoes. */
function drawLabel(tool: DrawingTool): string {
  if (tool === 'pen') return 'Draw freehand';
  const name = TOOL_NAMES[tool].toLowerCase();
  return `Draw ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
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
  private readonly drawings: DrawingController;
  private readonly drawingBar: DrawingBar;
  private readonly textBar: TextBar;
  private readonly drawingPopover: DrawingPopover;
  private readonly textPopover: TextPopover;
  private readonly colorPicker = new ColorPicker();
  private readonly undoStack = new UndoStack();
  private readonly sounds?: ReadingSounds;
  /** Show how drawing works the first time draw mode turns on (once per VS Code session). */
  private drawHint = false;
  /** The same for text mode, and for the eraser. */
  private textHint = false;
  private eraseHint = false;
  /** The style new text boxes get (the last one picked). */
  private textStyle: TextStyle = { ...DEFAULT_TEXT_STYLE };

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
  private readonly anchoring: AnchoringController;
  /** Storing drawings is asynchronous (they are bound to what they cover): one after the other. */
  private drawingCommits: Promise<void> = Promise.resolve();
  /** The banner on screen says that most annotations are missing from this version. */
  private orphanBanner = false;
  private readOnly = false;
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
      toggleDrawing: () => this.setMode(this.drawings.active ? 'off' : 'draw'),
      toggleText: () => this.setMode(this.drawings.textActive ? 'off' : 'text'),
      toggleEraser: () => this.setMode(this.drawings.erasing ? 'off' : 'erase'),
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
    if (!canPlaySounds()) {
      log('warn', 'Reading sounds are hidden: this webview cannot play Ogg Vorbis audio.');
    } else {
      this.sounds = new ReadingSounds(
        config.sounds ?? [],
        { sound: DEFAULT_SOUND, choices: { ...DEFAULT_CHOICES }, volume: DEFAULT_VOLUME, playing: false, owner: false },
        {
          request: (request) => post({ type: 'sound', ...request }),
          stateChanged: (state, name) => this.toolbar.setSoundState(state, name),
          openChanged: (open) => this.toolbar.setSoundsOpen(open),
          anchor: () => this.toolbar.soundsAnchor,
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
      accept: (id) => this.rebaseHighlight(id, undefined, 'Keep highlight on changed text'),
      attachSelection: (id) => this.attachToSelection(id),
      attachCandidate: (id) => {
        const candidate = this.highlights.candidateOf(id);
        if (candidate) this.rebaseHighlight(id, [candidate.start, candidate.end], 'Attach highlight');
      },
      removeOrphans: () => this.removeOrphans(),
      revealDrawing: (id) => {
        if (narrowPanel()) this.setListOpen(false, false);
        this.drawings.reveal(id);
      },
      removeDrawing: (id) => this.removeDrawing(id),
      placeDrawing: (id) => this.placeDrawing(id),
      acceptDrawing: (id) => {
        const shown = this.drawings.get(id);
        if (shown) void this.commitDrawings(isTextDrawing(shown) ? 'Keep text box here' : 'Keep drawing here', [{ ...shown, updatedAt: new Date().toISOString() }], [], { rebase: true });
      },
      removeAllDrawings: () => this.command('deleteAllDrawings'),
      removeAllTextBoxes: () => this.command('deleteAllTextBoxes'),
      close: () => this.setListOpen(false, true),
    });
    this.drawingBar = new DrawingBar({
      setTool: (tool) => this.setDrawStyle({ tool }),
      setWidth: (width) => this.setDrawStyle({ width }),
      pickColor: (anchor) =>
        this.colorPicker.toggle(anchor, {
          label: 'Ink color',
          value: this.drawings.color,
          onChange: (color, final) => this.setDrawStyle({ color }, final),
        }),
      done: () => this.setMode('off'),
    });
    this.textBar = new TextBar({
      setStyle: (patch) => this.changeTextStyle(patch),
      pickColor: (anchor) => {
        // A selected box shows each color while the reader drags; each color settled on is one undo step.
        const session = { base: this.drawings.editing ? undefined : this.selectedText() };
        this.colorPicker.toggle(anchor, {
          label: 'Text color',
          value: this.currentTextStyle().color,
          onChange: (color, final) => this.changeTextStyle({ color }, final, session),
          onClose: () => this.drawings.focusEditor(),
        });
      },
      done: () => this.setMode('off'),
    });
    this.colorPicker.onRecentChanged = (colors) => post({ type: 'recentColorsChanged', colors });

    const viewerElement = h('div', { id: 'viewer', class: 'pdfViewer' });
    this.container = h('div', { id: 'viewerContainer', class: 'mpv-viewer-container', tabindex: 0 }, viewerElement);
    const main = h('main', { class: 'mpv-main' }, this.sidebar.element, this.container, this.status.element, this.toast.element);
    root.append(this.toolbar.element, this.drawingBar.element, this.textBar.element, this.progress, this.banner.element, main);

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
      needsResolve: () => this.anchoring?.requestRun(),
    });
    this.marker = new ReadingMarkerController(
      this.viewer,
      this.layers,
      this.highlights,
      {
        placed: (marker) => this.setMarker(marker, 'Mark reading position'),
        tabClicked: (x, y) => this.showMarkerPopover(x, y),
        placingChanged: (placing) => this.onPlacingChanged(placing),
        needsResolve: () => this.anchoring?.requestRun(),
        changed: () => {
          this.toolbar.setMarkerState(this.marker.value !== null, this.marker.placing);
          this.renderList();
        },
      },
      { layout: () => this.anchoring?.layout, converted: this.kind !== 'pdf' },
    );
    // Registered after the highlights and the marker: drawings sit above links, below note badges
    // and the marker (by z-index), and the capture surface of draw and text mode above everything.
    this.drawings = new DrawingController(this.viewer, this.layers, this.highlights, {
      drawn: (drawing) => void this.commitDrawings(drawLabel(drawing.tool), [drawing]),
      erased: (drawings, highlights) => this.eraseAnnotations(drawings, highlights),
      rubbed: (removed, added) => void this.commitDrawings(removed.length === 1 ? 'Erase part of a drawing' : 'Erase parts of drawings', added, removed),
      moved: (_before, after) => void this.commitDrawings(isTextDrawing(after) ? 'Move text box' : 'Move drawing', [after]),
      resized: (_before, after) => void this.commitDrawings('Resize text box', [after]),
      textCommitted: (before, after) => this.onTextCommitted(before, after),
      editingChanged: () => this.showTextStyle(),
      editRequested: (id, x, y) => this.editText(id, x, y),
      selectionChanged: (id, popover) => this.onDrawingSelected(id, popover),
      changed: () => this.renderList(),
      notice: (message) => this.toast.show(message, { durationMs: 6000 }),
    });
    this.anchoring = new AnchoringController(this.highlights, this.marker, this.drawings, {
      kind: this.kind,
      post: (message) => post(message),
      log: (level, message) => log(level, message),
      report: (result) => this.reportRun(result),
    });
    this.drawingPopover = new DrawingPopover({
      pickColor: (id, anchor) => this.pickDrawingColor(id, anchor),
      setWidth: (id, width) => this.changeDrawing(id, { width }, 'Change drawing width'),
      attach: (id, to) => this.attachDrawing(id, to),
      remove: (id) => this.removeDrawing(id),
    });
    this.textPopover = new TextPopover({
      setStyle: (id, patch) => this.changeDrawing(id, patch, formatLabel(patch)),
      attach: (id, to) => this.attachDrawing(id, to),
      pickColor: (id, anchor) => this.pickDrawingColor(id, anchor),
      edit: (id) => this.editText(id),
      remove: (id) => this.removeDrawing(id),
    });
    this.popover = new HighlightPopover({
      setColor: (id, color) => this.changeHighlight(id, { color }, 'Change highlight color'),
      remove: (id) => this.removeHighlight(id),
      copy: (id) => {
        const text = this.highlights.get(id)?.data.target.selector[0].exact;
        if (text) post({ type: 'copyText', text });
      },
      saveNote: (id, note) => this.changeHighlight(id, { note }, note ? 'Edit note' : 'Delete note'),
      // The highlight whose popover is open is the selected one (Delete deletes it).
      shown: (id) => this.highlights.setSelected(id),
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
      // PDF.js lays the pages out again a moment later.
      requestAnimationFrame(() => this.drawings.placeEditor());
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
        this.marker.set(init.marker);
        this.drawings.setDrawings(init.drawings ?? []);
        this.anchoring.keepSnapshots = init.keepSnapshots !== false;
        this.anchoring.setStoredPages(init.pages);
        this.setReadOnly(init.readOnly === true);
        this.toolbar.setColor(init.color);
        this.toolbar.setFullView(init.fullView);
        this.setTool(init.toolActive, false);
        if (init.drawStyle) this.setDrawStyle(init.drawStyle, false);
        this.drawHint = init.drawHint === true;
        this.textHint = init.textHint === true;
        this.eraseHint = init.eraseHint === true;
        this.textStyle = { ...DEFAULT_TEXT_STYLE, ...(init.textStyle ?? {}) };
        this.drawings.setTextStyle(this.textStyle);
        this.toolbar.setTextColor(this.textStyle.color);
        this.textBar.setStyle(this.textStyle);
        this.colorPicker.setRecent(init.recentColors ?? []);
        if (init.customSounds) this.sounds?.setCustomSounds(init.customSounds);
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
        // Other annotations (a rename, Reattach): everything is resolved again against the document shown.
        this.highlights.setHighlights(msg.highlights);
        this.marker.set(msg.marker);
        this.drawings.setDrawings(msg.drawings ?? []);
        this.anchoring.setStoredPages(msg.pages);
        this.setReadOnly(msg.readOnly === true);
        this.undoStack.clear();
        this.anchoring.requestRun();
        break;
      case 'snapshots':
        this.anchoring.onSnapshots(msg.requestId, msg.texts);
        break;
      case 'toggleList':
        this.setListOpen(!this.sidebar.open, true);
        break;
      case 'toggleTool':
        this.setTool(!this.toolActive, true);
        break;
      case 'toggleDrawing':
        this.setMode(this.drawings.active ? 'off' : 'draw');
        break;
      case 'toggleText':
        this.setMode(this.drawings.textActive ? 'off' : 'text');
        break;
      case 'toggleEraser':
        this.setMode(this.drawings.erasing ? 'off' : 'erase');
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
        this.undoOrRedo(msg.type === 'undo');
        break;
      case 'deleteAll':
        this.deleteAll();
        break;
      case 'deleteAllDrawings':
        this.deleteAllDrawings(msg.kind === 'text' ? 'text' : 'ink');
        break;
      case 'marker':
        if (msg.action === 'place') this.toggleMarkerPlacement();
        else if (msg.action === 'goto') this.goToMarker();
        else this.removeMarker();
        break;
      case 'sound':
        this.sounds?.apply(msg.state);
        break;
      case 'customSounds':
        this.sounds?.setCustomSounds(msg.sounds);
        break;
      case 'soundsAdded':
        this.sounds?.soundsAdded(msg.ids, msg.reveal);
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
    // The new PDF is opened and read, and every annotation is placed in it, before anything on
    // screen changes: the previous PDF stays, with its annotations, under the progress bar.
    const opened = await this.viewer.open(data);
    if (!opened) return;
    let prepared: PreparedDocument | undefined;
    try {
      prepared = await this.anchoring.prepare(opened, {
        renderId: msg.renderId,
        provisional: msg.provisional === true,
        hints: msg.hints ?? [],
        snapshots: msg.snapshots ?? [],
      });
    } catch (err) {
      opened.discard();
      throw err;
    }
    if (!prepared) {
      opened.discard();
      return;
    }
    // A stroke being drawn is finished first. What the reader is in the middle of (typing in a
    // text box) is stored against the document it was made on.
    await Promise.race([this.drawings.idle(), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    this.drawings.settle();
    await this.drawingCommits;
    if (opened.stale()) {
      opened.discard();
      return;
    }
    // A note being typed stays open (it is saved on its highlight whatever happens to that).
    this.hideFloating(true);
    this.drawings.select(undefined);
    this.layers.reset();
    if (!(await opened.show(restore))) return;
    const firstLoad = !this.hasDocument;
    this.hasDocument = true;
    this.status.hide();
    this.progress.hidden = true;
    document.body.dataset.pageTheme = this.kind === 'pdf' ? this.theme : msg.theme;
    this.orphanBanner = false;
    if (msg.warnings.length > 0) {
      const first = msg.warnings[0].message;
      const more = msg.warnings.length > 1 ? ` (and ${msg.warnings.length - 1} more)` : '';
      this.banner.show('warning', `${first}${more}`, [{ label: 'Show Log', run: () => this.command('showLog') }]);
    } else if (this.readOnly) {
      this.showReadOnly();
    } else {
      this.banner.hide();
    }
    // The switch: what was computed for the previous PDF is dropped, the prepared results are shown.
    this.anchoring.commit(prepared);
    // Opening a document (not restoring a panel): continue where the reader stopped.
    if (firstLoad && !this.restoredLocation && this.marker.value && this.marker.goTo()) {
      this.toast.show(`Continuing where you stopped reading (page ${(this.marker.pageIndex ?? 0) + 1}).`);
    }
  }

  private setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    if (readOnly) this.showReadOnly();
  }

  private showReadOnly(): void {
    this.banner.show('info', 'These annotations were saved by a newer version of the extension. They are shown, but changes you make here are not stored.');
  }

  /** A resolving run finished: one line about what changed, and a banner when most annotations are missing. */
  private reportRun(result: RunResult): void {
    const message = summaryMessage(result.summary);
    if (result.summary.massOrphan) {
      this.orphanBanner = true;
      this.banner.show('warning', massOrphanMessage(result.summary), [{ label: 'Show List', run: () => this.setListOpen(true, true) }]);
    } else {
      if (this.orphanBanner && result.summary.orphanedNow * 2 <= result.summary.total) {
        this.orphanBanner = false;
        if (this.readOnly) this.showReadOnly();
        else this.banner.hide();
      }
      if (message) this.toast.show(message, { durationMs: 8000, action: { label: 'Show List', run: () => this.setListOpen(true, true) } });
    }
    this.renderList();
  }

  private async answerExport(requestId: number): Promise<void> {
    try {
      await this.loading;
      this.drawings.settle();
      await this.drawingCommits;
      const data = await this.highlights.exportData();
      const drawn = this.drawings.exportData();
      // The host checks that these positions were computed for the PDF it downloads.
      post({
        type: 'exportData',
        requestId,
        renderId: this.anchoring.renderId,
        hash: this.anchoring.hash() ?? '',
        highlights: data.highlights,
        orphaned: data.orphaned,
        orphanedNotes: data.orphanedNotes,
        orphanedDrawings: drawn.orphaned,
        drawings: drawn.drawings,
        textLayouts: drawn.textLayouts,
        skippedDrawings: drawn.skipped,
        password: this.viewer.password,
      });
    } catch (err) {
      post({ type: 'exportData', requestId, renderId: -1, hash: '', highlights: [], orphaned: 0, drawings: [], skippedDrawings: 0, error: String(err) });
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

  /** Applies an edit here and stores it. Drawing changes of a batch go to the host in one message each way. */
  private async apply(op: EditOp): Promise<void> {
    const saved: Drawing[] = [];
    const deleted: string[] = [];
    let resolve = false;
    const flush = () => {
      if (saved.length > 0) post({ type: 'saveDrawings', drawings: saved.splice(0) });
      if (deleted.length > 0) post({ type: 'deleteDrawings', ids: deleted.splice(0) });
    };
    const run = async (o: EditOp): Promise<void> => {
      switch (o.kind) {
        case 'create':
          post({ type: 'createHighlight', highlight: o.highlight });
          this.highlights.add(o.highlight);
          break;
        case 'replace':
          if (this.popover.highlightId === o.after.id) this.popover.hide(false);
          post({ type: 'replaceHighlight', highlight: o.after });
          this.highlights.replace(o.after);
          break;
        case 'delete':
          if (this.popover.highlightId === o.highlight.id) this.popover.hide(false);
          this.highlights.remove(o.highlight.id);
          post({ type: 'deleteHighlight', id: o.highlight.id });
          break;
        case 'update':
          if (o.after.color) this.highlights.setColor(o.id, o.after.color);
          if (o.after.note !== undefined) this.highlights.setNote(o.id, o.after.note);
          post({ type: 'updateHighlight', id: o.id, ...o.after });
          break;
        case 'marker':
          post({ type: 'setMarker', marker: o.after });
          this.marker.set(o.after);
          break;
        case 'createDrawing':
        case 'updateDrawing': {
          // Undo and redo work on drawings as they are stored; where they are shown is resolved again.
          const drawing = o.kind === 'createDrawing' ? o.drawing : o.after;
          if (deleted.length > 0) flush();
          this.drawings.restore(drawing);
          saved.push(drawing);
          resolve = true;
          break;
        }
        case 'deleteDrawing':
          if (saved.length > 0) flush();
          this.drawings.remove(o.drawing.id);
          deleted.push(o.drawing.id);
          break;
        case 'batch':
          for (const child of o.ops) await run(child);
          break;
      }
    };
    await run(op);
    flush();
    if (resolve) this.anchoring.requestRun();
  }

  /**
   * The reader made, changed or removed drawings or text boxes (the page shows it already):
   * stores them and records one undo step. A new place or shape is bound again to what it covers.
   */
  private commitDrawings(label: string, changed: Drawing[], removed: Drawing[] = [], options: { prefer?: 'text' | 'image' | 'page'; rebase?: boolean } = {}): Promise<void> {
    const task = this.drawingCommits
      .then(async () => {
        const ops: EditOp[] = [];
        const gone: string[] = [];
        for (const shown of removed) {
          const stored = this.drawings.storedOf(shown.id);
          this.drawings.remove(shown.id);
          if (!stored) continue;
          ops.push({ kind: 'deleteDrawing', drawing: stored });
          gone.push(shown.id);
        }
        const saved: Drawing[] = [];
        for (const shown of changed) {
          const before = this.drawings.storedOf(shown.id);
          const after = await this.drawings.adopt(shown, options.prefer, options.rebase);
          saved.push(after);
          ops.push(before ? { kind: 'updateDrawing', before, after } : { kind: 'createDrawing', drawing: after });
        }
        if (gone.length > 0) post({ type: 'deleteDrawings', ids: gone });
        if (saved.length > 0) post({ type: 'saveDrawings', drawings: saved });
        if (ops.length > 0) this.undoStack.record(ops.length === 1 ? ops[0] : { kind: 'batch', ops }, label);
      })
      .catch((err: unknown) => log('error', `Storing a drawing failed: ${String(err)}`));
    this.drawingCommits = task;
    return task;
  }

  // ---------- Annotations whose text changed or is gone ----------

  /** Puts a highlight on the text it is on now (after an edit), or on another range (an orphan). One undo step. */
  private rebaseHighlight(id: string, range: [number, number] | undefined, label: string): void {
    const change = this.highlights.rebase(id, range);
    if (!change) return;
    const op: EditOp = { kind: 'replace', before: change.before, after: change.after };
    void this.apply(op);
    this.undoStack.record(op, label);
    this.toast.show(range ? 'Highlight attached.' : 'The highlight now keeps this text.', { action: this.undoAction() });
  }

  private attachToSelection(id: string): void {
    const range = this.highlights.selectionRange();
    if (!range) {
      this.toast.show('Select the text to attach the highlight to first, then click Attach again.');
      return;
    }
    window.getSelection()?.removeAllRanges();
    this.selectionBar.hide();
    this.rebaseHighlight(id, range, 'Attach highlight');
  }

  /** Deletes every orphaned highlight, drawing and text box as one undo step. */
  private removeOrphans(): void {
    void this.drawingCommits.then(() => {
      const highlights = this.highlights.all.filter((h) => h.status === 'orphaned');
      const drawings = this.drawings.orphans().map((o) => o.drawing);
      const ops: EditOp[] = [...highlights.map((highlight): EditOp => ({ kind: 'delete', highlight })), ...drawings.map((drawing): EditOp => ({ kind: 'deleteDrawing', drawing }))];
      if (ops.length === 0) return;
      const op: EditOp = ops.length === 1 ? ops[0] : { kind: 'batch', ops };
      void this.apply(op);
      this.undoStack.record(op, 'Delete orphaned annotations');
      this.toast.show(`Deleted ${ops.length} orphaned annotation${ops.length === 1 ? '' : 's'}.`, { action: this.undoAction() });
    });
  }

  /** What a drawing or text box follows: the text, an image or the page (from its binding). */
  private attachmentOf(id: string): 'text' | 'image' | 'page' {
    const mode = this.drawings.bindingOf(id)?.mode;
    return mode === 'block' ? 'image' : mode === 'page' ? 'page' : 'text';
  }

  /** The reader chose what a drawing or text box follows (from its menu). One undo step. */
  private attachDrawing(id: string, to: 'text' | 'image' | 'page'): void {
    const shown = this.drawings.get(id);
    if (!shown) return;
    void this.commitDrawings(isTextDrawing(shown) ? 'Attach text box' : 'Attach drawing', [{ ...shown, updatedAt: new Date().toISOString() }], [], { prefer: to }).then(() => {
      const now = this.attachmentOf(id);
      this.drawingPopover.setAttached(now);
      this.textPopover.setAttached(now);
      // An image was asked for and there is none under it: say what it follows instead.
      if (now !== to) this.toast.show(to === 'image' ? 'There is no image here to attach it to. It follows the text.' : 'There is no text here to attach it to. It stays on the page.');
    });
  }

  /** Puts an orphaned drawing or text box back: where its content was, else on the page in view. */
  private placeDrawing(id: string): void {
    const orphan = this.drawings.orphans().find((o) => o.drawing.id === id);
    if (!orphan) return;
    const tombstone = orphan.result.tombstone;
    const page = tombstone?.page ?? this.viewer.pdfViewer.currentPageNumber - 1;
    const shown = this.drawings.placedAt(id, page, tombstone?.y);
    if (!shown) return;
    void this.commitDrawings(isTextDrawing(shown) ? 'Place text box' : 'Place drawing', [shown]).then(() => {
      if (narrowPanel()) this.setListOpen(false, false);
      this.drawings.reveal(id);
    });
  }

  /** Brings an undone/redone change into view if it is off-screen. */
  private revealChange(op: EditOp): void {
    const first = op.kind === 'batch' ? op.ops.find((o) => o.kind !== 'delete' && o.kind !== 'deleteDrawing') : op;
    if (!first) return;
    if (first.kind === 'marker') {
      if (first.after && !this.marker.isVisible()) this.marker.goTo();
      return;
    }
    if (first.kind === 'createDrawing' || first.kind === 'updateDrawing') {
      const id = first.kind === 'createDrawing' ? first.drawing.id : first.after.id;
      if (this.drawings.isVisible(id)) this.drawings.flash(id);
      else this.drawings.reveal(id);
      return;
    }
    const id = first.kind === 'update' ? first.id : first.kind === 'create' ? first.highlight.id : undefined;
    if (!id) return;
    if (this.highlights.isVisible(id)) this.highlights.flash(id);
    else this.highlights.reveal(id);
  }

  /**
   * Undo (or redo), wherever the keyboard is: while typing in a text box, its typing; in another
   * text field (a note, a hex color), that field's own; anywhere else, the last change to the
   * highlights, notes, reading marker, drawings and text boxes.
   */
  private undoOrRedo(undo: boolean): void {
    if (this.drawings.editorFocused) {
      if (undo) this.drawings.editorUndo();
      else this.drawings.editorRedo();
    } else if (isTextField(document.activeElement)) {
      document.execCommand(undo ? 'undo' : 'redo');
    } else if (undo) {
      void this.undo();
    } else {
      void this.redo();
    }
  }

  private async undo(): Promise<void> {
    this.drawings.cancelGesture();
    // Typing in a text box ends first (so the undo can take back the typing too).
    this.drawings.commitEditing();
    await this.drawingCommits;
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
    this.drawings.cancelGesture();
    this.drawings.commitEditing();
    await this.drawingCommits;
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

  /** Changes a drawing's ink or width, or a text box's style (one undo step). */
  private changeDrawing(id: string, changes: Partial<Pick<InkDrawing, 'color' | 'width'>> | Partial<TextStyle>, label: string, from?: Drawing): void {
    const before = from ?? this.drawings.get(id);
    if (!before) return;
    // (Bold, italic and underline of a text box go to all of its text.)
    const after: Drawing = isTextDrawing(before) ? this.drawings.fitText(applyTextStyle(before, changes as Partial<TextStyle>)) : ({ ...before, ...changes } as Drawing);
    const { updatedAt: _a, ...a } = after;
    const { updatedAt: _b, ...b } = before;
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    after.updatedAt = new Date().toISOString();
    this.drawings.put(after);
    if (isTextDrawing(after)) this.textPopover.update(after);
    else this.drawingPopover.update(after);
    void this.commitDrawings(label, [after]);
  }

  private removeDrawing(id: string): void {
    // One that is not shown (its content is gone) is deleted too.
    const drawing = this.drawings.get(id) ?? this.drawings.storedOf(id);
    if (!drawing) return;
    const text = isTextDrawing(drawing);
    void this.commitDrawings(text ? 'Delete text box' : 'Delete drawing', [], [drawing]);
    this.toast.show(text ? 'Text box deleted.' : 'Drawing deleted.', { action: this.undoAction() });
  }

  /**
   * The color picker of a selected drawing or text box: the drawing shows each color while the
   * reader drags in the picker, and every color they settle on is one undo step.
   */
  private pickDrawingColor(id: string, anchor: HTMLElement): void {
    let base = this.drawings.get(id);
    if (!base) return;
    const text = isTextDrawing(base);
    this.colorPicker.toggle(anchor, {
      label: text ? 'Text color' : 'Ink color',
      value: base.color,
      onChange: (color, final) => {
        if (!base) return;
        if (!final) {
          this.drawings.put({ ...base, color });
          return;
        }
        const from = base;
        this.changeDrawing(id, { color }, text ? 'Change text color' : 'Change drawing color', from);
        base = this.drawings.get(id);
        // Nothing changed (the original color picked again): show the original.
        if (base && base.color !== color) this.drawings.put(base);
      },
    });
  }

  // ---------- Text boxes ----------

  /** Typing in a text box ended: a new box, a changed one, or one emptied (deleted). */
  private onTextCommitted(before: TextDrawing | undefined, after: TextDrawing | undefined): void {
    if (after) {
      void this.commitDrawings(before ? 'Edit text box' : 'Add text box', [after]);
    } else if (before) {
      void this.commitDrawings('Delete text box', [], [before]);
      this.toast.show('Text box deleted (its text was empty).', { action: this.undoAction() });
    }
  }

  /** Types in a text box (text mode turns on). */
  private editText(id: string, clientX?: number, clientY?: number): void {
    this.setMode('text');
    this.drawings.startEditing(id, clientX, clientY);
  }

  /**
   * The style the text bar shows and works on: of the box being typed in (bold, italic and
   * underline: at the caret, or of the selected text), else of the selected box (in text mode),
   * else the one new boxes get.
   */
  private currentTextStyle(): TextStyle {
    const editing = this.drawings.editing;
    if (editing) return { size: editing.size, align: editing.align, color: editing.color, ...(this.drawings.editingCharStyle ?? PLAIN) };
    const selected = this.selectedText();
    return selected ? textStyleOf(selected) : this.textStyle;
  }

  private selectedText(): TextDrawing | undefined {
    const id = this.drawings.selectedId;
    const drawing = id && this.drawings.textActive ? this.drawings.get(id) : undefined;
    return drawing && isTextDrawing(drawing) ? drawing : undefined;
  }

  private showTextStyle(): void {
    this.textBar.setStyle(this.currentTextStyle());
  }

  /**
   * The text bar (or Ctrl+B/I/U) changed the style. While typing: size, alignment and color are
   * the box's; bold, italic and underline go to the selected text, or, with just a caret, to
   * what is typed next. Otherwise the selected box gets it (bold and so on: all of its text).
   * New boxes get the style too, except for bold and so on put on part of a text. `final` is
   * false while a color is being picked.
   */
  private changeTextStyle(patch: Partial<TextStyle>, final = true, session?: { base?: TextDrawing }): void {
    /** What new text boxes take over. */
    const sticky: Partial<TextStyle> = {};
    if (this.drawings.editing) {
      const box: Partial<TextBoxStyle> = {};
      if (patch.size !== undefined) box.size = patch.size;
      if (patch.align !== undefined) box.align = patch.align;
      if (patch.color !== undefined) box.color = patch.color;
      Object.assign(sticky, box);
      if (Object.keys(box).length > 0) this.drawings.setEditingStyle(box);
      for (const name of CHAR_STYLES) {
        if (patch[name] === undefined) continue;
        const partial = this.drawings.editingSelection;
        const on = this.drawings.toggleEditingStyle(name);
        if (!partial && on !== undefined) sticky[name] = on;
      }
      this.drawings.focusEditor();
    } else {
      Object.assign(sticky, patch);
      const selected = this.selectedText();
      const from = session?.base ?? selected;
      if (selected && from && final) {
        this.changeDrawing(selected.id, patch, formatLabel(patch), from);
        if (session) session.base = this.selectedText();
      } else if (selected && from) {
        this.drawings.put(applyTextStyle(from, patch));
      }
    }
    if (Object.keys(sticky).length > 0) {
      this.textStyle = { ...this.textStyle, ...sticky };
      this.drawings.setTextStyle(this.textStyle);
      this.toolbar.setTextColor(this.textStyle.color);
      if (final) post({ type: 'textStyleChanged', style: sticky });
    }
    this.showTextStyle();
  }

  /** One gesture of the eraser (drawings, text boxes and highlights it went over): one undo step. */
  private eraseAnnotations(drawings: Drawing[], highlightIds: string[]): void {
    const highlights = highlightIds.map((id) => this.highlights.snapshot(id)).filter((h): h is Highlight => h !== undefined);
    if (drawings.length + highlights.length === 0) return;
    // After any drawing still being stored, so what was just drawn can be erased too.
    this.drawingCommits = this.drawingCommits.then(() => {
      const ops: EditOp[] = [];
      for (const shown of drawings) ops.push({ kind: 'deleteDrawing', drawing: this.drawings.storedOf(shown.id) ?? shown });
      for (const highlight of highlights) ops.push({ kind: 'delete', highlight });
      const op: EditOp = ops.length === 1 ? ops[0] : { kind: 'batch', ops };
      void this.apply(op);
      const one = drawings[0] ? (isTextDrawing(drawings[0]) ? 'text box' : 'drawing') : 'highlight';
      this.undoStack.record(op, ops.length === 1 ? `Erase ${one}` : `Erase ${ops.length} annotations`);
    });
    // A note goes with its highlight: say so, with the way back.
    const notes = highlights.filter((h) => h.note).length;
    if (notes > 0) this.toast.show(notes === 1 ? 'Erased a highlight and its note.' : `Erased ${notes} highlights and their notes.`, { action: this.undoAction() });
  }

  /** Every drawing ('ink') or every text box ('text'). The host already asked the reader to confirm. */
  private deleteAllDrawings(kind: 'ink' | 'text'): void {
    this.drawings.commitEditing();
    void this.drawingCommits.then(() => {
      // Those that are not shown (their content is gone) too.
      const all = this.drawings.allStored.filter((d) => isTextDrawing(d) === (kind === 'text'));
      if (all.length === 0) return;
      const one = kind === 'text' ? 'text box' : 'drawing';
      const many = kind === 'text' ? 'text boxes' : 'drawings';
      void this.commitDrawings(`Delete all ${many}`, [], all);
      this.toast.show(`Deleted ${all.length} ${all.length === 1 ? one : many}.`, { action: this.undoAction() });
    });
  }

  private setMarker(marker: ReadingMarker | null, label: string): void {
    const op: EditOp = { kind: 'marker', before: this.marker.value, after: marker };
    // Placed just now on the page shown: it is drawn where the reader put it.
    post({ type: 'setMarker', marker });
    this.marker.set(marker, true);
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
    // The highlight tool, draw mode, text mode and placing the marker exclude each other.
    if (this.toolActive) this.setTool(false, true);
    this.setMode('off');
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
    if (active) {
      // The highlight tool, draw mode, text mode and placing the marker exclude each other.
      this.setMode('off');
      if (this.marker.placing) this.marker.stopPlacing();
    }
    this.toolActive = active;
    document.body.classList.toggle('mpv-tool-active', active);
    this.toolbar.setTool(active);
    if (notify) post({ type: 'toolChanged', active });
    if (active && this.highlights.selectionRange()) this.highlights.createFromSelection(this.color);
  }

  /** Draw mode, text mode or neither. Turning one on turns off the highlight tool and placing the marker. */
  private setMode(mode: DrawingMode): void {
    if (mode === this.drawings.mode) return;
    if (mode !== 'off') {
      if (this.toolActive) this.setTool(false, true);
      if (this.marker.placing) this.marker.stopPlacing();
      this.hideFloating();
      window.getSelection()?.removeAllRanges();
    }
    this.colorPicker.close();
    const bars = [this.drawingBar.element, this.textBar.element];
    const barFocused = bars.some((bar) => bar.contains(document.activeElement));
    this.drawings.setMode(mode);
    // A bar that opens or closes moves the pages down or up: scroll by as much, so they stay where they were on screen.
    const top = this.container.getBoundingClientRect().top;
    this.drawingBar.visible = mode === 'draw';
    this.textBar.visible = mode === 'text';
    const moved = this.container.getBoundingClientRect().top - top;
    if (moved !== 0) this.container.scrollTop += moved;
    this.toolbar.setDrawing(mode === 'draw');
    this.toolbar.setText(mode === 'text');
    this.toolbar.setEraser(mode === 'erase');
    this.showTextStyle();
    if (barFocused && !bars.some((bar) => !bar.hidden && bar.contains(document.activeElement))) this.container.focus({ preventScroll: true });
    if (mode === 'draw' && this.drawHint) {
      this.drawHint = false;
      post({ type: 'drawHintShown' });
      this.toast.show('Drag on the page to draw. Shift keeps shapes even. Esc stops drawing.', { durationMs: 7000 });
    }
    if (mode === 'text' && this.textHint) {
      this.textHint = false;
      post({ type: 'textHintShown' });
      this.toast.show('Click on the page to type, or drag to set the width first. Esc stops adding text.', { durationMs: 7000 });
    }
    if (mode === 'erase' && this.eraseHint) {
      this.eraseHint = false;
      post({ type: 'eraseHintShown' });
      this.toast.show('Click a highlight, drawing or text box to delete it, or drag over several. Esc stops erasing.', { durationMs: 7000 });
    }
  }

  /** Changes the drawing tool, ink or width (remembered for all files unless `notify` is false). */
  private setDrawStyle(style: Partial<DrawStyle>, notify = true): void {
    if (style.tool) {
      this.drawings.setTool(style.tool);
      this.drawingBar.setTool(style.tool);
    }
    if (style.color) {
      this.drawings.setColor(style.color);
      this.drawingBar.setColor(style.color);
      this.toolbar.setInk(style.color);
    }
    if (style.width) {
      this.drawings.setWidth(style.width);
      this.drawingBar.setWidth(style.width);
    }
    if (notify) post({ type: 'drawStyleChanged', style });
  }

  private onDrawingSelected(id: string | undefined, popover: boolean): void {
    if (this.drawings.textActive) this.showTextStyle();
    const drawing = id && popover ? this.drawings.get(id) : undefined;
    const r = id && popover ? this.drawings.clientRectOf(id) : undefined;
    if (this.colorPicker.openedFrom && (this.drawingPopover.element.contains(this.colorPicker.openedFrom) || this.textPopover.element.contains(this.colorPicker.openedFrom))) {
      if (!drawing || drawing.id !== (this.drawingPopover.drawingId ?? this.textPopover.textId)) this.colorPicker.close();
    }
    if (!drawing || !r) {
      this.drawingPopover.hide();
      this.textPopover.hide();
      return;
    }
    this.popover.hide();
    this.markerPopover.hide();
    this.noteTooltip.hide();
    this.selectionBar.hide();
    const x = (r.left + r.right) / 2;
    if (isTextDrawing(drawing)) {
      this.drawingPopover.hide();
      this.textPopover.setAttached(this.attachmentOf(drawing.id));
      this.textPopover.show(drawing, x, r.bottom);
    } else {
      this.textPopover.hide();
      this.drawingPopover.setAttached(this.attachmentOf(drawing.id));
      this.drawingPopover.show(drawing, x, r.bottom);
    }
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
    // Called while the controllers are still being built (their first `changed` events).
    if (!this.drawings) return;
    // Drawings as they are shown, then those whose content is not in this version.
    const shown = this.drawings.list().map((data) => ({ data, onPage: true, flags: this.drawings.flagsOf(data.id) }));
    const lost = this.drawings.orphans().map((o) => ({ data: o.drawing, onPage: false, orphan: { reason: o.result.reason } }));
    const listed = [...shown, ...lost];
    this.sidebar.render(
      this.highlights.list().map((rt) => {
        const r = rt.resolution;
        const now = this.highlights.currentText(rt.data.id);
        return {
          data: rt.data,
          page: this.highlights.firstPageOf(rt.data.id),
          kind: r?.kind,
          reason: r?.reason,
          wasPage: r?.status === 'orphaned' ? r.state.found?.page : undefined,
          now: now !== undefined && now !== rt.data.target.selector[0].exact ? now : undefined,
          candidate: this.highlights.candidateOf(rt.data.id)?.text,
        };
      }),
      marker ? { marker, page: this.marker.pageIndex ?? marker.pageIndex, caveat: this.marker.caveat } : null,
      listed.filter((e) => isInkDrawing(e.data)).map((e) => ({ ...e, data: e.data as InkDrawing, thumbnail: this.drawings.thumbnail(e.data as InkDrawing) })),
      listed.filter((e) => isTextDrawing(e.data)).map((e) => ({ ...e, data: e.data as TextDrawing })),
    );
  }

  /**
   * Hides popovers and tooltips, and deselects a drawing. On scroll/zoom (`passive`) a note being
   * edited stays open, and a selected drawing stays selected (its popover closes).
   */
  private hideFloating(passive = false): void {
    if (!passive || !this.popover.editing) this.popover.hide();
    // The sounds panel hangs from the toolbar, so scrolling and zooming leave it open.
    if (!passive) this.sounds?.hide();
    this.selectionBar.hide();
    this.markerPopover.hide();
    this.noteTooltip.hide();
    this.drawingPopover.hide();
    this.textPopover.hide();
    // A picker opened from a bar stays (the bar does not move); one opened from a popover goes with it.
    const from = this.colorPicker.openedFrom;
    if (from && (!passive || !(this.drawingBar.element.contains(from) || this.textBar.element.contains(from)))) this.colorPicker.close();
    if (!passive && this.drawings.selectedId && !this.drawings.editing) this.drawings.select(undefined);
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
      if (e.button !== 0 || this.marker.placing || this.drawings.mode !== 'off') return;
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
      // Clicks of draw and text mode, and the click ending a press on a drawing, are the drawings' own.
      if (e.button !== 0 || this.drawings.consumeClick() || this.drawings.mode !== 'off') return;
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
        if (this.marker.placing || this.drawings.mode !== 'off') {
          this.noteTooltip.hide();
          c.classList.remove('mpv-over-highlight');
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
      // A press on the selected drawing hides its popover while it may move; it comes back after.
      // (Not while picking its color: the picker belongs to the popover.)
      if (!this.drawingPopover.element.contains(target) && !this.colorPicker.contains(target)) this.drawingPopover.hide();
      if (!this.textPopover.element.contains(target) && !this.colorPicker.contains(target)) this.textPopover.hide();
      this.noteTooltip.hide();
      // Typing in a text box ends with a press anywhere but the box, the text bar or the picker
      // (presses on the pages are the drawings' own: they decide).
      if (this.drawings.editing && !this.container.contains(target) && !this.textBar.element.contains(target) && !this.colorPicker.contains(target)) {
        this.drawings.commitEditing();
      }
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
        // Bold, italic and underline in the text box being edited (VS Code never gets these keys).
        const format = { b: 'bold', i: 'italic', u: 'underline' } as const;
        const formatKey = (e.key.length === 1 ? e.key.toLowerCase() : '') || e.code.replace(/^Key/, '').toLowerCase();
        if (!e.shiftKey && formatKey in format && this.drawings.editorFocused) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const prop = format[formatKey as keyof typeof format];
          if (!e.repeat) this.changeTextStyle({ [prop]: !this.currentTextStyle()[prop] });
          return;
        }
        const undo = key === 'z' && !e.shiftKey;
        const redo = (key === 'z' && e.shiftKey) || (!isMac && key === 'y' && !e.shiftKey);
        if (!undo && !redo) return;
        // Handled here in every case, so VS Code never routes the key to its own undo.
        e.stopImmediatePropagation();
        // A note box or the hex field: the browser undoes the typing there.
        if (isTextField(document.activeElement) && !this.drawings.editorFocused) return;
        e.preventDefault();
        this.undoOrRedo(undo);
      },
      true,
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Esc cancels a shape being drawn (or a move); else it leaves draw or text mode; else it
      // closes things. (Esc in a text box ends typing there; in the color picker it closes it.)
      if (this.drawings.cancelGesture()) return;
      if (this.drawings.mode !== 'off') {
        this.setMode('off');
        return;
      }
      if (this.marker.placing) this.marker.stopPlacing();
      this.hideFloating();
      if (this.toolbar.element.contains(document.activeElement)) this.container.focus();
    });
    // Tool keys while drawing. Delete and Backspace delete what is selected, whatever it is: the
    // selected drawing or text box, the highlight whose popover is open, the reading marker whose
    // popover is open. Enter edits it: types in the text box, writes the highlight's note. Only
    // when the viewer itself has the keyboard (not a text field, a menu, the color picker or the
    // sounds panel).
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const focused = document.activeElement;
      if (isTextField(focused) || focused?.closest('.mpv-sounds, .mpv-menu, .mpv-status, .mpv-color-picker, select')) return;
      const tool = this.drawings.active ? TOOL_KEYS[e.key.toLowerCase()] : undefined;
      if (tool) {
        e.preventDefault();
        if (!e.repeat) this.setDrawStyle({ tool });
        return;
      }
      const selected = this.drawings.selectedId;
      const highlight = this.popover.visible && !this.popover.editing ? this.popover.highlightId : undefined;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected) {
          this.drawingPopover.hide();
          this.textPopover.hide();
          this.removeDrawing(selected);
        } else if (highlight) {
          this.popover.hide(false);
          this.removeHighlight(highlight);
        } else if (this.markerPopover.visible) {
          this.markerPopover.hide();
          this.removeMarker();
        } else {
          return;
        }
        e.preventDefault();
      } else if (e.key === 'Enter' && !focused?.closest('button, [role="button"]')) {
        if (selected && this.drawings.get(selected)?.tool === 'text') this.editText(selected);
        else if (highlight) this.popover.editNote();
        else return;
        e.preventDefault();
      }
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
