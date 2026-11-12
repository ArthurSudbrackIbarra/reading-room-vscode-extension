import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { BUILT_IN_SOUNDS, type BuiltInSound } from '../shared/sounds';
import type { DocumentKind } from '../shared/types';

/** Preview panels for Markdown and text files. */
export const VIEW_TYPE = 'readingRoom.preview';
/** Custom editor for PDF files. */
export const PDF_VIEW_TYPE = 'readingRoom.pdf';

/** `customSounds`: the folder of the reader's own reading sounds, which the viewer plays too. */
export function webviewOptions(extensionUri: vscode.Uri, customSounds: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableFindWidget: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), customSounds],
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

let soundsCache: { root: string; sounds: BuiltInSound[] } | undefined;

/** Built-in reading sounds whose audio file is in this build (scripts/fetch-sounds.mjs makes them). */
export function availableSounds(extensionUri: vscode.Uri): BuiltInSound[] {
  const root = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'sounds');
  if (soundsCache?.root !== root.toString()) {
    soundsCache = { root: root.toString(), sounds: BUILT_IN_SOUNDS.filter((s) => existsSync(vscode.Uri.joinPath(root, s.file).fsPath)) };
  }
  return soundsCache.sounds;
}

/** The viewer page: a strict CSP (nonce scripts, no inline styles), every resource via asWebviewUri. */
export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, kind: DocumentKind): string {
  const nonce = randomBytes(18).toString('base64');
  const asset = (path: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', ...path.split('/'))).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    'worker-src blob:',
    `connect-src ${webview.cspSource}`,
    // Reading sounds are fetched (connect-src) and played from blob: URLs.
    `media-src blob: ${webview.cspSource}`,
  ].join('; ');
  // PDF.js wants folder URLs with a trailing slash; Uri.joinPath drops it.
  const folder = (path: string) => `${asset(path).replace(/\/+$/, '')}/`;
  const config = {
    kind,
    worker: asset('pdfjs/pdf.worker.min.mjs'),
    cmaps: folder('pdfjs/cmaps'),
    standardFonts: folder('pdfjs/standard_fonts'),
    wasm: folder('pdfjs/wasm'),
    sounds: availableSounds(extensionUri).map((s) => ({
      id: s.id,
      category: s.category,
      name: s.name,
      description: s.description,
      credit: s.credit,
      url: asset(`sounds/${s.file}`),
    })),
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('pdfjs/pdf_viewer.css')}">
<link rel="stylesheet" href="${asset('codicons/codicon.css')}">
<link rel="stylesheet" href="${asset('styles.css')}">
<title>Reading Room</title>
</head>
<body>
<div id="app" data-config="${escapeAttr(JSON.stringify(config))}"></div>
<script type="module" nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
}
