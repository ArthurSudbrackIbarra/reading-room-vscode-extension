// Small rules of the viewer's interface that the host and the viewer share (and that have tests).

/** The sections of the annotations list; each can be collapsed, and that is remembered for all files. */
export const LIST_SECTIONS = ['highlights', 'orphaned', 'drawings', 'texts'] as const;
export type ListSection = (typeof LIST_SECTIONS)[number];

/** The collapsed sections as a viewer sent them or as they were stored: known names only, each once. */
export function sanitizeSections(value: unknown): ListSection[] {
  if (!Array.isArray(value)) return [];
  return LIST_SECTIONS.filter((section) => value.includes(section));
}

/**
 * How much room the viewer has. The toolbar never wraps: what does not fit on it moves into its
 * More menu, class by class.
 *  - wide: everything is on the bar;
 *  - medium: zoom and download are in More;
 *  - narrow: so are the reading marker and the reading sounds, and the page field has no arrows;
 *  - mini: so is the page field.
 */
export const SIZE_CLASSES = ['wide', 'medium', 'narrow', 'mini'] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];

/** The size class of a viewer `width` CSS pixels wide (before checking that the bar's controls fit). */
export function sizeClassOf(width: number): SizeClass {
  return width >= 640 ? 'wide' : width >= 420 ? 'medium' : width >= 300 ? 'narrow' : 'mini';
}

/** The next narrower class, or undefined for the narrowest. */
export function narrower(size: SizeClass): SizeClass | undefined {
  return SIZE_CLASSES[SIZE_CLASSES.indexOf(size) + 1];
}
