// Custom icons, drawn as inline SVG with DOM APIs: the CSP allows no markup strings and no
// inline style attributes. The toolbar icons are 16×16, use currentColor and one stroke weight
// (close to the codicons'), so they look like one set. Colors that change (the highlight band,
// the ink) come from CSS variables.
import type { DrawingTool, InkWidth, TextAlign } from '../src/shared/drawings';

const SVG_NS = 'http://www.w3.org/2000/svg';
export type SvgPart = [tag: string, attrs: Record<string, string>];

export function svg(viewBox: string, size: number, parts: SvgPart[], className?: string): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  if (className) el.setAttribute('class', className);
  for (const [tag, attrs] of parts) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    el.append(child);
  }
  return el;
}

/** A 16×16 toolbar icon. */
function icon16(parts: SvgPart[], className = ''): SVGSVGElement {
  return svg('0 0 16 16', 16, parts, `mpv-svg-icon ${className}`.trim());
}

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** The colored band under the three mode icons: the highlight color, the ink, the text color. */
const BAND: SvgPart = ['rect', { class: 'mpv-icon-band', x: '1.3', y: '12.9', width: '13.4', height: '2.3', rx: '.7' }];

/** The highlight tool: a highlighter marker with a wide chisel tip, at 45°, above the band. */
export function highlighterIcon(): SVGSVGElement {
  return icon16(
    [
      ['path', { ...STROKE, d: 'M6.1 0.2h3.8a.9.9 0 0 1 .9.9V7H5.2V1.1a.9.9 0 0 1 .9-.9Z', transform: 'rotate(45 8.2 6.8)' }],
      ['path', { fill: 'currentColor', d: 'M5.2 7.5h5.6l-1 2.9-3.7 1.2Z', transform: 'rotate(45 8.2 6.8)' }],
      BAND,
    ],
    'mpv-band-icon',
  );
}

/**
 * The Draw toggle: a pencil at 45°, above the band (in the current ink). Its tip ends as far above
 * the band as the highlighter's does: the three icons with a band keep the same clear space over it.
 */
export function drawIcon(): SVGSVGElement {
  return icon16(
    [['path', { ...STROKE, d: 'M10.35.9 12.95 3.5 7.15 9.3 3.35 10.4 4.45 6.6Z' }], ['path', { ...STROKE, d: 'M8.75 2.5 11.35 5.1M4.45 6.6 7.15 9.3' }], BAND],
    'mpv-band-icon',
  );
}

/** The Text toggle: "Aa", a capital A and a small a, above the band (in the current text color). */
export function textIcon(): SVGSVGElement {
  return icon16(
    [['path', { ...STROKE, d: 'M1.1 10.55 4.5 1.15l3.4 9.4M2.3 7.35h4.4' }], ['path', { ...STROKE, d: 'M14.6 5.15v5.4M14.6 7.95a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0Z' }], BAND],
    'mpv-band-icon',
  );
}

/**
 * The − and + of the zoom. (The codicons' glyphs are not in the middle of their 16 px box: their ink
 * starts 0.75 px from its left edge and ends 2 px from its right one.)
 */
export function minusIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, d: 'M2 8h12' }]]);
}

export function plusIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, d: 'M2 8h12M8 2v12' }]]);
}

/** A text box in the list: one "A", in the color of its text. */
export function letterIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, 'stroke-width': '1.5', d: 'M3.6 13 8 2.6 12.4 13M5.3 9.2h5.4' }]]);
}

const TOOL_ICONS: Record<DrawingTool, SvgPart[]> = {
  pen: [['path', { ...STROKE, d: 'M1.8 9.9c1.5-5.2 3.3-5.2 4.3-1.7s2.4 4.2 3.8.1 2.8-4.4 4.3-1.3' }]],
  line: [['path', { ...STROKE, 'stroke-width': '1.5', d: 'M3.2 12.8 12.8 3.2' }]],
  arrow: [['path', { ...STROKE, 'stroke-width': '1.4', d: 'M3.2 12.8 12.6 3.4M7.6 3.2h5.2v5.2' }]],
  rect: [['rect', { ...STROKE, x: '1.9', y: '4.1', width: '12.2', height: '7.8', rx: '1' }]],
  ellipse: [['ellipse', { ...STROKE, cx: '8', cy: '8', rx: '6.2', ry: '4.3' }]],
};

