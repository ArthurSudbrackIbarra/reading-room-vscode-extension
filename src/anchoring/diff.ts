// A minimal diff of two normalized texts, and mapping of ranges through it.
//
// The texts are split into words and separators, diffed with Myers' algorithm (after trimming the
// common start and end), and replaced runs that are similar are refined to characters. No cleanup
// pass moves boundaries afterwards: what the diff calls equal really is equal.
//
// Pure TypeScript: shared by the viewer, the host and the tests.

export interface DiffSegment {
  /** Old range. */
  a0: number;
  a1: number;
  /** New range. */
  b0: number;
  b1: number;
  /** The two ranges hold the same text (same length); otherwise the old one was replaced by the new one. */
  equal: boolean;
}

export interface TextDiff {
  /** Covers both texts, in order, alternating between equal and changed. */
  segments: DiffSegment[];
  oldLength: number;
  newLength: number;
}

export interface DiffOptions {
  /** Give up (return undefined) after this long. Default 250 ms. */
  budgetMs?: number;
  /** Give up when the texts differ by more than this many words and separators. Default 2500. */
  maxEdits?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** Which of two identical neighbors is the copy the reader just made (from the editor's change events). */
export interface CopyHint {
  /** The text that was inserted. */
  text: string;
  /** Where the copy is, relative to the text it was copied from. */
  side: 'before' | 'after';
}

/** Replaced runs longer than this are not refined to characters. */
const REFINE_MAX = 2000;
/** Share of matching characters above which a replaced run counts as an edit of the same words. */
const REFINE_SIMILAR = 0.5;

const WORD = /[\p{L}\p{N}\p{M}_]/u;
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]\p{M}*|[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*|\s+|[^]/gu;

/** Splits text into words and separators. Returns the start of every token (plus the text length). */
export function tokenStarts(text: string): number[] {
  const starts: number[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text))) {
    starts.push(m.index);
    if (m[0].length === 0) TOKEN.lastIndex++;
  }
  starts.push(text.length);
  return starts;
}

type Run = [a: number, b: number, length: number];

/**
 * Myers' O(ND) diff of two integer sequences. Returns the matching runs in order, or undefined
 * when the budget runs out.
 */
function myers(a: ArrayLike<number>, b: ArrayLike<number>, maxEdits: number, expired: () => boolean): Run[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = Math.min(n + m, maxEdits);
  const size = 2 * max + 3;
  const offset = max + 1;
  const v = new Int32Array(size);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found < 0 && (d & 15) === 15 && expired()) return undefined;
  }
  if (found < 0) return undefined;
  // Walk back from the end, collecting the diagonal runs.
  const runs: Run[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const startX = prevK === k + 1 ? prevX : prevX + 1;
    if (x > startX) runs.push([startX, startX - k, x - startX]);
    x = prevX;
    y = prevY;
  }
  if (x > 0) runs.push([0, 0, x]);
  runs.reverse();
  return runs;
}

function codes(text: string): Int32Array {
  // Letters compare without case, so a case-only change keeps its place.
  const lower = text.toLowerCase();
  const source = lower.length === text.length ? lower : text;
  const out = new Int32Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source.charCodeAt(i);
  return out;
}

function pushSegment(out: DiffSegment[], seg: DiffSegment): void {
  if (seg.a0 === seg.a1 && seg.b0 === seg.b1) return;
  const last = out[out.length - 1];
  if (last && last.equal === seg.equal && last.a1 === seg.a0 && last.b1 === seg.b0) {
    last.a1 = seg.a1;
    last.b1 = seg.b1;
  } else {
    out.push({ ...seg });
  }
}

