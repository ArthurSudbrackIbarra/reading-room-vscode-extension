// Inks: presets with a hand-picked shade per page theme, or any color, drawn lighter on dark
// pages when it would be hard to see there.
import { describe, expect, it } from 'vitest';
import {
  INK_PRESETS,
  INK_PRESET_SHADES,
  darkPageShade,
  hexToRgb,
  hsvToRgb,
  inkName,
  inkShades,
  isInk,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  rgbToOklab,
  sanitizeInk,
} from '../../src/shared/colors';

/** WCAG contrast ratio of two colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = hexToRgb(hex).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const DARK_PAGE = '#0D1117';

describe('inks', () => {
  it('are presets or #RRGGBB colors', () => {
    for (const preset of INK_PRESETS) expect(isInk(preset)).toBe(true);
    expect(isInk('#1F77B4')).toBe(true);
    expect(isInk('#1f77b4')).toBe(false); // stored form only; sanitizeInk normalizes
    expect(sanitizeInk('#1f77b4')).toBe('#1F77B4');
    expect(sanitizeInk('1f77b4')).toBe('#1F77B4');
    expect(sanitizeInk('#fff')).toBe('#FFFFFF');
    for (const bad of ['', 'navy', '#12345', '#1234567', 'rgb(0,0,0)', 12, undefined]) expect(sanitizeInk(bad)).toBeUndefined();
    expect(normalizeHex(' #AbC ')).toBe('#AABBCC');
  });

  it('are named by preset, or by their color', () => {
    expect(inkName('teal')).toBe('Teal');
    expect(inkName('#1F77B4')).toBe('#1F77B4');
  });

  it('use the hand-picked shades of presets, and a custom color as it is on light pages', () => {
    expect(inkShades('red')).toEqual(INK_PRESET_SHADES.red);
    expect(inkShades('#1F77B4').light).toBe('#1F77B4');
  });

  it('presets are readable on both page themes', () => {
    for (const preset of INK_PRESETS) {
      const { light, dark } = INK_PRESET_SHADES[preset];
      // (White is for covering things on a white page, and for dark pictures.)
      if (preset !== 'white') expect(contrast(light, '#FFFFFF'), `${preset} on white`).toBeGreaterThanOrEqual(preset === 'yellow' ? 2 : 3);
      expect(contrast(dark, DARK_PAGE), `${preset} on dark`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('custom colors on dark pages', () => {
  it('get lighter when they are dark, keeping their hue', () => {
    for (const color of ['#000000', '#1F3A93', '#7B1FA2', '#8B0000', '#004D40', '#333333']) {
      const dark = darkPageShade(color);
      expect(contrast(dark, DARK_PAGE), color).toBeGreaterThanOrEqual(5);
      expect(rgbToOklab(hexToRgb(dark))[0], color).toBeGreaterThan(rgbToOklab(hexToRgb(color))[0]);
      const [h1, s1] = rgbToHsv(hexToRgb(color));
      const [h2] = rgbToHsv(hexToRgb(dark));
      if (s1 > 0.2) expect(Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2)), color).toBeLessThan(25);
    }
    expect(darkPageShade('#000000')).toMatch(/^#F[0-9A-F]F[0-9A-F]F[0-9A-F]$/);
  });

  it('stay as they are when they are light enough', () => {
    for (const color of ['#FFFFFF', '#FFD33D', '#7EE787', '#A5D6FF']) expect(darkPageShade(color)).toBe(color);
  });
});

describe('color conversions', () => {
  it('go from hex to HSV and back', () => {
    for (const color of ['#000000', '#FFFFFF', '#D1242F', '#1F77B4', '#2CA02C', '#9467BD', '#808080']) {
      const [h, s, v] = rgbToHsv(hexToRgb(color));
      expect(rgbToHex(hsvToRgb(h, s, v)), color).toBe(color);
    }
    expect(rgbToHsv([255, 0, 0])).toEqual([0, 1, 1]);
    expect(rgbToHex(hsvToRgb(120, 1, 1))).toBe('#00FF00');
    expect(rgbToHex(hsvToRgb(240, 0.5, 0.5))).toBe('#404080');
  });
});
