// Activation: wires the store, the PDF cache, the lazily loaded converter and the viewers to commands.
// Kept small on purpose: the heavy converter bundle is only imported on the first conversion.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { PdfCache } from './cache/PdfCache';
import { PreviewManager } from './preview/PreviewManager';
import { RenderService } from './preview/RenderService';
import { copyFolderFromFirst } from './store/atomicWrite';
import { ANNOTATIONS_FOLDER, Backup, backupRoot } from './store/Backup';
import { HighlightStore } from './store/HighlightStore';
import { HistoryStore } from './store/HistoryStore';
import { SECTION, readSettings } from './util/settings';

let manager: PreviewManager | undefined;
let store: HighlightStore | undefined;
let history: HistoryStore | undefined;
let backup: Backup | undefined;
let renderer: RenderService | undefined;

/**
 * The ids this extension had before, newest first. Its storage folder is named after its id, so
 * each of them left a folder next to this one's:
 *   local.reading-room         0.9.0 to 0.11.0, installed from a .vsix, before it had a publisher
 *   local.markdown-pdf-viewer  up to 0.8.0, as Document Viewer & Highlighter
 */
const EARLIER_IDS = ['local.reading-room', 'local.markdown-pdf-viewer'];
/** The id of the copies installed from a .vsix. One of them may still be installed next to this one. */
const VSIX_ID = 'local.reading-room';

/** How many documents have annotations in a folder of annotation files. */
function countDocuments(folder: string): number {
  try {
    return new Set(readdirSync(folder).flatMap((name) => /^([0-9a-f]{64})(\.drawings)?\.json$/.exec(name)?.[1] ?? [])).size;
  } catch {
    return 0;
  }
}

/**
 * When this extension starts without annotations in its storage folder (the first time under its
 * id, or after it was uninstalled: VS Code deletes the storage folder then), they are brought
 * back: from the backup (`backupFolder`, when the backup is on), or else from the newest earlier
 * id that has them. The reader's own sounds come from an earlier id only: they are not in the
 * backup. The folder they are copied from is left as it is. False if something could not be
 * copied (the reader is told where it still is).
 */