/** Character-level runs of a replaced span, if the two sides are similar enough; otherwise undefined. */
function refine(oldText: string, newText: string, seg: DiffSegment, expired: () => boolean): DiffSegment[] | undefined {
  const la = seg.a1 - seg.a0;
  const lb = seg.b1 - seg.b0;
  if (la === 0 || lb === 0 || la > REFINE_MAX || lb > REFINE_MAX) return undefined;
  const a = codes(oldText.slice(seg.a0, seg.a1));
  const b = codes(newText.slice(seg.b0, seg.b1));
  if (a.length !== la || b.length !== lb) return undefined;
  const runs = myers(a, b, la + lb, expired);
  if (!runs) return undefined;
  // Never start or end a run inside a surrogate pair.
  const safe = runs
    .map(([x, y, len]): Run => {
      let start = 0;
      let end = len;
      if (isLowSurrogate(oldText.charCodeAt(seg.a0 + x)) || isLowSurrogate(newText.charCodeAt(seg.b0 + y))) start++;
      if (end > start && (isHighSurrogate(oldText.charCodeAt(seg.a0 + x + end - 1)) || isHighSurrogate(newText.charCodeAt(seg.b0 + y + end - 1)))) end--;
      return [x + start, y + start, end - start];
    })
    .filter((r) => r[2] > 0);
  const matched = safe.reduce((sum, r) => sum + r[2], 0);
  if ((2 * matched) / (la + lb) < REFINE_SIMILAR) return undefined;
  const out: DiffSegment[] = [];
  let x = 0;
  let y = 0;
  for (const [rx, ry, len] of safe) {
    pushSegment(out, { a0: seg.a0 + x, a1: seg.a0 + rx, b0: seg.b0 + y, b1: seg.b0 + ry, equal: false });
    pushSegment(out, { a0: seg.a0 + rx, a1: seg.a0 + rx + len, b0: seg.b0 + ry, b1: seg.b0 + ry + len, equal: true });
    x = rx + len;
    y = ry + len;
  }
  pushSegment(out, { a0: seg.a0 + x, a1: seg.a1, b0: seg.b0 + y, b1: seg.b1, equal: false });
  return out;
}

/** Whether a cut at `index` falls between two tokens (not inside a word or a surrogate pair). */
function isBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  if (isLowSurrogate(text.charCodeAt(index))) return false;
  return !(WORD.test(text[index - 1]) && WORD.test(text[index]));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Diffs the words of two sub-ranges and appends the result. False when the budget ran out. */
function wordDiff(oldText: string, newText: string, a0: number, a1: number, b0: number, b1: number, out: DiffSegment[], maxEdits: number, expired: () => boolean): boolean {
  if (a0 === a1 || b0 === b1) {
    pushSegment(out, { a0, a1, b0, b1, equal: false });
    return true;
  }
  const partA = oldText.slice(a0, a1);
  const partB = newText.slice(b0, b1);
  const startsA = tokenStarts(partA);
  const startsB = tokenStarts(partB);
  const ids = new Map<string, number>();
  const idOf = (token: string): number => {
    let id = ids.get(token);
    if (id === undefined) {
      id = ids.size;
      ids.set(token, id);
    }
    return id;
  };
  const tokensA = new Int32Array(startsA.length - 1);
  for (let i = 0; i < tokensA.length; i++) tokensA[i] = idOf(partA.slice(startsA[i], startsA[i + 1]));
  const tokensB = new Int32Array(startsB.length - 1);
  for (let i = 0; i < tokensB.length; i++) tokensB[i] = idOf(partB.slice(startsB[i], startsB[i + 1]));
  const runs = myers(tokensA, tokensB, maxEdits, expired);
  if (!runs) {
    if (expired()) return false;
    // Too different to be worth aligning word by word: one replaced stretch.
    pushSegment(out, { a0, a1, b0, b1, equal: false });
    return true;
  }
  let x = 0;
  let y = 0;
  for (const [rx, ry, len] of runs) {
    pushSegment(out, { a0: a0 + startsA[x], a1: a0 + startsA[rx], b0: b0 + startsB[y], b1: b0 + startsB[ry], equal: false });
    pushSegment(out, { a0: a0 + startsA[rx], a1: a0 + startsA[rx + len], b0: b0 + startsB[ry], b1: b0 + startsB[ry + len], equal: true });
    x = rx + len;
    y = ry + len;
  }
  pushSegment(out, { a0: a0 + startsA[x], a1, b0: b0 + startsB[y], b1, equal: false });
  return true;
}

