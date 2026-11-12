// Re-anchoring on real renders: Markdown and text converted with the installed browser, read with
// pdf.js through the same extraction the viewer uses, and resolved with the viewer's engine.
// Run with `npm run test:converter` (builds dist/ first). IDs are the edge cases of
// docs/prompts/robust-annotations.md §6.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractPage, pageImages } from '../../src/anchoring/extract';
import { DocumentLayout, type Box } from '../../src/anchoring/layout';
import { TextModel, type PageInput } from '../../src/anchoring/textModel';
import { MM_TO_PT, PAGE_MARGINS_MM } from '../../src/shared/types';
import { World, boxOfText, type TestDocument } from '../unit/anchoring/scenario';

const root = resolve(__dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'anchoring', 'base.md');
const BASE = readFileSync(fixture, 'utf8').replace(/\r\n/g, '\n');
const toUriPath = (fsPath: string) => pathToFileURL(fsPath).pathname.replace(/^\/([A-Z]):/, (_m, d: string) => `/${d.toLowerCase()}:`);
const fromUriPath = (uriPath: string) => decodeURIComponent(uriPath).replace(/^\/([a-zA-Z]:)/, '$1');

interface ConverterModule {
  Converter: new (options: unknown) => { render(request: unknown): Promise<{ pdf: Uint8Array; warnings: string[] }>; dispose(): Promise<void> };
}
interface PdfjsModule {
  OPS: Record<string, number>;
  getDocument(src: { data: Uint8Array; verbosity: number }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<unknown> }> };
}

let converter: InstanceType<ConverterModule['Converter']>;
let pdfjs: PdfjsModule;
/** What the next render is made with (the settings of the extension). */
const settings = { kind: 'markdown' as 'markdown' | 'text', pageSize: 'A4' as 'A4' | 'Letter', pageNumbers: true, theme: 'light' as 'light' | 'dark' };
let renders = 0;

async function render(source: string, _options: unknown, renderId: number): Promise<TestDocument> {
  renders++;
  const result = await converter.render({
    kind: settings.kind,
    markdown: source,
    docPath: toUriPath(fixture),
    workspaceRootPath: toUriPath(root),
    fileName: settings.kind === 'text' ? 'notes.txt' : 'base.md',
    pageSize: settings.pageSize,
    pageNumbers: settings.pageNumbers,
    allowRemoteImages: false,
    theme: settings.theme,
    readResource: async (uriPath: string) => new Uint8Array(await readFile(fromUriPath(uriPath))),
  });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(result.pdf), verbosity: 0 }).promise;
  const inputs: PageInput[] = [];
  const images: Box[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    inputs.push((await extractPage(page as never)).input);
    images.push(await pageImages(page as never, pdfjs.OPS as never));
  }
  const model = new TextModel(inputs, { marginsPt: { top: PAGE_MARGINS_MM.top * MM_TO_PT, bottom: PAGE_MARGINS_MM.bottom * MM_TO_PT } });
  const layout = new DocumentLayout(inputs, model);
  const left = Math.min(...layout.lines(0).map((l) => l.box[0]));
  return { renderId, model, layout, images, text: model.text, left: Number.isFinite(left) ? left : 45 };
}

const world = (source = BASE) => World.from(source, render);
const LONG = `Added later. ${'This paragraph was written after the others and is long enough to push everything below it further down the page. '.repeat(70)}`.trim();
const FOX =
  'The quick brown fox jumps over the lazy dog while the otters watch from the far bank. This sentence is here because every test document needs it. The otters did not seem to mind the fox at all.';
const insertAbove = (t: string) => t.replace('## Morning routine', `${LONG}\n\n## Morning routine`);
const pageOf = (w: World, text: string) => w.doc.model.pageOf(w.doc.text.indexOf(text));

