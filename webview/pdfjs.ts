// pdf_viewer.mjs reads the core library from `globalThis.pdfjsLib` when it is evaluated,
// so this module must be imported before it (main.ts imports it first).
import * as pdfjsLib from 'pdfjs-dist';

(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

// The text layer lays out invisible text in a generic family and stretches each run to the PDF's
// width. Our PDFs use print.css's font stacks, so using the same stacks makes characters inside
// a run (and therefore selections and highlight edges) line up with the rendered glyphs.
const families = (pdfjsLib.TextLayer as unknown as { fontFamilyMap?: Map<string, string> }).fontFamilyMap;
if (families instanceof Map) {
  families.set('sans-serif', "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif");
  families.set('monospace', "ui-monospace, 'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace");
}

export { pdfjsLib };

/**
 * The webview cannot start a worker from the resource origin directly, so the worker script
 * is fetched and started from a blob: URL (allowed by `worker-src blob:`).
 */
export async function startWorker(workerUrl: string): Promise<void> {
  const response = await fetch(workerUrl);
  if (!response.ok) throw new Error(`Could not load the PDF worker (${response.status})`);
  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(blobUrl, { type: 'module' });
}
