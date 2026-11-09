// Post-processing of the Chromium PDF with @cantoo/pdf-lib:
//  - real /Highlight annotations for downloads (visible in any PDF reader),
//  - a full-page background for the dark page theme (Chromium leaves the margins unpainted).
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, type PDFPage } from '@cantoo/pdf-lib';
import { HIGHLIGHT_HEX, HIGHLIGHT_OPACITY, type HighlightColor, type PageRects, type PdfRect } from '../shared/types';

export interface AnnotationInput {
  id: string;
  color: HighlightColor;
  text: string;
  /** The reader's note; becomes the annotation's comment (otherwise the highlighted text is used). */
  note?: string;
  createdAt: string;
  pages: PageRects[];
}

const AUTHOR = 'Document Viewer';

export class EncryptedPdfError extends Error {
  constructor() {
    super('This PDF is encrypted and could not be opened for adding highlights. Download it without highlights instead.');
    this.name = 'EncryptedPdfError';
  }
}

/**
 * Opens a PDF for editing. Encrypted PDFs are decrypted with the password the reader typed (or the
 * empty password, which opens PDFs that only restrict permissions); the result is saved unencrypted.
 */
async function loadForEditing(pdfBytes: Uint8Array, password?: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch (err) {
    if ((err as { name?: string })?.name !== 'EncryptedPDFError' && !/encrypt/i.test(String(err))) throw err;
  }
  for (const candidate of [password, ''].filter((p): p is string => p !== undefined)) {
    try {
      const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false, password: candidate });
      // The objects are decrypted in memory; drop the encryption dictionary so the copy is readable.
      doc.context.trailerInfo.Encrypt = undefined;
      // Make sure decryption worked: reading the page tree fails on garbage.
      doc.getPages();
      return doc;
    } catch {
      // Try the next password.
    }
  }
  throw new EncryptedPdfError();
}

/** True if the PDF has an encryption dictionary. */
export async function isEncryptedPdf(pdfBytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(pdfBytes, { updateMetadata: false });
    return false;
  } catch (err) {
    return (err as { name?: string })?.name === 'EncryptedPDFError';
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(
    date.getUTCMinutes(),
  )}${pad(date.getUTCSeconds())}Z`;
}

function unionRect(rects: PdfRect[]): PdfRect {
  return rects.reduce<PdfRect>(
    (acc, r) => [Math.min(acc[0], r[0]), Math.min(acc[1], r[1]), Math.max(acc[2], r[2]), Math.max(acc[3], r[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

function appendAnnotation(page: PDFPage, ref: PDFRef): void {
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), page.doc.context.obj([ref]));
}

/** Adds one /Highlight annotation per highlight and page. Returns the new PDF bytes. */
export async function addHighlightAnnotations(pdfBytes: Uint8Array, highlights: AnnotationInput[], password?: string): Promise<Uint8Array> {
  const doc = await loadForEditing(pdfBytes, password);
  const context = doc.context;
  const pages = doc.getPages();
  const now = pdfDate(new Date());
  const gs = context.register(context.obj({ Type: 'ExtGState', BM: 'Multiply', ca: HIGHLIGHT_OPACITY, CA: HIGHLIGHT_OPACITY }));

  for (const h of highlights) {
    const [r, g, b] = hexToRgb(HIGHLIGHT_HEX[h.color]);
    const created = (() => {
      const d = new Date(h.createdAt);
      return Number.isNaN(d.getTime()) ? now : pdfDate(d);
    })();
    for (const pageRects of h.pages) {
      const page = pages[pageRects.pageIndex];
      const rects = pageRects.rects.filter((rc) => rc[2] > rc[0] && rc[3] > rc[1]);
      if (!page || rects.length === 0) continue;
      const bbox = unionRect(rects);
      const quadPoints = rects.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]);
      const ops = [`/GS0 gs`, `${fmt(r)} ${fmt(g)} ${fmt(b)} rg`, ...rects.map(([x1, y1, x2, y2]) => `${fmt(x1)} ${fmt(y1)} ${fmt(x2 - x1)} ${fmt(y2 - y1)} re f`)];
      const appearance = context.register(
        context.stream(ops.join('\n'), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: bbox,
          Resources: { ExtGState: { GS0: gs } },
        }),
      );
      const annotation = context.register(
        context.obj({
          Type: 'Annot',
          Subtype: 'Highlight',
          Rect: bbox,
          QuadPoints: quadPoints,
          C: [r, g, b],
          CA: HIGHLIGHT_OPACITY,
          F: 4,
          T: PDFHexString.fromText(AUTHOR),
          Contents: PDFHexString.fromText(h.note?.trim() ? h.note : h.text),
          NM: PDFString.of(`${h.id}-p${pageRects.pageIndex + 1}`),
          M: PDFString.of(now),
          CreationDate: PDFString.of(created),
          P: page.ref,
          AP: { N: appearance },
        }),
      );
      appendAnnotation(page, annotation);
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** Paints every page with `color` underneath its content (used for the dark page theme). */
export async function paintPageBackground(pdfBytes: Uint8Array, color: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const context = doc.context;
  const [r, g, b] = hexToRgb(color);
  for (const page of doc.getPages()) {
    const { x, y, width, height } = page.getMediaBox();
    const background = context.register(
      context.flateStream(`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${fmt(x)} ${fmt(y)} ${fmt(width)} ${fmt(height)} re f Q`),
    );
    const contents = page.node.get(PDFName.of('Contents'));
    const resolved = contents instanceof PDFRef ? context.lookup(contents) : contents;
    if (resolved instanceof PDFArray) {
      resolved.insert(0, background);
    } else if (contents) {
      page.node.set(PDFName.of('Contents'), context.obj([background, contents]));
    } else {
      page.node.set(PDFName.of('Contents'), context.obj([background]));
    }
  }
  return doc.save({ useObjectStreams: false });
}
