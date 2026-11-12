// Matching the pages of a replaced PDF file to the pages before (B20, C2, E9, G5).
import { describe, expect, it } from 'vitest';
import {
  IMAGE_MAX_DISTANCE,
  alignPages,
  differenceHash,
  hashDistance,
  pageTextHash,
  parseSignature,
  samePage,
  signatureKey,
  type PageSignature,
} from '../../../src/anchoring/pageAlign';

const text = (content: string, rotate = 0): PageSignature => ({ text: pageTextHash(content), width: 612, height: 792, rotate });
const picture = (image: string): PageSignature => ({ text: '', width: 612, height: 792, rotate: 0, image });
const A = text('Page about apples');
const B = text('Page about bananas');
const C = text('Page about cherries');
const D = text('Page about dates');
const SCAN1 = picture('00ff00ff00ff00ff');
const SCAN2 = picture('ffffffff00000000');

describe('page signatures', () => {
  it('a page is recognized by its text, whatever its rotation or size', () => {
    expect(samePage(A, text('Page  about\napples', 90))).toBe(true);
    expect(samePage(A, { ...A, width: 595, height: 842 })).toBe(true);
    expect(samePage(A, B)).toBe(false);
    expect(pageTextHash('   ')).toBe('');
  });

  it('a page without text is recognized by how it looks, within a few bits', () => {
    const near = picture('00ff00ff00ff00fe');
    expect(hashDistance(SCAN1.image!, near.image!)).toBe(1);
    expect(samePage(SCAN1, near)).toBe(true);
    const far = picture('00ff00ff00ff0000');
    expect(hashDistance(SCAN1.image!, far.image!)).toBe(8);
    expect(samePage(SCAN1, far)).toBe(hashDistance(SCAN1.image!, far.image!) <= IMAGE_MAX_DISTANCE);
    expect(samePage(SCAN1, SCAN2)).toBe(false);
    // No false match: a page with text is never a page without, and a page without a hash matches nothing.
    expect(samePage(SCAN1, A)).toBe(false);
    expect(samePage({ text: '', width: 612, height: 792, rotate: 0 }, { text: '', width: 612, height: 792, rotate: 0 })).toBe(false);
  });

  it('the difference hash compares neighbors in each row', () => {
    const rising = Array.from({ length: 72 }, (_, i) => i % 9);
    const falling = Array.from({ length: 72 }, (_, i) => 8 - (i % 9));
    expect(differenceHash(rising)).toBe('0000000000000000');
    expect(differenceHash(falling)).toBe('ffffffffffffffff');
    expect(hashDistance(differenceHash(rising), differenceHash(falling))).toBe(64);
  });

  it('is stored as one short string and read back', () => {
    for (const sig of [A, text('Turned', 270), SCAN1, { text: '', width: 500, height: 700, rotate: 0 }]) {
      expect(parseSignature(signatureKey(sig))).toEqual(sig);
    }
    for (const bad of [undefined, 42, '', 'nonsense', 'abc|12x|0|', `${'a'.repeat(300)}|1x1|0|`]) expect(parseSignature(bad)).toBeUndefined();
  });
});

describe('alignPages', () => {
  it('the same pages stay where they are', () => {
    expect(alignPages([A, B, C], [A, B, C])).toEqual([0, 1, 2]);
  });

  it('a page inserted in front, in the middle or at the end shifts the ones after it', () => {
    expect(alignPages([A, B, C], [D, A, B, C])).toEqual([1, 2, 3]);
    expect(alignPages([A, B, C], [A, D, B, C])).toEqual([0, 2, 3]);
    expect(alignPages([A, B, C], [A, B, C, D])).toEqual([0, 1, 2]);
  });

  it('a deleted page has no page any more; the others close the gap', () => {
    expect(alignPages([A, B, C, D], [A, C, D])).toEqual([0, undefined, 1, 2]);
    expect(alignPages([A, B], [])).toEqual([undefined, undefined]);
    expect(alignPages([], [A])).toEqual([]);
  });

  it('pages that were reordered are found where they went', () => {
    expect(alignPages([A, B, C, D], [A, C, D, B])).toEqual([0, 3, 1, 2]);
    expect(alignPages([A, B, C], [C, B, A]).slice().sort()).toEqual([0, 1, 2]);
  });

  it('identical pages (blank ones) stay in sequence', () => {
    const blank = text('');
    const empty = picture('0000000000000000');
    expect(alignPages([A, empty, B, empty], [A, empty, B, empty])).toEqual([0, 1, 2, 3]);
    expect(alignPages([A, empty, B, empty], [D, A, empty, B, empty])).toEqual([1, 2, 3, 4]);
    void blank;
  });

  it('scanned pages follow by how they look; a page that looks different is not matched', () => {
    expect(alignPages([SCAN1, SCAN2], [A, SCAN1, SCAN2])).toEqual([1, 2]);
    expect(alignPages([SCAN1, SCAN2], [SCAN2, SCAN1])).toEqual(expect.arrayContaining([0, 1]));
    expect(alignPages([SCAN1], [picture('ffff0000ffff0000')])).toEqual([undefined]);
  });

  it('a page whose text was edited is a different page; its neighbors still match', () => {
    expect(alignPages([A, B, C], [A, text('Page about blueberries'), C])).toEqual([0, undefined, 2]);
  });

  it('handles a long document quickly', () => {
    const pages = Array.from({ length: 1500 }, (_, i) => text(`Page number ${i}`));
    const started = Date.now();
    const map = alignPages(pages, [D, ...pages.slice(0, 700), ...pages.slice(701)]);
    expect(map[0]).toBe(1);
    expect(map[700]).toBeUndefined();
    expect(map[1499]).toBe(1499);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
