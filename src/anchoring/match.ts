// Re-anchoring a W3C TextQuoteSelector in (possibly edited) text.
//
// Approach and scoring weights follow Hypothesis' `match-quote` (BSD-2-Clause): find the closest
// matches of the quote by edit distance (exact first, then approx-string-match), then rank the
// candidates by how well the surrounding text matches the stored prefix/suffix and by the
// distance to the previous position.
import search from 'approx-string-match';
import type { TextPositionSelector, TextQuoteSelector } from '../shared/types';

export interface QuoteMatch {
  start: number;
  end: number;
  errors: number;
  /** 0..1, higher is better. */
  score: number;
}

/** Highest share of the quote length that may differ for a fuzzy match to be accepted. */
export const MAX_ERROR_RATIO = 0.2;
export const CONTEXT_LENGTH = 32;

const WEIGHTS = { quote: 50, prefix: 20, suffix: 20, position: 2 };
const MAX_SCORE = WEIGHTS.quote + WEIGHTS.prefix + WEIGHTS.suffix + WEIGHTS.position;

interface Candidate {
  start: number;
  end: number;
  errors: number;
}

function exactMatches(text: string, quote: string): Candidate[] {
  const out: Candidate[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(quote, from);
    if (at === -1) return out;
    out.push({ start: at, end: at + quote.length, errors: 0 });
    from = at + 1;
  }
}

/** Similarity (0..1) of `pattern` to the best-matching substring of `window`. */
function similarity(window: string, pattern: string): number {
  if (pattern.length === 0 || window.length === 0) return 0;
  if (window === pattern) return 1;
  const matches = search(window, pattern, pattern.length);
  if (matches.length === 0) return 0;
  return Math.max(0, 1 - matches[0].errors / pattern.length);
}

function scoreCandidate(text: string, quote: TextQuoteSelector, hint: number | undefined, m: Candidate): number {
  const quoteScore = 1 - m.errors / quote.exact.length;
  const prefixScore = quote.prefix ? similarity(text.slice(Math.max(0, m.start - quote.prefix.length), m.start), quote.prefix) : 1;
  const suffixScore = quote.suffix ? similarity(text.slice(m.end, m.end + quote.suffix.length), quote.suffix) : 1;
  let positionScore = 1;
  if (hint !== undefined && hint >= 0 && text.length > 0) {
    positionScore = 1 - Math.min(1, Math.abs(m.start - hint) / text.length);
  }
  return (
    (WEIGHTS.quote * quoteScore + WEIGHTS.prefix * prefixScore + WEIGHTS.suffix * suffixScore + WEIGHTS.position * positionScore) /
    MAX_SCORE
  );
}

function best(text: string, quote: TextQuoteSelector, hint: number | undefined, candidates: Candidate[]): QuoteMatch | null {
  let winner: QuoteMatch | null = null;
  for (const c of candidates) {
    const score = scoreCandidate(text, quote, hint, c);
    if (!winner || score > winner.score) winner = { ...c, score };
  }
  return winner;
}

/**
 * Finds `quote` in `text`. Returns null when the best match differs from the quote by more
 * than MAX_ERROR_RATIO (the highlight is then "orphaned").
 */
export function anchorQuote(text: string, quote: TextQuoteSelector, position?: TextPositionSelector): QuoteMatch | null {
  const exact = quote.exact;
  if (exact.length === 0 || text.length === 0) return null;
  const hint = position && position.start >= 0 ? position.start : undefined;

  // 1. Fast path: the text did not move and the context still agrees.
  if (position && position.start >= 0 && text.slice(position.start, position.start + exact.length) === exact) {
    const before = text.slice(Math.max(0, position.start - quote.prefix.length), position.start);
    const after = text.slice(position.start + exact.length, position.start + exact.length + quote.suffix.length);
    if (before === quote.prefix && after === quote.suffix) {
      return { start: position.start, end: position.start + exact.length, errors: 0, score: 1 };
    }
  }

  // 2. Exact occurrences, ranked by context.
  const exacts = exactMatches(text, exact);
  if (exacts.length > 0) return best(text, quote, hint, exacts);

  // 3. Fuzzy search.
  const maxErrors = Math.min(256, Math.floor(exact.length / 2));
  if (maxErrors === 0) return null;
  const fuzzy = search(text, exact, maxErrors);
  if (fuzzy.length === 0) return null;
  const winner = best(text, quote, hint, fuzzy);
  if (!winner || winner.errors > exact.length * MAX_ERROR_RATIO) return null;
  return winner;
}

/** Builds the selectors for a normalized range. */
export function createSelectors(text: string, start: number, end: number): [TextQuoteSelector, TextPositionSelector] {
  return [
    {
      type: 'TextQuoteSelector',
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: text.slice(end, end + CONTEXT_LENGTH),
    },
    { type: 'TextPositionSelector', start, end },
  ];
}
