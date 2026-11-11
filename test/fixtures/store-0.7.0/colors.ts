// Fixture: src/shared/colors.ts as released in 0.7.0 (git show 19c381c), unchanged except for import paths.
// Colors of drawings and text boxes ("inks"). An ink is either a preset, stored by name and drawn
// in a hand-picked shade for light pages and another for dark pages, or any color the reader
// picked, stored as #RRGGBB and drawn lighter on dark pages when it is too dark to see there.
// Downloads always have light pages, so they use the light shade. No runtime dependencies.

export const INK_PRESETS = ['black', 'gray', 'white', 'brown', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type InkPreset = (typeof INK_PRESETS)[number];
/** A color the reader picked, always written as #RRGGBB (upper case). */
export type HexColor = `#${string}`;
export type Ink = InkPreset | HexColor;

export const DEFAULT_INK: Ink = 'red';

/** The two shades of each preset: on light pages and on dark pages. */
export const INK_PRESET_SHADES: Record<InkPreset, { light: string; dark: string }> = {
  black: { light: '#1F2328', dark: '#E6EDF3' },
  gray: { light: '#6E7781', dark: '#9BA3AC' },
  // White is white on any page (on a white page it covers what is under it).
  white: { light: '#FFFFFF', dark: '#FFFFFF' },
  brown: { light: '#8A5A2B', dark: '#C99A6B' },
  red: { light: '#D1242F', dark: '#FF7B72' },
  orange: { light: '#BC4C00', dark: '#F0883E' },
  yellow: { light: '#C99A06', dark: '#F2CC60' },
  green: { light: '#1A7F37', dark: '#3FB950' },
  teal: { light: '#0B7F87', dark: '#39C5CF' },
  blue: { light: '#0969DA', dark: '#58A6FF' },
  purple: { light: '#8250DF', dark: '#BC8CFF' },
  pink: { light: '#BF3989', dark: '#F778BA' },
};

export const INK_PRESET_NAMES: Record<InkPreset, string> = {
  black: 'Black',
  gray: 'Gray',
  white: 'White',
  brown: 'Brown',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
};

/** Most custom colors remembered as "recent" in the color picker. */
export const MAX_RECENT_COLORS = 6;

export function isInkPreset(value: unknown): value is InkPreset {
  return typeof value === 'string' && (INK_PRESETS as readonly string[]).includes(value);
}

/** "#abc", "#AABBCC" or "aabbcc" → "#AABBCC"; anything else → undefined. */
export function normalizeHex(value: unknown): HexColor | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return undefined;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${digits.toUpperCase()}`;
}

/** A preset, or a custom color in the stored form (#RRGGBB). */
export function isInk(value: unknown): value is Ink {
  return isInkPreset(value) || (typeof value === 'string' && /^#[0-9A-F]{6}$/.test(value));
}

/** Checks an ink from disk or from a viewer: a preset, or a color normalized to #RRGGBB. */
export function sanitizeInk(value: unknown): Ink | undefined {
  return isInkPreset(value) ? value : normalizeHex(value);
}

/** The name shown for an ink: "Red", or the color itself ("#1F77B4"). */
export function inkName(ink: Ink): string {
  return isInkPreset(ink) ? INK_PRESET_NAMES[ink] : ink;
}

/** The color of an ink on light pages and on dark pages. */
export function inkShades(ink: Ink): { light: string; dark: string } {
  if (isInkPreset(ink)) return INK_PRESET_SHADES[ink];
  const light = normalizeHex(ink) ?? INK_PRESET_SHADES.black.light;
  return { light, dark: darkPageShade(light) };
}

// ---------- Conversions ----------

export type Rgb = [r: number, g: number, b: number];

export function hexToRgb(hex: string): Rgb {
  const value = parseInt((normalizeHex(hex) ?? '#000000').slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex([r, g, b]: Rgb): HexColor {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase() as HexColor;
}

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export function rgbToHsv([r, g, b]: Rgb): [h: number, s: number, v: number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const d = max - Math.min(rr, gg, bb);
  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(c: number): number {
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
}

/** sRGB → OKLab (L in [0, 1]). */
export function rgbToOklab([r, g, b]: Rgb): [L: number, a: number, b: number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear sRGB (may be outside [0, 1] when the color is out of gamut). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Below this OKLab lightness a color is too dark for dark pages (#0D1117). */
const DARK_PAGE_MIN_L = 0.72;

/**
 * The shade of a custom color on dark pages: colors that would be hard to see there get lighter
 * (the darker they are, the lighter they get: black becomes almost white), keeping their hue and
 * as much of their saturation as sRGB allows. Light colors stay as they are.
 */
export function darkPageShade(hex: string): HexColor {
  const color = normalizeHex(hex) ?? '#000000';
  const [L, a, b] = rgbToOklab(hexToRgb(color));
  if (L >= DARK_PAGE_MIN_L) return color as HexColor;
  const target = DARK_PAGE_MIN_L + (DARK_PAGE_MIN_L - L) * 0.35;
  const inGamut = (k: number) => oklabToLinear(target, a * k, b * k).every((c) => c >= -1e-4 && c <= 1 + 1e-4);
  let k = 1;
  if (!inGamut(1)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  const linear = oklabToLinear(target, a * k, b * k);
  return rgbToHex(linear.map(fromLinear) as Rgb);
}
