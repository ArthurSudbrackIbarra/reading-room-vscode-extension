// Build: three bundles plus static assets, all into dist/.
//   dist/extension.js           CommonJS, loaded by VS Code (small; activation stays fast)
//   dist/converter/index.mjs    ESM with code splitting, imported lazily on the first render
//   dist/webview/main.js        ESM for the viewer webview (PDF.js components)
// Usage: node esbuild.mjs [--dev] [--watch]
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const watch = args.has('--watch');
const dist = join(root, 'dist');
const nm = (...p) => join(root, 'node_modules', ...p);

const common = {
  bundle: true,
  minify: !dev,
  // Source maps only for development builds; they would triple the size of the .vsix.
  sourcemap: dev,
  legalComments: 'eof',
  logLevel: 'info',
  absWorkingDir: root,
};

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: { index: 'src/converter/index.ts' },
    outdir: 'dist/converter',
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    // CommonJS dependencies bundled into ESM still expect these.
    banner: { js: "import { createRequire as __mpvCreateRequire } from 'node:module'; const require = __mpvCreateRequire(import.meta.url);" },
    define: { __dirname: 'import.meta.dirname', __filename: 'import.meta.filename' },
  },
  {
    ...common,
    entryPoints: { main: 'webview/main.ts', styles: 'webview/styles.css' },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'esm',
    target: ['chrome120'],
    loader: { '.svg': 'text' },
  },
];

async function copyAssets() {
  const copies = [
    [join(root, 'src/converter/print.css'), join(dist, 'assets/print.css')],
    [nm('katex/dist/katex.min.css'), join(dist, 'assets/katex/katex.min.css')],
    [nm('mermaid/dist/mermaid.min.js'), join(dist, 'assets/mermaid/mermaid.min.js')],
    [nm('pdfjs-dist/build/pdf.worker.min.mjs'), join(dist, 'webview/pdfjs/pdf.worker.min.mjs')],
    [nm('pdfjs-dist/web/pdf_viewer.css'), join(dist, 'webview/pdfjs/pdf_viewer.css')],
    [nm('pdfjs-dist/web/images'), join(dist, 'webview/pdfjs/images')],
    [nm('pdfjs-dist/cmaps'), join(dist, 'webview/pdfjs/cmaps')],
    [nm('pdfjs-dist/standard_fonts'), join(dist, 'webview/pdfjs/standard_fonts')],
    [nm('pdfjs-dist/wasm'), join(dist, 'webview/pdfjs/wasm')],
    [nm('@vscode/codicons/dist/codicon.css'), join(dist, 'webview/codicons/codicon.css')],
    [nm('@vscode/codicons/dist/codicon.ttf'), join(dist, 'webview/codicons/codicon.ttf')],
  ];
  for (const [from, to] of copies) {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }
  // KaTeX: browsers pick the first font format they support, so woff2 is enough.
  const fontsDir = nm('katex/dist/fonts');
  await mkdir(join(dist, 'assets/katex/fonts'), { recursive: true });
  for (const name of await readdir(fontsDir)) {
    if (name.endsWith('.woff2')) await cp(join(fontsDir, name), join(dist, 'assets/katex/fonts', name));
  }
  // Reading sounds: made by `npm run sounds` and kept out of git, so they may be missing.
  const soundsDir = join(root, 'media/sounds');
  const sounds = existsSync(soundsDir) ? (await readdir(soundsDir)).filter((name) => name.endsWith('.ogg')) : [];
  if (sounds.length === 0) {
    console.warn('No reading sounds in media/sounds/ (run "npm run sounds" first); the viewer will not offer them.');
  }
  for (const name of sounds) {
    await mkdir(join(dist, 'webview/sounds'), { recursive: true });
    await cp(join(soundsDir, name), join(dist, 'webview/sounds', name));
  }
}

if (!watch) await rm(dist, { recursive: true, force: true });
await copyAssets();

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