/** Longest stretch of text kept as one piece when cutting it into sentence-like chunks. */
const CHUNK_MAX = 240;
/** Shorter chunks are too common to tell where a text belongs. */
const CHUNK_MIN = 16;

/** Cuts a range of text into chunks at sentence ends (and at spaces inside very long stretches). */
function chunkStarts(text: string, from: number, to: number): number[] {
  const starts = [from];
  let last = from;
  for (let i = from + 2; i < to; i++) {
    if (text.charCodeAt(i - 1) !== 32) continue;
    const before = text.charCodeAt(i - 2);
    const sentenceEnd = before === 46 || before === 33 || before === 63 || before === 58 || before === 59 || before === 0x3002;
    if (sentenceEnd || i - last >= CHUNK_MAX) {
      starts.push(i);
      last = i;
    }
  }
  starts.push(to);
  return starts;
}

/**
 * Sentences that are in both texts exactly once, in the same order (a patience diff): the fixed
 * points the rest is aligned between. Without them a word-by-word diff of a long text pairs up
 * stray spaces and common words of unrelated passages.
 */
function anchorChunks(oldText: string, newText: string, a0: number, a1: number, b0: number, b1: number): Run[] {
  const startsA = chunkStarts(oldText, a0, a1);
  const startsB = chunkStarts(newText, b0, b1);
  const seen = new Map<string, { a: number; countA: number; b: number; countB: number }>();
  for (let i = 0; i + 1 < startsA.length; i++) {
    if (startsA[i + 1] - startsA[i] < CHUNK_MIN) continue;
    const chunk = oldText.slice(startsA[i], startsA[i + 1]);
    const entry = seen.get(chunk);
    if (entry) entry.countA++;
    else seen.set(chunk, { a: startsA[i], countA: 1, b: -1, countB: 0 });
  }
  for (let j = 0; j + 1 < startsB.length; j++) {
    if (startsB[j + 1] - startsB[j] < CHUNK_MIN) continue;
    const entry = seen.get(newText.slice(startsB[j], startsB[j + 1]));
    if (!entry) continue;
    entry.countB++;
    entry.b = startsB[j];
  }
  const pairs: Run[] = [];
  for (const [chunk, entry] of seen) if (entry.countA === 1 && entry.countB === 1) pairs.push([entry.a, entry.b, chunk.length]);
  pairs.sort((p, q) => p[0] - q[0]);
  // Longest increasing subsequence by position in the new text.
  const tails: number[] = [];
  const previous: number[] = new Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const kept: Run[] = [];
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) kept.push(pairs[i]);
  return kept.reverse();
}

/** Equal stretches up to this many characters (not counting spaces) between two changes may be chance. */
const CHANCE_MAX = 16;
/** How many times larger than such a stretch the changes on both sides must be for it to count as chance. */
const CHANCE_FACTOR = 4;

/**
 * Drops matches that are chance: a short equal stretch (a space, "the", "of") between two changes
 * that are each several times its size is part of the change around it. This only ever turns
 * "kept" into "changed"; it never moves where kept text maps to.
 */
function dropChance(oldText: string, newText: string, segments: DiffSegment[]): DiffSegment[] {
  const size = (s: DiffSegment) => countInk(oldText, s.a0, s.a1) + countInk(newText, s.b0, s.b1);
  // First the spaces between changed words (so neighboring changes become one), then short words.
  let current = segments;
  for (const limit of [0, CHANCE_MAX]) {
    const out: DiffSegment[] = [];
    for (let i = 0; i < current.length; i++) {
      const seg = current[i];
      const before = out[out.length - 1];
      const after = current[i + 1];
      if (seg.equal && before && after && !before.equal && !after.equal) {
        const kept = countInk(oldText, seg.a0, seg.a1);
        if (kept <= limit && size(before) >= Math.max(1, CHANCE_FACTOR * kept) && size(after) >= Math.max(1, CHANCE_FACTOR * kept)) {
          pushSegment(out, { ...seg, equal: false });
          continue;
        }
      }
      pushSegment(out, seg);
    }
    current = out;
  }
  return current;
}

