// From a PDF.js page to what the anchoring engine reads: the text items (PageInput) and the boxes
// of the images drawn on the page. One function for the viewer and for the tests, so the tests see
// exactly what the viewer sees.
import { applyMatrix, pageGeometry, type Matrix, type PageGeometry, type PdfPoint } from '../shared/drawingGeometry';
import type { Box } from './layout';
import type { PageInput } from './textModel';

export interface TextContentLike {
  items: { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number }[];
}

export interface PdfPageLike {
  view: number[];
  rotate?: number;
  userUnit?: number;
  getTextContent(options: { includeMarkedContent: boolean; disableNormalization: boolean }): Promise<unknown>;
  getOperatorList?(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>;
}

/** The options the text is always read with. */
export const TEXT_CONTENT_OPTIONS = { includeMarkedContent: true, disableNormalization: true } as const;

/** The text items of a page (entries with a `str`), in the order of PDF.js's text layer. */
export function pageInput(page: Pick<PdfPageLike, 'view' | 'rotate' | 'userUnit'>, textContent: TextContentLike): PageInput {
  const input: PageInput = {
    view: [...page.view],
    items: textContent.items
      .filter((it) => typeof it.str === 'string')
      .map((it) => ({
        str: it.str ?? '',
        hasEOL: !!it.hasEOL,
        transform: it.transform ?? [1, 0, 0, 1, 0, 0],
        ...(typeof it.width === 'number' ? { width: it.width } : {}),
        ...(typeof it.height === 'number' ? { height: it.height } : {}),
      })),
  };
  if (page.rotate) input.rotate = page.rotate;
  if (page.userUnit && page.userUnit !== 1) input.userUnit = page.userUnit;
  return input;
}

export async function extractPage(page: PdfPageLike): Promise<{ input: PageInput; textContent: TextContentLike }> {
  const textContent = (await page.getTextContent(TEXT_CONTENT_OPTIONS)) as TextContentLike;
  return { input: pageInput(page, textContent), textContent };
}

/** The operator codes this needs from `pdfjsLib.OPS`. */
export interface OpCodes {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintInlineImageXObject?: number;
  paintImageXObjectRepeat?: number;
  paintFormXObjectBegin?: number;
  paintFormXObjectEnd?: number;
}

function multiply(m: Matrix, n: Matrix): Matrix {
  // Apply n first, then m.
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

function isMatrix(value: unknown): value is Matrix {
  return (Array.isArray(value) || ArrayBuffer.isView(value)) && (value as ArrayLike<unknown>).length === 6 && Array.from(value as ArrayLike<unknown>).every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Smallest side (points) of an image a drawing can be bound to. */
const MIN_IMAGE_SIDE = 12;

/**
 * The boxes of the images a page draws, in page space, in drawing order. Read from the page's
 * operator list, so it works for pages that were never rendered.
 */
export function imageBoxes(operators: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }, ops: OpCodes, geometry: PageGeometry): Box[] {
  const out: Box[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < operators.fnArray.length; i++) {
    const fn = operators.fnArray[i];
    const args = operators.argsArray[i] as unknown[] | null | undefined;
    if (fn === ops.save) {
      stack.push(ctm);
    } else if (fn === ops.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === ops.transform) {
      const m = args && args.length === 6 ? Array.from(args as ArrayLike<number>) : undefined;
      if (isMatrix(m)) ctm = multiply(ctm, m);
    } else if (ops.paintFormXObjectBegin !== undefined && fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] ? Array.from(args[0] as ArrayLike<number>) : undefined;
      if (isMatrix(m)) ctm = multiply(ctm, m);
    } else if (ops.paintFormXObjectEnd !== undefined && fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageXObjectRepeat) {
      const corners = (
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as PdfPoint[]
      ).map((p) => applyMatrix(geometry.transform, applyMatrix(ctm, p)));
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      const box: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (box.every(Number.isFinite) && box[2] - box[0] >= MIN_IMAGE_SIDE && box[3] - box[1] >= MIN_IMAGE_SIDE) out.push(box);
    }
  }
  return out;
}

/** The image boxes of a page, or none when the page cannot give its operators. */
export async function pageImages(page: PdfPageLike, ops: OpCodes): Promise<Box[]> {
  if (!page.getOperatorList) return [];
  const operators = await page.getOperatorList();
  return imageBoxes(operators, ops, pageGeometry(page.view, page.rotate ?? 0, page.userUnit ?? 1));
}
