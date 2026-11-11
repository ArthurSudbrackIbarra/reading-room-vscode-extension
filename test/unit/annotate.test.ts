// Downloads: highlights and drawings become real PDF annotations. Read back with pdf.js, the way
// other PDF readers would see them.
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { pdfPathOps, shapePath } from '../../src/shared/drawingGeometry';
import { inkShades } from '../../src/shared/colors';
import { drawingShape, type InkDrawing } from '../../src/shared/drawings';
import { HIGHLIGHT_HEX } from '../../src/shared/types';
import { addAnnotations, drawingRect } from '../../src/export/annotate';
import { makeDrawing } from './helpers';

function rgb(hex: string): number[] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

async function blankPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return doc.save();
}

interface AnnotationData {
  subtype: string;
  id: string;
  rect: number[];
  color: Uint8ClampedArray | null;
  lineEndings?: string[];
  lineCoordinates?: number[];
  inkLists?: ArrayLike<number>[];
  borderStyle?: { width: number };
}

async function annotationsByPage(bytes: Uint8Array): Promise<AnnotationData[][]> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: AnnotationData[][] = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getAnnotations()) as AnnotationData[]);
  return pages;
}

const drawings: InkDrawing[] = [
  makeDrawing({ id: 'pen', tool: 'pen', color: 'purple', width: 'thin', points: [[60, 700], [80, 720], [100, 705], [130, 730]] }),
  makeDrawing({ id: 'dot', tool: 'pen', color: 'black', width: 'thick', points: [[300, 300]] }),
  makeDrawing({ id: 'line', tool: 'line', color: 'green', width: 'medium', points: [[50, 100], [250, 160]] }),
  makeDrawing({ id: 'arrow', tool: 'arrow', color: 'orange', width: 'thick', points: [[400, 500], [480, 420]] }),
  makeDrawing({ id: 'rect', tool: 'rect', color: 'blue', width: 'medium', pageIndex: 1, points: [[70, 600], [270, 680]] }),
  makeDrawing({ id: 'ellipse', tool: 'ellipse', color: 'red', width: 'thin', pageIndex: 1, points: [[300, 200], [420, 260]] }),
  makeDrawing({ id: 'nowhere', tool: 'line', pageIndex: 7 }),
];

describe('downloads with drawings', () => {
  it('add one annotation per drawing with the right subtype, page, rect, color and line endings', async () => {
    const highlight = {
      id: 'hl',
      color: 'yellow' as const,
      text: 'highlighted',
      createdAt: '2026-11-10T10:00:00.000Z',
      pages: [{ pageIndex: 0, rects: [[50, 760, 200, 772]] as [number, number, number, number][] }],
    };
    const bytes = await addAnnotations(await blankPdf(2), { highlights: [highlight], drawings });
    const [first, second] = await annotationsByPage(bytes);

    expect(first.map((a) => a.subtype)).toEqual(['Highlight', 'Ink', 'Ink', 'Line', 'Line']);
    expect(second.map((a) => a.subtype)).toEqual(['Square', 'Circle']);
    expect(Array.from(first[0].color ?? [])).toEqual(rgb(HIGHLIGHT_HEX.yellow));

    // pdf.js does not expose /NM: annotations are in the order they were added, page by page.
    const byId = new Map<string, AnnotationData>();
    for (const [page, annotations] of [first.slice(1), second].entries()) {
      const onPage = drawings.filter((d) => d.pageIndex === page);
      expect(annotations).toHaveLength(onPage.length);
      onPage.forEach((d, i) => byId.set(d.id, annotations[i]));
    }
    for (const drawing of drawings.filter((d) => d.id !== 'nowhere')) {
      const annotation = byId.get(drawing.id);
      expect(annotation, drawing.id).toBeDefined();
      // Downloads always have light pages, so the light shade.
      expect(Array.from(annotation!.color ?? []), drawing.id).toEqual(rgb(inkShades(drawing.color).light));
      const expected = drawingRect(drawing);
      annotation!.rect.forEach((v, i) => expect(v, `${drawing.id} rect`).toBeCloseTo(expected[i], 2));
      // (pdf.js ignores a border wider than half the rect, as for the thick dot; the appearance draws it anyway.)
      if (drawing.id !== 'dot') expect(annotation!.borderStyle?.width, drawing.id).toBe({ thin: 1, medium: 2, thick: 4 }[drawing.width]);
    }
    expect(byId.get('arrow')?.lineEndings).toEqual(['None', 'OpenArrow']);
    expect(byId.get('line')?.lineEndings).toEqual(['None', 'None']);
    expect(byId.get('line')?.lineCoordinates).toEqual([50, 100, 250, 160]);
    expect(Array.from(byId.get('pen')?.inkLists?.[0] as ArrayLike<number>)).toEqual([60, 700, 80, 720, 100, 705, 130, 730]);
    expect(byId.get('rect')?.rect).toEqual([69, 599, 271, 681]);
    // The drawing on a page the PDF does not have is left out.
    expect(byId.has('nowhere')).toBe(false);
  });

  it('draw each annotation with the same path as the screen', async () => {
    const bytes = await addAnnotations(await blankPdf(2), { highlights: [], drawings });
    const doc = await PDFDocument.load(bytes);
    const found: string[] = [];
    for (const page of doc.getPages()) {
      for (const ref of page.node.Annots()?.asArray() ?? []) {
        const annotation = doc.context.lookup(ref as PDFRef, PDFDict);
        const id = annotation.get(PDFName.of('NM'))?.toString().replace(/^\(|\)$/g, '');
        const drawing = drawings.find((d) => d.id === id);
        if (!drawing) continue;
        const appearance = doc.context.lookup(annotation.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef) as PDFRawStream;
        const content = new TextDecoder().decode(appearance.getContents());
        expect(content, id).toContain(pdfPathOps(shapePath(drawingShape(drawing))));
        expect(content).toMatch(/1 J\n1 j/);
        found.push(id!);
      }
    }
    expect(found.sort()).toEqual(drawings.filter((d) => d.id !== 'nowhere').map((d) => d.id).sort());
  });

  it('leave PDFs without drawings or highlights as they were', async () => {
    const bytes = await addAnnotations(await blankPdf(1), { highlights: [], drawings: [] });
    const [page] = await annotationsByPage(bytes);
    expect(page).toEqual([]);
  });
});
