// PDF files: text, geometry and images read from real PDFs with pdf.js (the same extraction the
// viewer uses), pages inserted, deleted and reordered, a /Rotate 90 page, a crop box that does not
// start at zero, and pages without text. Covers B20, C2, E9, E12 and G5.
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAnchor } from '../../../src/anchoring/anchor';
import { resolveBinding } from '../../../src/anchoring/binding';
import { extractPage, pageImages } from '../../../src/anchoring/extract';
import { DocumentLayout } from '../../../src/anchoring/layout';
import { alignPages, pageTextHash, signatureKey, type PageSignature } from '../../../src/anchoring/pageAlign';
import { resolveAnchor } from '../../../src/anchoring/resolve';
import { ResolverRuns, bindDrawing } from '../../../src/anchoring/runs';
import { TextModel, type PageInput } from '../../../src/anchoring/textModel';
import { addHighlightAnnotations } from '../../../src/export/annotate';
import { toPdfSpace, type PdfPoint } from '../../../src/shared/drawingGeometry';
import { sanitizeDrawing } from '../../../src/shared/drawings';
import type { PdfRect } from '../../../src/shared/types';

const PNG = readFileSync(join(__dirname, '..', '..', 'fixtures', 'images', 'sample.png'));

type PageKind = 'intro' | 'body' | 'turned' | 'picture' | 'extra';

async function makePdf(order: PageKind[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedPng(PNG);
  for (const kind of order) {
    const page = doc.addPage([612, 792]);
    if (kind === 'picture') {
      page.drawImage(image, { x: 100, y: 300, width: 300, height: 200 });
      continue;
    }
    page.drawText(`The ${kind} page`, { x: 60, y: 720, size: 20, font });
    for (let i = 0; i < 12; i++) page.drawText(`Line ${i + 1} of the ${kind} page: the quick brown fox jumps over the lazy dog.`, { x: 60, y: 680 - i * 22, size: 12, font });
    if (kind === 'turned') {
      page.setRotation(degrees(90));
      page.setCropBox(30, 250, 560, 520);
    }
    if (kind === 'body') page.drawRectangle({ x: 400, y: 100, width: 50, height: 50, color: rgb(0.8, 0.2, 0.2) });
  }
  return doc.save();
}

interface Loaded {
  doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  inputs: PageInput[];
  model: TextModel;
  layout: DocumentLayout;
  signatures: PageSignature[];
}

async function load(bytes: Uint8Array): Promise<Loaded> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const inputs: PageInput[] = [];
  for (let i = 1; i <= doc.numPages; i++) inputs.push((await extractPage((await doc.getPage(i)) as never)).input);
  const model = new TextModel(inputs);
  const layout = new DocumentLayout(inputs, model);
  const signatures = inputs.map((input, i): PageSignature => {
    const text = pageTextHash(model.text.slice(model.pageStart[i], model.pageStart[i + 1]));
    const size = layout.pageSize(i)!;
    // A page without text gets a picture hash in the viewer; here every picture page looks the same.
    return { text, width: size[0], height: size[1], rotate: input.rotate ?? 0, ...(text ? {} : { image: '0f0f0f0f0f0f0f0f' }) };
  });
  return { doc, inputs, model, layout, signatures };
}

const ORDER: PageKind[] = ['intro', 'body', 'turned', 'picture'];
let v1: Loaded;
let bytes1: Uint8Array;

beforeAll(async () => {
  bytes1 = await makePdf(ORDER);
  v1 = await load(bytes1);
});

