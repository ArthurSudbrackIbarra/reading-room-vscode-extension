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

/** The Draw toggle: a pencil at 45°, above the band (in the current ink). */
export function drawIcon(): SVGSVGElement {
  return icon16(
    [
      ['path', { ...STROKE, d: 'M11.1.9 13.7 3.5 6.4 10.8 2.6 11.9 3.7 8.1Z' }],
      ['path', { ...STROKE, d: 'M9.5 2.5 12.1 5.1M3.7 8.1 6.4 10.8' }],
      BAND,
    ],
    'mpv-band-icon',
  );
}

/** The Text toggle: a "T" above the band (in the current text color). */
export function textIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, 'stroke-width': '1.5', d: 'M3.3 2.2h9.4M8 2.2v9.1' }], BAND], 'mpv-band-icon');
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

/** The eraser of the toolbar (it deletes whole things): a block at 45° on a line. */
export function eraserIcon(): SVGSVGElement {
  return icon16([
    ['path', { ...STROKE, d: 'M5.8 13.1 2.1 9.4 8.6 2.9 12.3 6.6Z' }],
    ['path', { ...STROKE, d: 'M4.7 6.8 8.4 10.5M5.8 13.1h8.1' }],
  ]);
}

/** The eraser of the drawing bar (it rubs out part of a drawing): the block, on a pen stroke with a gap. */
export function rubberIcon(): SVGSVGElement {
  return icon16([
    ['path', { ...STROKE, d: 'M6.6 11.3 2.9 7.6 8.6 1.9 12.3 5.6Z' }],
    ['path', { ...STROKE, d: 'M5.1 5.4 8.8 9.1' }],
    ['path', { ...STROKE, d: 'M1.5 13.6c.8-.9 1.6-.9 2.4-.1M10.3 13.4c.9.8 1.7.9 2.5.1s1.3-.9 1.9-.4' }],
  ]);
}

/** The names of the mode bars, as icons: a pencil for the drawing tools, a T for the text tools. */
export function pencilIcon(): SVGSVGElement {
  return icon16([
    ['path', { ...STROKE, d: 'M11.1 2.4 13.1 4.4 5.4 12.1 2.4 13.1 3.4 10.1Z' }],
    ['path', { ...STROKE, d: 'M9.6 3.9 11.6 5.9' }],
  ]);
}

export function letterIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, 'stroke-width': '1.5', d: 'M3.3 3.4h9.4M8 3.4v9.4' }]]);
}

const WIDTH_PX: Record<InkWidth, string> = { thin: '1', medium: '2', thick: '4' };

/** A stroke width: a horizontal line of 1, 2 or 4 px. */
export function widthIcon(width: InkWidth): SVGSVGElement {
  return icon16([['path', { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-width': WIDTH_PX[width], d: 'M3 8h10' }]]);
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

/** A small chevron for buttons that open a menu or a picker. */
export function chevronIcon(): SVGSVGElement {
  return svg('0 0 10 10', 10, [['path', { ...STROKE, 'stroke-width': '1.2', d: 'M2.6 3.8 5 6.2l2.4-2.4' }]], 'mpv-chevron');
}

export function checkIcon(): SVGSVGElement {
  return icon16([['path', { ...STROKE, 'stroke-width': '1.6', d: 'M3.2 8.4 6.4 11.6 12.8 4.6' }]]);
}
