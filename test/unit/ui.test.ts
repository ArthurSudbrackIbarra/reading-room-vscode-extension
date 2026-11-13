import { describe, expect, it } from 'vitest';
import { LIST_SECTIONS, SIZE_CLASSES, narrower, sanitizeSections, sizeClassOf } from '../../src/shared/ui';

describe('size classes of the viewer', () => {
  it('follow the width of the viewer', () => {
    expect(sizeClassOf(1400)).toBe('wide');
    expect(sizeClassOf(640)).toBe('wide');
    expect(sizeClassOf(639)).toBe('medium');
    expect(sizeClassOf(420)).toBe('medium');
    expect(sizeClassOf(419)).toBe('narrow');
    expect(sizeClassOf(300)).toBe('narrow');
    expect(sizeClassOf(299)).toBe('mini');
    expect(sizeClassOf(0)).toBe('mini');
  });

  it('step down one at a time, and stop at the narrowest', () => {
    expect(SIZE_CLASSES.map((size) => narrower(size))).toEqual(['medium', 'narrow', 'mini', undefined]);
  });
});

describe('collapsed sections of the list', () => {
  it('keeps known sections, each once, in the order of the list', () => {
    expect(sanitizeSections(['texts', 'highlights', 'texts'])).toEqual(['highlights', 'texts']);
    expect(sanitizeSections([...LIST_SECTIONS])).toEqual([...LIST_SECTIONS]);
  });

  it('drops what is not a section', () => {
    expect(sanitizeSections(['highlights', 'toString', 7, null, { a: 1 }])).toEqual(['highlights']);
    expect(sanitizeSections('highlights')).toEqual([]);
    expect(sanitizeSections(undefined)).toEqual([]);
  });
});
