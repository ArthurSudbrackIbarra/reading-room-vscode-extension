// Renders a Markdown file with the built converter (dist/converter) and writes the PDF and
// one PNG per page into an output folder in the OS temp directory, for visual review.
// Usage: node test/converter/render-fixture.mjs [file.md] [--theme dark] [--size Letter] [--out <dir>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const input = resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? join(root, 'test/fixtures/feature-test.md'));
const theme = flag('--theme', 'light');
const pageSize = flag('--size', 'A4');
const out = resolve(flag('--out', join(tmpdir(), 'markdown-pdf-viewer-render')));
const scale = Number(flag('--scale', '1.4'));
mkdirSync(out, { recursive: true });

/** URI path the way VS Code writes it for file URIs: /c:/Users/... */
const toUriPath = (fsPath) => pathToFileURL(fsPath).pathname.replace(/^\/([A-Z]):/, (_m, d) => `/${d.toLowerCase()}:`);
const fromUriPath = (uriPath) => fileURLToPath(new URL(`file://${uriPath.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':')}`));

const { Converter } = await import(pathToFileURL(join(root, 'dist/converter/index.mjs')).href);
const log = { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m) };
const converter = new Converter({ assetsDir: join(root, 'dist/assets'), storageDir: join(tmpdir(), 'markdown-pdf-viewer-storage'), log });

const started = performance.now();
const result = await converter.render({
  markdown: readFileSync(input, 'utf8'),
  docPath: toUriPath(input),
  workspaceRootPath: toUriPath(root),
  fileName: basename(input),
  pageSize,
  pageNumbers: true,
  allowRemoteImages: true,
  theme,
  readResource: async (uriPath) => new Uint8Array(await readFile(fromUriPath(uriPath))),
});
const elapsed = Math.round(performance.now() - started);
const pdfPath = join(out, `${basename(input, '.md')}-${theme}.pdf`);
writeFileSync(pdfPath, result.pdf);

const pdfjs = await import(pathToFileURL(join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
const doc = await pdfjs.getDocument({ data: new Uint8Array(result.pdf), verbosity: 0 }).promise;
const summary = { pdf: pdfPath, bytes: result.pdf.length, pages: doc.numPages, title: result.title, elapsedMs: elapsed, timings: result.timings, warnings: result.warnings, links: [], outline: [] };
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  for (const a of await page.getAnnotations()) {
    if (a.subtype === 'Link') summary.links.push({ page: p, url: a.url ?? a.unsafeUrl, dest: typeof a.dest === 'string' ? a.dest : a.dest ? 'explicit' : undefined });
  }
  const viewport = page.getViewport({ scale });
  const { canvas, context } = doc.canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: context, canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
  writeFileSync(join(out, `page-${String(p).padStart(2, '0')}-${theme}.png`), canvas.toBuffer('image/png'));
  if (p === 1) {
    const { width, height } = page.getViewport({ scale: 1 });
    summary.pageSizePt = [Math.round(width * 10) / 10, Math.round(height * 10) / 10];
  }
}
summary.outline = ((await doc.getOutline()) ?? []).map((o) => o.title);
console.log(JSON.stringify(summary, null, 1));
await converter.dispose();