/**
 * Diffs two texts: sentences found once in both are the fixed points, the text between them is
 * diffed word by word, and replaced words that are alike are compared letter by letter. Returns
 * undefined when the time budget runs out; callers then fall back to searching for the quote.
 */
export function diffTexts(oldText: string, newText: string, options: DiffOptions = {}): TextDiff | undefined {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? 250);
  const expired = () => now() > deadline;
  const maxEdits = options.maxEdits ?? 2500;
  const result: TextDiff = { segments: [], oldLength: oldText.length, newLength: newText.length };
  if (oldText === newText) {
    pushSegment(result.segments, { a0: 0, a1: oldText.length, b0: 0, b1: newText.length, equal: true });
    return result;
  }

  // Common start and end, on token boundaries of both texts.
  const limit = Math.min(oldText.length, newText.length);
  let head = 0;
  while (head < limit && oldText.charCodeAt(head) === newText.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < limit - head && oldText.charCodeAt(oldText.length - 1 - tail) === newText.charCodeAt(newText.length - 1 - tail)) tail++;
  // Step back to a boundary between words in both texts, so words cut by the trimming are diffed whole.
  while (head > 0 && !(isBoundary(oldText, head) && isBoundary(newText, head))) head--;
  while (tail > 0 && !(isBoundary(oldText, oldText.length - tail) && isBoundary(newText, newText.length - tail))) tail--;

  const endA = oldText.length - tail;
  const endB = newText.length - tail;
  const coarse: DiffSegment[] = [];
  pushSegment(coarse, { a0: 0, a1: head, b0: 0, b1: head, equal: true });
  let a = head;
  let b = head;
  for (const [anchorA, anchorB, length] of anchorChunks(oldText, newText, head, endA, head, endB)) {
    if (anchorA < a || anchorB < b) continue;
    if (!wordDiff(oldText, newText, a, anchorA, b, anchorB, coarse, maxEdits, expired)) return undefined;
    pushSegment(coarse, { a0: anchorA, a1: anchorA + length, b0: anchorB, b1: anchorB + length, equal: true });
    a = anchorA + length;
    b = anchorB + length;
  }
  if (!wordDiff(oldText, newText, a, endA, b, endB, coarse, maxEdits, expired)) return undefined;
  pushSegment(coarse, { a0: endA, a1: oldText.length, b0: endB, b1: newText.length, equal: true });

  for (const seg of dropChance(oldText, newText, coarse)) {
    const fine = seg.equal ? undefined : refine(oldText, newText, seg, expired);
    if (fine) for (const s of fine) pushSegment(result.segments, s);
    else pushSegment(result.segments, seg);
  }
  return result;
}

