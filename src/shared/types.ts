// Types shared by the extension host, the converter bundle and the webview.
// Keep this file free of runtime dependencies so every bundle can import it.
import type { Drawing } from './drawings';

export const HIGHLIGHT_COLORS = ['yellow', 'pink', 'green', 'blue', 'orange'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const DEFAULT_COLOR: HighlightColor = 'yellow';

/** Highlight fill colors. Shown at 40 % opacity with a multiply blend, on screen and in exported PDFs. */
export const HIGHLIGHT_HEX: Record<HighlightColor, string> = {
  yellow: '#FFE45C',
  pink: '#FF8AC6',
  green: '#7BE38B',
  blue: '#74C0FC',
  orange: '#FFB347',
};
export const HIGHLIGHT_OPACITY = 0.4;

export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === 'string' && (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

export type ZoomPreset = 'page-width' | 'page-fit' | 'page-actual';
export type ZoomValue = ZoomPreset | number;
export const DEFAULT_ZOOM: ZoomValue = 'page-width';
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

export function isZoomValue(value: unknown): value is ZoomValue {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return value === 'page-width' || value === 'page-fit' || value === 'page-actual';
}

export type PageTheme = 'light' | 'dark';
export type PageSize = 'A4' | 'Letter';

/**
 * What a viewer shows: Markdown and plain text are converted to PDF with Chromium; PDF files are
 * shown as they are.
 */
export type DocumentKind = 'markdown' | 'text' | 'pdf';

export function isConvertedKind(kind: DocumentKind): kind is 'markdown' | 'text' {
  return kind !== 'pdf';
}

/** Longest note kept on a highlight (characters). */
export const MAX_NOTE_LENGTH = 20_000;

/** W3C Web Annotation TextQuoteSelector. */
export interface TextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix: string;
  suffix: string;
}

/** W3C Web Annotation TextPositionSelector, over the normalized text model. */
export interface TextPositionSelector {
  type: 'TextPositionSelector';
  start: number;
  end: number;
}

/** [x1, y1, x2, y2] in PDF user units, origin at the bottom-left of the page. */
export type PdfRect = [number, number, number, number];

export interface PageRects {
  pageIndex: number;
  rects: PdfRect[];
}

export interface HighlightTarget {
  selector: [TextQuoteSelector, TextPositionSelector];
  hints: {
    pages: PageRects[];
    textModelHash?: string;
  };
}

export type HighlightStatus = 'anchored' | 'orphaned';

export interface Highlight {
  id: string;
  color: HighlightColor;
  createdAt: string;
  updatedAt: string;
  status: HighlightStatus;
  target: HighlightTarget;
  /** The reader's comment on the highlight. Shown on hover and click; exported as the annotation text. */
  note?: string;
}

/**
 * "I stopped reading here": one per document. Anchored to the text of the marked line when there
 * is any (so it follows edits of converted documents), with the page position as a fallback.
 */
export interface ReadingMarker {
  /** Page index (0-based). */
  pageIndex: number;
  /** Top of the marked line, as a fraction of the page height measured from the top. */
  y: number;
  /** Text at the start of the marked line; absent when the line has no text (an image, a scan). */
  selector?: [TextQuoteSelector, TextPositionSelector];
  createdAt: string;
}

export function isReadingMarker(value: unknown): value is ReadingMarker {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<ReadingMarker>;
  if (typeof m.pageIndex !== 'number' || !Number.isInteger(m.pageIndex) || m.pageIndex < 0) return false;
  if (typeof m.y !== 'number' || !Number.isFinite(m.y)) return false;
  if (m.selector !== undefined) {
    const [quote, position] = Array.isArray(m.selector) ? m.selector : [];
    if (quote?.type !== 'TextQuoteSelector' || typeof quote.exact !== 'string' || position?.type !== 'TextPositionSelector') return false;
  }
  return true;
}

export interface ViewState {
  zoom?: ZoomValue;
}

export interface StoredRecord {
  schemaVersion: 1;
  uri: string;
  fsPath?: string;
  view: ViewState;
  highlights: Highlight[];
  marker?: ReadingMarker;
  updatedAt: string;
  /**
   * Kept in a companion file next to the record (`<key>.drawings.json`), never in the record file
   * itself: 0.4.x rebuilds records from the fields it knows and would erase them.
   */
  drawings: Drawing[];
}

/** Page margins used by the converter. The viewer uses them to drop header/footer text from the text model. */
export const PAGE_MARGINS_MM = { top: 18, bottom: 20, left: 16, right: 16 } as const;
export const MM_TO_PT = 72 / 25.4;

export function quoteOf(h: Highlight): TextQuoteSelector {
  return h.target.selector[0];
}

export function positionOf(h: Highlight): TextPositionSelector {
  return h.target.selector[1];
}