beforeAll(async () => {
  const mod = (await import(pathToFileURL(join(root, 'dist', 'converter', 'index.mjs')).href)) as ConverterModule;
  const log = { info: () => undefined, warn: () => undefined, error: (m: string) => console.error(m) };
  converter = new mod.Converter({ assetsDir: join(root, 'dist', 'assets'), storageDir: join(tmpdir(), 'mpv-converter-test'), log });
  pdfjs = (await import(pathToFileURL(join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href)) as PdfjsModule;
});

afterAll(async () => {
  await converter?.dispose();
  console.log(`reanchor: ${renders} renders`);
});

describe('the fixture', () => {
  it('renders to several pages with text, a picture, a table over pages, math, code, a diagram and footnotes', async () => {
    const w = await world();
    expect(w.doc.layout.pageCount).toBeGreaterThanOrEqual(3);
    for (const text of [
      'Field notes on river otters',
      'The quick brown fox jumps over the lazy dog',
      'Crayfish caught',
      'mean_catch',
      'Gravel bar',
      'Counted by two observers',
      'The diet changes with the season',
      'Small fish, mostly minnows',
    ]) {
      expect(w.doc.text, text).toContain(text);
    }
    // Page numbers are in the bottom margin and not part of the text.
    expect(w.doc.text).not.toMatch(/\b1 \/ \d\b/);
    // The picture, and the boxes of the diagram (which the browser prints as images).
    expect(w.doc.images.flat().length).toBeGreaterThanOrEqual(1);
    expect(w.doc.images[0].some((b) => b[2] - b[0] > 200)).toBe(true);
    expect(w.doc.text.split('Fish caught').length - 1).toBeGreaterThanOrEqual(1);
  });
});

describe('edits on a real render', () => {
  it('A1, C1, C2, E1, E3, G: a long paragraph inserted above moves everything, onto later pages', async () => {
    const w = await world();
    w.addHighlight('h', 'The quick brown fox jumps over the lazy dog');
    w.addHighlight('late', 'Three weeks are not enough to say anything certain');
    await w.addDrawing('circle', { shape: 'ellipse', around: 'before sunrise' });
    await w.addDrawing('under', { shape: 'underline', under: 'nineteen days' });
    await w.addDrawing('note', { shape: 'text', over: 'never seen an otter' });
    await w.addDrawing('mark', { shape: 'margin', beside: 'We hope to return in spring' });
    w.placeMarker('In the afternoon the otters rest');
    await w.resolve({}, true);
    w.checkDrawing('circle', { mode: 'text-stretch', boxCovers: 'before sunrise' });
    w.checkDrawing('mark', { mode: 'line' });
    const before = { h: pageOf(w, 'The quick brown fox'), late: pageOf(w, 'Three weeks are not enough'), pages: w.doc.layout.pageCount };
    await w.edit(insertAbove);
    expect(w.doc.layout.pageCount).toBeGreaterThan(before.pages);
    w.checkHighlight('h', { status: 'anchored', kind: 'shifted', text: 'The quick brown fox jumps over the lazy dog' });
    w.checkHighlight('late', { status: 'anchored', kind: 'shifted' });
    expect(pageOf(w, 'The quick brown fox')).toBeGreaterThan(before.h);
    expect(pageOf(w, 'Three weeks are not enough')).toBeGreaterThan(before.late);
    w.checkDrawing('circle', { status: 'anchored', boxCovers: 'before sunrise', flags: [] });
    w.checkDrawing('under', { status: 'anchored', underlines: 'nineteen days', flags: [] });
    w.checkDrawing('note', { status: 'anchored', follows: 'never seen an otter' });
    w.checkDrawing('mark', { status: 'anchored', follows: 'We hope to return in spring' });
    w.checkMarker({ status: 'anchored', lineStartsWith: 'In the afternoon the otters rest' });
    // And back.
    await w.edit(() => BASE);
    w.checkHighlight('h', { status: 'anchored', kind: 'shifted' });
    expect(pageOf(w, 'The quick brown fox')).toBe(before.h);
    w.checkDrawing('circle', { boxCovers: 'before sunrise', flags: [] });
  });

  it('A3, A7, A8, A10, E7: edits inside, partial deletion, deletion and replacement', async () => {
    const w = await world();
    w.addHighlight('h', 'quick brown fox');
    w.addHighlight('part', 'oldest female leads the group');
    w.addHighlight('gone', 'We counted the visits for nineteen days in a row');
    w.addHighlight('swap', 'Three weeks are not enough');
    await w.addDrawing('circle', { shape: 'ellipse', around: 'quick brown fox' });
    await w.resolve({}, true);
    await w.edit((t) =>
      t
        .replace('quick brown fox jumps', 'quick dark brown fox jumps')
        .replace('The oldest female leads the group', 'The group')
        .replace(' We counted the visits for nineteen days in a row.', '')
        .replace('Three weeks are not enough', 'Twenty days are too few'),
    );
    w.checkHighlight('h', { status: 'anchored', kind: 'edited', text: 'quick dark brown fox' });
    w.checkHighlight('part', { status: 'anchored', kind: 'partial', text: 'group' });
    w.checkHighlight('gone', { status: 'orphaned', reason: 'deleted' });
    w.checkHighlight('swap', { status: 'orphaned', reason: 'replaced', candidate: 'Twenty days are too few' });
    w.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick dark brown fox' });
    await w.edit(() => BASE);
    const quotes: Record<string, string> = {
      h: 'quick brown fox',
      part: 'oldest female leads the group',
      gone: 'We counted the visits for nineteen days in a row',
      swap: 'Three weeks are not enough',
    };
    for (const [id, text] of Object.entries(quotes)) {
      w.checkHighlight(id, { status: 'anchored', text });
      expect(['exact', 'shifted']).toContain(w.last!.highlights.get(id)!.kind);
    }
    w.checkDrawing('circle', { status: 'anchored', boxCovers: 'quick brown fox', flags: [] });
  });

  it('A11, A13, A14: a passage split in two blocks, a paragraph moved, a paragraph copied', async () => {
    const w = await world();
    w.addHighlight('h', 'quick brown fox');
    w.addHighlight('split', 'needs it. The otters did not seem');
    await w.resolve({}, true);
    await w.edit((t) => t.replace('needs it. The otters did not', 'needs it.\n\nThe otters did not'));
    w.checkHighlight('split', { status: 'anchored', kind: 'exact', text: 'needs it. The otters did not seem' });
    await w.edit(() => BASE.replace(`${FOX}\n\n`, '').replace('## Closing remarks', `${FOX}\n\n## Closing remarks`));
    w.checkHighlight('h', { status: 'anchored', kind: 'moved', text: 'quick brown fox' });
    expect(w.doc.text.slice(w.last!.highlights.get('h')!.start! - 4, w.last!.highlights.get('h')!.start!)).toBe('The ');
    await w.edit(() => BASE.replace(FOX, `${FOX}\n\n${FOX}`));
    w.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
    expect(w.last!.highlights.get('h')!.start).toBe(w.doc.text.indexOf('quick brown fox'));
  });

  it('A16, A17, C5: rewrapping the source and formatting-only changes keep the same words', async () => {
    const w = await world();
    w.addHighlight('h', 'quick brown fox jumps over the lazy dog');
    w.addHighlight('plain', 'The cubs sleep in a heap');
    await w.addDrawing('circle', { shape: 'ellipse', around: 'lazy dog' });
    await w.resolve({}, true);
    const hash = w.doc.model.hash;
    // Hard wraps in the source (a formatter) and CRLF line ends: the same text.
    await w.edit((t) => t.replace(FOX, FOX.replace(/(.{60}\S*) /g, '$1\n')).replace(/\n/g, '\r\n'));
    expect(w.doc.model.hash).toBe(hash);
    w.checkHighlight('h', { status: 'anchored', kind: 'exact' });
    // Bold, a link, a block quote, a heading level: other text items, the same words.
    await w.edit(() =>
      BASE.replace('quick brown fox jumps', '**quick brown** [fox](https://example.com) jumps')
        .replace('In the afternoon the otters rest', '> In the afternoon the otters rest')
        .replace('## Afternoon and evening', '### Afternoon and evening'),
    );
    w.checkHighlight('h', { status: 'anchored', text: 'quick brown fox jumps over the lazy dog' });
    w.checkHighlight('plain', { status: 'anchored', text: 'The cubs sleep in a heap' });
    w.checkDrawing('circle', { status: 'anchored', boxCovers: 'lazy dog' });
    const boxes = boxOfText(w.doc, 'quick brown fox jumps over the lazy dog');
    expect(boxes.boxes.length).toBeGreaterThanOrEqual(1);
  });

  it('A18, A21, A24: footnotes renumbered, a table head repeated once more, text in code, a diagram, a list and an alert', async () => {
    const w = await world();
    const quotes: Record<string, string> = {
      source: 'A second source',
      code: 'mean_catch',
      label: 'Gravel bar',
      task: 'Crayfish from under the flat stones',
      alert: 'The diet changes with the season',
      footnote: 'Counted by two observers from the path',
      cell: 'The best day of all',
    };
    for (const [id, quote] of Object.entries(quotes)) w.addHighlight(id, quote);
    // The head cell of the first page of the table.
    w.addHighlight('head', 'Crayfish caught');
    await w.resolve({}, true);
    const headAt = w.last!.highlights.get('head')!.start!;
    const heads = w.doc.text.split('Crayfish caught').length - 1;
    const rows = Array.from({ length: 90 }, (_, i) => `| ${20 + i} | ${5 + (i % 9)} | ${i % 7} | Later count number ${i + 1} |`).join('\n');
    await w.edit((t) =>
      t
        .replace('These notes were written', 'These notes[^first] were written')
        .replace('[^counts]: Counted', '[^first]: A new first footnote.\n[^counts]: Counted')
        .replace('| 19 | 16 | 2 | The best day of all |', `| 19 | 16 | 2 | The best day of all |\n${rows}`),
    );
    for (const [id, quote] of Object.entries(quotes)) w.checkHighlight(id, { status: 'anchored', text: quote });
    // The head is repeated on more pages now: the highlight stays on the first one.
    expect(w.doc.text.split('Crayfish caught').length - 1).toBeGreaterThan(heads);
    w.checkHighlight('head', { status: 'anchored', text: 'Crayfish caught' });
    expect(w.last!.highlights.get('head')!.start).toBe(w.doc.text.indexOf('Crayfish caught'));
    expect(w.doc.text.indexOf('Crayfish caught')).toBeGreaterThanOrEqual(headAt);
  });

  it('B10: an empty file, only front matter, only a picture: everything is orphaned and comes back', async () => {
    const w = await world();
    w.addHighlight('h', 'quick brown fox');
    w.addHighlight('h2', 'Three weeks are not enough');
    await w.addDrawing('circle', { shape: 'ellipse', around: 'before sunrise' });
    w.placeMarker('In the afternoon the otters rest');
    await w.resolve({}, true);
    for (const source of ['', '   \n\n', '---\ntitle: Nothing here\n---\n', '![A sample picture](../images/sample.png)\n']) {
      await w.edit(() => source);
      w.checkHighlight('h', { status: 'orphaned', reason: 'not-found' });
      w.checkDrawing('circle', { status: 'orphaned' });
      w.checkMarker({ stored: true });
      expect(w.last!.summary.orphanedNow).toBe(4);
    }
    await w.edit(() => BASE);
    w.checkHighlight('h', { status: 'anchored', kind: 'exact' });
    w.checkHighlight('h2', { status: 'anchored', kind: 'exact' });
    w.checkDrawing('circle', { status: 'anchored', boxCovers: 'before sunrise', flags: [] });
    w.checkMarker({ status: 'anchored', lineStartsWith: 'In the afternoon the otters rest', stored: false });
  });

  it('B17, B18: page size, page numbers and the page theme change no text; the same input renders the same', async () => {
    const w = await world();
    w.addHighlight('h', 'quick brown fox');
    await w.addDrawing('circle', { shape: 'ellipse', around: 'before sunrise' });
    await w.resolve({}, true);
    const first = { hash: w.doc.model.hash, boxes: JSON.stringify(boxOfText(w.doc, 'quick brown fox').boxes), circle: JSON.stringify(w.shownBox('circle')) };
    const a4 = w.doc.text;
    // The same input again (what a cache hit gives): identical.
    await w.edit((t) => t);
    expect({ hash: w.doc.model.hash, boxes: JSON.stringify(boxOfText(w.doc, 'quick brown fox').boxes), circle: JSON.stringify(w.shownBox('circle')) }).toEqual(first);
    try {
      settings.theme = 'dark';
      await w.edit((t) => t);
      expect(w.doc.model.hash).toBe(first.hash);
      expect(JSON.stringify(boxOfText(w.doc, 'quick brown fox').boxes)).toBe(first.boxes);
      w.checkHighlight('h', { kind: 'exact' });
      settings.theme = 'light';
      settings.pageNumbers = false;
      await w.edit((t) => t);
      expect(w.doc.model.hash).toBe(first.hash);
      expect(JSON.stringify(boxOfText(w.doc, 'quick brown fox').boxes)).toBe(first.boxes);
      settings.pageNumbers = true;
      settings.pageSize = 'Letter';
      await w.edit((t) => t);
      // Another page size wraps lines and breaks pages differently. The words are the same, but
      // not always their order in the PDF (the browser may write a boxed block, like the note,
      // before or after its neighbors depending on the page break), and the head of a table is
      // repeated on every page the table is on. Annotations follow all the same.
      const sameWords = (text: string) =>
        text
          .replace(/Day Fish caught Crayfish caught Remarks ?/g, '')
          .split(' ')
          .sort()
          .join(' ');
      expect(sameWords(w.doc.text)).toBe(sameWords(a4));
      w.checkHighlight('h', { status: 'anchored', text: 'quick brown fox' });
      w.checkDrawing('circle', { status: 'anchored' });
      const circle = w.shownBox('circle')!;
      const words = boxOfText(w.doc, 'before sunrise');
      expect(circle.page).toBe(words.page);
      expect(Math.abs(circle.box[1] - words.boxes[0][1])).toBeLessThanOrEqual(4);
    } finally {
      Object.assign(settings, { pageSize: 'A4', pageNumbers: true, theme: 'light' });
    }
  });

  it('C3, E2: a drawing on a picture scales with it and is orphaned without it; marks on code and a diagram follow', async () => {
    const w = await world();
    await w.addDrawing('onImage', { shape: 'rect', onImage: 0, page: 0 });
    await w.addDrawing('onCode', { shape: 'ellipse', around: 'mean_catch' });
    await w.addDrawing('onDiagram', { shape: 'ellipse', around: 'Gravel bar' });
    await w.addDrawing('byCode', { shape: 'margin', beside: 'The diagram shows a typical morning' });
    // A rectangle over the formula: around everything between the two sentences next to it.
    const formula = (): { page: number; box: Box } => {
      const above = boxOfText(w.doc, 'so the mean per animal is');
      const below = boxOfText(w.doc, 'where the group size');
      const lines = w.doc.layout.lines(above.page).filter((l) => l.box[1] > above.box[3] - 2 && l.box[3] < below.box[1] + 2);
      return { page: above.page, box: lines.map((l) => l.box).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]) };
    };
    const math = formula();
    await w.addDrawing('onMath', { shape: 'rect', at: [math.box[0] - 4, math.box[1] - 4, math.box[2] + 4, math.box[3] + 4], page: math.page });
    await w.resolve({}, true);
    expect(w.drawings.get('onMath')!.binding?.mode).not.toBe('page');
    w.checkDrawing('onImage', { mode: 'block', insideImage: 0 });
    const width = () => {
      const b = w.shownBox('onImage')!.box;
      return b[2] - b[0];
    };
    const before = width();
    const image = w.doc.images.flat()[0];
    const half = Math.round((image[2] - image[0]) / 2 / 0.75);
    await w.edit((t) => insertAbove(t).replace('![A sample picture](../images/sample.png)', `<img src="../images/sample.png" width="${half}" alt="A sample picture">`));
    w.checkDrawing('onImage', { status: 'anchored', flags: [] });
    const page = w.shownBox('onImage')!.page;
    const now = w.doc.images[page][0];
    expect((now[2] - now[0]) / (image[2] - image[0])).toBeCloseTo(0.5, 1);
    expect(width() / before).toBeCloseTo(0.5, 1);
    w.checkDrawing('onImage', { insideImage: 0 });
    w.checkDrawing('onCode', { status: 'anchored', boxCovers: 'mean_catch' });
    w.checkDrawing('onDiagram', { status: 'anchored', boxCovers: 'Gravel bar' });
    w.checkDrawing('byCode', { status: 'anchored', follows: 'The diagram shows a typical morning' });
    // The rectangle is still over the formula, on its page.
    const mathNow = formula();
    const mathResult = w.last!.drawings.get('onMath')!;
    expect(
      `${mathResult.status} ${mathResult.reason ?? ''} ${w.drawings.get('onMath')!.binding?.mode} ${JSON.stringify(w.drawings.get('onMath')!.binding?.anchors.map((a) => a.exact))}`,
    ).toMatch(/^anchored/);
    const shown = w.shownBox('onMath')!;
    expect(shown.page).toBe(mathNow.page);
    expect(Math.abs(shown.box[1] - (mathNow.box[1] - 4.5))).toBeLessThanOrEqual(3);
    expect(Math.abs(shown.box[0] - (mathNow.box[0] - 4.5))).toBeLessThanOrEqual(3);
    await w.edit((t) => t.replace(/<img [^>]+>\n\n/, ''));
    w.checkDrawing('onImage', { status: 'orphaned' });
    await w.edit(() => BASE);
    w.checkDrawing('onImage', { status: 'anchored', insideImage: 0, flags: [] });
    expect(width()).toBeCloseTo(before, 0);
  });

  it('E4, E5, E6: an arrow between words, a bracket beside lines, words that wrap', async () => {
    const w = await world();
    await w.addDrawing('arrow', { shape: 'arrow', from: 'before sunrise', to: 'flat stone' });
    await w.addDrawing('bracket', { shape: 'bracket', beside: ['Every morning the otters leave the holt', 'fish until noon'] });
    await w.resolve({}, true);
    w.checkDrawing('arrow', { mode: 'span' });
    w.checkDrawing('bracket', { mode: 'span' });
    const height = () => {
      const b = w.shownBox('bracket')!.box;
      return b[3] - b[1];
    };
    const before = height();
    await w.edit((t) =>
      t.replace(
        'The oldest female leads the group',
        'After a long look around the bank, which can take several minutes when the wind carries a strange smell, the oldest female leads the group',
      ),
    );
    w.checkDrawing('arrow', { status: 'anchored', endsNear: ['before sunrise', 'flat stone'] });
    expect(height()).toBeGreaterThan(before + 8);
    await w.edit(() => BASE);
    expect(height()).toBeCloseTo(before, 0);
    w.checkDrawing('arrow', { status: 'anchored', endsNear: ['before sunrise', 'flat stone'], flags: [] });
  });

  it('G1, G2: the reading marker stays on its line, goes where the line was, and returns with it', async () => {
    const w = await world();
    w.placeMarker('The evening visits to the pool');
    await w.resolve({}, true);
    await w.edit((t) => insertAbove(t).replace('The evening visits to the pool became shorter', 'Those evening visits to the pool became shorter'));
    w.checkMarker({ status: 'anchored', lineStartsWith: 'Those evening visits to the pool' });
    await w.edit((t) => t.replace(/Those evening visits to the pool became shorter[^\n]+\n\n/, ''));
    w.checkMarker({ status: 'orphaned', approximate: true, stored: false, lineStartsWith: 'Closing remarks' });
    await w.edit(() => BASE);
    w.checkMarker({ status: 'anchored', approximate: false, lineStartsWith: 'The evening visits to the pool' });
  });
});

