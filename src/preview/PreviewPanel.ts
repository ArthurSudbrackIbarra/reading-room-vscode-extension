// One viewer: owns a webview panel (a preview panel for Markdown and text files, a custom editor
// for PDF files), produces the PDF it shows and routes messages between the viewer and the store.
//  - Markdown / text: converted with Chromium; results are kept in memory and in the disk cache.
//  - PDF: the file itself, reloaded when it changes on disk.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { PdfCache } from '../cache/PdfCache';
import { downloadsFolder, writeDownloadedPdf } from '../export/downloads';
import type { AnchorResult, CustomSoundView, ExportHighlight, HostToViewer, ViewerToHost } from '../shared/messages';
import { MAX_RECENT_COLORS, normalizeHex, sanitizeInk, type HexColor, type Ink } from '../shared/colors';
import {
  MAX_DRAWINGS,
  MAX_TEXT_LENGTH,
  isDrawTool,
  isInkWidth,
  isTextDrawing,
  sanitizeDrawing,
  sanitizeTextStyle,
  type DrawTool,
  type Drawing,
  type InkWidth,
  type TextLayout,
  type TextStyle,
} from '../shared/drawings';
import {
  DEFAULT_ZOOM,
  MAX_NOTE_LENGTH,
  MM_TO_PT,
  PAGE_MARGINS_MM,
  isConvertedKind,
  isHighlightColor,
  isZoomValue,
  type DocumentKind,
  type Highlight,
  type HighlightColor,
  type PageTheme,
} from '../shared/types';
import { normalizeKeyPath, sanitizeHighlight, sanitizeMarker, type DocumentRef, type HighlightStore } from '../store/HighlightStore';
import type { SoundRequest, SoundState } from '../shared/sounds';
import type { SoundLibrary } from '../store/SoundLibrary';
import { readSettings } from '../util/settings';
import { RenderError, type RenderService } from './RenderService';
import type { SoundCoordinator } from './SoundCoordinator';
import { buildWebviewHtml, webviewOptions } from './webviewHtml';

export interface UiState {
  color: HighlightColor;
  theme: PageTheme;
  toolActive: boolean;
  listOpen: boolean;
  /** The last drawing tool, ink and width; draw mode itself always starts off. */
  drawTool: DrawTool;
  inkColor: Ink;
  inkWidth: InkWidth;
  /** The style new text boxes get; text mode itself always starts off. */
  textStyle: TextStyle;
  /** Custom colors picked lately (newest first), offered again in the color picker. */
  recentColors: HexColor[];
}

export interface PanelHost {
  readonly extensionUri: vscode.Uri;
  readonly extensionVersion: string;
  readonly log: vscode.LogOutputChannel;
  readonly store: HighlightStore;
  readonly renderer: RenderService;
  readonly pdfCache: PdfCache;
  readonly sounds: SoundCoordinator<PreviewPanel>;
  /** The reader's own reading sounds, and the folder their files are in. */
  readonly soundLibrary: SoundLibrary;
  readonly customSoundsUri: vscode.Uri;
  /** A reading sounds request from a viewer's controls. */
  soundRequest(panel: PreviewPanel, request: SoundRequest): void;
  uiState(): UiState;
  updateUiState(patch: Partial<UiState>): void;
  /** Whether the "how to draw" tip is still to be shown in this VS Code session; `shown` marks it shown. */
  drawHint(shown?: boolean): boolean;
  /** The same for the "how to add text" tip. */
  textHint(shown?: boolean): boolean;
  /**
   * Asks the reader to confirm, then deletes every drawing ('ink') or every text box ('text') of the
   * panel's file (through its viewer, so it can be undone).
   */
  deleteAllDrawings(panel: PreviewPanel, kind: 'ink' | 'text'): Promise<void>;
  toggleTheme(): void;
  refFor(uri: vscode.Uri): DocumentRef;
  focusChanged(panel: PreviewPanel, focused: boolean): void;
  viewStateChanged(panel: PreviewPanel): void;
  disposed(panel: PreviewPanel): void;
}

interface ShownPdf {
  key: string;
  pdf: Uint8Array;
  warnings: string[];
}

type ExportReply = {
  highlights: ExportHighlight[];
  orphaned: number;
  drawings: Drawing[];
  textLayouts?: TextLayout[];
  skippedDrawings: number;
  password?: string;
  error?: string;
};

/** A text box layout from a viewer, if it is well formed (the export checks it against the text). */
function sanitizeTextLayout(value: unknown): TextLayout | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const l = value as Partial<Record<keyof TextLayout, unknown>>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e6;
  if (typeof l.id !== 'string' || !Array.isArray(l.lines) || l.lines.length > MAX_TEXT_LENGTH || !finite(l.width) || !finite(l.height)) return undefined;
  if (!l.lines.every((line): line is string => typeof line === 'string')) return undefined;
  return { id: l.id, lines: l.lines.slice(), width: l.width, height: l.height };
}

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** "a", "a and b", "a, b and c". */
function listOf(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdtxt|mdtext|rmd|qmd)$/i;
export const TEXT_EXT = /\.txt$/i;
export const PDF_EXT = /\.pdf$/i;
const EXPORT_TIMEOUT_MS = 60_000;
/** Bump when the converter output changes in a way the extension version does not capture. */
const CACHE_SALT = 'v1';
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
export { MAX_CACHE_BYTES };

