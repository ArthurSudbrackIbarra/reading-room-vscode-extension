// Finding an anchor in the current text. One engine for highlights, the reading marker and
// drawings and text boxes bound to text.
//
// 1. Same text as where it was last found: reuse the offsets.
// 2. The text it was last found in is known: diff it against the current text and map the range.
// 3. Otherwise search: exact occurrences ranked by context, then the place between the stored
//    prefix and suffix, then a fuzzy search.
// The result says what happened (moved with its text, edited, partly deleted, deleted, replaced)
// and never rewrites the anchor itself.
import search from 'approx-string-match';
import {
  WIDE_CONTEXT,
  clusterEnd,
  clusterStart,
  fingerprintSimilarity,
  type AnchorState,
  type FoundState,
  type OrphanReason,
  type ResolutionKind,
  type TextAnchor,
} from './anchor';
import { applyCopyHints, diffTexts, insertedOccurrences, insertedShare, mapRange, type CopyHint, type DiffOptions, type TextDiff } from './diff';
import { MAX_ERROR_RATIO, similarity } from './match';
import { TEXT_MODEL_VERSION, trimRange } from './textModel';

/** Share of the quote's characters that must be left for an edited passage to keep its annotation. */
export const EDITED_MIN_SURVIVOR = 0.3;
/** What must be left of a partly deleted passage: this share of the quote, and at least this many characters. */
export const PARTIAL_MIN_SURVIVOR = 0.15;
export const PARTIAL_MIN_CHARS = 3;
/** Context similarity (0..1) from which an occurrence is trusted to be the same place. */
export const CONTEXT_STRONG = 0.6;
/**
 * Fingerprint similarity from which an occurrence is trusted even when its near context changed
 * (only for quotes of at least BARE_MIN_LENGTH characters: around a short one, common words alone
 * make it high).
 */
export const FINGERPRINT_STRONG = 0.75;
/** Context similarity an approximate match needs, unless the quote is long enough to be telling. */
export const FUZZY_CONTEXT = 0.35;
/** A quote this long, found exactly once, is taken to be the moved passage even without context. */
export const DISTINCTIVE_LENGTH = 24;
/**
 * Without any of its context left, a quote is only taken where it stands when it is there exactly
 * once and is at least this long: a short one is most likely another passage.
 */
export const BARE_MIN_LENGTH = 12;
/** Share of an occurrence that must be newly inserted text for it to count as the moved passage. */
export const MOVED_INSERTED_SHARE = 0.8;
/** How alike the text on one side must be for a quote found in new text to be taken as the moved passage. */
export const MOVED_CONTEXT = 0.8;
/** How much more unchanged text an occurrence in new text must have around it to be taken instead of the mapped one. */
const INTACT_MARGIN = 16;
/** Unchanged characters right next to a passage (on each side) for its place to count as untouched. */
const NEAR_CONTEXT = 16;
/** Text between prefix and suffix longer than this (times the quote, plus slack) is not offered as a replacement. */
export const CANDIDATE_MAX_FACTOR = 3;
const CANDIDATE_SLACK = 64;
/** A mapped range that grew beyond this (times the quote, plus slack) is cut back to its larger surviving side. */
export const GROWTH_MAX_FACTOR = 3;
const GROWTH_SLACK = 200;
/** Shortest piece of context used to find where a quote was. */
const BRACKET_MIN = 8;
/** Share of what stands where a passage was that must be new text for it to count as its replacement. */
export const REPLACED_NEW_SHARE = 0.5;
/** When less than this share of the old text is left, the new text is another document (or a cut-off file), not a version of it. */
export const UNRELATED_SHARE = 0.25;
/** How far around a passage its surroundings are compared with the old text. */
const INTACT_REACH = 512;
const BRACKET_PIECE = 32;
const MAX_OCCURRENCES = 2000;

export interface CurrentText {
  text: string;
  hash: string;
}

export interface ResolveContext {
  current: CurrentText;
  /** The text of an earlier version by hash, when it is known (kept in memory, or from a snapshot). */
  oldText(hash: string): string | undefined;
  /** Which of two identical neighbors is the copy (from the editor), for this render. */
  hints?: readonly CopyHint[];
  diffOptions?: DiffOptions;
  /** Diffs by old hash; null when the texts differ too much. Filled as anchors are resolved. */
  diffs?: Map<string, TextDiff | null>;
}

