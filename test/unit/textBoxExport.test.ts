// Downloads with text boxes: /FreeText annotations drawn with the lines the viewer showed, in
// Helvetica, on the same baselines, upright on rotated pages. Read back with pdf.js.
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, degrees } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { annotate } from '../../src/export/annotate';
import { matchLines, textBoxAppearance, textWidth, wrapText } from '../../src/export/textBox';
import { pageGeometry } from '../../src/shared/drawingGeometry';
import { TEXT_BASELINE, TEXT_LINE_HEIGHT, TEXT_PAD_X, TEXT_PAD_Y, type TextLayout } from '../../src/shared/drawings';
import { makeText } from './helpers';

const NL = String.fromCharCode(10);

async function pdfWithPages(rotations: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const rotation of rotations) {
    const page = doc.addPage([612, 792]);
    page.setRotation(degrees(rotation));
  }
  return doc.save();
}

interface FreeTextData {
  subtype: string;
  rect: number[];
  contentsObj?: { str: string };
  textContent?: string[];
  defaultAppearanceData?: { fontSize: number; fontColor: Uint8ClampedArray };
}

async function annotationsOf(bytes: Uint8Array): Promise<{ annotations: FreeTextData[]; viewport: { convertToPdfPoint(x: number, y: number): number[] } }[]> {
  // pdf.js takes the buffer it is given: hand it a copy.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push({ annotations: (await page.getAnnotations()) as FreeTextData[], viewport: page.getViewport({ scale: 1 }) });
  }
  return pages;
}

function appearanceOf(doc: PDFDocument, pageIndex: number): string[] {
  return (doc.getPages()[pageIndex].node.Annots()?.asArray() ?? []).map((ref) => {
    const annotation = doc.context.lookup(ref as PDFRef, PDFDict);
    const stream = doc.context.lookup(annotation.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef) as PDFRawStream;
    return new TextDecoder('latin1').decode(stream.getContents());
  });
}

describe('wrapping text like the viewer', () => {
  const style = { size: 12, bold: false, italic: false };

  it('breaks after spaces, keeping them on the line before', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', style, textWidth('the quick brown fox', style) + 1);
    expect(lines).toEqual(['the quick brown fox ', 'jumps over the lazy ', 'dog']);
  });

  it('breaks after hyphens and inside words longer than the line', () => {
    const width = textWidth('well-known', style) - 1;
    expect(wrapText('well-known', style, width)).toEqual(['well-', 'known']);
    const long = wrapText('Supercalifragilistic', style, textWidth('Supercal', style) + 0.5);
    expect(long.join('')).toBe('Supercalifragilistic');
    expect(long[0]).toBe('Supercal');
    for (const line of long) expect(textWidth(line, style)).toBeLessThanOrEqual(textWidth('Supercal', style) + 0.5);
  });

  it('keeps line breaks, and never wraps a box that grows with its text', () => {
    expect(wrapText(`one${NL}${NL}two three`, style)).toEqual(['one', '', 'two three']);
  });

  it('accepts the viewer lines only when they are exactly the text', () => {
    const text = `alpha beta gamma${NL}delta`;
    expect(matchLines(text, ['alpha beta ', 'gamma', 'delta'])).toEqual([
      { line: 'alpha beta ', start: 0, last: false },
      { line: 'gamma', start: 11, last: true },
      { line: 'delta', start: 17, last: true },
    ]);
    expect(matchLines(text, ['alpha beta gamma'])).toBeUndefined();
    expect(matchLines(text, ['alpha', 'beta gamma', 'delta'])).toBeUndefined();
  });
});

