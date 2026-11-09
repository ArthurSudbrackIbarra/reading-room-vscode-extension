// Converter integration test: renders the feature-test fixture with the installed browser and
// checks the PDF with pdf.js. Run with `npm run test:converter` (builds dist/ first).
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'feature-test.md');
const toUriPath = (fsPath: string) => pathToFileURL(fsPath).pathname.replace(/^\/([A-Z]):/, (_m, d: string) => `/${d.toLowerCase()}:`);
const fromUriPath = (uriPath: string) => decodeURIComponent(uriPath).replace(/^\/([a-zA-Z]:)/, '$1');

interface ConverterModule {
  Converter: new (options: unknown) => {
    render(request: unknown): Promise<{ pdf: Uint8Array; warnings: string[]; title: string; timings: Record<string, number> }>;
    dispose(): Promise<void>;
  };
}

interface PdfjsModule {
  getDocument(src: { data: Uint8Array; verbosity: number }): { promise: Promise<PdfDoc> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{
    view: number[];
    getAnnotations(): Promise<{ subtype: string; url?: string; unsafeUrl?: string; dest?: unknown }[]>;
    getTextContent(): Promise<{ items: { str?: string }[] }>;
  }>;
  getOutline(): Promise<{ title: string }[] | null>;
}

let converter: InstanceType<ConverterModule['Converter']>;
let pdfjs: PdfjsModule;

async function render(markdown: string, options: Record<string, unknown> = {}) {
  return converter.render({
    markdown,
    docPath: toUriPath(fixture),
    workspaceRootPath: toUriPath(root),
    fileName: 'feature-test.md',
    pageSize: 'A4',
    pageNumbers: true,
    allowRemoteImages: false,
    theme: 'light',
    readResource: async (uriPath: string) => new Uint8Array(await readFile(fromUriPath(uriPath))),
    ...options,
  });
}

async function inspect(pdf: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  const links: string[] = [];
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    for (const a of await page.getAnnotations()) {
      if (a.subtype === 'Link') links.push(a.url ?? a.unsafeUrl ?? (typeof a.dest === 'string' ? `#${a.dest}` : '#explicit'));
    }
    text += (await page.getTextContent()).items.map((i) => i.str ?? '').join(' ') + '\n';
  }
  const first = await doc.getPage(1);
  return { doc, links, text, view: first.view, outline: (await doc.getOutline())?.map((o) => o.title) ?? [] };
}

