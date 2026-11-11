// Text boxes in downloads: /FreeText annotations whose appearance stream draws the text as the
// viewer showed it: the same lines (the viewer sends how it wrapped them), in Helvetica (one of
// the PDF standard fonts, so nothing is embedded; Arial on screen has the same metrics), on the
// same baselines, aligned and justified the same way, upright on pages with any /Rotate.
import { PDFHexString, PDFName, PDFNumber, PDFString, StandardFontEmbedder, type PDFContext, type PDFPage, type PDFRef } from '@cantoo/pdf-lib';
import { inkShades } from '../shared/colors';
import { invertMatrix, pageGeometry, pageRectToPdf, round2, textBoxRect, type Matrix, type PageGeometry } from '../shared/drawingGeometry';
import { TEXT_BASELINE, TEXT_LINE_HEIGHT, TEXT_PAD_X, TEXT_PAD_Y, type TextDrawing, type TextLayout } from '../shared/drawings';

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique';

function fontNameOf(style: Pick<TextDrawing, 'bold' | 'italic'>): FontName {
  if (style.bold && style.italic) return 'Helvetica-BoldOblique';
  if (style.bold) return 'Helvetica-Bold';
  if (style.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
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

/** Width of text in points at a font size. */
export function textWidth(text: string, style: Pick<TextDrawing, 'bold' | 'italic' | 'size'>): number {
  return (encodeText(text, fontNameOf(style)).width * style.size) / 1000;
}

/**
 * Wraps text like the viewer does (white-space: pre-wrap; overflow-wrap: break-word): breaks
 * after spaces and hyphens, spaces at a break stay on the line before (and take no room), a word
 * longer than the line is split. Used when the viewer sent no usable layout.
 */
export function wrapText(text: string, style: Pick<TextDrawing, 'bold' | 'italic' | 'size'>, contentWidth?: number): string[] {
  const lines: string[] = [];
  const fits = (s: string) => contentWidth === undefined || textWidth(s.trimEnd(), style) <= contentWidth + 0.01;
  for (const paragraph of text.split('\n')) {
    if (contentWidth === undefined) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (const token of paragraph.match(/ +|[^ -]+-+(?=[^ -])|[^ ]+/g) ?? []) {
      if (token.startsWith(' ') || fits(line + token)) {
        line += token;
        continue;
      }
      if (line.trim() !== '') {
        lines.push(line);
        line = '';
      }
      // A word wider than the line: as many characters as fit (at least one) per line.
      let rest = token;
      while (!fits(line + rest)) {
        const chars = [...rest];
        let n = chars.length - 1;
        while (n > 1 && !fits(line + chars.slice(0, n).join(''))) n--;
        lines.push(line + chars.slice(0, n).join(''));
        line = '';
        rest = chars.slice(n).join('');
      }
      line += rest;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Splits the text into the viewer's lines, telling which of them end a paragraph (those are not
 * justified). Undefined if the lines are not exactly the text (then the export wraps it itself).
 */
export function matchLines(text: string, lines: string[]): { line: string; last: boolean }[] | undefined {
  const result: { line: string; last: boolean }[] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!text.startsWith(line, pos)) return undefined;
    pos += line.length;
    const hard = text[pos] === '\n';
    if (hard) pos++;
    result.push({ line, last: hard || i === lines.length - 1 });
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
  font: FontName;
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
  const font = fontNameOf(text);
  const size = text.size;
  const lineHeight = size * TEXT_LINE_HEIGHT;
  const contentWidth = text.boxWidth !== undefined ? Math.max(1, text.boxWidth - 2 * TEXT_PAD_X) : undefined;
  const matched = layout && layout.id === text.id ? matchLines(text.text, layout.lines) : undefined;
  const lines = matched ?? matchLines(text.text, wrapText(text.text, text, contentWidth)) ?? [{ line: text.text, last: true }];
  const encoded = lines.map(({ line }) => encodeText(line.replace(/ +$/, ''), font));
  const natural = encoded.map((e) => (e.width * size) / 1000);
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
  const ops: string[] = ['q', `${cm.map(fmt).join(' ')} cm`, `${color} rg`, 'BT', `/F0 ${fmt(size)} Tf`];
  const underlines: string[] = [];
  lines.forEach(({ line, last }, i) => {
    const trimmed = line.replace(/ +$/, '');
    const y = height - TEXT_PAD_Y - i * lineHeight - TEXT_BASELINE * size;
    const spaces = (trimmed.match(/ /g) ?? []).length - (trimmed.match(/^ +/)?.[0].length ?? 0);
    const justify = text.align === 'justify' && !last && spaces > 0 && natural[i] < inner;
    let x = TEXT_PAD_X;
    if (text.align === 'center') x += (inner - natural[i]) / 2;
    else if (text.align === 'right') x += inner - natural[i];
    const wordSpacing = justify ? (inner - natural[i]) / spaces : 0;
    const hex = encoded[i].codes.map((code) => code.toString(16).padStart(2, '0')).join('');
    ops.push(`${fmt(wordSpacing)} Tw`, `1 0 0 1 ${fmt(x)} ${fmt(y)} Tm`, `<${hex}> Tj`);
    if (text.underline && trimmed.length > 0) {
      const lineWidth = justify ? inner : natural[i];
      underlines.push(`${fmt(x)} ${fmt(y - 0.125 * size)} ${fmt(lineWidth)} ${fmt(0.05 * size)} re f`);
    }
  });
  ops.push('ET', ...underlines, 'Q');
  const rect = pageRectToPdf(page, box).map(round2) as [number, number, number, number];
  return { rect, ops: ops.join('\n'), font, replaced: encoded.reduce((n, e) => n + e.replaced, 0), lines: lines.map((l) => l.line) };
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
  let fontRef = fonts.get(appearance.font);
  if (!fontRef) {
    fontRef = context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: appearance.font, Encoding: 'WinAnsiEncoding' }));
    fonts.set(appearance.font, fontRef);
  }
  const stream = context.register(
    context.stream(appearance.ops, { Type: 'XObject', Subtype: 'Form', BBox: appearance.rect, Resources: { Font: { F0: fontRef } } }),
  );
  const light = inkShades(text.color).light;
  const [r, g, b] = hexToRgb(light);
  const style = [
    `font: ${text.italic ? 'italic ' : ''}${text.bold ? 'bold ' : ''}${fmt(text.size)}pt Helvetica,sans-serif`,
    `color:${light}`,
    `text-align:${text.align}`,
    text.underline ? 'text-decoration:underline' : '',
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
