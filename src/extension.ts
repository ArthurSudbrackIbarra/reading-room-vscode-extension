// Activation: wires the store, the PDF cache, the lazily loaded converter and the viewers to commands.
// Kept small on purpose: the heavy converter bundle is only imported on the first conversion.
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { PdfCache } from './cache/PdfCache';
import { PreviewManager } from './preview/PreviewManager';
import { RenderService } from './preview/RenderService';
import { copyFolderOnce } from './store/atomicWrite';
import { HighlightStore } from './store/HighlightStore';

let manager: PreviewManager | undefined;
let store: HighlightStore | undefined;
let renderer: RenderService | undefined;

/** The name this extension had up to 0.8.0 (Document Viewer & Highlighter): its storage folder is next to this one's. */
const EARLIER_NAME = 'markdown-pdf-viewer';

/**
 * Up to 0.8.0 the extension had another name, and with it another storage folder. The first time
 * this one starts, the annotations and the reader's own sounds are copied over (the old folder is
 * left as it is), so nothing made with the earlier versions is lost.
 */
function adoptEarlierData(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  const here = context.globalStorageUri.fsPath;
  const publisher = context.extension.id.split('.')[0];
  const earlier = join(dirname(here), `${publisher}.${EARLIER_NAME}`);
  for (const folder of ['highlights', 'sounds']) {
    try {
      if (copyFolderOnce(join(earlier, folder), join(here, folder))) log.info(`Copied ${folder} from ${earlier} (the extension's earlier name)`);
    } catch (err) {
      log.error(`Could not copy ${folder} from ${earlier}: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showWarningMessage(
        `Reading Room could not bring over the ${folder === 'highlights' ? 'annotations' : 'reading sounds'} made with Document Viewer & Highlighter. They are still in ${join(earlier, folder)}.`,
      );
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Reading Room', { log: true });
  context.subscriptions.push(log);
  adoptEarlierData(context, log);

  store = new HighlightStore({
    dir: vscode.Uri.joinPath(context.globalStorageUri, 'highlights').fsPath,
    log,
    onCorrupt: (ref, movedTo) => {
      void vscode.window.showWarningMessage(`Reading Room: the stored annotations of ${ref.uri.split('/').pop()} were unreadable. The file was kept as ${movedTo}.`);
    },
    onReadOnly: (ref) => log.warn(`The annotations of ${ref.uri} were saved by a newer version of the extension: they are shown, and changes are not stored`),
    onSimplified: (ref, count) => {
      void vscode.window.showWarningMessage(
        `Reading Room: ${count} drawing${count === 1 ? '' : 's'} or text box${count === 1 ? '' : 'es'} of ${ref.uri.split('/').pop()} ${count === 1 ? 'was' : 'were'} larger than allowed (too many points, or too much text) and ${count === 1 ? 'was' : 'were'} shortened to fit.`,
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
    'readingRoom.openPreviewToSide': (uri) => m.open(uri, 'side'),
    'readingRoom.openPreview': (uri) => m.open(uri, 'full'),
    'readingRoom.showSource': withPanel((p) => p.showSource()),
    'readingRoom.toggleFullView': withPanel((p) => p.toggleFullView()),
    'readingRoom.refresh': withPanel((p) => p.requestRender(true)),
    'readingRoom.download': withPanel((p) => p.download(true)),
    'readingRoom.downloadWithoutHighlights': withPanel((p) => p.download(false)),
    'readingRoom.zoomIn': withPanel((p) => p.zoom('in')),
    'readingRoom.zoomOut': withPanel((p) => p.zoom('out')),
    'readingRoom.toggleHighlightTool': withPanel((p) => p.toggleTool()),
    'readingRoom.toggleDrawing': withPanel((p) => p.toggleDrawing()),
    'readingRoom.toggleText': withPanel((p) => p.toggleText()),
    'readingRoom.toggleSelectTool': withPanel((p) => p.toggleSelect()),
    'readingRoom.deleteAllDrawings': () => m.deleteAllDrawings(undefined, 'ink'),
    'readingRoom.deleteAllTextBoxes': () => m.deleteAllDrawings(undefined, 'text'),
    'readingRoom.toggleHighlightsList': withPanel((p) => p.toggleList()),
    'readingRoom.toggleDarkMode': () => m.toggleTheme(),
    'readingRoom.undo': withPanel((p) => p.undo()),
    'readingRoom.redo': withPanel((p) => p.redo()),
    'readingRoom.markReadingPosition': withPanel((p) => p.marker('place')),
    'readingRoom.goToReadingPosition': withPanel((p) => p.marker('goto')),
    'readingRoom.removeReadingPosition': withPanel((p) => p.marker('remove')),
    'readingRoom.toggleSounds': () => m.toggleSounds(),
    'readingRoom.addSounds': () => m.addSounds(),
    'readingRoom.reattachHighlights': () => m.reattach(),
    'readingRoom.deleteAllHighlights': () => m.deleteAll(),
    'readingRoom.revealDataFolder': () => m.revealDataFolder(),
    'readingRoom.clearCache': () => m.clearCache(),
    'readingRoom.showLog': () => log.show(true),
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