describe('reading a PDF', () => {
  it('pages, rotation and crop box come through', () => {
    expect(v1.inputs.map((p) => p.rotate ?? 0)).toEqual([0, 0, 90, 0]);
    // The crop box: 560 wide and 520 high, from (30, 250).
    expect(v1.inputs[2].view).toEqual([30, 250, 590, 770]);
    // The turned page is shown lying on its side: its size as shown is the crop box turned.
    expect(v1.layout.pageSize(2)).toEqual([520, 560]);
    expect(v1.model.text).toContain('Line 3 of the turned page: the quick brown fox');
    expect(v1.model.pageOf(v1.model.text.indexOf('The turned page'))).toBe(2);
  });

  it('E12: boxes of text on a turned, cropped page are where the PDF has the text', () => {
    const at = v1.model.text.indexOf('Line 5 of the turned page');
    const part = v1.layout.rangeBoxes(at, at + 'Line 5 of the turned page'.length)[0];
    expect(part.page).toBe(2);
    const geometry = v1.layout.geometry(2)!;
    // Back to PDF units: the text was drawn at x = 60, baseline y = 680 - 4 * 22 = 592, 12 pt.
    const corners = (
      [
        [part.boxes[0][0], part.boxes[0][1]],
        [part.boxes[0][2], part.boxes[0][3]],
      ] as PdfPoint[]
    ).map((p) => toPdfSpace(geometry, p));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    expect(Math.min(...xs)).toBeCloseTo(60, 0);
    expect(Math.min(...ys)).toBeLessThanOrEqual(592);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(592 + 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12, 0);
    // On the page as shown the line runs down the page (the text lies on its side).
    expect(part.boxes[0][3] - part.boxes[0][1]).toBeGreaterThan(part.boxes[0][2] - part.boxes[0][0]);
    expect(v1.layout.sideways(2)).toBe(true);
    expect(v1.layout.sideways(1)).toBe(false);
  });

  it('E12: a highlight exported on the turned page lies on its text in the file', async () => {
    const at = v1.model.text.indexOf('Line 5 of the turned page');
    const part = v1.layout.rangeBoxes(at, at + 'Line 5 of the turned page'.length)[0];
    const geometry = v1.layout.geometry(2)!;
    const a = toPdfSpace(geometry, [part.boxes[0][0], part.boxes[0][1]]);
    const b = toPdfSpace(geometry, [part.boxes[0][2], part.boxes[0][3]]);
    const rect: PdfRect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const out = await addHighlightAnnotations(bytes1, [
      { id: 'h', color: 'yellow', text: 'Line 5 of the turned page', createdAt: '2026-11-11T00:00:00.000Z', pages: [{ pageIndex: 2, rects: [rect] }] },
    ]);
    const exported = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
    const page = await exported.getPage(3);
    const [annotation] = (await page.getAnnotations()).filter((x: { subtype: string }) => x.subtype === 'Highlight');
    const item = ((await page.getTextContent()).items as { str?: string; transform: number[]; width: number }[]).find((it) => it.str?.startsWith('Line 5 of the turned'))!;
    expect(annotation.rect[0]).toBeCloseTo(item.transform[4], 0);
    expect(annotation.rect[1]).toBeLessThanOrEqual(item.transform[5]);
    expect(annotation.rect[3]).toBeGreaterThanOrEqual(item.transform[5] + 6);
    expect(annotation.rect[2]).toBeLessThanOrEqual(item.transform[4] + item.width + 1);
  });

  it('images are found from the page operators, on pages that were never rendered', async () => {
    const boxes = await pageImages((await v1.doc.getPage(4)) as never, pdfjs.OPS as never);
    expect(boxes).toHaveLength(1);
    // Drawn at x 100..400, y 300..500 in PDF units: in page space y runs down from 792.
    const [x0, y0, x1, y1] = boxes[0];
    expect([x0, y0, x1, y1].map(Math.round)).toEqual([100, 292, 400, 492]);
    expect(await pageImages((await v1.doc.getPage(2)) as never, pdfjs.OPS as never)).toEqual([]);
  });
});