export interface Resolution {
  status: 'anchored' | 'orphaned';
  kind?: ResolutionKind;
  reason?: OrphanReason;
  /** 0..1. */
  confidence: number;
  start?: number;
  end?: number;
  /** The text there now, when it differs from the quote. */
  text?: string;
  /** Orphans: where the text used to be, in the current text. */
  tombstone?: number;
  /** Orphans: the text that took its place. */
  candidate?: { start: number; end: number };
  /** How it was found. */
  via: 'same' | 'diff' | 'search' | 'context' | 'fuzzy' | 'none';
  /** The state to keep for the next render. */
  state: AnchorState;
}

function ink(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) !== 32) n++;
  return n;
}

export type Comparison = 'exact' | 'edited' | 'partial' | 'replaced' | 'gone';

/**
 * Compares the text at a place with the quote: the same, edited inside (first and last word still
 * there), partly deleted (the head or the tail is gone), replaced (too little is left) or gone.
 */
export function compareWithQuote(exact: string, current: string): Comparison {
  if (current === exact) return 'exact';
  const diff = diffTexts(exact, current, { budgetMs: 100 });
  if (!diff) return 'replaced';
  const m = mapRange(diff, exact, current, 0, exact.length);
  const minimum = Math.max(PARTIAL_MIN_CHARS, Math.ceil(m.total * PARTIAL_MIN_SURVIVOR));
  if (m.kept < minimum) return 'gone';
  const equal = diff.segments.filter((s) => s.equal && ink(exact.slice(s.a0, s.a1)) > 0);
  const head = equal[0]?.a0 ?? exact.length;
  const tail = equal[equal.length - 1]?.a1 ?? 0;
  // A head or tail that was changed inside one word (a typo fixed) still counts as there.
  const headThere = !/\s/.test(exact.slice(0, head).trimStart());
  const tailThere = !/\s/.test(exact.slice(tail).trimEnd());
  if (!headThere || !tailThere) return 'partial';
  return m.kept / Math.max(1, m.total) >= EDITED_MIN_SURVIVOR ? 'edited' : 'replaced';
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

function occurrences(text: string, quote: string): number[] {
  const out: number[] = [];
  if (quote.length === 0) return out;
  let from = 0;
  while (out.length < MAX_OCCURRENCES) {
    const at = text.indexOf(quote, from);
    if (at === -1) break;
    out.push(at);
    from = at + 1;
  }
  return out;
}

/**
 * Whether an occurrence stands as whole words where the quote did: a quote that began and ended
 * at word boundaries ("fox") is not found inside another word ("foxes").
 */
function wholeWords(anchor: TextAnchor, quote: string, text: string, at: number): boolean {
  const end = at + quote.length;
  const startedAtBoundary = anchor.prefix.length === 0 || !WORD_CHAR.test(anchor.prefix[anchor.prefix.length - 1]);
  const endedAtBoundary = anchor.suffix.length === 0 || !WORD_CHAR.test(anchor.suffix[0]);
  if (startedAtBoundary && at > 0 && WORD_CHAR.test(quote[0]) && WORD_CHAR.test(text[at - 1])) return false;
  if (endedAtBoundary && end < text.length && WORD_CHAR.test(quote[quote.length - 1]) && WORD_CHAR.test(text[end])) return false;
  return true;
}

function sideSimilarity(anchor: TextAnchor, text: string, start: number, end: number): [before: number, after: number] {
  const before = anchor.prefix ? similarity(text.slice(Math.max(0, start - anchor.prefix.length), start), anchor.prefix) : start === 0 ? 1 : 0.5;
  const after = anchor.suffix ? similarity(text.slice(end, end + anchor.suffix.length), anchor.suffix) : end === text.length ? 1 : 0.5;
  return [before, after];
}

function contextSimilarity(anchor: TextAnchor, text: string, start: number, end: number): number {
  const [before, after] = sideSimilarity(anchor, text, start, end);
  return (before + after) / 2;
}

/** Whether a mapped range is the old range unchanged (every character kept, nothing inside changed). */
function mappedExactly(m: { kept: number; total: number; changed: boolean }): boolean {
  return m.kept === m.total && !m.changed;
}

function validFound(state: AnchorState | undefined): FoundState | undefined {
  const f = state?.found;
  if (!f || f.v !== TEXT_MODEL_VERSION || f.start < 0 || f.end <= f.start) return undefined;
  return f;
}

class Resolver {
  private readonly text: string;
  private readonly found?: FoundState;

  constructor(
    private readonly anchor: TextAnchor,
    private readonly previous: AnchorState | undefined,
    private readonly ctx: ResolveContext,
  ) {
    this.text = ctx.current.text;
    this.found = validFound(previous);
    // Never resolved yet: it is where it was made, in the text it was made in.
    const made = anchor.createdIn;
    if (!this.found && !previous?.found && made && made.v === TEXT_MODEL_VERSION && made.start >= 0 && made.hash) {
      this.found = { hash: made.hash, v: made.v, length: -1, start: made.start, end: made.start + anchor.exact.length };
    }
  }

  // ---------- Results ----------

  private anchored(start: number, end: number, kind: ResolutionKind, confidence: number, via: Resolution['via']): Resolution {
    const current = this.text.slice(start, end);
    const differs = current !== this.anchor.exact;
    const found: FoundState = { hash: this.ctx.current.hash, v: TEXT_MODEL_VERSION, length: this.text.length, start, end };
    if (differs) found.text = current;
    return {
      status: 'anchored',
      kind,
      confidence,
      start,
      end,
      ...(differs ? { text: current } : {}),
      via,
      state: { found, status: 'anchored', kind, resolvedIn: this.ctx.current.hash },
    };
  }

  private orphaned(reason: OrphanReason, via: Resolution['via'], tombstone?: number, candidate?: { start: number; end: number }): Resolution {
    const state: AnchorState = { status: 'orphaned', reason, resolvedIn: this.ctx.current.hash };
    // Keep pointing at the last version it was found in, even one of another text model version
    // (as a hint for later).
    if (this.previous?.found) state.found = this.previous.found;
    return {
      status: 'orphaned',
      reason,
      confidence: 0,
      ...(tombstone !== undefined ? { tombstone: Math.max(0, Math.min(tombstone, this.text.length)) } : {}),
      ...(candidate ? { candidate } : {}),
      via,
      state,
    };
  }

  /** A found range, described by comparing it with the quote. Undefined when too little of the quote is there. */
  private describe(start: number, end: number, moved: boolean, confidence: number, via: Resolution['via']): Resolution | undefined {
    const [ts, te] = trimRange(this.text, start, end);
    const s = clusterStart(this.text, ts);
    const e = clusterEnd(this.text, te);
    if (e <= s) return undefined;
    const comparison = compareWithQuote(this.anchor.exact, this.text.slice(s, e));
    if (comparison === 'gone') return undefined;
    if (comparison === 'replaced') return this.orphaned('replaced', via, s, { start: s, end: e });
    if (comparison !== 'exact') return this.anchored(s, e, comparison, confidence * 0.8, via);
    return this.anchored(s, e, moved ? 'moved' : s === this.previousStart ? 'exact' : 'shifted', confidence, via);
  }

  /** Where it was in the version it was last found in (or made in). */
  private get previousStart(): number | undefined {
    return this.previous?.found?.start ?? this.anchor.createdIn?.start;
  }

  /** What stands between the end of the old prefix and the start of the old suffix: nothing (deleted) or other text (replaced). */
  private vacated(gap: [number, number], via: Resolution['via'], diff?: TextDiff): Resolution {
    const [s, e] = trimRange(this.text, gap[0], gap[1]);
    const limit = this.anchor.exact.length * CANDIDATE_MAX_FACTOR + CANDIDATE_SLACK;
    if (e > s && e - s <= limit) {
      // A scrap of the old passage that is still there did not replace it: only new text did.
      const between = this.text.slice(s, e);
      let fresh: number;
      if (diff) {
        fresh = insertedShare(diff, s, e);
      } else {
        const local = diffTexts(this.anchor.exact, between, { budgetMs: 100 });
        fresh = local ? 1 - mapRange(local, this.anchor.exact, between, 0, this.anchor.exact.length).kept / Math.max(1, ink(between)) : 1;
      }
      if (fresh >= REPLACED_NEW_SHARE) return this.orphaned('replaced', via, gap[0], { start: clusterStart(this.text, s), end: clusterEnd(this.text, e) });
    }
    return this.orphaned('deleted', via, gap[0]);
  }

  // ---------- 1. Same text ----------

  private same(): Resolution | undefined {
    const f = this.found;
    if (!f || f.hash !== this.ctx.current.hash || f.end > this.text.length) return undefined;
    const expected = f.text ?? this.anchor.exact;
    if (this.text.slice(f.start, f.end) !== expected) return undefined;
    const comparison = compareWithQuote(this.anchor.exact, expected);
    if (comparison === 'gone' || comparison === 'replaced') return undefined;
    return this.anchored(f.start, f.end, comparison, 1, 'same');
  }

  // ---------- 2. Diff mapping ----------

  private diffFrom(hash: string, oldText: string): TextDiff | undefined {
    const cache = (this.ctx.diffs ??= new Map());
    let diff = cache.get(hash);
    if (diff === undefined) {
      const made = diffTexts(oldText, this.text, this.ctx.diffOptions);
      // Texts with almost nothing in common are different documents: what is not in this one was
      // not "deleted", and where it "was" means nothing.
      const common = made ? made.segments.reduce((sum, s) => (s.equal ? sum + ink(oldText.slice(s.a0, s.a1)) : sum), 0) : 0;
      const related = common >= UNRELATED_SHARE * ink(oldText);
      diff = made && related ? (this.ctx.hints?.length ? applyCopyHints(made, this.text, this.ctx.hints) : made) : null;
      cache.set(hash, diff);
    }
    return diff ?? undefined;
  }

  private viaDiff(): Resolution | undefined {
    const f = this.found;
    if (!f) return undefined;
    const oldText = this.ctx.oldText(f.hash);
    if (oldText === undefined || f.end > oldText.length) return undefined;
    if (oldText.slice(f.start, f.end) !== (f.text ?? this.anchor.exact)) return undefined;
    const diff = this.diffFrom(f.hash, oldText);
    if (!diff) return undefined;

    let m = mapRange(diff, oldText, this.text, f.start, f.end);
    if (m.kept > 0 && m.end - m.start > this.anchor.exact.length * GROWTH_MAX_FACTOR + GROWTH_SLACK) {
      m = this.largerSide(diff, oldText, f, m) ?? m;
    }
    // Its text is not what it was: if the whole quote stands somewhere with all of its stored
    // context around it, the content came back (an undo, a restored file): it goes back there.
    if (f.text !== undefined || !mappedExactly(m)) {
      const back = this.originalBack();
      if (back !== undefined) return this.describe(back, back + this.anchor.exact.length, false, 1, 'diff') ?? this.orphaned('not-found', 'none');
    }
    if (m.kept > 0) {
      const here = this.describe(m.start, m.end, false, 1, 'diff');
      if (here) {
        if (here.status === 'anchored' && here.text !== undefined) {
          // The whole quote is back at this place (an undo, a restored file): take all of it again.
          const full = this.originalAt(here.start!, here.end!);
          if (full !== undefined) return this.describe(full, full + this.anchor.exact.length, false, 1, 'diff') ?? here;
        }
        if (here.status === 'anchored' && here.text === undefined && !this.ctx.hints?.length) {
          // A copy was pasted next to the passage and one of the two was edited: the diff may have
          // followed the edited one. When the text right next to the mapped place changed, an
          // occurrence in new text with untouched text on both sides is the original.
          const length = this.anchor.exact.length;
          const mine = this.intactSides(oldText, f, here.start!);
          if (Math.min(...mine) < NEAR_CONTEXT) {
            let better: { at: number; score: number } | undefined;
            for (const at of insertedOccurrences(diff, this.text, this.anchor.exact)) {
              if (at === here.start) continue;
              const sides = this.intactSides(oldText, f, at);
              const score = sides[0] + sides[1];
              if (Math.min(...sides) >= NEAR_CONTEXT && score > mine[0] + mine[1] + INTACT_MARGIN && (!better || score > better.score)) better = { at, score };
            }
            if (better) return this.describe(better.at, better.at + length, false, 1, 'diff') ?? here;
          }
          // It stands on text with other surroundings than it was made in (a twin it moved to when
          // its own passage was gone): if its own passage is back, whole, it returns there.
          if (!this.contextIntact(here.start!, here.end!)) {
            const back = this.originalBack();
            if (back !== undefined && back !== here.start) return this.describe(back, back + length, false, 1, 'diff') ?? here;
          }
        }
        return here;
      }
    }
    // Nothing of it is left where it was. Was it moved? Only text the diff calls new can be it:
    // an occurrence that was already there before is another passage.
    const quotes = f.text && f.text !== this.anchor.exact ? [this.anchor.exact, f.text] : [this.anchor.exact];
    for (const quote of quotes) {
      let best: { at: number; score: number } | undefined;
      for (const at of insertedOccurrences(diff, this.text, quote)) {
        if (!wholeWords(this.anchor, quote, this.text, at)) continue;
        // What came along with it on at least one side.
        const score = Math.max(...sideSimilarity(this.anchor, this.text, at, at + quote.length));
        if (!best || score > best.score) best = { at, score };
      }
      // New text that holds the quote is the moved passage when what surrounds it came along,
      // or when the quote is long enough to be telling by itself.
      if (best && (best.score >= MOVED_CONTEXT || ink(quote) >= DISTINCTIVE_LENGTH)) {
        const moved = this.describe(best.at, best.at + quote.length, true, 0.9, 'diff');
        if (moved?.status === 'anchored') return moved;
      }
    }
    // Of two identical passages next to each other one was deleted, and the diff says it was this
    // one. They cannot be told apart: the one standing where this one was, with the same text on
    // one side, is it.
    const twin = this.twinAt(m.gap);
    if (twin !== undefined) {
      const here = this.describe(twin, twin + this.anchor.exact.length, false, 0.9, 'diff');
      if (here?.status === 'anchored') return here;
    }
    return this.vacated(m.gap, 'diff', diff);
  }

  /**
   * The quote standing near where it was deleted (within the passage that was duplicated), with
   * its whole stored prefix or suffix unchanged next to it: the nearest such one.
   */
  private twinAt(gap: [number, number]): number | undefined {
    const { exact, prefix, suffix } = this.anchor;
    const text = this.text;
    const last = gap[1] + INTACT_REACH;
    let best: number | undefined;
    for (let at = text.indexOf(exact, Math.max(0, gap[0] - INTACT_REACH)); at !== -1 && at <= last; at = text.indexOf(exact, at + 1)) {
      const end = at + exact.length;
      const before = prefix.length >= BRACKET_MIN && text.slice(Math.max(0, at - prefix.length), at) === prefix;
      const after = suffix.length >= BRACKET_MIN && text.slice(end, end + suffix.length) === suffix;
      if ((before || after) && (best === undefined || Math.abs(at - gap[0]) < Math.abs(best - gap[0]))) best = at;
    }
    return best;
  }

  /**
   * How much text before and after an occurrence of the quote is the same as it was around the
   * old passage. A side on which the old text is the same right up to its start (or end) is whole.
   */
  private intactSides(oldText: string, f: FoundState, at: number): [before: number, after: number] {
    const text = this.text;
    let before = 0;
    while (before < INTACT_REACH && f.start - 1 - before >= 0 && at - 1 - before >= 0 && oldText.charCodeAt(f.start - 1 - before) === text.charCodeAt(at - 1 - before)) before++;
    if (f.start - before === 0) before = INTACT_REACH;
    const end = at + (f.end - f.start);
    let after = 0;
    while (after < INTACT_REACH && f.end + after < oldText.length && end + after < text.length && oldText.charCodeAt(f.end + after) === text.charCodeAt(end + after)) after++;
    if (f.end + after === oldText.length) after = INTACT_REACH;
    return [before, after];
  }

  /** Whether the stored prefix and suffix stand unchanged around a range. */
  private contextIntact(start: number, end: number): boolean {
    const { prefix, suffix } = this.anchor;
    return this.text.slice(Math.max(0, start - prefix.length), start) === prefix && this.text.slice(end, end + suffix.length) === suffix;
  }

  /** The start of the quote where it stands with its whole stored prefix and suffix unchanged around it (once). */
  private originalBack(): number | undefined {
    const { exact, prefix, suffix } = this.anchor;
    if (prefix.length + suffix.length < BRACKET_MIN) return undefined;
    const text = this.text;
    let found: number | undefined;
    for (const at of occurrences(text, exact)) {
      const end = at + exact.length;
      if (text.slice(Math.max(0, at - prefix.length), at) !== prefix || text.slice(end, end + suffix.length) !== suffix) continue;
      if (prefix.length < WIDE_CONTEXT && at - prefix.length > 0 && prefix.length > 0 && this.anchor.createdIn?.start !== prefix.length) continue;
      if (found !== undefined) return undefined;
      found = at;
    }
    return found;
  }

  /** When text was inserted in the middle of a passage, keeps the side with more of it left. */
  private largerSide(diff: TextDiff, oldText: string, f: FoundState, whole: ReturnType<typeof mapRange>) {
    let widest: { a: number; size: number } | undefined;
    for (const seg of diff.segments) {
      if (seg.equal || seg.a1 <= f.start || seg.a0 >= f.end) continue;
      const size = seg.b1 - seg.b0;
      if (!widest || size > widest.size) widest = { a: seg.a0, size };
    }
    if (!widest || widest.a <= f.start || widest.a >= f.end) return undefined;
    const left = mapRange(diff, oldText, this.text, f.start, widest.a);
    const right = mapRange(diff, oldText, this.text, widest.a, f.end);
    const side = left.kept >= right.kept ? left : right;
    return side.kept > 0 ? { ...side, changed: true, gap: whole.gap } : undefined;
  }

  /** The start of the original quote if it stands at (overlapping) a range of the current text. */
  private originalAt(start: number, end: number): number | undefined {
    const exact = this.anchor.exact;
    const at = this.text.indexOf(exact, Math.max(0, start - exact.length));
    if (at === -1 || at >= end || at + exact.length <= start) return undefined;
    return at;
  }

  // ---------- 3. Search ----------

  private expected(): number | undefined {
    const f = this.previous?.found;
    if (f && f.start >= 0) return f.length > 0 ? Math.round((f.start / f.length) * this.text.length) : f.start;
    return this.anchor.createdIn?.start;
  }

  private viaSearch(fuzzy: boolean): Resolution {
    const { anchor, text } = this;
    const exact = anchor.exact;
    const expected = this.expected();
    const previousStart = this.previousStart;

    // The place did not move and its context still agrees.
    if (previousStart !== undefined && previousStart >= 0 && text.startsWith(exact, previousStart)) {
      const end = previousStart + exact.length;
      if (text.slice(Math.max(0, previousStart - anchor.prefix.length), previousStart) === anchor.prefix && text.slice(end, end + anchor.suffix.length) === anchor.suffix) {
        return this.anchored(previousStart, end, 'exact', 1, 'search');
      }
    }

    // Exact occurrences of the quote (or of what it had become), ranked by what surrounds them.
    const last = this.previous?.found?.text;
    const quotes = last && last !== exact ? [exact, last] : [exact];
    let weak: { at: number; length: number; score: number; count: number } | undefined;
    for (const quote of quotes) {
      const all = occurrences(text, quote).filter((at) => wholeWords(anchor, quote, text, at));
      let best: { at: number; score: number; context: number; print: number } | undefined;
      for (const at of all) {
        const context = contextSimilarity(anchor, text, at, at + quote.length);
        const print = all.length > 1 || context < CONTEXT_STRONG ? (fingerprintSimilarity(anchor, text, at, at + quote.length) ?? context) : context;
        const near = expected === undefined || text.length === 0 ? 0 : 1 - Math.min(1, Math.abs(at - expected) / text.length);
        const score = 0.6 * context + 0.3 * print + 0.1 * near;
        if (!best || score > best.score) best = { at, score, context, print };
      }
      if (!best) continue;
      if (best.context >= CONTEXT_STRONG || (best.print >= FINGERPRINT_STRONG && ink(quote) >= BARE_MIN_LENGTH)) {
        const here = this.describe(best.at, best.at + quote.length, false, 0.5 + best.score / 2, 'search');
        if (here?.status === 'anchored') return here;
      }
      if (!weak) weak = { at: best.at, length: quote.length, score: best.score, count: all.length };
    }

    // Where the quote was, by the text on both sides of it.
    const place = this.bracket(expected);
    if (place) {
      if (weak && weak.at >= place.from - 1 && weak.at + weak.length <= place.to + 1) {
        const here = this.describe(weak.at, weak.at + weak.length, false, 0.7, 'context');
        if (here?.status === 'anchored') return here;
      }
      const between = text.slice(place.from, place.to);
      if (place.both) {
        const diff = between.trim().length > 0 ? diffTexts(exact, between, { budgetMs: 100 }) : undefined;
        const m = diff ? mapRange(diff, exact, between, 0, exact.length) : undefined;
        if (m && m.kept > 0) {
          const here = this.describe(place.from + m.start, place.from + m.end, false, 0.7, 'context');
          if (here?.status === 'anchored') return here;
        }
      } else {
        // Only one side of the context is there: what is left of the quote must stand right next to it.
        const left = this.besideEdited(place.from, place.to, place.side === 'prefix') ?? this.besideContext(between, place.side === 'prefix');
        if (left) {
          const here = this.describe(place.from + left[0], place.from + left[1], false, 0.6, 'context');
          if (here?.status === 'anchored') return here;
        }
      }
      // The place is there and the quote is not. A long quote found exactly once elsewhere was moved.
      if (weak && weak.count === 1 && ink(exact) >= DISTINCTIVE_LENGTH) {
        const moved = this.describe(weak.at, weak.at + weak.length, true, 0.6, 'search');
        if (moved?.status === 'anchored') return moved;
      }
      if (place.both) return this.vacated([place.from, place.to], 'context');
      return this.orphaned('deleted', 'context', place.side === 'prefix' ? place.from : place.to);
    }

    // The context is gone too: a quote that is there exactly once, and long enough to be telling, is it.
    if (weak && weak.count === 1 && ink(exact) >= BARE_MIN_LENGTH) {
      const here = this.describe(weak.at, weak.at + weak.length, false, 0.5, 'search');
      if (here?.status === 'anchored') return here;
    }
    if (fuzzy) {
      const approximate = this.fuzzy(expected);
      if (approximate) return approximate;
    }
    return this.orphaned('not-found', 'none');
  }

  /**
   * An edited version of the quote right next to the one side of its context that is still there:
   * it has to start (or end) at that side and keep enough of the quote.
   */
  private besideEdited(from: number, to: number, atStart: boolean): [number, number] | undefined {
    const exact = this.anchor.exact;
    const reach = exact.length + 16;
    const window = atStart ? this.text.slice(from, Math.min(to, from + reach)) : this.text.slice(Math.max(from, to - reach), to);
    const shift = atStart ? 0 : Math.max(from, to - reach) - from;
    const diff = diffTexts(exact, window, { budgetMs: 100 });
    if (!diff) return undefined;
    const m = mapRange(diff, exact, window, 0, exact.length);
    if (m.kept / Math.max(1, m.total) < EDITED_MIN_SURVIVOR) return undefined;
    const lead = window.length - window.trimStart().length;
    const stop = window.trimEnd().length;
    if (atStart ? m.start > lead : m.end < stop) return undefined;
    return [shift + m.start, shift + m.end];
  }

  /** The head of the quote at the start of a window (or its tail at the end), if enough of it is there. */
  private besideContext(window: string, atStart: boolean): [number, number] | undefined {
    const exact = this.anchor.exact;
    const minimum = Math.max(PARTIAL_MIN_CHARS, Math.ceil(ink(exact) * PARTIAL_MIN_SURVIVOR));
    if (atStart) {
      const lead = window.length - window.trimStart().length;
      let n = 0;
      while (n < exact.length && lead + n < window.length && exact.charCodeAt(n) === window.charCodeAt(lead + n)) n++;
      return ink(exact.slice(0, n)) >= minimum ? [lead, lead + n] : undefined;
    }
    const stop = window.trimEnd().length;
    let n = 0;
    while (n < exact.length && n < stop && exact.charCodeAt(exact.length - 1 - n) === window.charCodeAt(stop - 1 - n)) n++;
    return ink(exact.slice(exact.length - n)) >= minimum ? [stop - n, stop] : undefined;
  }

  /**
   * Finds where the quote stood from its stored context: the end of the prefix and the start of
   * the suffix, located independently. With only one of them, the place starts (or ends) there.
   */
  private bracket(expected: number | undefined): { from: number; to: number; both: boolean; side?: 'prefix' | 'suffix' } | undefined {
    const { anchor, text } = this;
    const reach = anchor.exact.length * 4 + 256;
    const prefixPiece = anchor.prefix.slice(-BRACKET_PIECE);
    const suffixPiece = anchor.suffix.slice(0, BRACKET_PIECE);
    const ends = prefixPiece.length >= BRACKET_MIN ? occurrences(text, prefixPiece).map((at) => at + prefixPiece.length) : [];
    const starts = suffixPiece.length >= BRACKET_MIN ? occurrences(text, suffixPiece) : [];
    // A quote at the very start or end of the text has no context on that side.
    if (anchor.prefix.length === 0 && anchor.createdIn?.start === 0) ends.push(0);
    if (anchor.suffix.length === 0 && anchor.createdIn !== undefined && anchor.prefix.length > 0) starts.push(text.length);
    const near = (at: number) => (expected === undefined ? 0 : Math.abs(at - expected));
    let pair: { from: number; to: number; cost: number } | undefined;
    for (const from of ends) {
      for (const to of starts) {
        // The two pieces may share the space that stood between them and the quote.
        if (to < from - 1 || to - from > reach) continue;
        const cost = Math.max(0, to - from) * 4 + near(from) / 16;
        if (!pair || cost < pair.cost) pair = { from, to: Math.max(from, to), cost };
      }
    }
    if (pair) return { from: pair.from, to: pair.to, both: true };
    if (ends.length > 0) {
      const from = ends.reduce((a, b) => (near(b) < near(a) ? b : a));
      return { from, to: Math.min(text.length, from + anchor.exact.length * 2 + CANDIDATE_SLACK), both: false, side: 'prefix' };
    }
    if (starts.length > 0) {
      const to = starts.reduce((a, b) => (near(b) < near(a) ? b : a));
      return { from: Math.max(0, to - anchor.exact.length * 2 - CANDIDATE_SLACK), to, both: false, side: 'suffix' };
    }
    return undefined;
  }

  /** An approximate match of the quote: first around where it should be, then anywhere. */
  private fuzzy(expected: number | undefined): Resolution | undefined {
    const { anchor, text } = this;
    const exact = anchor.exact;
    const maxErrors = Math.min(256, Math.floor(exact.length * MAX_ERROR_RATIO));
    // A short quote has too many near-misses for an approximate match to mean anything.
    if (maxErrors === 0 || text.length === 0 || ink(exact) < BARE_MIN_LENGTH) return undefined;
    const telling = ink(exact) >= DISTINCTIVE_LENGTH;
    const windows: [number, number][] = [];
    if (expected !== undefined) {
      const half = Math.max(2000, exact.length * 20);
      windows.push([Math.max(0, expected - half), Math.min(text.length, expected + half)]);
    }
    windows.push([0, text.length]);
    for (const [from, to] of windows) {
      const matches = search(text.slice(from, to), exact, maxErrors);
      let best: { start: number; end: number; score: number } | undefined;
      for (const m of matches) {
        // Exact occurrences were looked at before (and turned down, if this is reached).
        if (m.errors === 0) continue;
        const start = from + m.start;
        const end = from + m.end;
        const context = contextSimilarity(anchor, text, start, end);
        if (!telling && context < FUZZY_CONTEXT) continue;
        const score = 0.5 * (1 - m.errors / exact.length) + 0.5 * context;
        if (!best || score > best.score) best = { start, end, score };
      }
      if (best) {
        const here = this.describe(best.start, best.end, false, best.score * 0.8, 'fuzzy');
        if (here?.status === 'anchored') return here;
      }
    }
    return undefined;
  }

  run(fuzzy: boolean): Resolution {
    if (this.anchor.exact.length === 0) return this.orphaned('invalid', 'none');
    if (this.text.length === 0) return this.orphaned('not-found', 'none');
    return this.same() ?? this.viaDiff() ?? this.viaSearch(fuzzy);
  }
}

/**
 * Finds an anchor in the current text. `previous` is the state kept from the last render (where
 * it was last found); the result carries the state to keep next. With `fuzzy: false` the slow
 * approximate search is skipped (the caller runs it later, in the background).
 */
export function resolveAnchor(anchor: TextAnchor, previous: AnchorState | undefined, ctx: ResolveContext, options: { fuzzy?: boolean } = {}): Resolution {
  return new Resolver(anchor, previous, ctx).run(options.fuzzy ?? true);
}

/** Whether a resolution without the slow search could still change with it. */
export function needsFuzzy(resolution: Resolution): boolean {
  return resolution.status === 'orphaned' && resolution.reason === 'not-found';
}

/** What a category change is reported by: 'ok' covers exact and shifted. */
export function categoryOf(state: Pick<AnchorState, 'status' | 'kind' | 'reason'> | undefined): string {
  if (!state) return 'ok';
  if (state.status === 'orphaned') return `orphaned:${state.reason ?? 'not-found'}`;
  return state.kind === 'moved' || state.kind === 'edited' || state.kind === 'partial' ? state.kind : 'ok';
}