function key(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * When a block was duplicated next to itself, the diff cannot tell which of the two is the copy.
 * The editor can: this moves such insertions to the side the hints name.
 */
export function applyCopyHints(diff: TextDiff, newText: string, hints: readonly CopyHint[]): TextDiff {
  if (hints.length === 0) return diff;
  const keyed = hints.map((h) => ({ key: key(h.text), side: h.side })).filter((h) => h.key.length >= 6);
  if (keyed.length === 0) return diff;
  const segs = diff.segments.map((s) => ({ ...s }));
  for (let i = 0; i < segs.length; i++) {
    const ins = segs[i];
    if (ins.equal || ins.a0 !== ins.a1) continue;
    const length = ins.b1 - ins.b0;
    const insKey = key(newText.slice(ins.b0, ins.b1));
    if (insKey.length < 6) continue;
    // The diff may have cut the copy at another point of the repetition: compare as a rotation too.
    const hint = keyed.find((h) => h.key.includes(insKey) || insKey.includes(h.key) || (h.key.length === insKey.length && (insKey + insKey).includes(h.key)));
    if (!hint) continue;
    const prev = segs[i - 1];
    const next = segs[i + 1];
    if (hint.side === 'before' && prev?.equal) {
      // The copy is the first of the two: slide the insertion left over the identical text.
      let k = 0;
      const maxK = Math.min(length, prev.a1 - prev.a0);
      while (k < maxK && newText.charCodeAt(ins.b0 - 1 - k) === newText.charCodeAt(ins.b1 - 1 - k)) k++;
      if (k < length) continue;
      prev.a1 -= k;
      prev.b1 -= k;
      ins.a0 -= k;
      ins.a1 -= k;
      ins.b0 -= k;
      ins.b1 -= k;
      const moved: DiffSegment = { a0: ins.a1, a1: ins.a1 + k, b0: ins.b1, b1: ins.b1 + k, equal: true };
      segs.splice(i + 1, 0, moved);
    } else if (hint.side === 'after' && next?.equal) {
      let k = 0;
      const maxK = Math.min(length, next.a1 - next.a0);
      while (k < maxK && newText.charCodeAt(ins.b0 + k) === newText.charCodeAt(ins.b1 + k)) k++;
      if (k < length) continue;
      const moved: DiffSegment = { a0: ins.a0, a1: ins.a0 + k, b0: ins.b0, b1: ins.b0 + k, equal: true };
      next.a0 += k;
      next.b0 += k;
      ins.a0 += k;
      ins.a1 += k;
      ins.b0 += k;
      ins.b1 += k;
      segs.splice(i, 0, moved);
      i++;
    }
  }
  const out: TextDiff = { segments: [], oldLength: diff.oldLength, newLength: diff.newLength };
  for (const s of segs) pushSegment(out.segments, s);
  return out;
}

// ---------- Mapping ----------

/** Index of the segment holding old character `p` (the first one whose old range ends after it). */
function segmentOfOld(diff: TextDiff, p: number): number {
  const segs = diff.segments;
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].a1 > p) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Where an old boundary is in the new text, seen from the text before it: right after the image of
 * old character p-1, or where that character was deleted. Text inserted exactly at the boundary
 * comes after the result.
 */
export function mapPointLeft(diff: TextDiff, p: number): number {
  if (p <= 0) return 0;
  const seg = diff.segments[segmentOfOld(diff, p - 1)];
  if (!seg) return diff.newLength;
  return seg.equal ? seg.b0 + (p - seg.a0) : seg.b0;
}

/** The same seen from the text after it: the image of old character p, or the end of what replaced it. */
export function mapPointRight(diff: TextDiff, p: number): number {
  if (p >= diff.oldLength) return diff.newLength;
  const seg = diff.segments[segmentOfOld(diff, p)];
  if (!seg) return diff.newLength;
  return seg.equal ? seg.b0 + (p - seg.a0) : seg.b1;
}

export interface MappedRange {
  /** The new range from the first to the last surviving character; empty (start = end) when none survives. */
  start: number;
  end: number;
  /** Surviving characters of the old range, white space not counted, and how many it had. */
  kept: number;
  total: number;
  /** Something was inserted, deleted or replaced inside the old range. */
  changed: boolean;
  /** Where the old range was: the end of what came before it and the start of what came after, in the new text. */
  gap: [number, number];
}

function countInk(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) !== 32) n++;
  return n;
}

/**
 * Maps an old range to the new text. The start is right-associative and the end left-associative:
 * text typed right before or right after the range does not join it. When the first or last word
 * was edited in place (a typo fixed), the range grows over the rest of the new word.
 */
