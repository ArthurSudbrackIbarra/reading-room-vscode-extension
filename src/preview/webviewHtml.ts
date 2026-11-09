import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export const VIEW_TYPE = 'markdownPdfViewer.preview';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  return {
    enableScripts: true,
    enableFindWidget: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
  };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The viewer page: a strict CSP (nonce scripts, no inline styles), every resource via asWebviewUri. */
export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
  ].join('; ');
  // PDF.js wants folder URLs with a trailing slash; Uri.joinPath drops it.
  const folder = (path: string) => `${asset(path).replace(/\/+$/, '')}/`;
  const config = {
    worker: asset('pdfjs/pdf.worker.min.mjs'),
    cmaps: folder('pdfjs/cmaps'),
    standardFonts: folder('pdfjs/standard_fonts'),
    wasm: folder('pdfjs/wasm'),
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
<title>PDF Preview</title>
</head>
<body>
<div id="app" data-config="${escapeAttr(JSON.stringify(config))}"></div>
<script type="module" nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
}
