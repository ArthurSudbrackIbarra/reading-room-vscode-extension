// A normalized text model of a whole PDF, built from PDF.js text content.
//
// Item indices match PDF.js `TextLayer.textDivs` (every text item, including empty ones), so a
// DOM selection inside a text layer maps to (page, item, char offset) and from there to an offset
// in `text`. Whitespace runs (spaces, line ends, page breaks) collapse to one space, which keeps
// quotes stable when lines re-wrap after an edit. Header/footer text (page numbers) is excluded.

/**
 * Bump whenever text extraction or normalization changes. Hashes, offsets and snapshots made with
 * another version are hints only: they are never trusted as positions.
 */
export const TEXT_MODEL_VERSION = 1;

export interface TextItemInput {
  str: string;
  hasEOL: boolean;
  /** PDF transform [a, b, c, d, e, f]; `f` is the baseline y in PDF units (origin bottom-left). */
  transform: number[];
  /** Advance width and height of the item in PDF units (PDF.js gives them); used for geometry only. */
  width?: number;
  height?: number;
}

export interface PageInput {
  /** Text items (entries with a `str`), in text-content order. */
  items: TextItemInput[];
  /** Page box [x0, y0, x1, y1] in PDF units. */
  view: number[];
  /** The page's /Rotate (0, 90, 180, 270). */
  rotate?: number;
  userUnit?: number;
}

export interface TextModelOptions {
  /** Text whose baseline lies this close to the top/bottom page edge is header/footer and is skipped. */
  marginsPt?: { top: number; bottom: number };
}

export interface ItemSegment {
  item: number;
  /** Character offsets in the item's `str`, end exclusive. */
  from: number;
  to: number;
}

export interface PageSegments {
  page: number;
  segments: ItemSegment[];
}

const WHITESPACE = /\s/;