export function mapRange(diff: TextDiff, oldText: string, newText: string, start: number, end: number): MappedRange {
  const s = Math.max(0, Math.min(start, diff.oldLength));
  const e = Math.max(s, Math.min(end, diff.oldLength));
  const gap: [number, number] = [mapPointLeft(diff, s), mapPointRight(diff, e)];
  if (gap[1] < gap[0]) gap[1] = gap[0];
  const total = countInk(oldText, s, e);
  let first = -1;
  let last = -1;
  let kept = 0;
  let changed = false;
  let headSeg = -1;
  let tailSeg = -1;
  const segs = diff.segments;
  for (let i = segmentOfOld(diff, s); i < segs.length; i++) {
    const seg = segs[i];
    if (seg.a0 >= e && !(seg.a0 === seg.a1 && seg.a0 < e)) break;
    if (seg.equal) {
      const from = Math.max(s, seg.a0);
      const to = Math.min(e, seg.a1);
      if (to <= from) continue;
      const count = countInk(oldText, from, to);
      if (count === 0 && first < 0) continue;
      kept += count;
      if (first < 0) {
        first = seg.b0 + (from - seg.a0);
        headSeg = i;
      }
      if (count > 0) {
        // Up to the last character that is not white space, so `last` sits at the end of its segment only when the text does.
        let stop = to;
        while (stop > from && oldText.charCodeAt(stop - 1) === 32) stop--;
        last = seg.b0 + (stop - seg.a0);
        tailSeg = i;
      }
    } else if (seg.a0 === seg.a1) {
      if (seg.a0 > s && seg.a0 < e) changed = true;
    } else if (seg.a0 < e && seg.a1 > s) {
      changed = true;
    }
  }
  if (first < 0 || last < 0 || kept === 0) {
    return { start: gap[0], end: gap[0], kept: 0, total, changed: true, gap };
  }
  // An edge word edited in place: take in the new letters that continue it, when they replaced
  // letters of this range or the range ended on a word boundary (so the word was changed, and
  // the range did not stop inside it on purpose).
  const before = segs[headSeg - 1];
  const headOnBoundary = s === 0 || !WORD.test(oldText[s - 1]);
  const mappedFirst = first;
  const mappedLast = last;
  if (before && !before.equal && before.b1 === first && (before.a1 > s || headOnBoundary)) {
    while (first > before.b0 && WORD.test(newText[first - 1]) && WORD.test(newText[first])) first--;
  }
  const after = segs[tailSeg + 1];
  const tailOnBoundary = e >= oldText.length || !WORD.test(oldText[e]);
  if (after && !after.equal && after.b0 === last && (after.a0 < e || tailOnBoundary)) {
    while (last < after.b1 && WORD.test(newText[last]) && WORD.test(newText[last - 1])) last++;
  }
  // New letters taken in at an edge are a change of the passage.
  if (first !== mappedFirst || last !== mappedLast) changed = true;
  while (first < last && newText.charCodeAt(first) === 32) first++;
  while (last > first && newText.charCodeAt(last - 1) === 32) last--;
  return { start: first, end: last, kept, total, changed, gap };
}

/** How much of a new range (0..1) is text the diff says was inserted or replaced. */
export function insertedShare(diff: TextDiff, start: number, end: number): number {
  if (end <= start) return 0;
  let inserted = 0;
  for (const seg of diff.segments) {
    if (seg.b1 <= start) continue;
    if (seg.b0 >= end) break;
    if (!seg.equal) inserted += Math.min(end, seg.b1) - Math.max(start, seg.b0);
  }
  return inserted / (end - start);
}

const insertedCache = new WeakMap<TextDiff, [number, number][]>();

/** The stretches of the new text that the diff calls inserted or replaced. */
export function insertedRanges(diff: TextDiff): [number, number][] {
  let ranges = insertedCache.get(diff);
  if (!ranges) {
    ranges = [];
    for (const seg of diff.segments) if (!seg.equal && seg.b1 > seg.b0) ranges.push([seg.b0, seg.b1]);
    insertedCache.set(diff, ranges);
  }
  return ranges;
}

/** Where a quote stands entirely inside new text (most `limit` places). */
export function insertedOccurrences(diff: TextDiff, newText: string, quote: string, limit = 200): number[] {
  const out: number[] = [];
  if (quote.length === 0) return out;
  for (const [from, to] of insertedRanges(diff)) {
    if (to - from < quote.length) continue;
    for (let at = newText.indexOf(quote, from); at !== -1 && at + quote.length <= to && out.length < limit; at = newText.indexOf(quote, at + 1)) out.push(at);
  }
  return out;
}

/** Characters two texts have in common, in order (white space not counted), for short texts. */
export function commonInk(a: string, b: string): number | undefined {
  if (a.length > REFINE_MAX * 2 || b.length > REFINE_MAX * 2) return undefined;
  const runs = myers(codes(a), codes(b), a.length + b.length, () => false);
  if (!runs) return undefined;
  let n = 0;
  for (const [x, , len] of runs) n += countInk(a, x, x + len);
  return n;
}
