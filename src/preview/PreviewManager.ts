// Owns all viewers: one per document. Markdown and text files get a preview panel next to (or in
// place of) their editor; PDF files open in a custom editor. Also: panel restore after a restart,
// re-render on save, highlight migration when files are renamed, and the PDF cache housekeeping.
import * as vscode from 'vscode';
import type { PdfCache } from '../cache/PdfCache';
import type { WebviewPersistedState } from '../shared/messages';
import { DEFAULT_INK, MAX_RECENT_COLORS, normalizeHex, sanitizeInk, type HexColor } from '../shared/colors';
import { DEFAULT_DRAW_TOOL, DEFAULT_INK_WIDTH, isDrawTool, isInkWidth, isTextDrawing, sanitizeTextStyle } from '../shared/drawings';
import { CUSTOM_SOUND_EXTENSIONS, type SoundRequest } from '../shared/sounds';
import { DEFAULT_COLOR, isHighlightColor, type DocumentKind, type PageTheme } from '../shared/types';
import type { DocumentRef, HighlightStore } from '../store/HighlightStore';
import { SoundLibrary, type SoundFile } from '../store/SoundLibrary';
import { RENDER_SETTINGS, SECTION, readSettings } from '../util/settings';
import { duplicateOf, hintFor } from './copyHints';
import { MAX_CACHE_BYTES, PreviewPanel, kindOf, panelTitle, type PanelHost, type UiState } from './PreviewPanel';
import type { RenderService } from './RenderService';
import { SoundCoordinator } from './SoundCoordinator';
import { PDF_VIEW_TYPE, VIEW_TYPE, availableSounds, webviewOptions } from './webviewHtml';

const UI_STATE_KEY = 'markdownPdfViewer.ui';
const SOUND_STATE_KEY = 'markdownPdfViewer.sound';
const FOCUS_CONTEXT = 'markdownPdfViewer.viewerFocused';
const SOUND_CONTEXT = 'markdownPdfViewer.soundPlaying';
const CACHE_PRUNE_DELAY_MS = 20_000;

/** PDF files open in the viewer as a (read-only) custom editor. */
class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly manager: PreviewManager) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    this.manager.attachPdf(panel, document.uri);
  }
}

