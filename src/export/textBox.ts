// Text boxes in downloads: /FreeText annotations whose appearance stream draws the text as the
// viewer showed it: the same lines (the viewer sends how it wrapped them), in Helvetica (one of
// the PDF standard fonts, so nothing is embedded; Arial on screen has the same metrics), on the
// same baselines, aligned and justified the same way, upright on pages with any /Rotate. Bold
// and italic parts switch to Helvetica's bold and oblique faces inside a line.
import { PDFHexString, PDFName, PDFNumber, PDFString, StandardFontEmbedder, type PDFContext, type PDFPage, type PDFRef } from '@cantoo/pdf-lib';
import { inkShades } from '../shared/colors';
import { invertMatrix, pageGeometry, pageRectToPdf, round2, textBoxRect, type Matrix, type PageGeometry } from '../shared/drawingGeometry';
import { TEXT_BASELINE, TEXT_LINE_HEIGHT, TEXT_PAD_X, TEXT_PAD_Y, textStyleOf, type TextDrawing, type TextLayout } from '../shared/drawings';
import { textRuns, type TextSpan } from '../shared/richText';

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique';

/** The name each face has in an appearance stream's resources. */
const FONT_KEYS: Record<FontName, string> = { Helvetica: 'F0', 'Helvetica-Bold': 'F1', 'Helvetica-Oblique': 'F2', 'Helvetica-BoldOblique': 'F3' };

function fontNameOf(style: { bold?: boolean; italic?: boolean }): FontName {
  if (style.bold && style.italic) return 'Helvetica-BoldOblique';
  if (style.bold) return 'Helvetica-Bold';
  if (style.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/** How a text is set: its size, and either one face for all of it or the styled parts of it. */
export interface TextFace {
  size: number;
  bold?: boolean;
  italic?: boolean;
  spans?: TextSpan[];
}

const embedders = new Map<FontName, StandardFontEmbedder>();

function embedderFor(name: FontName): StandardFontEmbedder {
  let embedder = embedders.get(name);
  if (!embedder) {
    embedder = StandardFontEmbedder.for(name as Parameters<typeof StandardFontEmbedder.for>[0]);
    embedders.set(name, embedder);
  }
  return embedder;
}

interface EncodedText {
  /** WinAnsi codes, one per character. */
  codes: number[];
  /** Width in 1/1000 em (no kerning: Tj draws none either). */
  width: number;
  /** Characters the font cannot show, drawn as "?". */
  replaced: number;
}

/** Encodes text for a standard font (WinAnsi), measuring it on the way. */
export function encodeText(text: string, font: FontName): EncodedText {
  const embedder = embedderFor(font);
  const codes: number[] = [];
  let width = 0;
  let replaced = 0;
  for (const ch of text) {
    let glyph: { code: number; name: string };
    try {
      glyph = embedder.encoding.encodeUnicodeCodePoint(ch.codePointAt(0) ?? 63);
    } catch {
      glyph = embedder.encoding.encodeUnicodeCodePoint(63);
      replaced++;
    }
    codes.push(glyph.code);
    width += embedder.font.getWidthOfGlyph(glyph.name) ?? 250;
  }
  return { codes, width, replaced };
}

/** Width of text in points at a font size, in one face. */
export function textWidth(text: string, style: { size: number; bold?: boolean; italic?: boolean }): number {
  return (encodeText(text, fontNameOf(style)).width * style.size) / 1000;
}

/** Width in points of characters [from, to) of a text, each part in its own face. */
export function rangeWidth(text: string, face: TextFace, from: number, to: number): number {
  if (!face.spans) return textWidth(text.slice(from, to), face);
  let width = 0;
  for (const run of textRuns(text, face.spans, from, to)) width += encodeText(run.text, fontNameOf(run)).width;
  return (width * face.size) / 1000;
}

/**
 * Wraps text like the viewer does (white-space: pre-wrap; overflow-wrap: break-word): breaks
 * after spaces and hyphens, spaces at a break stay on the line before (and take no room), a word
 * longer than the line is split. Used when the viewer sent no usable layout.
 */
export function wrapText(text: string, face: TextFace, contentWidth?: number): string[] {
  const lines: string[] = [];
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    const base = offset;
    offset += paragraph.length + 1;
    if (contentWidth === undefined) {
      lines.push(paragraph);
      continue;
    }
    /** Whether characters [from, to) of the paragraph fit on a line (spaces at its end take no room). */
    const fits = (from: number, to: number) => {
      let end = to;
      while (end > from && /\s/.test(paragraph[end - 1])) end--;
      return rangeWidth(text, face, base + from, base + end) <= contentWidth + 0.01;
    };
    let start = 0;
    for (const match of paragraph.matchAll(/ +|[^ -]+-+(?=[^ -])|[^ ]+/g)) {
      const from = match.index;
      const to = from + match[0].length;
      if (match[0].startsWith(' ') || fits(start, to)) continue;
      if (paragraph.slice(start, from).trim() !== '') {
        lines.push(paragraph.slice(start, from));
        start = from;
      }
      // A word wider than the line: as many characters as fit (at least one) per line.
      let pos = from;
      while (!fits(start, to)) {
        const chars = [...paragraph.slice(pos, to)];
        if (chars.length <= 1) break;
        let n = chars.length - 1;
        while (n > 1 && !fits(start, pos + chars.slice(0, n).join('').length)) n--;
        pos += chars.slice(0, n).join('').length;
        lines.push(paragraph.slice(start, pos));
        start = pos;
      }
    }
    lines.push(paragraph.slice(start));
  }
  return lines;
}

export interface MatchedLine {
  line: string;
  /** Where the line starts in the text. */
  start: number;
  /** It ends a paragraph (such lines are not justified). */
  last: boolean;
}

/**
 * Splits the text into the viewer's lines, telling where each starts and which of them end a
 * paragraph. Undefined if the lines are not exactly the text (then the export wraps it itself).
 */
export function matchLines(text: string, lines: string[]): MatchedLine[] | undefined {
  const result: MatchedLine[] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!text.startsWith(line, pos)) return undefined;
    const start = pos;
    pos += line.length;
    const hard = text[pos] === '\n';
    if (hard) pos++;
    result.push({ line, start, last: hard || i === lines.length - 1 });
  }
  return pos === text.length ? result : undefined;
}

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export interface TextBoxAppearance {
  /** The annotation rectangle (PDF units). */
  rect: [number, number, number, number];
  /** The appearance stream's content. */
  ops: string;
  /** The faces the content uses (as /F0…/F3, see FONT_KEYS). */
  fonts: FontName[];
  replaced: number;
  lines: string[];
}