describe('a PDF replaced on disk (B20)', () => {
  it('C2: text-bound annotations follow their text to another page', async () => {
    const at = v1.model.text.indexOf('Line 7 of the body page');
    const anchor = createAnchor(v1.model.text, v1.model.hash, at, at + 23);
    const v2 = await load(await makePdf(['extra', ...ORDER]));
    const r = resolveAnchor(anchor, undefined, { current: { text: v2.model.text, hash: v2.model.hash }, oldText: (h) => (h === v1.model.hash ? v1.model.text : undefined) });
    expect(r).toMatchObject({ status: 'anchored', kind: 'shifted' });
    expect(v2.model.pageOf(r.start!)).toBe(2);
    // And when its page is removed, it is orphaned; the others are not touched.
    const v3 = await load(await makePdf(['intro', 'turned', 'picture']));
    expect(
      resolveAnchor(anchor, r.state, { current: { text: v3.model.text, hash: v3.model.hash }, oldText: (h) => (h === v2.model.hash ? v2.model.text : undefined) }),
    ).toMatchObject({ status: 'orphaned', reason: 'deleted' });
  });

  it('pages are matched by their text, and pages without text by how they look', async () => {
    const inserted = await load(await makePdf(['extra', ...ORDER]));
    expect(alignPages(v1.signatures, inserted.signatures)).toEqual([1, 2, 3, 4]);
    const removed = await load(await makePdf(['intro', 'turned', 'picture']));
    expect(alignPages(v1.signatures, removed.signatures)).toEqual([0, undefined, 1, 2]);
    const reordered = await load(await makePdf(['picture', 'turned', 'body', 'intro']));
    expect(alignPages(v1.signatures, reordered.signatures)).toEqual([3, 2, 1, 0]);
    // A page turned in the new version is still the same page.
    const turnedBack = await load(await makePdf(['intro', 'body', 'body', 'picture']));
    expect(alignPages(v1.signatures, turnedBack.signatures)).toEqual([0, 1, undefined, 3]);
    expect(v1.signatures.map(signatureKey)[3]).toMatch(/^-\|612x792\|0\|[0-9a-f]{16}$/);
  });

  it('E9: a drawing on a page without text stays on its page; it is orphaned when the page is gone and found when it is back', async () => {
    const geometry = v1.layout.geometry(3)!;
    const drawing = sanitizeDrawing({
      id: 'd',
      tool: 'rect',
      color: 'red',
      width: 'thin',
      pageIndex: 3,
      points: [toPdfSpace(geometry, [150, 320]), toPdfSpace(geometry, [250, 400])],
      createdAt: 'x',
      updatedAt: 'x',
    })!;
    const images = async (page: number) => pageImages((await v1.doc.getPage(page + 1)) as never, pdfjs.OPS as never);
    // Over the picture: bound to the image. Asked to stay on the page: bound to the page, with its fingerprint.
    expect((await bindDrawing(drawing, v1, { images }))!.mode).toBe('block');
    const binding = (await bindDrawing(drawing, v1, { images, prefer: 'page', pagePrint: signatureKey(v1.signatures[3]) }))!;
    expect(binding).toMatchObject({ mode: 'page', page: 3, manual: true });

    const ctx = (v: Loaded) => ({ current: { text: v.model.text, hash: v.model.hash }, oldText: () => undefined });
    const v2 = await load(await makePdf(['extra', ...ORDER]));
    const map2 = alignPages(v1.signatures, v2.signatures);
    const moved = await resolveBinding(binding, [], ctx(v2), v2.layout, { pageMap: (p) => map2[p] });
    expect(moved).toMatchObject({ status: 'anchored', page: 4, kind: 'shifted' });

    // The picture page is removed: the next version's map starts from where it was last (page 5).
    const v3 = await load(await makePdf(['extra', 'intro', 'body', 'turned']));
    const map3 = alignPages(v2.signatures, v3.signatures);
    const gone = await resolveBinding(binding, moved.states, ctx(v3), v3.layout, { pageMap: (p) => map3[p] });
    expect(gone).toMatchObject({ status: 'orphaned', reason: 'page-missing' });

    // It comes back somewhere else: found by its fingerprint.
    const v4 = await load(await makePdf(['picture', 'extra', 'intro', 'body', 'turned']));
    const map4 = alignPages(v3.signatures, v4.signatures);
    const back = await resolveBinding(binding, gone.states, ctx(v4), v4.layout, {
      pageMap: (p) => map4[p],
      findPage: (print) => v4.signatures.findIndex((s) => signatureKey(s) === print),
    });
    expect(back).toMatchObject({ status: 'anchored', page: 0 });
  });

  it('G5: a marker on a page without text follows its page', async () => {
    const runs = new ResolverRuns();
    const marker = { page: 3, y: 0.4 };
    const v2 = await load(await makePdf(['extra', ...ORDER]));
    const map = alignPages(v1.signatures, v2.signatures);
    const first = (await runs.run(
      { renderId: 2, model: v2.model, layout: v2.layout },
      { highlights: [], drawings: [], marker },
      { oldText: () => undefined, pageMap: (p) => map[p] },
    ))!;
    expect(first.marker).toMatchObject({ page: 4, y: 0.4, approximate: false });
    // Its state remembers the page it is on now; the stored page is never rewritten.
    expect(first.marker!.state?.found?.page).toBe(4);
    expect(marker).toEqual({ page: 3, y: 0.4 });
    // The page is gone: shown where it was (clamped to the document), and said to be approximate.
    const v3 = await load(await makePdf(['intro']));
    const map3 = alignPages(v2.signatures, v3.signatures);
    const lost = (await runs.run(
      { renderId: 3, model: v3.model, layout: v3.layout },
      { highlights: [], drawings: [], marker: { ...marker, state: first.marker!.state } },
      { oldText: () => undefined, pageMap: (p) => map3[p] },
    ))!;
    expect(lost.marker).toMatchObject({ page: 0, stored: true, approximate: true });
  });
});