/** cyrb53: a small, fast non-cryptographic string hash. */
export function hashText(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export class TextModel {
  /** The normalized text of the whole document. */
  readonly text: string;
  readonly hash: string;
  readonly pageCount: number;
  /** pageStart[p] is the normalized index where page p starts; pageStart[pageCount] = text.length. */
  readonly pageStart: number[];
  /** Included (non header/footer) item indices per page. */
  readonly includedItems: number[][];

  /** For each normalized char: its source page, item and char offset (offset = item length for virtual whitespace). */
  private readonly srcPage: Int32Array;
  private readonly srcItem: Int32Array;
  private readonly srcOffset: Int32Array;
  /** rawToNorm[page][item][offset] = normalized index of that char (or the space it collapsed into). */
  private readonly rawToNorm: (Int32Array | undefined)[][];
  private readonly itemLengths: number[][];

  constructor(pages: PageInput[], options: TextModelOptions = {}) {
    const chars: string[] = [];
    const srcPage: number[] = [];
    const srcItem: number[] = [];
    const srcOffset: number[] = [];
    const rawToNorm: (Int32Array | undefined)[][] = [];
    const includedItems: number[][] = [];
    const itemLengths: number[][] = [];
    const pageStart: number[] = [];
    const margins = options.marginsPt;

    let lastWasSpace = true; // suppress leading whitespace
    const emitSpace = (page: number, item: number, offset: number): number => {
      if (!lastWasSpace) {
        chars.push(' ');
        srcPage.push(page);
        srcItem.push(item);
        srcOffset.push(offset);
        lastWasSpace = true;
      }
      return Math.max(0, chars.length - 1);
    };

    pages.forEach((page, p) => {
      if (p > 0) {
        const prev = includedItems[p - 1];
        const lastItem = prev.length > 0 ? prev[prev.length - 1] : 0;
        emitSpace(p - 1, lastItem, itemLengths[p - 1][lastItem] ?? 0);
      }
      pageStart.push(chars.length);
      const [, y0 = 0, , y1 = 0] = page.view;
      const included: number[] = [];
      const maps: (Int32Array | undefined)[] = [];
      const lengths: number[] = [];
      page.items.forEach((item, k) => {
        lengths.push(item.str.length);
        const baseline = item.transform[5] ?? 0;
        const inMargin = margins !== undefined && (baseline < y0 + margins.bottom || baseline > y1 - margins.top);
        if (inMargin) {
          maps.push(undefined);
          return;
        }
        included.push(k);
        const map = new Int32Array(item.str.length + 1);
        for (let o = 0; o < item.str.length; o++) {
          const ch = item.str[o];
          if (WHITESPACE.test(ch)) {
            map[o] = lastWasSpace ? Math.max(0, chars.length - 1) : emitSpace(p, k, o);
          } else {
            map[o] = chars.length;
            chars.push(ch);
            srcPage.push(p);
            srcItem.push(k);
            srcOffset.push(o);
            lastWasSpace = false;
          }
        }
        map[item.str.length] = chars.length;
        maps.push(map);
        if (item.hasEOL) emitSpace(p, k, item.str.length);
      });
      rawToNorm.push(maps);
      includedItems.push(included);
      itemLengths.push(lengths);
    });

    // Drop a trailing space.
    if (chars.length > 0 && chars[chars.length - 1] === ' ') {
      chars.pop();
      srcPage.pop();
      srcItem.pop();
      srcOffset.pop();
    }
    pageStart.push(chars.length);
    for (let p = 0; p < pageStart.length; p++) pageStart[p] = Math.min(pageStart[p], chars.length);

    this.text = chars.join('');
    this.hash = hashText(this.text);
    this.pageCount = pages.length;
    this.pageStart = pageStart;
    this.includedItems = includedItems;
    this.srcPage = Int32Array.from(srcPage);
    this.srcItem = Int32Array.from(srcItem);
    this.srcOffset = Int32Array.from(srcOffset);
    this.rawToNorm = rawToNorm;
    this.itemLengths = itemLengths;
  }

  isIncluded(page: number, item: number): boolean {
    return this.rawToNorm[page]?.[item] !== undefined;
  }

  itemLength(page: number, item: number): number {
    return this.itemLengths[page]?.[item] ?? 0;
  }

  /** The normalized range an item's characters map to, or undefined for excluded items. */
  itemRange(page: number, item: number): [number, number] | undefined {
    const map = this.rawToNorm[page]?.[item];
    if (!map) return undefined;
    return [Math.min(map[0], this.text.length), Math.min(map[map.length - 1], this.text.length)];
  }

  /** Where a normalized character comes from: its page, item and offset in the item. */
  source(index: number): { page: number; item: number; offset: number } | undefined {
    if (index < 0 || index >= this.text.length) return undefined;
    return { page: this.srcPage[index], item: this.srcItem[index], offset: this.srcOffset[index] };
  }

  /**
   * Maps a text-layer position to a normalized offset. `edge: 'start'` treats the position as the
   * start of a range (the char at `offset` is included); `'end'` as an exclusive end.
   */
  indexAt(page: number, item: number, offset: number, edge: 'start' | 'end'): number | undefined {
    const map = this.rawToNorm[page]?.[item];
    if (!map) return undefined;
    const len = map.length - 1;
    const o = Math.max(0, Math.min(offset, len));
    if (edge === 'start') return Math.min(map[o], this.text.length);
    if (o === 0) return Math.min(map[0], this.text.length);
    return Math.min(map[o - 1] + 1, this.text.length);
  }

  /** The page containing normalized offset `index`. */
  pageOf(index: number): number {
    if (this.text.length === 0) return 0;
    const i = Math.max(0, Math.min(index, this.text.length - 1));
    return this.srcPage[i];
  }

  /**
   * Splits a normalized range into per-page item segments, skipping excluded and virtual text.
   * Collapsed whitespace inside an item is covered because segments of one item are contiguous.
   */
  segments(start: number, end: number): PageSegments[] {
    const out: PageSegments[] = [];
    const s = Math.max(0, start);
    const e = Math.min(end, this.text.length);
    let current: PageSegments | undefined;
    let segment: ItemSegment | undefined;
    for (let i = s; i < e; i++) {
      const page = this.srcPage[i];
      const item = this.srcItem[i];
      const offset = this.srcOffset[i];
      if (offset >= this.itemLength(page, item)) continue; // virtual whitespace (line end / page break)
      if (!current || current.page !== page) {
        current = { page, segments: [] };
        out.push(current);
        segment = undefined;
      }
      if (segment && segment.item === item && offset >= segment.to) {
        segment.to = offset + 1;
      } else {
        segment = { item, from: offset, to: offset + 1 };
        current.segments.push(segment);
      }
    }
    return out;
  }
}

/** Trims whitespace at both ends of a normalized range. */
export function trimRange(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && text[s] === ' ') s++;
  while (e > s && text[e - 1] === ' ') e--;
  return [s, e];
}