/** The PDF.js-equivalent geometry of a pdf-lib page (crop box within the media box, /Rotate, /UserUnit). */
export function pdfLibPageGeometry(page: PDFPage): PageGeometry {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x0 = Math.max(media.x, crop.x);
  const y0 = Math.max(media.y, crop.y);
  const x1 = Math.min(media.x + media.width, crop.x + crop.width);
  const y1 = Math.min(media.y + media.height, crop.y + crop.height);
  const view = x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : [media.x, media.y, media.x + media.width, media.y + media.height];
  const unit = page.node.get(PDFName.of('UserUnit'));
  const userUnit = unit instanceof PDFNumber ? unit.asNumber() : 1;
  return pageGeometry(view, page.getRotation().angle, userUnit);
}

/**
 * Lays out a text box and builds its appearance: lines from the viewer when they match the text
 * (else wrapped here), box width from the box itself, or from the viewer, or the longest line.
 */
export function textBoxAppearance(text: TextDrawing, page: PageGeometry, layout?: TextLayout): TextBoxAppearance {
  const size = text.size;
  const lineHeight = size * TEXT_LINE_HEIGHT;
  const face: TextFace = { size, spans: text.spans ?? [] };
  const contentWidth = text.boxWidth !== undefined ? Math.max(1, text.boxWidth - 2 * TEXT_PAD_X) : undefined;
  const matched = layout && layout.id === text.id ? matchLines(text.text, layout.lines) : undefined;
  const lines = matched ?? matchLines(text.text, wrapText(text.text, face, contentWidth)) ?? [{ line: text.text, start: 0, last: true }];
  // Each line as its runs: one face each, encoded and measured (spaces at the end of a line take no room).
  const laid = lines.map(({ line, start }) => {
    const trimmed = line.replace(/ +$/, '');
    const runs = textRuns(text.text, text.spans, start, start + trimmed.length).map((run) => {
      const font = fontNameOf(run);
      const encoded = encodeText(run.text, font);
      return {
        font,
        underline: run.underline,
        codes: encoded.codes,
        width: (encoded.width * size) / 1000,
        replaced: encoded.replaced,
        spaces: (run.text.match(/ /g) ?? []).length,
      };
    });
    return { trimmed, runs, width: runs.reduce((sum, run) => sum + run.width, 0) };
  });
  const natural = laid.map((l) => l.width);
  const width = text.boxWidth ?? (matched && layout ? layout.width : Math.max(0, ...natural) + 2 * TEXT_PAD_X);
  const height = lines.length * lineHeight + 2 * TEXT_PAD_Y;
  const inner = width - 2 * TEXT_PAD_X;

  // Box-local coordinates (origin at the bottom left of the box as shown, y up) → PDF units.
  const box = textBoxRect(page, text.points[0], width, height);
  const inv = invertMatrix(page.transform);
  const [a, b, c, d, e, f] = inv;
  const top = box[1] + height;
  const cm: Matrix = [a, b, -c, -d, a * box[0] + c * top + e, b * box[0] + d * top + f];

  const [r, g, bl] = hexToRgb(inkShades(text.color).light);
  const color = `${fmt(r)} ${fmt(g)} ${fmt(bl)}`;
  const ops: string[] = ['q', `${cm.map(fmt).join(' ')} cm`, `${color} rg`, 'BT'];
  const underlines: string[] = [];
  const fonts = new Set<FontName>();
  let current: FontName | undefined;
  let replaced = 0;
  lines.forEach(({ last }, i) => {
    const { trimmed, runs } = laid[i];
    const y = height - TEXT_PAD_Y - i * lineHeight - TEXT_BASELINE * size;
    const spaces = (trimmed.match(/ /g) ?? []).length - (trimmed.match(/^ +/)?.[0].length ?? 0);
    const justify = text.align === 'justify' && !last && spaces > 0 && natural[i] < inner;
    let x = TEXT_PAD_X;
    if (text.align === 'center') x += (inner - natural[i]) / 2;
    else if (text.align === 'right') x += inner - natural[i];
    const wordSpacing = justify ? (inner - natural[i]) / spaces : 0;
    ops.push(`${fmt(wordSpacing)} Tw`, `1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`);
    /** Where the underline being drawn started (runs next to each other share one). */
    let underlineFrom: number | undefined;
    const endUnderline = (to: number) => {
      if (underlineFrom !== undefined && to > underlineFrom) underlines.push(`${fmt(underlineFrom)} ${fmt(y - 0.125 * size)} ${fmt(to - underlineFrom)} ${fmt(0.05 * size)} re f`);
      underlineFrom = undefined;
    };
    for (const run of runs) {
      if (run.font !== current) {
        current = run.font;
        fonts.add(run.font);
        ops.push(`/${FONT_KEYS[run.font]} ${fmt(size)} Tf`);
      }
      ops.push(`<${run.codes.map((code) => code.toString(16).padStart(2, '0')).join('')}> Tj`);
      replaced += run.replaced;
      if (run.underline) underlineFrom ??= x;
      else endUnderline(x);
      x += run.width + wordSpacing * run.spaces;
    }
    endUnderline(x);
  });
  ops.push('ET', ...underlines, 'Q');
  const rect = pageRectToPdf(page, box).map(round2) as [number, number, number, number];
  return { rect, ops: ops.join('\n'), fonts: [...fonts], replaced, lines: lines.map((l) => l.line) };
}