export function toolIcon(tool: DrawingTool): SVGSVGElement {
  return icon16(TOOL_ICONS[tool]);
}

/** An 18×18 toolbar icon: one that has no band under it and needs the room (the same stroke, 1 unit is 1 px). */
function icon18(parts: SvgPart[]): SVGSVGElement {
  return svg('0 0 18 18', 18, parts, 'mpv-svg-icon');
}

/**
 * The select tool of the toolbar (click or drag around annotations to select them): the dashed
 * frame that is dragged around them, and the pointer that drags it, at the corner it ends in.
 * Only the two thin tips of the pointer reach the right and bottom edges, so the drawing is
 * centered by what is seen of it, not by its outline: the frame, which is most of what is seen,
 * starts 2.7 px in from the left, and the tip of the pointer ends at the right edge.
 */
export function selectIcon(): SVGSVGElement {
  return icon18([
    // The frame: its three corners and a dash on each side. The fourth corner is under the pointer.
    ['path', { ...STROKE, d: 'M3.35 4.5V3.65a1.3 1.3 0 0 1 1.3-1.3h.85M12.2 2.35h.85a1.3 1.3 0 0 1 1.3 1.3v.85M5.5 13.35h-.85a1.3 1.3 0 0 1-1.3-1.3v-.85' }],
    ['path', { ...STROKE, d: 'M7.9 2.35h1.9M3.35 6.9v1.9M14.35 6.9v1M7.9 13.35h1' }],
    ['path', { ...STROKE, fill: 'currentColor', 'stroke-width': '1.1', d: 'M10.4 9.5 17.4 12.1 14.3 13.5 13 17Z' }],
  ]);
}

/**
 * The translate tool of the toolbar: a Japanese character and, a step lower and to the right, a
 * Latin one.
 */
export function translateIcon(): SVGSVGElement {
  return icon18([
    // 文: the dot, the bar, and the two strokes that cross under it.
    ['path', { ...STROKE, d: 'M5.4 1.5v1.7M1.6 3.6h7.6M7.5 3.8C7 6.7 4.7 9 1.7 10M3.3 3.8c.6 2.9 2.9 5.2 5.9 6.2' }],
    ['path', { ...STROKE, d: 'M9.7 16.5 13.2 8.3l3.5 8.2M11 13.6h4.4' }],
  ]);
}

/** The eyedropper of the color picker: a pipette at 45°, its tip at the bottom left. */
export function eyedropperIcon(): SVGSVGElement {
  return icon16([
    ['path', { ...STROKE, d: 'M2.5 13.5 3.3 11.1 8.9 5.5 10.5 7.1 4.9 12.7Z' }],
    ['path', { ...STROKE, d: 'M7.8 4.4 11.6 8.2' }],
    ['path', { ...STROKE, d: 'M10.8 7.4 12.9 5.3a1.55 1.55 0 0 0-2.2-2.2L8.6 5.2' }],
  ]);
}

/** The eraser of the drawing bar (it rubs out part of a drawing): a block at 45°, on a pen stroke with a gap. */
export function rubberIcon(): SVGSVGElement {
  return icon16([
    ['path', { ...STROKE, d: 'M6.6 11.3 2.9 7.6 8.6 1.9 12.3 5.6Z' }],
    ['path', { ...STROKE, d: 'M5.1 5.4 8.8 9.1' }],
    ['path', { ...STROKE, d: 'M1.5 13.6c.8-.9 1.6-.9 2.4-.1M10.3 13.4c.9.8 1.7.9 2.5.1s1.3-.9 1.9-.4' }],
  ]);
}

const WIDTH_PX: Record<InkWidth, string> = { thin: '1', medium: '2', thick: '4' };

