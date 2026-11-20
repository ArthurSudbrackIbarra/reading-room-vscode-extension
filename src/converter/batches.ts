// A long document is converted in batches, so the reader is not kept waiting for all of it: its
// first part alone (a few pages, there in a moment), then a larger part, and so on, while the
// whole document is converted alongside. Every batch starts at the top of the document, so its
// pages are the pages the whole document will have (all but its last, which may end early).
//
// This file only decides where the batches end. No runtime dependencies.

/**
 * The weight of the first batch. One unit is about one character of source: 20 000 is seven or
 * eight pages, which Chromium prints in a few tenths of a second.
 */
export const FIRST_BATCH = 20_000;
/** Each batch is this many times the one before it. */
export const BATCH_GROWTH = 8;
/**
 * A document is converted in batches when it weighs at least this many times the first batch
 * (about ninety pages: below that, all of it is there in about a second anyway).
 */
export const BATCHED_FROM = 12;
/** A later batch is made when the document weighs at least this many times that batch. */
const WORTH_IT = 3;

/** What a block that is not text weighs, in characters: it takes room on the page and time to make. */
export const IMAGE_WEIGHT = 3_000;
export const DIAGRAM_WEIGHT = 20_000;
/** The room a block takes besides its text (the space around a paragraph, a heading, a row). */
export const BLOCK_WEIGHT = 80;

/**
 * Where the batches of a document end: for each batch, how many of the document's blocks it
 * holds, counted from the top. Empty when the document is converted in one go (it is short, or
 * one block is most of it).
 */
export function batchPlan(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const plan: number[] = [];
  let target = FIRST_BATCH;
  let blocks = 0;
  let held = 0;
  while (total >= target * (plan.length === 0 ? BATCHED_FROM : WORTH_IT)) {
    while (blocks < weights.length && held < target) held += weights[blocks++];
    // A batch that holds most of the document saves no time over the document itself.
    if (blocks >= weights.length || held > total / 2) break;
    plan.push(blocks);
    target *= BATCH_GROWTH;
  }
  return plan;
}

/** What the lines of a plain text file weigh: a long line wraps and takes several lines on the page. */
export function lineWeights(lines: readonly string[]): number[] {
  // About 95 characters to a line of the page and 60 lines to a page: 45 units per line keep a page at about 2 700.
  return lines.map((line) => Math.max(1, Math.ceil(line.length / 95)) * 45);
}
