// Activation: wires the store, the lazily loaded converter and the preview manager to commands.
// Kept small on purpose: the heavy converter bundle is only imported on the first render.
import * as vscode from 'vscode';
import { PreviewManager } from './preview/PreviewManager';
import { RenderService } from './preview/RenderService';
import { HighlightStore } from './store/HighlightStore';

let manager: PreviewManager | undefined;
let store: HighlightStore | undefined;
let renderer: RenderService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Markdown PDF Viewer', { log: true });
  context.subscriptions.push(log);

  store = new HighlightStore({
    dir: vscode.Uri.joinPath(context.globalStorageUri, 'highlights').fsPath,
    log,
    onCorrupt: (ref, movedTo) => {
      void vscode.window.showWarningMessage(
        `Markdown PDF Viewer: the stored highlights of ${ref.uri.split('/').pop()} were unreadable. The file was kept as ${movedTo}.`,
      );
    },
  });
  renderer = new RenderService(context, log);
  manager = new PreviewManager(context, log, store, renderer);
  context.subscriptions.push(manager, renderer);

  const m = manager;
  const withPanel = (fn: (panel: NonNullable<ReturnType<PreviewManager['current']>>) => unknown) => () => {
    const panel = m.current();
    if (!panel) {
      void vscode.window.showInformationMessage('Open a PDF preview of a Markdown file first.');
      return;
    }
    return fn(panel);
  };

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'markdownPdfViewer.openPreviewToSide': (uri) => m.open(uri, 'side'),
    'markdownPdfViewer.openPreview': (uri) => m.open(uri, 'full'),
    'markdownPdfViewer.showSource': withPanel((p) => p.showSource()),
    'markdownPdfViewer.toggleFullView': withPanel((p) => p.toggleFullView()),
    'markdownPdfViewer.refresh': withPanel((p) => p.requestRender()),
    'markdownPdfViewer.download': withPanel((p) => p.download(true)),
    'markdownPdfViewer.downloadWithoutHighlights': withPanel((p) => p.download(false)),
    'markdownPdfViewer.zoomIn': withPanel((p) => p.zoom('in')),
    'markdownPdfViewer.zoomOut': withPanel((p) => p.zoom('out')),
    'markdownPdfViewer.zoomReset': withPanel((p) => p.zoom('reset')),
    'markdownPdfViewer.toggleHighlightTool': withPanel((p) => p.toggleTool()),
    'markdownPdfViewer.toggleHighlightsList': withPanel((p) => p.toggleList()),
    'markdownPdfViewer.toggleDarkMode': () => m.toggleTheme(),
    'markdownPdfViewer.reattachHighlights': () => m.reattach(),
    'markdownPdfViewer.deleteAllHighlights': () => m.deleteAll(),
    'markdownPdfViewer.revealDataFolder': () => m.revealDataFolder(),
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