export class PreviewManager implements vscode.Disposable, PanelHost {
  private readonly panels = new Map<string, PreviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private activePanel?: PreviewPanel;
  private focusedPanel?: PreviewPanel;
  private ui: UiState;
  /** The "how to draw" tip was shown in this VS Code session. */
  private drawHintShown = false;
  /** The "how to add text" tip was shown in this VS Code session. */
  private textHintShown = false;
  private eraseHintShown = false;
  private pruneTimer?: ReturnType<typeof setTimeout>;
  /** Reading sounds: shared by all viewers, played by one of them. */
  readonly sounds: SoundCoordinator<PreviewPanel>;
  /** The reader's own reading sounds (copies in the extension's storage). */
  readonly soundLibrary: SoundLibrary;
  readonly customSoundsUri: vscode.Uri;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly log: vscode.LogOutputChannel,
    readonly store: HighlightStore,
    readonly renderer: RenderService,
    readonly pdfCache: PdfCache,
  ) {
    const saved = context.globalState.get<Partial<UiState>>(UI_STATE_KEY) ?? {};
    this.ui = {
      color: isHighlightColor(saved.color) ? saved.color : DEFAULT_COLOR,
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      toolActive: saved.toolActive === true,
      listOpen: saved.listOpen === true,
      drawTool: isDrawTool(saved.drawTool) ? saved.drawTool : DEFAULT_DRAW_TOOL,
      inkColor: sanitizeInk(saved.inkColor) ?? DEFAULT_INK,
      inkWidth: isInkWidth(saved.inkWidth) ? saved.inkWidth : DEFAULT_INK_WIDTH,
      textStyle: sanitizeTextStyle(saved.textStyle),
      recentColors: (Array.isArray(saved.recentColors) ? saved.recentColors : [])
        .map(normalizeHex)
        .filter((c): c is HexColor => c !== undefined)
        .slice(0, MAX_RECENT_COLORS),
    };
    void vscode.commands.executeCommand('setContext', FOCUS_CONTEXT, false);
    // A file: URI on purpose: globalStorageUri can have VS Code's own scheme (vscode-userdata:),
    // and a webview only serves files whose URI has the same scheme as one of its resource roots.
    this.customSoundsUri = vscode.Uri.file(vscode.Uri.joinPath(context.globalStorageUri, 'sounds').fsPath);
    this.soundLibrary = new SoundLibrary(this.customSoundsUri.fsPath, log);
    this.sounds = new SoundCoordinator<PreviewPanel>(
      {
        get: () => context.globalState.get(SOUND_STATE_KEY),
        set: (value) => void context.globalState.update(SOUND_STATE_KEY, value),
      },
      () => this.panels.values(),
      () => [
        ...availableSounds(context.extensionUri).map((s) => ({ id: s.id, category: s.category })),
        ...this.soundLibrary.sounds.map((s) => ({ id: s.id, category: 'custom' as const })),
      ],
      (playing) => void vscode.commands.executeCommand('setContext', SOUND_CONTEXT, playing),
    );
    void vscode.commands.executeCommand('setContext', SOUND_CONTEXT, false);
    void this.refreshCustomSounds(true);

    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: WebviewPersistedState | undefined) => this.restore(panel, state),
      }),
      vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, new PdfEditorProvider(this), {
        webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
        supportsMultipleEditorsPerDocument: false,
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (readSettings().renderOnSave) this.panels.get(doc.uri.toString())?.scheduleRender(300);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const panel = this.panels.get(e.document.uri.toString());
        if (!panel) return;
        // A clean document changed: it was reloaded from disk (git checkout, external editor).
        if (!e.document.isDirty && e.contentChanges.length > 0 && readSettings().renderOnSave) panel.scheduleRender(500);
        this.noteCopies(panel, e);
      }),
      vscode.workspace.onDidRenameFiles((e) => void this.onRename(e)),
      renderer.onDidFixBrowser(() => {
        for (const panel of this.panels.values()) void panel.requestRender();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (RENDER_SETTINGS.some((s) => e.affectsConfiguration(s))) {
          for (const panel of this.panels.values()) void panel.requestRender();
        }
        if (e.affectsConfiguration(`${SECTION}.cacheDays`)) this.schedulePrune(2_000);
        if (e.affectsConfiguration(`${SECTION}.textSnapshots`) && !readSettings().textSnapshots) {
          void this.store.removeAllSnapshots().catch((err: unknown) => this.log.warn(`Could not delete the text snapshots: ${String(err)}`));
        }
      }),
    );
    this.schedulePrune(CACHE_PRUNE_DELAY_MS);
  }

  get extensionUri(): vscode.Uri {
    return this.context.extensionUri;
  }

  get extensionVersion(): string {
    return String((this.context.extension.packageJSON as { version?: string }).version ?? '0');
  }

  /**
   * A block duplicated next to itself (Copy Line Up/Down, a paste above or below the original):
   * tells the viewer which of the two is the copy, from where the cursor is a moment later.
   */
  private noteCopies(panel: PreviewPanel, e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length !== 1) return;
    const change = e.contentChanges[0];
    const duplicate = duplicateOf(e.document.getText(), { offset: change.rangeOffset, text: change.text, removed: change.rangeLength });
    if (!duplicate) return;
    const version = e.document.version;
    setTimeout(() => {
      if (panel.isDisposed || e.document.version !== version) return;
      const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === e.document && ed === vscode.window.activeTextEditor) ?? vscode.window.visibleTextEditors.find((ed) => ed.document === e.document);
      panel.addCopyHint(hintFor(duplicate, editor ? e.document.offsetAt(editor.selection.active) : undefined));
    }, 40);
  }

  refFor(uri: vscode.Uri): DocumentRef {
    return { uri: uri.toString(), scheme: uri.scheme, fsPath: uri.scheme === 'file' ? uri.fsPath : undefined };
  }

  // ---------- UI state shared by all viewers ----------

  uiState(): UiState {
    return { ...this.ui };
  }

  updateUiState(patch: Partial<UiState>): void {
    this.ui = { ...this.ui, ...patch };
    void this.context.globalState.update(UI_STATE_KEY, this.ui);
  }

  drawHint(shown?: boolean): boolean {
    if (shown) this.drawHintShown = true;
    return !this.drawHintShown;
  }

  eraseHint(shown?: boolean): boolean {
    if (shown) this.eraseHintShown = true;
    return !this.eraseHintShown;
  }

  textHint(shown?: boolean): boolean {
    if (shown) this.textHintShown = true;
    return !this.textHintShown;
  }

  toggleTheme(): void {
    const theme: PageTheme = this.ui.theme === 'dark' ? 'light' : 'dark';
    this.updateUiState({ theme });
    for (const panel of this.panels.values()) void panel.setTheme(theme);
  }

  // ---------- Panel bookkeeping ----------

  focusChanged(panel: PreviewPanel, focused: boolean): void {
    if (focused) {
      this.focusedPanel = panel;
      this.activePanel = panel;
    } else if (this.focusedPanel === panel) {
      this.focusedPanel = undefined;
    }
    void vscode.commands.executeCommand('setContext', FOCUS_CONTEXT, this.focusedPanel !== undefined);
  }

  viewStateChanged(panel: PreviewPanel): void {
    if (panel.panel.active) this.activePanel = panel;
    else if (this.activePanel === panel) this.activePanel = undefined;
    if (!panel.panel.active && this.focusedPanel === panel) this.focusChanged(panel, false);
  }

  disposed(panel: PreviewPanel): void {
    for (const [key, value] of this.panels) if (value === panel) this.panels.delete(key);
    if (this.activePanel === panel) this.activePanel = undefined;
    if (this.focusedPanel === panel) this.focusChanged(panel, false);
    if (!this.panels.has(panel.uri.toString())) this.store.evict(this.refFor(panel.uri));
    // A sound playing in this viewer keeps going in another open viewer.
    this.sounds.viewerClosed(panel, this.current());
  }

  /** The viewer a command applies to: the active one, else the only one. */
  current(): PreviewPanel | undefined {
    if (this.activePanel && !this.activePanel.isDisposed) return this.activePanel;
    const visible = [...this.panels.values()].filter((p) => p.panel.active);
    if (visible.length === 1) return visible[0];
    return this.panels.size === 1 ? [...this.panels.values()][0] : undefined;
  }

  // ---------- Opening ----------

  private sourceFromContext(arg?: unknown): { uri: vscode.Uri; kind: DocumentKind } | undefined {
    if (arg instanceof vscode.Uri) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === arg.toString());
      const kind = kindOf(arg, doc?.languageId);
      return kind ? { uri: arg, kind } : undefined;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const kind = kindOf(editor.document.uri, editor.document.languageId);
      if (kind && kind !== 'pdf') return { uri: editor.document.uri, kind };
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const tabUri = tab?.input instanceof vscode.TabInputText || tab?.input instanceof vscode.TabInputCustom ? tab.input.uri : undefined;
    if (tabUri) {
      const kind = kindOf(tabUri);
      if (kind) return { uri: tabUri, kind };
    }
    const current = this.current();
    return current ? { uri: current.uri, kind: current.kind } : undefined;
  }

  async open(arg: unknown, mode: 'side' | 'full'): Promise<void> {
    const source = this.sourceFromContext(arg);
    if (!source) {
      void vscode.window.showInformationMessage('Open a Markdown, text (.txt) or PDF file first, then run this command again.');
      return;
    }
    const existing = this.panels.get(source.uri.toString());
    if (existing) {
      existing.reveal(false);
      return;
    }
    if (source.kind === 'pdf') {
      await vscode.commands.executeCommand('vscode.openWith', source.uri, PDF_VIEW_TYPE, mode === 'side' ? vscode.ViewColumn.Beside : undefined);
      return;
    }
    let column: vscode.ViewColumn;
    if (mode === 'side') {
      column = vscode.ViewColumn.Beside;
    } else {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === source.uri.toString());
      column = editor?.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn ?? vscode.ViewColumn.Active;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      panelTitle(source.uri),
      { viewColumn: column, preserveFocus: false },
      webviewOptions(this.context.extensionUri, this.customSoundsUri),
    );
    this.track(new PreviewPanel(this, panel, source.uri, source.kind));
  }

  /** Called by the custom editor provider when VS Code opens a PDF in the viewer. */
  attachPdf(panel: vscode.WebviewPanel, uri: vscode.Uri): void {
    this.track(new PreviewPanel(this, panel, uri, 'pdf'));
  }

  private track(preview: PreviewPanel): void {
    this.panels.set(preview.uri.toString(), preview);
    if (preview.panel.active) this.activePanel = preview;
  }

  private async restore(panel: vscode.WebviewPanel, state: WebviewPersistedState | undefined): Promise<void> {
    if (!state?.uri) {
      panel.dispose();
      return;
    }
    const uri = vscode.Uri.parse(state.uri);
    const kind = kindOf(uri) ?? 'markdown';
    if (kind === 'pdf' || this.panels.has(uri.toString())) {
      panel.dispose();
      return;
    }
    this.track(new PreviewPanel(this, panel, uri, kind));
  }

  // ---------- Renames ----------

  private async onRename(e: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of e.files) {
      try {
        let isDirectory = false;
        try {
          isDirectory = ((await vscode.workspace.fs.stat(newUri)).type & vscode.FileType.Directory) !== 0;
        } catch {
          // The target vanished again; nothing to do.
          continue;
        }
        if (isDirectory) {
          const moved = await this.store.migrateFolder(this.refFor(oldUri), this.refFor(newUri), (path) =>
            this.refFor(newUri.scheme === 'file' ? vscode.Uri.file(path) : vscode.Uri.parse(path)),
          );
          if (moved > 0) this.log.info(`Moved highlight data of ${moved} file(s) from ${oldUri.toString()} to ${newUri.toString()}`);
          const prefix = `${oldUri.toString()}/`;
          for (const [key, panel] of [...this.panels]) {
            if (!key.startsWith(prefix)) continue;
            const moved = vscode.Uri.parse(`${newUri.toString()}/${key.slice(prefix.length)}`);
            this.rekey(key, panel, moved);
          }
        } else {
          await this.store.migrate(this.refFor(oldUri), this.refFor(newUri));
          const panel = this.panels.get(oldUri.toString());
          if (panel) this.rekey(oldUri.toString(), panel, newUri);
          // VS Code reopens PDF editors under the new name; that viewer may have loaded before the move.
          else void this.panels.get(newUri.toString())?.reloadHighlights();
        }
      } catch (err) {
        this.log.error(`Could not move highlight data for ${oldUri.toString()}: ${String(err)}`);
        void vscode.window.showWarningMessage(
          `Document Viewer could not move the highlights of ${oldUri.path.split('/').pop()} to its new name. Use "Reattach Highlights from Another File…" to recover them.`,
        );
      }
    }
  }

  private rekey(oldKey: string, panel: PreviewPanel, uri: vscode.Uri): void {
    const existing = this.panels.get(uri.toString());
    if (existing && existing !== panel) {
      // A new viewer already shows the renamed file; refresh its highlights instead.
      void existing.reloadHighlights();
      return;
    }
    this.panels.delete(oldKey);
    panel.setUri(uri);
    this.panels.set(uri.toString(), panel);
  }

  // ---------- Highlight data commands ----------

  async reattach(): Promise<void> {
    const panel = this.current();
    if (!panel) return;
    const records = await this.store.list();
    const target = panel.uri.toString();
    const candidates: { record: (typeof records)[number]['record']; exists: boolean }[] = [];
    for (const { record } of records) {
      if (record.uri === target || (record.highlights.length === 0 && record.drawings.length === 0)) continue;
      let exists = true;
      try {
        await vscode.workspace.fs.stat(vscode.Uri.parse(record.uri));
      } catch {
        exists = false;
      }
      candidates.push({ record, exists });
    }
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('There are no other files with stored highlights, drawings or text boxes.');
      return;
    }
    const plural = (n: number, noun: string, many = `${noun}s`) => `${n} ${n === 1 ? noun : many}`;
    const contents = (record: (typeof records)[number]['record']) => {
      const texts = record.drawings.filter(isTextDrawing).length;
      const inks = record.drawings.length - texts;
      return [
        record.highlights.length > 0 || record.drawings.length === 0 ? plural(record.highlights.length, 'highlight') : '',
        inks > 0 ? plural(inks, 'drawing') : '',
        texts > 0 ? plural(texts, 'text box', 'text boxes') : '',
      ]
        .filter(Boolean)
        .join(', ');
    };
    candidates.sort((a, b) => Number(a.exists) - Number(b.exists) || b.record.updatedAt.localeCompare(a.record.updatedAt));
    const pick = await vscode.window.showQuickPick(
      candidates.map(({ record, exists }) => {
        const uri = vscode.Uri.parse(record.uri);
        return {
          label: `${exists ? '$(file)' : '$(warning)'} ${uri.path.split('/').pop()}`,
          description: record.fsPath ?? uri.toString(),
          detail: `${contents(record)} · last changed ${new Date(record.updatedAt).toLocaleString()}${exists ? '' : ' · file no longer exists'}`,
          record,
        };
      }),
      {
        title: `Reattach highlights, drawings and text boxes to ${panel.uri.path.split('/').pop()}`,
        placeHolder: 'Pick the file whose highlights, drawings and text boxes should be copied to this file (files that no longer exist are listed first)',
        matchOnDescription: true,
      },
    );
    if (!pick) return;
    const added = await this.store.mergeInto(pick.record, this.refFor(panel.uri));
    await this.store.flush();
    await panel.reloadHighlights();
    const copied = [plural(added.highlights, 'highlight'), added.drawings > 0 ? plural(added.drawings, 'drawing') : ''].filter(Boolean).join(' and ');
    void vscode.window.showInformationMessage(
      `Copied ${copied}. Highlights whose text is not in this file are listed as orphaned; drawings and text boxes stay at their place on the page.`,
    );
  }

  async deleteAll(): Promise<void> {
    const panel = this.current();
    if (!panel) return;
    const count = (await panel.storedHighlights()).length;
    if (count === 0) {
      void vscode.window.showInformationMessage('This file has no highlights.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete all ${count} highlight${count === 1 ? '' : 's'} of ${panel.uri.path.split('/').pop()}?`,
      { modal: true, detail: 'Their notes are deleted too. You can bring them back with Ctrl+Z in the viewer.' },
      'Delete All',
    );
    if (answer !== 'Delete All') return;
    panel.deleteAllHighlights();
  }

  /**
   * Commands and the list's buttons: confirm, then delete every drawing ('ink') or every text box
   * ('text') of the file (undoable in the viewer).
   */
  async deleteAllDrawings(panel = this.current(), kind: 'ink' | 'text' = 'ink'): Promise<void> {
    if (!panel || panel.isDisposed) return;
    const count = (await panel.storedDrawings()).filter((d) => isTextDrawing(d) === (kind === 'text')).length;
    const noun = kind === 'text' ? (count === 1 ? 'text box' : 'text boxes') : count === 1 ? 'drawing' : 'drawings';
    if (count === 0) {
      void vscode.window.showInformationMessage(kind === 'text' ? 'This file has no text boxes.' : 'This file has no drawings.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete all ${count} ${noun} of ${panel.uri.path.split('/').pop()}?`,
      { modal: true, detail: 'You can bring them back with Ctrl+Z in the viewer.' },
      'Delete All',
    );
    if (answer !== 'Delete All' || panel.isDisposed) return;
    panel.deleteAllDrawings(kind);
  }

  async revealDataFolder(): Promise<void> {
    await this.store.ensureDirectory();
    const folder = vscode.Uri.file(this.store.directory);
    await vscode.commands.executeCommand('revealFileInOS', folder);
  }

  // ---------- PDF cache ----------

  private schedulePrune(delayMs: number): void {
    clearTimeout(this.pruneTimer);
    this.pruneTimer = setTimeout(() => void this.pruneCache(), delayMs);
  }

  private async pruneCache(): Promise<void> {
    try {
      const days = readSettings().cacheDays;
      const result = await this.pdfCache.prune(days, MAX_CACHE_BYTES);
      if (result.removed > 0 || result.kept > 0) {
        this.log.info(
          `PDF cache: ${result.kept} file(s), ${(result.bytes / 1048576).toFixed(1)} MB kept; ${result.removed} removed (unused for ${days} day(s) or over the size limit)`,
        );
      }
    } catch (err) {
      this.log.warn(`Cleaning the PDF cache failed: ${String(err)}`);
    }
  }

  // ---------- Reading sounds ----------

  /** Command: pause the reading sound, or play it (in the current viewer when it can start sound). */
  toggleSounds(): void {
    if (this.sounds.isPlaying) {
      this.sounds.pause();
      return;
    }
    if (!this.sounds.toggle(this.current())) {
      void vscode.window.showInformationMessage('Open a document in the viewer first (a Markdown, text or PDF file), then play a reading sound.');
    }
  }

  /** A request from a viewer's reading sounds panel. */
  soundRequest(panel: PreviewPanel, request: SoundRequest): void {
    switch (request.action) {
      case 'add':
        void this.addSounds(panel);
        break;
      case 'rename':
        this.soundLibrary.renameSound(request.sound, request.name).then(
          (changed) => changed && this.customSoundsChanged(),
          (err: unknown) => this.soundError('Renaming the sound failed', err),
        );
        break;
      case 'remove':
        void this.removeSound(request.sound);
        break;
      case 'measured':
        this.soundLibrary.setGain(request.sound, request.gainDb).then(
          (changed) => changed && this.broadcastCustomSounds(),
          (err: unknown) => this.log.warn(`Saving the level of a reading sound failed: ${String(err)}`),
        );
        break;
      case 'unplayable':
        void this.dropUnplayable(request.sound, request.message);
        break;
      case 'refresh':
        void this.refreshCustomSounds(false);
        break;
      case 'failed':
        this.log.warn(`Reading sound "${request.sound}": ${request.message}`);
        this.sounds.handle(panel, request);
        break;
      default:
        this.sounds.handle(panel, request);
    }
  }

  /** Command and the panel's button: pick audio files and add them as custom reading sounds. */
  async addSounds(panel = this.current()): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      title: 'Add Reading Sounds',
      openLabel: 'Add',
      filters: { 'Audio files (MP3, Ogg Vorbis, WAV, FLAC)': [...CUSTOM_SOUND_EXTENSIONS] },
    });
    if (!picked?.length) return;
    const files: SoundFile[] = [];
    const unreadable: string[] = [];
    for (const uri of picked) {
      const name = uri.path.split('/').pop() || 'sound';
      try {
        const { size } = await vscode.workspace.fs.stat(uri);
        // Files of a remote workspace are read through VS Code; local ones are copied directly.
        files.push(uri.scheme === 'file' ? { name, size, path: uri.fsPath } : { name, size, read: () => Promise.resolve(vscode.workspace.fs.readFile(uri)) });
      } catch (err) {
        unreadable.push(`${name} could not be read (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    let result;
    try {
      result = await this.soundLibrary.add(files);
    } catch (err) {
      this.soundError('Adding the sounds failed', err);
      return;
    }
    const problems = [...unreadable, ...result.skipped.map((s) => `${s.file} ${s.reason}`)];
    if (problems.length > 0) {
      const added = result.added.length;
      void vscode.window.showWarningMessage(
        added > 0 ? `Added ${added} sound${added === 1 ? '' : 's'}. Not added: ${problems.join('; ')}.` : `No sound was added: ${problems.join('; ')}.`,
      );
    }
    if (result.added.length === 0) return;
    this.log.info(`Added reading sound(s): ${result.added.map((r) => `"${r.name}" (${r.source.name})`).join(', ')}`);
    this.customSoundsChanged();
    this.sounds.choose(result.added[0].id);
    // A viewer measures how loud they are (so they play as loud as the built-in sounds) and shows them.
    const target = panel && !panel.isDisposed ? panel : this.current();
    target?.soundsAdded(
      result.added.map((r) => r.id),
      true,
    );
  }

  private async removeSound(id: string): Promise<void> {
    try {
      const removed = await this.soundLibrary.removeSound(id);
      if (!removed) return;
      this.log.info(`Removed reading sound "${removed.name}"`);
      this.customSoundsChanged();
    } catch (err) {
      this.soundError('Removing the sound failed', err);
    }
  }

  /** A sound just added turned out to be undecodable here (Opus, AAC…): take it out again and say why. */
  private async dropUnplayable(id: string, message: string): Promise<void> {
    try {
      const removed = await this.soundLibrary.removeSound(id);
      if (!removed) return;
      this.customSoundsChanged();
      this.log.warn(`Reading sound "${removed.name}" (${removed.source.name}) cannot be played: ${message}`);
      void vscode.window.showWarningMessage(
        `${removed.source.name} can't be played in VS Code (${message}), so it was not added. MP3, Ogg Vorbis, WAV and FLAC files work; Opus and AAC (.m4a) do not.`,
      );
    } catch (err) {
      this.soundError('Removing the sound failed', err);
    }
  }

  /** Reads the custom sounds again (another VS Code window may have changed them). */
  private async refreshCustomSounds(initial: boolean): Promise<void> {
    let changed = false;
    try {
      changed = await this.soundLibrary.reload();
    } catch (err) {
      this.log.warn(`Reading the custom reading sounds failed: ${String(err)}`);
    }
    if (changed) this.broadcastCustomSounds();
    if (changed || initial) this.sounds.catalogChanged();
  }

  /** The custom sounds changed: every viewer gets the new list, and choices of removed sounds move on. */
  private customSoundsChanged(): void {
    this.broadcastCustomSounds();
    this.sounds.catalogChanged();
  }

  private broadcastCustomSounds(): void {
    for (const panel of new Set(this.panels.values())) if (!panel.isDisposed) panel.postCustomSounds();
  }

  private soundError(what: string, err: unknown): void {
    this.log.error(`${what}: ${String(err)}`);
    void vscode.window.showErrorMessage(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }

  async clearCache(): Promise<void> {
    const removed = await this.pdfCache.clear();
    void vscode.window.showInformationMessage(
      removed > 0 ? `Deleted ${removed} cached PDF${removed === 1 ? '' : 's'}. Documents are converted again the next time you open them.` : 'The PDF cache is already empty.',
    );
  }

  dispose(): void {
    clearTimeout(this.pruneTimer);
    this.sounds.dispose();
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