export function kindOf(uri: vscode.Uri, languageId?: string): DocumentKind | undefined {
  if (PDF_EXT.test(uri.path)) return 'pdf';
  if (languageId === 'markdown' || MARKDOWN_EXT.test(uri.path)) return 'markdown';
  if (TEXT_EXT.test(uri.path)) return 'text';
  return undefined;
}

export function panelTitle(uri: vscode.Uri): string {
  return `PDF: ${uri.path.split('/').pop() ?? 'document'}`;
}

/** Escapes glob characters in a file name for a RelativePattern. */
function globEscape(name: string): string {
  return name.replace(/[[\]{}*?]/g, (c) => `[${c}]`);
}

/**
 * A plain Uint8Array over the same memory. `workspace.fs.readFile` returns a Node Buffer, which
 * postMessage would turn into `{ type: 'Buffer', data: [...] }` (Buffer.toJSON) instead of bytes.
 */
function plainBytes(bytes: Uint8Array): Uint8Array {
  return Object.getPrototypeOf(bytes) === Uint8Array.prototype ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export class PreviewPanel implements vscode.Disposable {
  private uriValue: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher?: vscode.FileSystemWatcher;
  private ready = false;
  private readonly outbox: HostToViewer[] = [];
  private disposed = false;

  private pinAfterMove = false;
  private renderLoop?: Promise<void>;
  private renderAgain = false;
  private forceNext = false;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private renderSeq = 0;
  /** What the viewer currently shows. */
  private shown?: ShownPdf & { renderId: number; theme: PageTheme };
  /** Converted PDFs by page theme (Markdown and text only). */
  private readonly cache = new Map<PageTheme, ShownPdf>();
  private theme: PageTheme;

  private exportSeq = 0;
  private readonly exportWaiters = new Map<number, (data: ExportReply) => void>();

  constructor(
    private readonly host: PanelHost,
    readonly panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    readonly kind: DocumentKind,
  ) {
    this.uriValue = uri;
    this.theme = host.uiState().theme;
    if (kind !== 'pdf') {
      panel.title = panelTitle(uri);
      panel.iconPath = {
        light: vscode.Uri.joinPath(host.extensionUri, 'media', 'preview-light.svg'),
        dark: vscode.Uri.joinPath(host.extensionUri, 'media', 'preview-dark.svg'),
      };
    }
    panel.webview.options = webviewOptions(host.extensionUri, host.customSoundsUri);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: ViewerToHost) => {
        this.onMessage(msg).catch((err: unknown) => this.host.log.error(`Message ${msg?.type} failed: ${String(err)}`));
      }),
      panel.onDidChangeViewState(() => {
        this.host.viewStateChanged(this);
        if (this.kind !== 'pdf') this.post({ type: 'fullView', full: this.isFullView() });
        if (this.pinAfterMove && panel.active) {
          // Moving an editor between groups turns it into a preview tab, which the next file
          // opened in that group would replace. Keep it.
          this.pinAfterMove = false;
          void vscode.commands.executeCommand('workbench.action.keepEditor');
        }
      }),
      panel.onDidDispose(() => this.dispose()),
    );
    this.watchFile();
    panel.webview.html = buildWebviewHtml(panel.webview, host.extensionUri, kind);
  }

  get uri(): vscode.Uri {
    return this.uriValue;
  }

  private get ref(): DocumentRef {
    return this.host.refFor(this.uriValue);
  }

  private get fileName(): string {
    return this.uriValue.path.split('/').pop() ?? 'document';
  }

  // ---------- Messaging ----------

  /** Reading sounds state for this viewer (from the SoundCoordinator). */
  postSound(state: SoundState): void {
    this.post({ type: 'sound', state });
  }

  /** The custom reading sounds changed. */
  postCustomSounds(): void {
    this.post({ type: 'customSounds', sounds: this.customSoundViews() });
  }

  /** Sounds this viewer asked to add are in: it measures their loudness (and shows them, if `reveal`). */
  soundsAdded(ids: string[], reveal: boolean): void {
    this.post({ type: 'soundsAdded', ids, reveal });
  }

  private customSoundViews(): CustomSoundView[] {
    const library = this.host.soundLibrary;
    return library.sounds.map((r) => ({
      id: r.id,
      name: r.name,
      gainDb: r.gainDb,
      url: this.panel.webview.asWebviewUri(vscode.Uri.file(library.pathOf(r))).toString(),
    }));
  }

  private post(message: HostToViewer): void {
    if (this.disposed) return;
    if (!this.ready) {
      // Keep only the latest of each kind of state message until the viewer is ready.
      if (!['pdf', 'requestExport', 'undo', 'redo', 'deleteAll', 'marker', 'soundsAdded'].includes(message.type)) {
        const i = this.outbox.findIndex((m) => m.type === message.type);
        if (i >= 0) this.outbox.splice(i, 1);
      }
      this.outbox.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: ViewerToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.onReady();
        break;
      case 'focus':
        this.host.focusChanged(this, msg.focused);
        break;
      case 'createHighlight': {
        const highlight = sanitizeHighlight(structuredClone(msg.highlight));
        if (!highlight) return;
        await this.host.store.update(this.ref, (r) => {
          if (!r.highlights.some((h) => h.id === highlight.id)) r.highlights.push(highlight);
        });
        break;
      }
      case 'updateHighlight': {
        const color = msg.color !== undefined && isHighlightColor(msg.color) ? msg.color : undefined;
        const note = typeof msg.note === 'string' ? msg.note.slice(0, MAX_NOTE_LENGTH) : undefined;
        if (color === undefined && note === undefined) return;
        await this.host.store.update(this.ref, (r) => {
          const h = r.highlights.find((x) => x.id === msg.id);
          if (!h) return;
          if (color) h.color = color;
          if (note !== undefined) {
            if (note.trim()) h.note = note;
            else delete h.note;
          }
          h.updatedAt = new Date().toISOString();
        });
        break;
      }
      case 'deleteHighlight':
        await this.host.store.update(this.ref, (r) => {
          r.highlights = r.highlights.filter((h) => h.id !== msg.id);
        });
        break;
      case 'setMarker': {
        const marker = msg.marker ? sanitizeMarker(structuredClone(msg.marker)) : undefined;
        if (msg.marker && !marker) return;
        await this.host.store.update(this.ref, (r) => {
          if (marker) r.marker = marker;
          else delete r.marker;
        });
        break;
      }
      case 'saveDrawings':
        await this.saveDrawings(msg.drawings);
        break;
      case 'deleteDrawings': {
        const ids = new Set((Array.isArray(msg.ids) ? msg.ids : []).filter((id): id is string => typeof id === 'string'));
        if (ids.size === 0) return;
        await this.host.store.update(this.ref, (r) => {
          r.drawings = r.drawings.filter((d) => !ids.has(d.id));
        });
        break;
      }
      case 'drawStyleChanged': {
        const style = msg.style ?? {};
        const patch: Partial<UiState> = {};
        const color = sanitizeInk(style.color);
        if (isDrawTool(style.tool)) patch.drawTool = style.tool;
        if (color) patch.inkColor = color;
        if (isInkWidth(style.width)) patch.inkWidth = style.width;
        if (Object.keys(patch).length > 0) this.host.updateUiState(patch);
        break;
      }
      case 'drawHintShown':
        this.host.drawHint(true);
        break;
      case 'textStyleChanged': {
        const current = this.host.uiState().textStyle;
        this.host.updateUiState({ textStyle: sanitizeTextStyle({ ...current, ...(msg.style ?? {}) }, current) });
        break;
      }
      case 'textHintShown':
        this.host.textHint(true);
        break;
      case 'recentColorsChanged': {
        const colors = (Array.isArray(msg.colors) ? msg.colors : []).map(normalizeHex).filter((c): c is HexColor => c !== undefined);
        this.host.updateUiState({ recentColors: [...new Set(colors)].slice(0, MAX_RECENT_COLORS) });
        break;
      }
      case 'anchorsResolved':
        await this.applyAnchors(msg.renderId, msg.results);
        break;
      case 'viewChanged':
        if (!isZoomValue(msg.zoom)) return;
        await this.host.store.update(this.ref, (r) => {
          r.view.zoom = msg.zoom;
        });
        break;
      case 'colorChanged':
        if (isHighlightColor(msg.color)) this.host.updateUiState({ color: msg.color });
        break;
      case 'toolChanged':
        this.host.updateUiState({ toolActive: !!msg.active });
        break;
      case 'listChanged':
        this.host.updateUiState({ listOpen: !!msg.open });
        break;
      case 'openLink':
        await this.openLink(msg.href);
        break;
      case 'command':
        await this.runViewerCommand(msg.command);
        break;
      case 'exportData':
        this.exportWaiters.get(msg.requestId)?.(msg);
        this.exportWaiters.delete(msg.requestId);
        break;
      case 'copyText':
        await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'sound':
        this.host.soundRequest(this, msg);
        break;
      case 'log':
        this.host.log[msg.level](`[viewer] ${msg.message}`);
        break;
    }
  }

  /** Stores new drawings and new versions of existing ones, after checking every one of them. */
  private async saveDrawings(incoming: unknown): Promise<void> {
    let simplified = 0;
    let shortened = 0;
    const drawings = (Array.isArray(incoming) ? incoming : [])
      .map((value: unknown) =>
        sanitizeDrawing(structuredClone(value), (d) => {
          if (isTextDrawing(d)) shortened++;
          else simplified++;
        }),
      )
      .filter((d): d is Drawing => d !== undefined);
    if (drawings.length === 0) return;
    let refused = 0;
    const now = new Date().toISOString();
    await this.host.store.update(this.ref, (r) => {
      const index = new Map(r.drawings.map((d, i) => [d.id, i]));
      for (const drawing of drawings) {
        const i = index.get(drawing.id);
        if (i !== undefined) {
          r.drawings[i] = { ...drawing, createdAt: r.drawings[i].createdAt, updatedAt: now };
        } else if (r.drawings.length >= MAX_DRAWINGS) {
          refused++;
        } else {
          index.set(drawing.id, r.drawings.length);
          r.drawings.push({ ...drawing, updatedAt: now });
        }
      }
    });
    if (simplified > 0) {
      this.host.log.warn(`${count(simplified, 'drawing')} of ${this.fileName} had more points than allowed and ${simplified === 1 ? 'was' : 'were'} simplified to fit`);
    }
    if (shortened > 0) {
      this.host.log.warn(
        `${count(shortened, 'text box', 'text boxes')} of ${this.fileName} had more than ${MAX_TEXT_LENGTH} characters and ${shortened === 1 ? 'was' : 'were'} shortened`,
      );
    }
    if (refused > 0) {
      this.host.log.warn(`${count(refused, 'drawing')} of ${this.fileName} not saved: the file already has ${MAX_DRAWINGS} drawings`);
      void vscode.window.showWarningMessage(
        `Document Viewer: ${this.fileName} already has ${MAX_DRAWINGS} drawings, the most one file can have, so ${count(refused, 'new drawing')} ${refused === 1 ? 'was' : 'were'} not saved. Delete some drawings to make room.`,
      );
    }
  }

  private async onReady(): Promise<void> {
    this.ready = true;
    this.host.sounds.pageLoaded(this);
    const record = await this.host.store.get(this.ref);
    const ui = this.host.uiState();
    const margins = isConvertedKind(this.kind)
      ? { top: PAGE_MARGINS_MM.top * MM_TO_PT, bottom: PAGE_MARGINS_MM.bottom * MM_TO_PT }
      : { top: 0, bottom: 0 };
    void this.panel.webview.postMessage({
      type: 'init',
      init: {
        kind: this.kind,
        fileName: this.fileName,
        uri: this.uri.toString(),
        highlights: record.highlights,
        marker: record.marker ?? null,
        drawings: record.drawings,
        zoom: record.view.zoom ?? DEFAULT_ZOOM,
        color: ui.color,
        theme: this.theme,
        toolActive: ui.toolActive,
        listOpen: ui.listOpen,
        drawStyle: { tool: ui.drawTool, color: ui.inkColor, width: ui.inkWidth },
        drawHint: this.host.drawHint(),
        textStyle: ui.textStyle,
        textHint: this.host.textHint(),
        recentColors: ui.recentColors,
        fullView: this.kind !== 'pdf' && this.isFullView(),
        marginsPt: margins,
        sound: this.host.sounds.stateFor(this),
        customSounds: this.customSoundViews(),
      },
    } satisfies HostToViewer);
    const queued = this.outbox.splice(0);
    for (const message of queued) void this.panel.webview.postMessage(message);
    if (this.shown) {
      // The webview was reloaded (e.g. restored): show what we have, then refresh.
      const { pdf, renderId, theme, warnings } = this.shown;
      this.post({ type: 'pdf', data: pdf, renderId, theme, warnings: warnings.map((message) => ({ message })) });
    } else if (!this.renderLoop) {
      void this.requestRender();
    }
  }

  // ---------- Producing the PDF ----------

  private async readText(): Promise<string> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.uri.toString());
    if (open) return open.getText();
    // Same decoding as the editor (files.encoding, auto-guessing).
    return vscode.workspace.decode(await vscode.workspace.fs.readFile(this.uri), { uri: this.uri });
  }

  /** Identifies a conversion: same hash, same PDF. */
  private sourceHash(text: string, theme: PageTheme): string {
    const s = readSettings();
    return createHash('sha256')
      .update(`${CACHE_SALT}|${this.host.extensionVersion}|${this.kind}|${theme}|${s.pageSize}|${s.pageNumbers}|${s.allowRemoteImages}\n`)
      .update(text)
      .digest('hex');
  }

  private get cacheKey(): string {
    return normalizeKeyPath(this.ref);
  }

  /** Renders after a short delay, collapsing bursts (e.g. "Save All"). */
  scheduleRender(delayMs = 300): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.requestRender(), delayMs);
  }

  /**
   * Starts a render (or a reload, for PDF files), or queues one more if one is running.
   * `force` skips every cache. Resolves when all queued renders finish.
   */
  requestRender(force = false): Promise<void> {
    clearTimeout(this.renderTimer);
    if (force) this.forceNext = true;
    if (this.renderLoop) {
      this.renderAgain = true;
      return this.renderLoop;
    }
    this.renderLoop = (async () => {
      try {
        do {
          this.renderAgain = false;
          const forced = this.forceNext;
          this.forceNext = false;
          if (this.kind === 'pdf') await this.loadPdfFile(forced);
          else await this.renderOnce(forced);
        } while (this.renderAgain && !this.disposed);
      } finally {
        this.renderLoop = undefined;
      }
    })();
    return this.renderLoop;
  }

  private async loadPdfFile(force: boolean): Promise<void> {
    if (this.disposed) return;
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(this.uri);
    } catch {
      this.post({
        type: 'renderError',
        message: `${this.fileName} no longer exists. It may have been moved or deleted.`,
        firstRender: !this.shown,
      });
      return;
    }
    const key = `${stat.mtime}:${stat.size}`;
    if (!force && this.shown?.key === key) return;
    if (this.shown) this.post({ type: 'rendering' });
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.uri);
    } catch (err) {
      this.post({ type: 'renderError', message: `Could not read ${this.uri.fsPath || this.uri.toString()}: ${String(err)}`, firstRender: !this.shown });
      return;
    }
    if (this.disposed) return;
    this.show({ key, pdf: bytes, warnings: [], renderId: ++this.renderSeq, theme: this.theme });
    this.host.log.info(`Opened ${this.uri.fsPath || this.uri.toString()} (${bytes.byteLength} bytes)`);
  }

  private async renderOnce(force: boolean): Promise<void> {
    if (this.disposed || !isConvertedKind(this.kind)) return;
    let text: string;
    try {
      text = await this.readText();
    } catch (err) {
      this.post({ type: 'renderError', message: `Could not read ${this.uri.fsPath || this.uri.toString()}: ${String(err)}`, firstRender: !this.shown });
      return;
    }
    const theme = this.theme;
    const key = this.sourceHash(text, theme);
    if (!force && this.shown?.key === key && this.shown.theme === theme) return;
    const cached = this.cache.get(theme);
    if (!force && cached?.key === key) {
      this.show({ ...cached, renderId: ++this.renderSeq, theme });
      return;
    }
    const settings = readSettings();
    if (!force && settings.cacheDays > 0) {
      const started = Date.now();
      const hit = await this.host.pdfCache.get(this.cacheKey, theme, key, (path) => this.statPath(path)).catch((err: unknown) => {
        this.host.log.warn(`Reading the PDF cache failed: ${String(err)}`);
        return undefined;
      });
      if (this.disposed) return;
      if (hit) {
        const entry: ShownPdf = { key, pdf: hit.pdf, warnings: hit.warnings };
        this.cache.set(theme, entry);
        this.show({ ...entry, renderId: ++this.renderSeq, theme });
        this.host.log.info(`Opened ${this.uri.fsPath || this.uri.toString()} (${theme}) from the cache in ${Date.now() - started} ms`);
        return;
      }
    }
    const renderId = ++this.renderSeq;
    this.post({ type: 'rendering' });
    try {
      const result = await this.host.renderer.render({ uri: this.uri, text, kind: this.kind }, theme);
      if (this.disposed) return;
      const rendered: ShownPdf = { key, pdf: result.pdf, warnings: result.warnings };
      this.cache.set(theme, rendered);
      for (const [t, entry] of this.cache) if (entry.key !== key && t !== theme) this.cache.delete(t);
      this.show({ ...rendered, renderId, theme });
      const timings = Object.entries(result.timings)
        .map(([k, v]) => `${k} ${v} ms`)
        .join(', ');
      this.host.log.info(`Rendered ${this.uri.fsPath || this.uri.toString()} (${theme}, ${result.pdf.byteLength} bytes): ${timings}`);
      for (const w of result.warnings) this.host.log.warn(`${this.fileName}: ${w}`);
      if (settings.cacheDays > 0 && result.remoteFailures === 0) {
        this.host.pdfCache
          .put(this.cacheKey, theme, key, result.pdf, result.deps, result.warnings)
          .catch((err: unknown) => this.host.log.warn(`Could not cache the PDF: ${String(err)}`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.log.error(`Rendering ${this.uri.toString()} failed: ${message}`);
      this.post({ type: 'renderError', message, firstRender: !this.shown });
      if (!(err instanceof RenderError && err.reported)) {
        void vscode.window.showErrorMessage(`Document Viewer: converting ${this.fileName} failed. ${message}`, 'Show Log').then((choice) => {
          if (choice) this.host.log.show(true);
        });
      }
    }
  }

  private async statPath(path: string): Promise<{ size: number; mtime: number } | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(this.uri.with({ path, query: '', fragment: '' }));
      return { size: stat.size, mtime: stat.mtime };
    } catch {
      return undefined;
    }
  }

  private show(rendered: ShownPdf & { renderId: number; theme: PageTheme }): void {
    rendered.pdf = plainBytes(rendered.pdf);
    this.shown = rendered;
    this.post({
      type: 'pdf',
      data: rendered.pdf,
      renderId: rendered.renderId,
      theme: rendered.theme,
      warnings: rendered.warnings.map((message) => ({ message })),
    });
  }

  /** Watches the file itself, so changes made outside VS Code's editors show up too. */
  private watchFile(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const name = this.fileName;
    if (!name) return;
    try {
      const folder = vscode.Uri.joinPath(this.uri, '..');
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, globEscape(name)));
      const changed = () => {
        if (this.kind === 'pdf') {
          this.scheduleRender(400);
          return;
        }
        // Open documents are followed through their editor buffer (see PreviewManager).
        const open = vscode.workspace.textDocuments.some((d) => d.uri.toString() === this.uri.toString());
        if (!open && readSettings().renderOnSave) this.scheduleRender(600);
      };
      watcher.onDidChange(changed);
      watcher.onDidCreate(changed);
      watcher.onDidDelete(changed);
      this.watcher = watcher;
    } catch (err) {
      this.host.log.warn(`Could not watch ${this.uri.toString()}: ${String(err)}`);
    }
  }

  private async applyAnchors(renderId: number, results: AnchorResult[]): Promise<void> {
    if (this.shown?.renderId !== renderId) return;
    const byId = new Map(results.map((r) => [r.id, r]));
    const record = await this.host.store.get(this.ref);
    const changed = record.highlights.some((h) => {
      const r = byId.get(h.id);
      if (!r) return false;
      const pos = h.target.selector[1];
      return (
        r.status !== h.status ||
        (r.start !== undefined && (r.start !== pos.start || r.end !== pos.end)) ||
        (r.pages !== undefined && JSON.stringify(r.pages) !== JSON.stringify(h.target.hints.pages))
      );
    });
    if (!changed) return;
    await this.host.store.update(this.ref, (rec) => {
      for (const h of rec.highlights) {
        const r = byId.get(h.id);
        if (!r) continue;
        h.status = r.status;
        if (r.status === 'anchored' && r.start !== undefined && r.end !== undefined) {
          h.target.selector[1] = { type: 'TextPositionSelector', start: r.start, end: r.end };
        }
        if (r.pages) h.target.hints.pages = r.pages;
        if (r.textModelHash) h.target.hints.textModelHash = r.textModelHash;
      }
    });
  }

  // ---------- Commands ----------

  async setTheme(theme: PageTheme): Promise<void> {
    if (theme === this.theme) return;
    this.theme = theme;
    this.post({ type: 'theme', theme });
    // PDF files are recolored by the viewer; converted documents are rendered again.
    if (this.kind !== 'pdf') await this.requestRender();
  }

  zoom(action: 'in' | 'out' | 'reset'): void {
    this.post({ type: 'zoom', action });
  }

  toggleList(): void {
    this.post({ type: 'toggleList' });
  }

  toggleTool(): void {
    this.post({ type: 'toggleTool' });
  }

  toggleDrawing(): void {
    this.post({ type: 'toggleDrawing' });
  }

  toggleText(): void {
    this.post({ type: 'toggleText' });
  }

  undo(): void {
    this.post({ type: 'undo' });
  }

  redo(): void {
    this.post({ type: 'redo' });
  }

  marker(action: 'place' | 'goto' | 'remove'): void {
    this.post({ type: 'marker', action });
  }

  /** Deletes every highlight through the viewer, so it is one undoable step. */
  deleteAllHighlights(): void {
    this.post({ type: 'deleteAll' });
  }

  /** Deletes every drawing ('ink') or text box ('text') through the viewer, so it is one undoable step. */
  deleteAllDrawings(kind: 'ink' | 'text'): void {
    this.post({ type: 'deleteAllDrawings', kind });
  }

  async reloadHighlights(): Promise<void> {
    const record = await this.host.store.reload(this.ref);
    this.post({ type: 'highlights', highlights: record.highlights, marker: record.marker ?? null, drawings: record.drawings });
  }

  reveal(preserveFocus = false): void {
    this.panel.reveal(this.panel.viewColumn, preserveFocus);
  }

  /** Called after a rename/move of the document. */
  setUri(uri: vscode.Uri): void {
    this.uriValue = uri;
    if (this.kind !== 'pdf') this.panel.title = panelTitle(uri);
    this.watchFile();
    this.post({ type: 'document', fileName: this.fileName, uri: uri.toString() });
  }

  private sourceGroups(): vscode.TabGroup[] {
    const target = this.uri.toString();
    return vscode.window.tabGroups.all.filter((g) =>
      g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === target),
    );
  }

  isFullView(): boolean {
    if (this.kind === 'pdf') return true;
    const groups = this.sourceGroups();
    if (groups.length > 0) return groups.some((g) => g.viewColumn === this.panel.viewColumn);
    return vscode.window.tabGroups.all.length === 1;
  }

  /** Moves the preview between "next to the source editor" and "in the source editor's group". */
  toggleFullView(): void {
    if (this.kind === 'pdf') return;
    const groups = this.sourceGroups();
    const column = this.panel.viewColumn;
    this.pinAfterMove = true;
    if (groups.length > 0) {
      const sameGroup = groups.find((g) => g.viewColumn === column);
      if (sameGroup) this.panel.reveal(vscode.ViewColumn.Beside, false);
      else this.panel.reveal(groups[0].viewColumn, false);
    } else {
      this.panel.reveal(vscode.window.tabGroups.all.length > 1 ? vscode.ViewColumn.One : vscode.ViewColumn.Beside, false);
    }
  }

  async showSource(): Promise<void> {
    if (this.kind === 'pdf') return;
    const group = this.sourceGroups()[0];
    await vscode.window.showTextDocument(this.uri, {
      viewColumn: group?.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: false,
    });
  }

  private async runViewerCommand(command: string): Promise<void> {
    switch (command) {
      case 'refresh':
        this.cache.clear();
        await this.requestRender(true);
        break;
      case 'toggleFullView':
        this.toggleFullView();
        break;
      case 'download':
        await this.download(true);
        break;
      case 'downloadWithoutHighlights':
        await this.download(false);
        break;
      case 'toggleTheme':
        this.host.toggleTheme();
        break;
      case 'showLog':
        this.host.log.show(true);
        break;
      case 'showSource':
        await this.showSource();
        break;
      case 'deleteAllDrawings':
        await this.host.deleteAllDrawings(this, 'ink');
        break;
      case 'deleteAllTextBoxes':
        await this.host.deleteAllDrawings(this, 'text');
        break;
    }
  }

  private async openLink(href: string): Promise<void> {
    let target: vscode.Uri;
    try {
      target = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (['http', 'https', 'mailto'].includes(target.scheme)) {
      await vscode.env.openExternal(target);
      return;
    }
    if (target.scheme === 'file') {
      // Links are written as file:///… so they work in other readers; map them back for remote documents.
      const local = this.uri.scheme === 'file' ? target : this.uri.with({ path: target.path, query: '', fragment: '' });
      const fragment = target.fragment;
      const fileUri = local.with({ fragment: '' });
      let isDirectory = false;
      try {
        isDirectory = ((await vscode.workspace.fs.stat(fileUri)).type & vscode.FileType.Directory) !== 0;
      } catch {
        void vscode.window.showWarningMessage(`Document Viewer: the linked file does not exist: ${fileUri.fsPath || fileUri.toString()}`);
        return;
      }
      if (isDirectory) {
        await vscode.commands.executeCommand('revealInExplorer', fileUri);
        return;
      }
      if (PDF_EXT.test(fileUri.path)) {
        await vscode.commands.executeCommand('vscode.open', fileUri);
      } else if (MARKDOWN_EXT.test(fileUri.path) || !/\.(png|jpe?g|gif|svg|webp|zip|docx?|xlsx?|pptx?)$/i.test(fileUri.path)) {
        const editor = await vscode.window.showTextDocument(fileUri, { preview: false, viewColumn: this.sourceGroups()[0]?.viewColumn });
        if (fragment && MARKDOWN_EXT.test(fileUri.path)) this.revealHeading(editor, fragment);
      } else {
        await vscode.commands.executeCommand('vscode.open', fileUri);
      }
      return;
    }
    if (target.scheme !== 'command' && target.scheme !== 'javascript' && target.scheme !== 'vbscript') {
      await vscode.env.openExternal(target);
    }
  }

  /** Moves the cursor to the heading whose GitHub-style slug matches `fragment`. */
  private revealHeading(editor: vscode.TextEditor, fragment: string): void {
    const wanted = decodeURIComponent(fragment).toLowerCase();
    const seen = new Map<string, number>();
    const doc = editor.document;
    let inFence = false;
    for (let line = 0; line < doc.lineCount; line++) {
      const text = doc.lineAt(line).text;
      if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
      if (inFence) continue;
      const match = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
      if (!match) continue;
      const base = match[1]
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
        .replace(/ /g, '-');
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const slug = count === 0 ? base : `${base}-${count}`;
      if (slug === wanted) {
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
        return;
      }
    }
  }

  // ---------- Download ----------

  private requestExportData(): Promise<ExportReply> {
    const requestId = ++this.exportSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.exportWaiters.delete(requestId);
        reject(new Error('The viewer did not answer in time.'));
      }, EXPORT_TIMEOUT_MS);
      this.exportWaiters.set(requestId, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.post({ type: 'requestExport', requestId });
    });
  }

  private suggestedFileName(withAnnotations: boolean): string {
    if (this.kind === 'pdf') {
      const base = this.fileName.replace(PDF_EXT, '') || 'document';
      return `${base} (${withAnnotations ? 'annotated' : 'copy'}).pdf`;
    }
    const base = this.fileName.replace(this.kind === 'text' ? TEXT_EXT : MARKDOWN_EXT, '') || 'document';
    return `${base}.pdf`;
  }

  /** The PDF to download, before highlights are added: the file itself, or the light render. */
  private async downloadBytes(): Promise<Uint8Array> {
    if (this.kind === 'pdf') return vscode.workspace.fs.readFile(this.uri);
    const text = await this.readText();
    // Bring the viewer up to date first, so highlight positions match the exported PDF.
    if (this.shown?.key !== this.sourceHash(text, this.theme)) await this.requestRender();
    const key = this.sourceHash(text, 'light');
    let light = this.cache.get('light');
    if (!light || light.key !== key) {
      const hit =
        readSettings().cacheDays > 0
          ? await this.host.pdfCache.get(this.cacheKey, 'light', key, (path) => this.statPath(path)).catch(() => undefined)
          : undefined;
      if (hit) {
        light = { key, pdf: hit.pdf, warnings: hit.warnings };
      } else {
        const result = await this.host.renderer.render({ uri: this.uri, text, kind: this.kind as 'markdown' | 'text' }, 'light');
        light = { key, pdf: result.pdf, warnings: result.warnings };
      }
      this.cache.set('light', light);
    }
    return light.pdf;
  }

  /** Downloads the PDF, by default with highlights, notes, drawings and text boxes as PDF annotations. */
  async download(withAnnotations: boolean): Promise<void> {
    const folder = await downloadsFolder();
    const separator = folder.endsWith('\\') || folder.endsWith('/') ? '' : process.platform === 'win32' ? '\\' : '/';
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${folder}${separator}${this.suggestedFileName(withAnnotations)}`),
      filters: { PDF: ['pdf'] },
      saveLabel: withAnnotations ? 'Download PDF' : 'Download without Annotations',
      title: withAnnotations ? 'Download PDF (with highlights, notes, drawings and text)' : 'Download PDF without annotations',
    });
    if (!target) return;
    if (target.toString().toLowerCase() === this.uri.toString().toLowerCase()) {
      void vscode.window.showErrorMessage('Document Viewer will not overwrite the document you are viewing. Choose another name.');
      return;
    }
    let skipped = 0;
    let included = 0;
    let drawn = 0;
    let texts = 0;
    let skippedDrawings = 0;
    let replacedChars = 0;
    let decrypted = false;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Document Viewer: preparing the PDF…' },
        async () => {
          let bytes = await this.downloadBytes();
          if (withAnnotations) {
            const data = await this.requestExportData();
            if (data.error) throw new Error(data.error);
            skipped = data.orphaned;
            included = data.highlights.length;
            const drawings = (Array.isArray(data.drawings) ? data.drawings : []).map((d) => sanitizeDrawing(d)).filter((d): d is Drawing => d !== undefined);
            const textLayouts = (Array.isArray(data.textLayouts) ? data.textLayouts : []).map(sanitizeTextLayout).filter((l): l is TextLayout => l !== undefined);
            texts = drawings.filter(isTextDrawing).length;
            drawn = drawings.length - texts;
            skippedDrawings = data.skippedDrawings;
            if (included + drawings.length > 0) {
              decrypted = this.kind === 'pdf' && data.password !== undefined;
              const result = await this.host.renderer.annotate(bytes, { highlights: data.highlights, drawings, textLayouts }, data.password);
              bytes = result.pdf;
              replacedChars = result.replacedChars;
            }
          }
          await writeDownloadedPdf(target, bytes);
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.log.error(`Download failed: ${message}`);
      void vscode.window.showErrorMessage(`Document Viewer: the download failed. ${message}`, 'Show Log').then((c) => {
        if (c) this.host.log.show(true);
      });
      return;
    }
    const name = target.path.split('/').pop();
    const included_ = [count(included, 'highlight'), count(drawn, 'drawing'), texts > 0 ? count(texts, 'text box', 'text boxes') : ''].filter(Boolean);
    const notes = [
      withAnnotations ? `${listOf(included_)} included` : 'without annotations',
      skipped > 0 ? `${skipped} orphaned highlight${skipped === 1 ? ' was' : 's were'} left out` : '',
      skippedDrawings > 0 ? `${count(skippedDrawings, 'drawing')} on pages the document no longer has ${skippedDrawings === 1 ? 'was' : 'were'} left out` : '',
      replacedChars > 0
        ? `${count(replacedChars, 'character')} in text boxes ${replacedChars === 1 ? 'is' : 'are'} not in the PDF's standard font and ${replacedChars === 1 ? 'shows' : 'show'} as "?"`
        : '',
      decrypted ? 'the copy is not password-protected' : '',
    ].filter(Boolean);
    const choice = await vscode.window.showInformationMessage(`Saved ${name} (${notes.join('; ')}).`, 'Open PDF', 'Show in Folder');
    if (choice === 'Open PDF') await vscode.env.openExternal(target);
    if (choice === 'Show in Folder') await vscode.commands.executeCommand('revealFileInOS', target);
  }

  // ---------- Lifecycle ----------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.renderTimer);
    for (const waiter of this.exportWaiters.values()) waiter({ highlights: [], orphaned: 0, drawings: [], skippedDrawings: 0, error: 'The viewer was closed.' });
    this.exportWaiters.clear();
    this.watcher?.dispose();
    this.host.disposed(this);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Test/diagnostic helper: highlights currently stored for this document. */
  async storedHighlights(): Promise<Highlight[]> {
    return (await this.host.store.get(this.ref)).highlights;
  }

  /** Drawings currently stored for this document. */
  async storedDrawings(): Promise<Drawing[]> {
    return (await this.host.store.get(this.ref)).drawings;
  }
}