beforeAll(async () => {
  const mod = (await import(pathToFileURL(join(root, 'dist', 'converter', 'index.mjs')).href)) as ConverterModule;
  const log = { info: () => undefined, warn: () => undefined, error: (m: string) => console.error(m) };
  converter = new mod.Converter({ assetsDir: join(root, 'dist', 'assets'), storageDir: join(tmpdir(), 'mpv-converter-test'), log });
  pdfjs = (await import(pathToFileURL(join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href)) as PdfjsModule;
});

afterAll(async () => {
  await converter?.dispose();
});

describe('feature-test.md', () => {
  let result: Awaited<ReturnType<typeof render>>;
  let info: Awaited<ReturnType<typeof inspect>>;

  beforeAll(async () => {
    result = await render(readFileSync(fixture, 'utf8'));
    info = await inspect(result.pdf);
  });

  it('produces an in-memory A4 PDF with the front-matter title', () => {
    expect(result.pdf).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(...result.pdf.slice(0, 5))).toBe('%PDF-');
    expect(Math.abs(info.view[2] - 595.3)).toBeLessThan(1.5);
    expect(Math.abs(info.view[3] - 841.9)).toBeLessThan(1.5);
    expect(info.doc.numPages).toBeGreaterThanOrEqual(6);
    expect(result.title).toBe('Markdown PDF Viewer — Feature Test');
  });

  it('keeps internal, external, mail and relative .md links', () => {
    expect(info.links).toContain('#math');
    expect(info.links).toContain('#example-1');
    expect(info.links).toContain('https://code.visualstudio.com/');
    expect(info.links).toContain('mailto:someone@example.com');
    expect(info.links.some((l) => /^file:\/\/\/.*\/test\/fixtures\/other\.md#intro$/.test(l))).toBe(true);
    expect(info.links).toContain('#fn1');
  });

  it('builds an outline from the headings', () => {
    expect(info.outline[0]).toBe('Markdown PDF Viewer — Feature Test');
  });

  it('contains every section: tables, code, math, diagrams, footnotes, alerts', () => {
    const t = info.text;
    for (const needle of ['Right aligned', 'apples', 'Whiteboard pen', 'describe', 'dataclass', 'Markdown file', 'Extension host', 'NOTE', 'CAUTION', 'The first footnote', 'ação', 'A centered HTML block']) {
      expect(t, needle).toContain(needle);
    }
    // KaTeX output (text of the formulas)
    expect(t).toMatch(/E\s*=\s*m\s*c/);
  });

  it('hides the front matter and never runs scripts from the Markdown', () => {
    expect(info.text).not.toContain('This front matter must not appear');
    expect(info.text).not.toContain('SCRIPT RAN');
  });

  it('reports the missing image and shows a placeholder', () => {
    expect(result.warnings).toContain('Image not found: images/missing.png');
    expect(info.text).toContain('Image not available');
  });
});

describe('rendering options', () => {
  it('supports Letter paper', async () => {
    const r = await render('# Letter\n\nText.', { pageSize: 'Letter' });
    const { view } = await inspect(r.pdf);
    expect(Math.abs(view[2] - 612)).toBeLessThan(1.5);
    expect(Math.abs(view[3] - 792)).toBeLessThan(1.5);
  });

  it('resolves absolute Windows-style and workspace-root image paths', async () => {
    const abs = join(root, 'test', 'fixtures', 'images', 'sample.png');
    const r = await render(`![abs](${abs})\n\n![root](/test/fixtures/images/badge.svg)\n\n![file](${pathToFileURL(abs).href})`);
    expect(r.warnings).toEqual([]);
  });

  it('renders a dark variant with the same text and a dark page background', async () => {
    const md = '# Dark\n\nSome **text** and `code`.\n\n```ts\nconst x = 1;\n```';
    const light = await inspect((await render(md)).pdf);
    const dark = await inspect((await render(md, { theme: 'dark' })).pdf);
    expect(dark.text).toBe(light.text);
  });

  it('turns Mermaid errors into a visible box and a warning', async () => {
    const r = await render('```mermaid\nthis is not a diagram\n```');
    expect(r.warnings.some((w) => w.startsWith('Mermaid diagram #1 could not be rendered'))).toBe(true);
    expect((await inspect(r.pdf)).text).toContain('Mermaid diagram could not be rendered');
  });

  it('blocks javascript: links', async () => {
    const r = await render('[bad](javascript:alert(1)) and [good](https://example.com)');
    const { links } = await inspect(r.pdf);
    expect(links).toEqual(['https://example.com/']);
  });
});

describe('plain text files', () => {
  it('renders the text as written, wraps long lines, links web addresses and spans pages', async () => {
    const longLine = 'word '.repeat(60).trim();
    const body = Array.from({ length: 140 }, (_, i) => `Line ${i + 1}: ${i === 3 ? longLine : 'short line'}`).join('\n');
    const text = `# Not a heading\n**not bold** <b>not html</b>\nhttps://example.com/docs and readme.md\n\n${body}\n`;
    const r = await render(text, { kind: 'text', fileName: 'notes.txt' });
    const info = await inspect(r.pdf);
    expect(r.title).toBe('notes.txt');
    expect(r.warnings).toEqual([]);
    expect(info.doc.numPages).toBeGreaterThanOrEqual(2);
    expect(info.text).toContain('# Not a heading');
    expect(info.text).toContain('**not bold**');
    expect(info.text).toContain('<b>not html</b>');
    expect(info.text).toContain('Line 140: short line');
    expect(info.links).toEqual(['https://example.com/docs']);
  });
});
