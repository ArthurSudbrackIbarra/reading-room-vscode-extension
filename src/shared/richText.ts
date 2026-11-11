// Bold, italic and underline inside a text box: which characters have which. A text box stores
// its text and, for the styled parts, spans of character offsets. Shared by the viewer (showing,
// typing) and the export. No runtime dependencies.

export const CHAR_STYLES = ['bold', 'italic', 'underline'] as const;
export type CharStyleName = (typeof CHAR_STYLES)[number];
/** The style of one character (or of what is typed next). */
export type CharStyle = Record<CharStyleName, boolean>;

export const PLAIN: CharStyle = { bold: false, italic: false, underline: false };

/** A styled stretch of a text: characters [start, end) (UTF-16 offsets), with at least one style. */
export interface TextSpan {
  start: number;
  end: number;
  bold?: true;
  italic?: true;
  underline?: true;
}

/** A stretch of text in one style; the runs of a text cover all of it, in order. */
export interface TextRun extends CharStyle {
  start: number;
  end: number;
  text: string;
}

const BIT: Record<CharStyleName, number> = { bold: 1, italic: 2, underline: 4 };

function bitsOf(style: Partial<CharStyle>): number {
  return (style.bold ? 1 : 0) | (style.italic ? 2 : 0) | (style.underline ? 4 : 0);
}

function styleOf(bits: number): CharStyle {
  return { bold: (bits & 1) !== 0, italic: (bits & 2) !== 0, underline: (bits & 4) !== 0 };
}

/** One number per character: its styles as bits. */
function toBits(spans: readonly TextSpan[] | undefined, length: number): Uint8Array {
  const bits = new Uint8Array(length);
  for (const span of spans ?? []) {
    const value = bitsOf(span);
    const end = Math.min(length, span.end);
    for (let i = Math.max(0, span.start); i < end; i++) bits[i] |= value;
  }
  return bits;
}

function fromBits(bits: Uint8Array): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;
  for (let i = 1; i <= bits.length; i++) {
    if (i < bits.length && bits[i] === bits[start]) continue;
    const value = bits[start];
    if (value !== 0) {
      const span: TextSpan = { start, end: i };
      if (value & 1) span.bold = true;
      if (value & 2) span.italic = true;
      if (value & 4) span.underline = true;
      spans.push(span);
    }
    start = i;
  }
  return spans;
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Spans from untrusted input (or after the text got shorter), as stored: inside the text, sorted,
 * not overlapping, merged, each with a style. Undefined when nothing is styled.
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
    if (span.bold || span.italic || span.underline) clean.push(span);
  }
  const spans = fromBits(toBits(clean, length));
  return spans.length > 0 ? spans : undefined;
}

/** The style of the character at `offset` (plain beyond the text). */
export function styleAt(spans: readonly TextSpan[] | undefined, offset: number): CharStyle {
  let bits = 0;
  for (const span of spans ?? []) if (offset >= span.start && offset < span.end) bits |= bitsOf(span);
  return styleOf(bits);
}

/** The text cut into stretches of one style each. An empty text has no runs. */
export function textRuns(text: string, spans: readonly TextSpan[] | undefined, from = 0, to = text.length): TextRun[] {
  const bits = toBits(spans, text.length);
  const runs: TextRun[] = [];
  let start = from;
  for (let i = from + 1; i <= to; i++) {
    if (i < to && bits[i] === bits[start]) continue;
    if (i > start) runs.push({ start, end: i, text: text.slice(start, i), ...styleOf(bits[start]) });
    start = i;
  }
  return runs;
}

/**
 * The styles every character of [start, end) has (line breaks do not count: they show none).
 * A stretch without characters has none.
 */
export function rangeStyle(text: string, spans: readonly TextSpan[] | undefined, start: number, end: number): CharStyle {
  const bits = toBits(spans, text.length);
  let all = 7;
  let counted = 0;
  for (let i = Math.max(0, start); i < Math.min(text.length, end); i++) {
    if (text[i] === '\n') continue;
    all &= bits[i];
    counted++;
  }
  return styleOf(counted === 0 ? 0 : all);
}

/** Sets or clears styles on [start, end). */
export function styleRange(spans: readonly TextSpan[] | undefined, length: number, start: number, end: number, patch: Partial<CharStyle>): TextSpan[] | undefined {
  const bits = toBits(spans, length);
  let set = 0;
  let clear = 0;
  for (const name of CHAR_STYLES) {
    if (patch[name] === true) set |= BIT[name];
    else if (patch[name] === false) clear |= BIT[name];
  }
  for (let i = Math.max(0, start); i < Math.min(length, end); i++) bits[i] = (bits[i] | set) & ~clear;
  const next = fromBits(bits);
  return next.length > 0 ? next : undefined;
}

/**
 * The spans after characters [start, end) of a text `length` long were replaced by `inserted`
 * characters in `style`.
 */
export function replaceRange(
  spans: readonly TextSpan[] | undefined,
  length: number,
  start: number,
  end: number,
  inserted: number,
  style: Partial<CharStyle> = PLAIN,
): TextSpan[] | undefined {
  const before = toBits(spans, length);
  const from = Math.max(0, Math.min(length, start));
  const to = Math.max(from, Math.min(length, end));
  const bits = new Uint8Array(length - (to - from) + inserted);
  bits.set(before.subarray(0, from), 0);
  bits.fill(bitsOf(style), from, from + inserted);
  bits.set(before.subarray(to), from + inserted);
  const next = fromBits(bits);
  return next.length > 0 ? next : undefined;
}

export function sameSpans(a: readonly TextSpan[] | undefined, b: readonly TextSpan[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
