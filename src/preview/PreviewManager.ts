// Owns all viewers: one per document. Markdown and text files get a preview panel next to (or in
// place of) their editor; PDF files open in a custom editor. Also: panel restore after a restart,
// re-render on save, highlight migration when files are renamed, and the PDF cache housekeeping.
import * as vscode from 'vscode';
import type { PdfCache } from '../cache/PdfCache';
import type { WebviewPersistedState } from '../shared/messages';
import { DEFAULT_COLOR, isHighlightColor, type DocumentKind, type PageTheme } from '../shared/types';
import type { DocumentRef, HighlightStore } from '../store/HighlightStore';
import { RENDER_SETTINGS, SECTION, readSettings } from '../util/settings';
import { MAX_CACHE_BYTES, PreviewPanel, kindOf, panelTitle, type PanelHost, type UiState } from './PreviewPanel';
import type { RenderService } from './RenderService';
import { PDF_VIEW_TYPE, VIEW_TYPE, webviewOptions } from './webviewHtml';

const UI_STATE_KEY = 'markdownPdfViewer.ui';
const FOCUS_CONTEXT = 'markdownPdfViewer.viewerFocused';
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
  private pruneTimer?: ReturnType<typeof setTimeout>;

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
    };
    void vscode.commands.executeCommand('setContext', FOCUS_CONTEXT, false);

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
        // A clean document changed: it was reloaded from disk (git checkout, external editor).
        if (!e.document.isDirty && e.contentChanges.length > 0 && readSettings().renderOnSave) {
          this.panels.get(e.document.uri.toString())?.scheduleRender(500);
        }
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
      webviewOptions(this.context.extensionUri),
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
      if (record.uri === target || record.highlights.length === 0) continue;
      let exists = true;
      try {
        await vscode.workspace.fs.stat(vscode.Uri.parse(record.uri));
      } catch {
        exists = false;
      }
      candidates.push({ record, exists });
    }
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('There are no other files with stored highlights.');
      return;
    }
    candidates.sort((a, b) => Number(a.exists) - Number(b.exists) || b.record.updatedAt.localeCompare(a.record.updatedAt));
    const pick = await vscode.window.showQuickPick(
      candidates.map(({ record, exists }) => {
        const uri = vscode.Uri.parse(record.uri);
        return {
          label: `${exists ? '$(file)' : '$(warning)'} ${uri.path.split('/').pop()}`,
          description: record.fsPath ?? uri.toString(),
          detail: `${record.highlights.length} highlight${record.highlights.length === 1 ? '' : 's'} · last changed ${new Date(record.updatedAt).toLocaleString()}${exists ? '' : ' · file no longer exists'}`,
          record,
        };
      }),
      {
        title: `Reattach highlights to ${panel.uri.path.split('/').pop()}`,
        placeHolder: 'Pick the file whose highlights should be copied to this file (files that no longer exist are listed first)',
        matchOnDescription: true,
      },
    );
    if (!pick) return;
    const added = await this.store.mergeInto(pick.record, this.refFor(panel.uri));
    await this.store.flush();
    await panel.reloadHighlights();
    void vscode.window.showInformationMessage(
      `Copied ${added} highlight${added === 1 ? '' : 's'}. Highlights whose text is not in this file are listed as orphaned.`,
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

  async clearCache(): Promise<void> {
    const removed = await this.pdfCache.clear();
    void vscode.window.showInformationMessage(
      removed > 0 ? `Deleted ${removed} cached PDF${removed === 1 ? '' : 's'}. Documents are converted again the next time you open them.` : 'The PDF cache is already empty.',
    );
  }

  dispose(): void {
    clearTimeout(this.pruneTimer);
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
