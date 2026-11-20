// Bold, italic, underline and color inside a text box: which characters have which. A text box
// stores its text and, for the styled parts, spans of character offsets. Shared by the viewer
// (showing, typing) and the export. No runtime dependencies (colors.ts has none either).
import { sanitizeInk, type Ink } from './colors';

export const CHAR_STYLES = ['bold', 'italic', 'underline'] as const;
export type CharStyleName = (typeof CHAR_STYLES)[number];
/** Bold, italic and underline of one character (or of what is typed next). */
export type CharStyle = Record<CharStyleName, boolean>;

export const PLAIN: CharStyle = { bold: false, italic: false, underline: false };

/** The style of what is typed next: bold and so on, and a color of its own (absent: the color of the box). */
export interface TypingStyle extends CharStyle {
  color?: Ink;
}

/**
 * A styled stretch of a text: characters [start, end) (UTF-16 offsets), with at least one style or
 * a color of its own (absent: the color of the box).
 */
export interface TextSpan {
  start: number;
  end: number;
  bold?: true;
  italic?: true;
  underline?: true;
  color?: Ink;
}

/** A stretch of text in one style; the runs of a text cover all of it, in order. */
export interface TextRun extends CharStyle {
  start: number;
  end: number;
  text: string;
  /** The color of this stretch, when it has one of its own. */
  color?: Ink;
}

/** What `rangeColor` says of a range whose characters do not all have the same color. */
export const MIXED_COLOR = 'mixed';

const BIT: Record<CharStyleName, number> = { bold: 1, italic: 2, underline: 4 };
/** The three style bits of a character's code; the rest of the code names its color. */
const STYLE_BITS = 7;
const COLOR_SHIFT = 3;

function bitsOf(style: Partial<CharStyle>): number {
  return (style.bold ? 1 : 0) | (style.italic ? 2 : 0) | (style.underline ? 4 : 0);
}

function styleOf(code: number): CharStyle {
  return { bold: (code & 1) !== 0, italic: (code & 2) !== 0, underline: (code & 4) !== 0 };
}

/** The colors in use while spans are worked on: a character's code names its color by its number here (0: none). */
class Palette {
  private readonly inks: Ink[] = [];
  private readonly numbers = new Map<Ink, number>();

  numberOf(color: Ink | undefined): number {
    if (color === undefined) return 0;
    let number = this.numbers.get(color);
    if (number === undefined) {
      number = this.inks.push(color);
      this.numbers.set(color, number);
    }
    return number;
  }

  /** The number of a color, if any character can have it (0: none does). */
  find(color: Ink): number {
    return this.numbers.get(color) ?? 0;
  }

  colorOf(code: number): Ink | undefined {
    const number = code >>> COLOR_SHIFT;
    return number === 0 ? undefined : this.inks[number - 1];
  }
}

/** One number per character: its styles as bits, and above them the number of its color. A later span's color wins. */
function toCodes(spans: readonly TextSpan[] | undefined, length: number, palette: Palette): Uint32Array {
  const codes = new Uint32Array(length);
  for (const span of spans ?? []) {
    const bits = bitsOf(span);
    const color = palette.numberOf(span.color);
    const end = Math.min(length, span.end);
    for (let i = Math.max(0, span.start); i < end; i++) {
      const code = codes[i];
      codes[i] = (((color || code >>> COLOR_SHIFT) << COLOR_SHIFT) | (code & STYLE_BITS) | bits) >>> 0;
    }
  }
  return codes;
}

function fromCodes(codes: Uint32Array, palette: Palette): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  for (let i = 1; i <= codes.length; i++) {
    if (i < codes.length && codes[i] === codes[start]) continue;
    const code = codes[start];
    if (code !== 0) {
      const span: TextSpan = { start, end: i };
      if (code & 1) span.bold = true;
      if (code & 2) span.italic = true;
      if (code & 4) span.underline = true;
      const color = palette.colorOf(code);
      if (color !== undefined) span.color = color;
      spans.push(span);
    }
    start = i;
  }
  return spans;
}

function stored(codes: Uint32Array, palette: Palette): TextSpan[] | undefined {
  const spans = fromCodes(codes, palette);
  return spans.length > 0 ? spans : undefined;
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Spans from untrusted input (or after the text got shorter), as stored: inside the text, sorted,
 * not overlapping, merged, each with a style or a color. Undefined when nothing is styled.
 */
export function sanitizeSpans(value: unknown, length: number): TextSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean: TextSpan[] = [];
  for (const item of value.slice(0, 20_000)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (!isOffset(s.start) || !isOffset(s.end) || s.end <= s.start) continue;
    const span: TextSpan = { start: s.start, end: s.end };
    if (s.bold === true) span.bold = true;
    if (s.italic === true) span.italic = true;
    if (s.underline === true) span.underline = true;
    const color = sanitizeInk(s.color);
    if (color) span.color = color;
    if (span.bold || span.italic || span.underline || span.color) clean.push(span);
  }
  const palette = new Palette();
  return stored(toCodes(clean, length, palette), palette);
}

/** Bold, italic and underline of the character at `offset` (plain beyond the text). */
export function styleAt(spans: readonly TextSpan[] | undefined, offset: number): CharStyle {
  let bits = 0;
  for (const span of spans ?? []) if (offset >= span.start && offset < span.end) bits |= bitsOf(span);
  return styleOf(bits);
}