const QUADDING = { left: 0, center: 1, right: 2, justify: 0 } as const;

/**
 * Builds the /FreeText annotation of a text box (the caller adds it to the page). Returns it and
 * how many characters had to be drawn as "?".
 */
export function textBoxAnnotation(
  context: PDFContext,
  page: PDFPage,
  text: TextDrawing,
  layout: TextLayout | undefined,
  fonts: Map<FontName, PDFRef>,
  common: Record<string, unknown>,
): { ref: PDFRef; replaced: number } {
  const appearance = textBoxAppearance(text, pdfLibPageGeometry(page), layout);
  const fontDict: Record<string, PDFRef> = {};
  for (const name of appearance.fonts) {
    let fontRef = fonts.get(name);
    if (!fontRef) {
      fontRef = context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: name, Encoding: 'WinAnsiEncoding' }));
      fonts.set(name, fontRef);
    }
    fontDict[FONT_KEYS[name]] = fontRef;
  }
  const stream = context.register(context.stream(appearance.ops, { Type: 'XObject', Subtype: 'Form', BBox: appearance.rect, Resources: { Font: fontDict } }));
  const light = inkShades(text.color).light;
  const [r, g, b] = hexToRgb(light);
  // The default style, for programs that lay the text out again: what all of the text has.
  const whole = textStyleOf(text);
  const style = [
    `font: ${whole.italic ? 'italic ' : ''}${whole.bold ? 'bold ' : ''}${fmt(text.size)}pt Helvetica,sans-serif`,
    `color:${light}`,
    `text-align:${text.align}`,
    whole.underline ? 'text-decoration:underline' : '',
  ].filter(Boolean);
  const ref = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: appearance.rect,
      Contents: PDFHexString.fromText(text.text),
      DA: PDFString.of(`/Helv ${fmt(text.size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg`),
      DS: PDFString.of(style.join('; ')),
      Q: QUADDING[text.align],
      BS: { Type: 'Border', W: 0 },
      ...common,
      AP: { N: stream },
    }),
  );
  return { ref, replaced: appearance.replaced };
}
