// Matching the pages of a replaced PDF file to the pages of the version before it, so drawings
// bound to a page and a reading marker on a page without text stay on their page when pages are
// inserted, deleted or reordered.
//
// A page is recognized by its text (a hash of its normalized text). A page without text (a scan,
// a picture) is recognized by a small perceptual hash of how it looks.
import { hashText } from './textModel';

export interface PageSignature {
  /** Hash of the page's normalized text; empty when the page has no text. */
  text: string;
  /** Size in points as shown, rounded. */
  width: number;
  height: number;
  rotate: number;
  /** Perceptual hash (16 hex digits) of a small render; only for pages without text. */
  image?: string;
}

/** Bits (of 64) two perceptual hashes may differ by and still be the same page. */
export const IMAGE_MAX_DISTANCE = 8;

export function pageTextHash(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? hashText(normalized) : '';
}

/** A signature as one short string (what is stored). */
export function signatureKey(sig: PageSignature): string {
  return `${sig.text || '-'}|${Math.round(sig.width)}x${Math.round(sig.height)}|${sig.rotate}|${sig.image ?? ''}`;
}

export function parseSignature(key: unknown): PageSignature | undefined {
  if (typeof key !== 'string' || key.length > 200) return undefined;
  const m = /^([0-9a-f]+|-)\|(\d+)x(\d+)\|(-?\d+)\|([0-9a-f]{16})?$/.exec(key);
  if (!m) return undefined;
  return { text: m[1] === '-' ? '' : m[1], width: Number(m[2]), height: Number(m[3]), rotate: Number(m[4]), ...(m[5] ? { image: m[5] } : {}) };
}

/** Difference hash of a 9×8 grayscale picture (72 values, row by row): 64 bits as 16 hex digits. */
export function differenceHash(gray: ArrayLike<number>): string {
  let hex = '';
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) byte = (byte << 1) | (gray[row * 9 + col] > gray[row * 9 + col + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

/** Whether two signatures are the same page. Rotation and size may differ: the content decides. */
export function samePage(a: PageSignature, b: PageSignature): boolean {
  if (a.text || b.text) return a.text === b.text;
  if (!a.image || !b.image) return false;
  return hashDistance(a.image, b.image) <= IMAGE_MAX_DISTANCE;
}

/**
 * Where each page of the old version is in the new one (undefined: gone). Pages are matched in
 * order first, like a diff, so identical pages (blank ones) stay in sequence; what is left is
 * matched anywhere, which covers pages that were moved.
 */
export function alignPages(before: readonly PageSignature[], now: readonly PageSignature[]): (number | undefined)[] {
  const n = before.length;
  const m = now.length;
  const map: (number | undefined)[] = new Array(n).fill(undefined);
  if (n === 0 || m === 0) return map;
  // Longest common subsequence.
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = samePage(before[i], now[j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const taken = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (samePage(before[i], now[j])) {
      map[i] = j;
      taken.add(j);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  // Moved pages: the nearest unmatched page that looks the same.
  for (let p = 0; p < n; p++) {
    if (map[p] !== undefined) continue;
    let best: number | undefined;
    for (let q = 0; q < m; q++) {
      if (taken.has(q) || !samePage(before[p], now[q])) continue;
      if (best === undefined || Math.abs(q - p) < Math.abs(best - p)) best = q;
    }
    if (best !== undefined) {
      map[p] = best;
      taken.add(best);
    }
  }
  return map;
}