/** The color of its own the character at `offset` has, if any (none: it has the color of the box). */
export function colorAt(spans: readonly TextSpan[] | undefined, offset: number): Ink | undefined {
  let color: Ink | undefined;
  for (const span of spans ?? []) if (offset >= span.start && offset < span.end && span.color !== undefined) color = span.color;
  return color;
}

/** The text cut into stretches of one style and color each. An empty text has no runs. */
export function textRuns(text: string, spans: readonly TextSpan[] | undefined, from = 0, to = text.length): TextRun[] {
  const palette = new Palette();
  const codes = toCodes(spans, text.length, palette);
  const runs: TextRun[] = [];
  let start = from;
  for (let i = from + 1; i <= to; i++) {
    if (i < to && codes[i] === codes[start]) continue;
    if (i > start) {
      const run: TextRun = { start, end: i, text: text.slice(start, i), ...styleOf(codes[start]) };
      const color = palette.colorOf(codes[start]);
      if (color !== undefined) run.color = color;
      runs.push(run);
    }
    start = i;
  }
  return runs;
}

/**
 * The styles every character of [start, end) has (line breaks do not count: they show none).
 * A stretch without characters has none.
 */
export function rangeStyle(text: string, spans: readonly TextSpan[] | undefined, start: number, end: number): CharStyle {
  const codes = toCodes(spans, text.length, new Palette());
  let all = STYLE_BITS;
  let counted = 0;
  for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) {
    if (text[i] === '\n') continue;
    all &= codes[i];
    counted++;
  }
  return styleOf(counted === 0 ? 0 : all);
}

/**
 * The color of their own all characters of [start, end) have (line breaks do not count):
 * undefined when none of them has one (they have the color of the box, and so does a stretch
 * without characters), `MIXED_COLOR` when they do not all have the same.
 */
export function rangeColor(text: string, spans: readonly TextSpan[] | undefined, start: number, end: number): Ink | typeof MIXED_COLOR | undefined {
  const palette = new Palette();
  const codes = toCodes(spans, text.length, palette);
  let first: number | undefined;
  for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) {
    if (text[i] === '\n') continue;
    const number = codes[i] >>> COLOR_SHIFT;
    if (first === undefined) first = number;
    else if (number !== first) return MIXED_COLOR;
  }
  return first === undefined ? undefined : palette.colorOf(first << COLOR_SHIFT);
}

/** Sets or clears styles on [start, end). The colors stay as they are. */
export function styleRange(spans: readonly TextSpan[] | undefined, length: number, start: number, end: number, patch: Partial<CharStyle>): TextSpan[] | undefined {
  const palette = new Palette();
  const codes = toCodes(spans, length, palette);
  let set = 0;
  let clear = 0;
  for (const name of CHAR_STYLES) {
    if (patch[name] === true) set |= BIT[name];
    else if (patch[name] === false) clear |= BIT[name];
  }
  for (let i = Math.max(0, start); i < Math.min(length, end); i++) codes[i] = ((codes[i] | set) & ~clear) >>> 0;
  return stored(codes, palette);
}

/** Gives [start, end) a color of its own, or (with `undefined`) takes it away: the color of the box shows again. Bold and so on stay. */
export function colorRange(spans: readonly TextSpan[] | undefined, length: number, start: number, end: number, color: Ink | undefined): TextSpan[] | undefined {
  const palette = new Palette();
  const codes = toCodes(spans, length, palette);
  const number = palette.numberOf(color);
  for (let i = Math.max(0, start); i < Math.min(length, end); i++) codes[i] = ((number << COLOR_SHIFT) | (codes[i] & STYLE_BITS)) >>> 0;
  return stored(codes, palette);
}

/** Takes one color away wherever a part has it as its own (it is the color of the box now). */
export function withoutColor(spans: readonly TextSpan[] | undefined, length: number, color: Ink): TextSpan[] | undefined {
  const palette = new Palette();
  const codes = toCodes(spans, length, palette);
  const number = palette.find(color);
  if (number !== 0) {
    for (let i = 0; i < length; i++) if (codes[i] >>> COLOR_SHIFT === number) codes[i] &= STYLE_BITS;
  }
  return stored(codes, palette);
}

/**
 * The spans after characters [start, end) of a text `length` long were replaced by `inserted`
 * characters in `style` (bold and so on, and a color of their own if it names one).
 */
export function replaceRange(
  spans: readonly TextSpan[] | undefined,
  length: number,
  start: number,
  end: number,
  inserted: number,
  style: Partial<TypingStyle> = PLAIN,
): TextSpan[] | undefined {
  const palette = new Palette();
  const before = toCodes(spans, length, palette);
  const from = Math.max(0, Math.min(length, start));
  const to = Math.max(from, Math.min(length, end));
  const codes = new Uint32Array(length - (to - from) + inserted);
  codes.set(before.subarray(0, from), 0);
  codes.fill(((palette.numberOf(style.color) << COLOR_SHIFT) | bitsOf(style)) >>> 0, from, from + inserted);
  codes.set(before.subarray(to), from + inserted);
  return stored(codes, palette);
}

export function sameSpans(a: readonly TextSpan[] | undefined, b: readonly TextSpan[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