describe('plain text files', () => {
  const TEXT = [
    'Notes on the weir',
    '=================',
    '',
    'The weir is twelve metres wide and the pool below it is the deepest place on this stretch of the river, deep enough that the bottom cannot be seen even on the clearest days of late summer.',
    '',
    '   /\\_/\\      a drawing made of characters',
    '  ( o.o )     that must keep its columns',
    '   > ^ <',
    '',
    'Depth\tWidth\tFlow',
    '2.4 m\t12 m\tslow',
    '',
    'The otters come here in the evening. The quick brown fox does not.',
  ].join('\n');

  it('long lines rewrap after an insert at the start of a line; character art and tabs keep their annotations', async () => {
    settings.kind = 'text';
    try {
      const w = await world(TEXT);
      w.addHighlight('deep', 'deep enough that the bottom cannot be seen');
      w.addHighlight('art', '( o.o )');
      w.addHighlight('cell', '12 m');
      w.addHighlight('fox', 'quick brown fox');
      await w.addDrawing('circle', { shape: 'ellipse', around: 'clearest days' });
      await w.resolve({}, true);
      await w.edit((t) =>
        t
          .replace('The weir is twelve metres wide', 'Measured twice with a tape and once by pacing along the top, the weir is twelve metres wide')
          .replace('Notes on the weir', 'More notes on the weir'),
      );
      w.checkHighlight('deep', { status: 'anchored', kind: 'shifted', text: 'deep enough that the bottom cannot be seen' });
      w.checkHighlight('art', { status: 'anchored', text: '( o.o )' });
      w.checkHighlight('cell', { status: 'anchored', text: '12 m' });
      w.checkHighlight('fox', { status: 'anchored', text: 'quick brown fox' });
      w.checkDrawing('circle', { status: 'anchored', boxCovers: 'clearest days' });
      await w.edit(() => TEXT);
      for (const id of ['deep', 'art', 'cell', 'fox']) w.checkHighlight(id, { status: 'anchored' });
    } finally {
      settings.kind = 'markdown';
    }
  });
});
