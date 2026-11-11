import type { PageInput, TextItemInput } from '../../src/anchoring/textModel';
import { DEFAULT_TEXT_STYLE, type InkDrawing, type TextDrawing } from '../../src/shared/drawings';
import type { Highlight, HighlightColor } from '../../src/shared/types';

let drawingCounter = 0;
/** A red, medium line on the first page (unique id unless one is given). */
export function makeDrawing(overrides: Partial<InkDrawing> = {}): InkDrawing {
  drawingCounter++;
  return {
    id: `d-${drawingCounter}`,
    tool: 'line',
    color: 'red',
    width: 'medium',
    pageIndex: 0,
    points: [
      [10, 20],
      [110, 220],
    ],
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    ...overrides,
  };
}

/** A text box with the default style near the top left of the first page (unique id unless one is given). */
export function makeText(overrides: Partial<TextDrawing> = {}): TextDrawing {
  drawingCounter++;
  return {
    id: `t-${drawingCounter}`,
    tool: 'text',
    pageIndex: 0,
    points: [[72, 770]],
    text: 'A note on the page',
    ...DEFAULT_TEXT_STYLE,
    createdAt: '2026-11-11T10:00:00.000Z',
    updatedAt: '2026-11-11T10:00:00.000Z',
    ...overrides,
  };
}

/** A4 page box in PDF points. */
export const A4_VIEW = [0, 0, 595.28, 841.89];
export const MARGINS = { top: 51.02, bottom: 56.69 };

/** Builds a page from lines of text: each line becomes one text item with hasEOL, top to bottom. */
export function pageFromLines(lines: string[], options: { footer?: string; splitWords?: boolean } = {}): PageInput {
  const items: TextItemInput[] = [];
  let y = 780;
  for (const line of lines) {
    if (options.splitWords) {
      const words = line.split(' ');
      words.forEach((word, i) => {
        items.push({ str: word, hasEOL: false, transform: [11, 0, 0, 11, 50 + i * 40, y] });
        if (i < words.length - 1) items.push({ str: ' ', hasEOL: false, transform: [11, 0, 0, 11, 50 + i * 40 + 30, y] });
      });
      items[items.length - 1].hasEOL = true;
    } else {
      items.push({ str: line, hasEOL: true, transform: [11, 0, 0, 11, 50, y] });
    }
    y -= 16;
  }
  if (options.footer) items.push({ str: options.footer, hasEOL: false, transform: [8, 0, 0, 8, 290, 30] });
  return { items, view: A4_VIEW };
}

let counter = 0;
export function makeHighlight(exact: string, prefix = '', suffix = '', color: HighlightColor = 'yellow', start = -1): Highlight {
  counter++;
  const now = new Date(Date.UTC(2026, 10, 6, 12, 0, counter)).toISOString();
  return {
    id: `h-${counter}`,
    color,
    createdAt: now,
    updatedAt: now,
    status: 'anchored',
    target: {
      selector: [
        { type: 'TextQuoteSelector', exact, prefix, suffix },
        { type: 'TextPositionSelector', start, end: start >= 0 ? start + exact.length : -1 },
      ],
      hints: { pages: [{ pageIndex: 0, rects: [[50, 700, 200, 712]] }] },
    },
  };
}