describe('downloads with text boxes', () => {
  it('add a /FreeText annotation per text box with its text, size and color', async () => {
    const plain = makeText({ id: 'plain', text: `Hello there${NL}second line`, color: '#1F77B4', size: 14 });
    const bold = makeText({ id: 'bold', text: 'Bold text', spans: [{ start: 0, end: 9, bold: true, italic: true }], pageIndex: 1, color: 'red' });
    const away = makeText({ id: 'away', pageIndex: 9 });
    const { pdf, replacedChars } = await annotate(await pdfWithPages([0, 0]), { highlights: [], drawings: [plain, bold, away] });
    expect(replacedChars).toBe(0);
    const [first, second] = await annotationsOf(pdf);
    expect(first.annotations.map((a) => a.subtype)).toEqual(['FreeText']);
    expect(second.annotations.map((a) => a.subtype)).toEqual(['FreeText']);
    const a = first.annotations[0];
    expect(a.contentsObj?.str).toBe(plain.text);
    expect(a.defaultAppearanceData?.fontSize).toBe(14);
    expect(Array.from(a.defaultAppearanceData?.fontColor ?? [])).toEqual([0x1f, 0x77, 0xb4]);
    // The box: two lines high, from the top left corner the text box stores.
    const height = 2 * 14 * TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y;
    expect(a.rect[0]).toBeCloseTo(72, 2);
    expect(a.rect[3]).toBeCloseTo(770, 2);
    expect(a.rect[3] - a.rect[1]).toBeCloseTo(height, 1);
    expect(a.rect[2] - a.rect[0]).toBeCloseTo(textWidth('second line', { size: 14, bold: false, italic: false }) + 2 * TEXT_PAD_X, 1);
    const doc = await PDFDocument.load(pdf);
    expect(appearanceOf(doc, 1)[0]).toMatch(/\/F3 12 Tf/);
    const fonts = doc.context.enumerateIndirectObjects().map(([, o]) => o.toString()).filter((o) => o.includes('/BaseFont'));
    expect(fonts.join()).toContain('/Helvetica-BoldOblique');
  });

  it('draw the lines the viewer showed, on its baselines, aligned and justified the same way', async () => {
    const text = makeText({ id: 'just', text: 'aa bb cc dd ee ff', align: 'justify', spans: [{ start: 0, end: 17, underline: true }], boxWidth: 80 });
    const layout: TextLayout = { id: 'just', lines: ['aa bb cc ', 'dd ee ff'], width: 80, height: 0 };
    const page = pageGeometry([0, 0, 612, 792]);
    const { ops, lines } = textBoxAppearance(text, page, layout);
    expect(lines).toEqual(['aa bb cc ', 'dd ee ff']);
    const inner = 80 - 2 * TEXT_PAD_X;
    const natural = textWidth('aa bb cc', { size: 12 });
    // The first line is justified (word spacing fills the line), the last one is not.
    const tw = ops.match(/(-?[\d.]+) Tw/g)?.map((m) => parseFloat(m));
    expect(tw?.[0]).toBeCloseTo((inner - natural) / 2, 2);
    expect(tw?.[1]).toBe(0);
    // Baselines: the same distance from the top of the box as on screen.
    const height = 2 * 12 * TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y;
    const ys = [...ops.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g)].map((m) => parseFloat(m[1]));
    expect(ys[0]).toBeCloseTo(height - TEXT_PAD_Y - TEXT_BASELINE * 12, 2);
    expect(ys[0] - ys[1]).toBeCloseTo(12 * TEXT_LINE_HEIGHT, 2);
    // Underlines: the justified line is underlined across the whole box.
    const underline = ops.match(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f/);
    expect(parseFloat(underline![3])).toBeCloseTo(inner, 2);
  });

  it('wrap the text itself when the viewer lines do not match it', () => {
    const text = makeText({ id: 'w', text: 'one two three four five six', boxWidth: 60 });
    const { lines } = textBoxAppearance(text, pageGeometry([0, 0, 612, 792]), { id: 'w', lines: ['something else'], width: 60, height: 10 });
    expect(lines.join('')).toBe(text.text);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('center and right-align lines inside the box', () => {
    const page = pageGeometry([0, 0, 612, 792]);
    const xOf = (align: 'left' | 'center' | 'right') =>
      parseFloat(textBoxAppearance(makeText({ text: 'abc', align, boxWidth: 100 }), page).ops.match(/1 0 0 1 ([\d.]+) [\d.]+ Tm/)![1]);
    const w = textWidth('abc', { size: 12, bold: false, italic: false });
    expect(xOf('left')).toBeCloseTo(TEXT_PAD_X, 2);
    expect(xOf('center')).toBeCloseTo(TEXT_PAD_X + (100 - 2 * TEXT_PAD_X - w) / 2, 2);
    expect(xOf('right')).toBeCloseTo(100 - TEXT_PAD_X - w, 2);
  });

  it('stay upright and in place on a page turned by /Rotate', async () => {
    // A box stored at the page-space point (100, 50) of a page shown turned 90°.
    const page = pageGeometry([0, 0, 612, 792], 90);
    const anchorPdf = [50, 100] as [number, number]; // (x, y) → page space (y, x) for /Rotate 90 of this box
    const text = makeText({ id: 'r', text: 'Turned page', pageIndex: 0, points: [anchorPdf] });
    const { pdf } = await annotate(await pdfWithPages([90]), { highlights: [], drawings: [text] });
    const [{ annotations, viewport }] = await annotationsOf(pdf);
    const appearance = textBoxAppearance(text, page);
    const width = textWidth('Turned page', { size: 12 }) + 2 * TEXT_PAD_X;
    const height = 12 * TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y;
    // pdf.js's own viewport maps the box's corners (page space) to the PDF rectangle.
    const [px, py] = [page.transform[0] * anchorPdf[0] + page.transform[2] * anchorPdf[1] + page.transform[4], page.transform[1] * anchorPdf[0] + page.transform[3] * anchorPdf[1] + page.transform[5]];
    const corners = [
      viewport.convertToPdfPoint(px, py),
      viewport.convertToPdfPoint(px + width, py + height),
    ];
    const expected = [Math.min(corners[0][0], corners[1][0]), Math.min(corners[0][1], corners[1][1]), Math.max(corners[0][0], corners[1][0]), Math.max(corners[0][1], corners[1][1])];
    annotations[0].rect.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 1));
    // On a turned page the box is taller than wide in PDF units: the text runs along the page's y axis.
    expect(appearance.rect[3] - appearance.rect[1]).toBeCloseTo(width, 1);
    // The appearance turns the text with the page (a rotation in its matrix).
    expect(appearance.ops.split(NL)[1]).toMatch(/^0 1 -1 0 /);
  });

  it('switch faces inside a line for bold and italic parts, and underline only what is underlined', async () => {
    const text = makeText({
      id: 'mix',
      text: 'plain bold both under',
      spans: [
        { start: 6, end: 10, bold: true },
        { start: 11, end: 15, bold: true, italic: true },
        { start: 16, end: 21, underline: true },
      ],
    });
    const { ops, fonts, rect } = textBoxAppearance(text, pageGeometry([0, 0, 612, 792]));
    expect(fonts).toEqual(['Helvetica', 'Helvetica-Bold', 'Helvetica-BoldOblique']);
    expect([...ops.matchAll(/\/(F\d) 12 Tf/g)].map((m) => m[1])).toEqual(['F0', 'F1', 'F0', 'F3', 'F0']);
    // One line: one position, then the runs follow each other.
    expect(ops.match(/ Tm/g)).toHaveLength(1);
    const before =
      textWidth('plain ', { size: 12 }) + textWidth('bold', { size: 12, bold: true }) + textWidth(' ', { size: 12 }) + textWidth('both', { size: 12, bold: true, italic: true }) + textWidth(' ', { size: 12 });
    const underline = ops.match(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f/)!;
    expect(ops.match(/ re f/g)).toHaveLength(1);
    expect(parseFloat(underline[1])).toBeCloseTo(TEXT_PAD_X + before, 2);
    expect(parseFloat(underline[3])).toBeCloseTo(textWidth('under', { size: 12 }), 2);
    // The box is as wide as the runs together: bold text is wider than plain text.
    expect(rect[2] - rect[0]).toBeCloseTo(before + textWidth('under', { size: 12 }) + 2 * TEXT_PAD_X, 1);
    expect(rect[2] - rect[0]).toBeGreaterThan(textWidth(text.text, { size: 12 }) + 2 * TEXT_PAD_X);
    // The download has the three faces, each once, and pdf.js reads the text back whole.
    const { pdf } = await annotate(await pdfWithPages([0]), { highlights: [], drawings: [text, makeText({ id: 'mix2', text: 'more bold', spans: [{ start: 5, end: 9, bold: true }] })] });
    const doc = await PDFDocument.load(pdf);
    const faces = doc.context.enumerateIndirectObjects().map(([, o]) => o.toString()).filter((o) => o.includes('/BaseFont'));
    expect(faces).toHaveLength(3);
    const [{ annotations }] = await annotationsOf(pdf);
    expect(annotations[0].textContent?.join('')).toBe(text.text);
  });

  it('wrap bold text by its own widths when the viewer sent no lines', () => {
    const words = 'aaaa bbbb cccc';
    const plain = textWidth('aaaa bbbb', { size: 12 });
    const bold = [{ start: 0, end: words.length, bold: true as const }];
    // Wide enough for two plain words, not for two bold ones.
    expect(wrapText(words, { size: 12, spans: [] }, plain + 0.5)).toEqual(['aaaa bbbb ', 'cccc']);
    expect(wrapText(words, { size: 12, spans: bold }, plain + 0.5)).toEqual(['aaaa ', 'bbbb ', 'cccc']);
    // A width narrower than one letter still ends (one letter per line).
    expect(wrapText('abc', { size: 12 }, 1)).toEqual(['a', 'b', 'c']);
  });

  it('count characters the standard font cannot show (they become "?")', async () => {
    const arrow = String.fromCodePoint(0x2192);
    const smile = String.fromCodePoint(0x1f600);
    const text = makeText({ text: `Ok ${arrow} fine ${smile} caf${String.fromCodePoint(0xe9)}` });
    const { replacedChars } = await annotate(await pdfWithPages([0]), { highlights: [], drawings: [text] });
    expect(replacedChars).toBe(2);
  });
});