function adoptEarlierData(context: vscode.ExtensionContext, log: vscode.LogOutputChannel, backupFolder?: string): boolean {
  const here = context.globalStorageUri.fsPath;
  const own = context.extension.id.toLowerCase();
  const earlier = EARLIER_IDS.filter((id) => id !== own).map((id) => join(dirname(here), id));
  let complete = true;
  for (const folder of [ANNOTATIONS_FOLDER, 'sounds']) {
    try {
      // The backup first: it follows every change, so it is never older than what an earlier id left behind.
      const sources = folder === ANNOTATIONS_FOLDER && backupFolder ? [backupFolder, ...earlier] : earlier;
      const from = copyFolderFromFirst(sources, here, folder);
      if (from && from === backupFolder) {
        const count = countDocuments(join(here, folder));
        log.info(`Brought back the annotations of ${count} document(s) from the backup in ${from}`);
        if (count > 0) {
          void vscode.window.showInformationMessage(
            `Reading Room brought back the annotations of ${count} document${count === 1 ? '' : 's'} from its backup. They were made before the extension was installed again.`,
          );
        }
      } else if (from) {
        log.info(`Copied ${folder} from ${from} (an earlier id of the extension)`);
      }
    } catch (err) {
      complete = false;
      log.error(`Could not copy ${folder} from an earlier storage folder: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showWarningMessage(
        `Reading Room could not bring over the ${folder === 'highlights' ? 'annotations' : 'reading sounds'} made with an earlier version. They are still in ${dirname(here)}, in a folder named ${EARLIER_IDS.join(' or ')}.`,
      );
    }
  }
  return complete;
}

/**
 * A copy installed from a .vsix (another id) is still installed next to this one. Two copies
 * cannot both run: they have the same commands and both open PDF files. And the earlier one is
 * the one in use, with the reader's annotations in its storage, which VS Code deletes some time
 * after an extension is uninstalled. So this one stays out of the way and offers to switch, in
 * one step and in this order: copy the annotations and sounds as they are now, uninstall the
 * earlier copy, reload the window. Until then the earlier copy keeps working as before.
 */
async function offerSwitch(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<void> {
  log.info(`${VSIX_ID} is installed too: staying inactive until the reader switches`);
  // A dialog, not a notification: a notification hides itself after a few seconds, and this is
  // about the reader's annotations.
  const choice = await vscode.window.showInformationMessage(
    'Reading Room is installed twice',
    {
      modal: true,
      detail:
        'This version, and an earlier copy that was installed from a file. The earlier copy stays in use until you switch.\n\nSwitching brings your annotations and sounds over, uninstalls the earlier copy and reloads the window.',
    },
    'Switch Now',
  );
  if (choice !== 'Switch Now') return;
  try {
    if (!adoptEarlierData(context, log)) return;
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', VSIX_ID);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (err) {
    log.error(`Switching from ${VSIX_ID} failed: ${err instanceof Error ? err.message : String(err)}`);
    void vscode.window.showErrorMessage(`Reading Room could not uninstall its earlier copy. Uninstall "${VSIX_ID}" in the Extensions view, then reload the window.`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Reading Room', { log: true });
  context.subscriptions.push(log);
  if (context.extension.id.toLowerCase() !== VSIX_ID && vscode.extensions.getExtension(VSIX_ID)) {
    void offerSwitch(context, log);
    return;
  }
  // The backup is in a folder VS Code does not know about, so an uninstall leaves it alone.
  const backupFolder = backupRoot(process.platform, process.env, homedir());
  adoptEarlierData(context, log, readSettings().backup ? backupFolder : undefined);

  const annotations = vscode.Uri.joinPath(context.globalStorageUri, ANNOTATIONS_FOLDER).fsPath;
  const copies = new Backup({ source: annotations, target: join(backupFolder, ANNOTATIONS_FOLDER), log, enabled: () => readSettings().backup });
  backup = copies;
  const primeBackup = () =>
    void copies.prime().then((copied) => {
      if (copied > 0) log.info(`Backup: copied ${copied} file(s) to ${copies.directory}`);
    });
  primeBackup();
  context.subscriptions.push(
    copies,
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Turned on (again): what was made in the meantime is copied now.
      if (e.affectsConfiguration(`${SECTION}.backup.enabled`) && readSettings().backup) primeBackup();
    }),
  );

  store = new HighlightStore({
    dir: annotations,
    log,
    onFilesChanged: (key) => copies.changed(key),
    onMigrate: (from, to) => history?.migrate(from, to),
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
  const annotationsStore = store;
  // The undo history of each document is kept next to its annotations (and in the backup with them).
  history = new HistoryStore({ dir: annotations, keyOf: (ref) => annotationsStore.keyOf(ref), log, onFilesChanged: (key) => copies.changed(key) });
  // Converted PDFs live in the extension's own storage folder, never next to the documents.
  const pdfCache = new PdfCache({ dir: vscode.Uri.joinPath(context.globalStorageUri, 'cache').fsPath, log });
  renderer = new RenderService(context, log);
  manager = new PreviewManager(context, log, store, history, renderer, pdfCache);
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
    'readingRoom.revealBackupFolder': async () => {
      await store?.flush();
      await history?.flush();
      await copies.flush();
      if (!existsSync(copies.directory)) {
        void vscode.window.showInformationMessage(
          readSettings().backup
            ? 'There is no backup yet: it is made when you first annotate a document.'
            : 'The backup is turned off (the setting "Reading Room: Backup: Enabled"), and there is no backup folder.',
        );
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(copies.directory));
    },
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
    await history?.flush();
    // Last: the backup copies what the two above just wrote.
    await backup?.flush();
  } finally {
    manager?.dispose();
    await renderer?.disposeAsync();
  }
}
