// Activation: wires the store, the PDF cache, the lazily loaded converter and the viewers to commands.
// Kept small on purpose: the heavy converter bundle is only imported on the first conversion.
import * as vscode from 'vscode';
import { PdfCache } from './cache/PdfCache';
import { PreviewManager } from './preview/PreviewManager';
import { RenderService } from './preview/RenderService';
import { HighlightStore } from './store/HighlightStore';

let manager: PreviewManager | undefined;
let store: HighlightStore | undefined;
let renderer: RenderService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Document Viewer', { log: true });
  context.subscriptions.push(log);

  store = new HighlightStore({
    dir: vscode.Uri.joinPath(context.globalStorageUri, 'highlights').fsPath,
    log,
    onCorrupt: (ref, movedTo) => {
      void vscode.window.showWarningMessage(
        `Document Viewer: the stored highlights of ${ref.uri.split('/').pop()} were unreadable. The file was kept as ${movedTo}.`,
      );
    },
  });
  // Converted PDFs live in the extension's own storage folder, never next to the documents.
  const pdfCache = new PdfCache({ dir: vscode.Uri.joinPath(context.globalStorageUri, 'cache').fsPath, log });
  renderer = new RenderService(context, log);
  manager = new PreviewManager(context, log, store, renderer, pdfCache);
  context.subscriptions.push(manager, renderer);

  const m = manager;
  const withPanel = (fn: (panel: NonNullable<ReturnType<PreviewManager['current']>>) => unknown) => () => {
    const panel = m.current();
    if (!panel) {
      void vscode.window.showInformationMessage('Open a document in the viewer first (a Markdown, text or PDF file).');
      return;
    }
    return fn(panel);
  };

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'markdownPdfViewer.openPreviewToSide': (uri) => m.open(uri, 'side'),
    'markdownPdfViewer.openPreview': (uri) => m.open(uri, 'full'),
    'markdownPdfViewer.showSource': withPanel((p) => p.showSource()),
    'markdownPdfViewer.toggleFullView': withPanel((p) => p.toggleFullView()),
    'markdownPdfViewer.refresh': withPanel((p) => p.requestRender(true)),
    'markdownPdfViewer.download': withPanel((p) => p.download(true)),
    'markdownPdfViewer.downloadWithoutHighlights': withPanel((p) => p.download(false)),
    'markdownPdfViewer.zoomIn': withPanel((p) => p.zoom('in')),
    'markdownPdfViewer.zoomOut': withPanel((p) => p.zoom('out')),
    'markdownPdfViewer.zoomReset': withPanel((p) => p.zoom('reset')),
    'markdownPdfViewer.toggleHighlightTool': withPanel((p) => p.toggleTool()),
    'markdownPdfViewer.toggleHighlightsList': withPanel((p) => p.toggleList()),
    'markdownPdfViewer.toggleDarkMode': () => m.toggleTheme(),
    'markdownPdfViewer.undo': withPanel((p) => p.undo()),
    'markdownPdfViewer.redo': withPanel((p) => p.redo()),
    'markdownPdfViewer.markReadingPosition': withPanel((p) => p.marker('place')),
    'markdownPdfViewer.goToReadingPosition': withPanel((p) => p.marker('goto')),
    'markdownPdfViewer.removeReadingPosition': withPanel((p) => p.marker('remove')),
    'markdownPdfViewer.toggleSounds': () => m.toggleSounds(),
    'markdownPdfViewer.addSounds': () => m.addSounds(),
    'markdownPdfViewer.reattachHighlights': () => m.reattach(),
    'markdownPdfViewer.deleteAllHighlights': () => m.deleteAll(),
    'markdownPdfViewer.revealDataFolder': () => m.revealDataFolder(),
    'markdownPdfViewer.clearCache': () => m.clearCache(),
    'markdownPdfViewer.showLog': () => log.show(true),
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
}

export async function deactivate(): Promise<void> {
  try {
    await store?.flush();
  } finally {
    manager?.dispose();
    await renderer?.disposeAsync();
  }
}
