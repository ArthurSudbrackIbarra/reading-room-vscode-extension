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
    for (const needle of [
      'Right aligned',
      'apples',
      'Whiteboard pen',
      'describe',
      'dataclass',
      'Markdown file',
      'Extension host',
      'NOTE',
      'CAUTION',
      'The first footnote',
      'ação',
      'A centered HTML block',
    ]) {
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

describe('long documents are converted in batches', () => {
  /** A document of `sections` sections of prose, the same every time. */
  function longDocument(sections: number): string {
    const words = 'reading memory practice interval review recall knowledge schedule spaced repetition forgetting curve retention session question answer method evidence'.split(
      ' ',
    );
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const sentence = () => `${Array.from({ length: 10 + Math.floor(next() * 12) }, () => words[Math.floor(next() * words.length)]).join(' ')}.`;
    const paragraph = () => Array.from({ length: 4 + Math.floor(next() * 4) }, sentence).join(' ');
    const out = ['# A long document', ''];
    for (let s = 1; s <= sections; s++) out.push(`## Section ${s}`, '', paragraph(), '', paragraph(), '', '- ' + sentence(), '- ' + sentence(), '', paragraph(), '');
    return out.join('\n');
  }

  /** The text of each page without its footer (the page number, in the bottom margin). */
  async function pageTexts(pdf: Uint8Array): Promise<{ pages: string[]; footer: string }> {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
    const pages: string[] = [];
    let footer = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const items = (await (await doc.getPage(p)).getTextContent()).items as { str?: string; transform?: number[] }[];
      const inMargin = (item: { transform?: number[] }) => (item.transform?.[5] ?? 100) <= 57;
      pages.push(
        items
          .filter((item) => !inMargin(item))
          .map((item) => item.str ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      );
      if (p === 1)
        footer = items
          .filter(inMargin)
          .map((item) => item.str ?? '')
          .join('')
          .trim();
    }
    return { pages, footer };
  }

  it('hands out the first part of a long document before the whole, with the pages the whole will have', async () => {
    const parts: { pdf: Uint8Array; fraction: number; ms: number }[] = [];
    let settled = false;
    const result = await render(longDocument(260), {
      onPartial: (part: { pdf: Uint8Array; fraction: number; ms: number }) => {
        // Never after the whole document is there.
        expect(settled).toBe(false);
        parts.push(part);
      },
    });
    settled = true;
    expect(parts.length).toBeGreaterThanOrEqual(1);
    const whole = await pageTexts(result.pdf);
    const first = await pageTexts(parts[0].pdf);
    expect(whole.pages.length).toBeGreaterThan(80);
    expect(first.pages.length).toBeGreaterThanOrEqual(4);
    expect(first.pages.length).toBeLessThan(whole.pages.length / 4);
    expect(parts[0].fraction).toBeGreaterThan(0);
    expect(parts[0].fraction).toBeLessThan(0.25);
    // Every page but its last is a page of the whole document; its last one ends early.
    for (let i = 0; i < first.pages.length - 1; i++) expect(first.pages[i]).toBe(whole.pages[i]);
    expect(whole.pages[first.pages.length - 1].startsWith(first.pages[first.pages.length - 1])).toBe(true);
    // Its last page is not the document's: pages are numbered without a total.
    expect(first.footer).toBe('1');
    expect(whole.footer).toBe(`1 / ${whole.pages.length}`);
    expect(result.timings.firstPart).toBeGreaterThan(0);
    // Later parts hold more, each from the top.
    for (let i = 1; i < parts.length; i++) expect(parts[i].fraction).toBeGreaterThan(parts[i - 1].fraction);
  });

  it('converts a short document in one go', async () => {
    let parts = 0;
    const result = await render(longDocument(12), { onPartial: () => parts++ });
    expect(parts).toBe(0);
    expect(result.timings.firstPart).toBeUndefined();
    expect((await pageTexts(result.pdf)).pages.length).toBeGreaterThan(3);
  });

  it('does the same for a long plain text file', async () => {
    const lines = Array.from({ length: 9000 }, (_, i) => `Line ${i + 1}: some text that fills a good part of the line of the page.`);
    const parts: { pdf: Uint8Array; fraction: number }[] = [];
    const result = await render(lines.join('\n'), { kind: 'text', fileName: 'long.txt', onPartial: (part: { pdf: Uint8Array; fraction: number }) => parts.push(part) });
    expect(parts.length).toBeGreaterThanOrEqual(1);
    const whole = await pageTexts(result.pdf);
    const first = await pageTexts(parts[0].pdf);
    expect(first.pages.length).toBeLessThan(whole.pages.length / 4);
    for (let i = 0; i < first.pages.length - 1; i++) expect(first.pages[i]).toBe(whole.pages[i]);
  });
});