/** A stroke width: a horizontal line of 1, 2 or 4 px. */
export function widthIcon(width: InkWidth): SVGSVGElement {
  return icon16([['path', { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-width': WIDTH_PX[width], d: 'M3 8h10' }]]);
}

const SIZE_R: Record<InkWidth, string> = { thin: '1.9', medium: '3.5', thick: '5.6' };

/** A size of the eraser: a circle, small, medium or large. */
export function sizeIcon(width: InkWidth): SVGSVGElement {
  return icon16([['circle', { ...STROKE, cx: '8', cy: '8', r: SIZE_R[width] }]]);
}

export function boldIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, 'stroke-width': '1.8', d: 'M4.6 2.6h4a2.5 2.5 0 0 1 0 5h-4ZM4.6 7.6h4.6a2.9 2.9 0 0 1 0 5.8H4.6Z' }]]);
}

export function italicIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, d: 'M7.2 2.6h5M3.8 13.4h5M9.7 2.6 6.3 13.4' }]]);
}

export function underlineIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, d: 'M4.6 2.2v5.1a3.4 3.4 0 0 0 6.8 0V2.2M3.4 14.1h9.2' }]]);
}

const ALIGN_LINES: Record<TextAlign, string> = {
  left: 'M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8',
  center: 'M2 3.5h12M4 6.5h8M2 9.5h12M4 12.5h8',
  right: 'M2 3.5h12M6 6.5h8M2 9.5h12M6 12.5h8',
  justify: 'M2 3.5h12M2 6.5h12M2 9.5h12M2 12.5h12',
};

export function alignIcon(align: TextAlign): SVGSVGElement {
  return icon16([['path', { ...STROKE, d: ALIGN_LINES[align] }]]);
}

/** The chevron of everything that opens a menu or a picker: 8 px wide, in a box as tall as an icon. */
export function chevronIcon(): SVGSVGElement {
  const el = svg('0 0 8 16', 16, [['path', { ...STROKE, d: 'M1 6.5l3 3 3-3' }]], 'mpv-chevron');
  el.setAttribute('width', '8');
  return el;
}

/** The mark of Reading Room: an open book in outline, with the red ribbon. */
export function bookIcon(size = 16): SVGSVGElement {
  return svg(
    '0 0 16 16',
    size,
    [
      [
        'path',
        { ...STROKE, 'stroke-width': size > 24 ? '1' : '1.3', d: 'M8 4.3C6.3 3.2 4.2 3 2 3.5v8.8c2.2-.5 4.3-.3 6 .8 1.7-1.1 3.8-1.3 6-.8V3.5c-2.2-.5-4.3-.3-6 .8Zm0 0v8.8' },
      ],
      ['path', { class: 'mpv-book-ribbon', d: 'M10 2.2h2.6v6.2l-1.3-1.2L10 8.4Z' }],
    ],
    'mpv-book',
  );
}

const PAGE: SvgPart[] = [
  ['path', { ...STROKE, d: 'M3.4 1.7h5.8l3.4 3.4v9.2H3.4Z' }],
  ['path', { ...STROKE, d: 'M9.2 1.7v3.4h3.4' }],
];

/**
 * A page for the two downloads. With annotations: a highlighted line and a pen stroke on it, in
 * their own colors. Without: the page with nothing but its lines of text.
 */
export function pageIcon(annotated: boolean): SVGSVGElement {
  const lines: SvgPart[] = annotated
    ? [
        ['rect', { class: 'mpv-page-mark', x: '5.2', y: '6.8', width: '5.6', height: '2.4', rx: '.5' }],
        ['path', { class: 'mpv-page-pen', fill: 'none', 'stroke-width': '1.3', 'stroke-linecap': 'round', d: 'M5.4 11.6c.9-.9 1.7-.9 2.6 0s1.7.9 2.6 0' }],
      ]
    : [['path', { ...STROKE, 'stroke-width': '1', d: 'M5.6 8.2h4.8M5.6 10.4h4.8M5.6 12.6h2.6' }]];
  return icon16([...PAGE, ...lines]);
}

export function checkIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, 'stroke-width': '1.6', d: 'M3.2 8.4 6.4 11.6 12.8 4.6' }]]);
}
