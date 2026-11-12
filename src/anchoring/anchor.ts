// What ties an annotation to text, and what the viewer derives from it.
//
// A TextAnchor is made by the reader (by highlighting, placing the marker, drawing over words) and
// changes only when the reader acts. An AnchorState is a cache: where the anchor was last found.
// It can be thrown away and recomputed at any time.
import { TEXT_MODEL_VERSION } from './textModel';

/** Characters of context kept on each side of a new anchor. */
export const WIDE_CONTEXT = 64;
/** How far around an anchor its fingerprint reaches, and how many words it keeps per side. */
export const FINGERPRINT_REACH = 512;
export const FINGERPRINT_WORDS = 96;

export interface TextAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  /**
   * 16-bit hashes of the words around the anchor (nearest first), out to FINGERPRINT_REACH
   * characters. Tells identical passages apart when their near context is identical too.
   */
  fingerprint?: { before: number[]; after: number[] };
  /** The text it was made in. */
  createdIn?: { hash: string; v: number; start: number };
}

export type ResolutionKind = 'exact' | 'shifted' | 'edited' | 'partial' | 'moved';
export type OrphanReason = 'deleted' | 'replaced' | 'not-found' | 'page-missing' | 'invalid';

export const RESOLUTION_KINDS: readonly ResolutionKind[] = ['exact', 'shifted', 'edited', 'partial', 'moved'];
export const ORPHAN_REASONS: readonly OrphanReason[] = ['deleted', 'replaced', 'not-found', 'page-missing', 'invalid'];

/** The version of the text an anchor was last found in, and where. */
export interface FoundState {
  hash: string;
  /** TEXT_MODEL_VERSION of that text. */
  v: number;
  /** Length of that text. */
  length: number;
  start: number;
  end: number;
  /** The text there, when it differs from the quote (an edited or partly deleted passage). */
  text?: string;
  /** The page it was on (0-based), for "was on page N". */
  page?: number;
}

export interface AnchorState {
  /** Only advanced when the anchor is actually found, so a briefly empty file cannot erase it. */
  found?: FoundState;
  status: 'anchored' | 'orphaned';
  kind?: ResolutionKind;
  reason?: OrphanReason;
  /** Hash of the text this state was computed for. */
  resolvedIn?: string;
}

/** A combining mark, a zero-width joiner or a variation selector: it belongs to the character before it. */
const MARK = /\p{M}|\u200d|\ufe0e|\ufe0f/u;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Whether a boundary at `index` would split a surrogate pair or cut a base character from its marks. */
function splitsCluster(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  if (isLowSurrogate(text.charCodeAt(index))) return true;
  const next = String.fromCodePoint(text.codePointAt(index) ?? 0);
  if (MARK.test(next)) return true;
  // After a zero-width joiner the next character belongs to the same cluster.
  return text.charCodeAt(index - 1) === 0x200d;
}

/** The nearest boundary at or before `index` that does not split a character. */
export function clusterStart(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length));
  while (splitsCluster(text, i)) i--;
  return i;
}

/** The nearest boundary at or after `index` that does not split a character. */
export function clusterEnd(text: string, index: number): number {
  let i = Math.max(0, Math.min(index, text.length));
  while (splitsCluster(text, i)) i++;
  return i;
}

function hashWord(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ (h >>> 16)) & 0xffff;
}

const WORDS = /[\p{L}\p{N}]+/gu;

function wordHashes(text: string): number[] {
  return (text.toLowerCase().match(WORDS) ?? []).map(hashWord);
}

export function fingerprintAt(text: string, start: number, end: number): { before: number[]; after: number[] } {
  const before = wordHashes(text.slice(Math.max(0, start - FINGERPRINT_REACH), start))
    .reverse()
    .slice(0, FINGERPRINT_WORDS);
  const after = wordHashes(text.slice(end, end + FINGERPRINT_REACH)).slice(0, FINGERPRINT_WORDS);
  return { before, after };
}

function containment(stored: number[], here: number[]): number | undefined {
  if (stored.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const h of here) counts.set(h, (counts.get(h) ?? 0) + 1);
  let hit = 0;
  for (const h of stored) {
    const n = counts.get(h) ?? 0;
    if (n > 0) {
      hit++;
      counts.set(h, n - 1);
    }
  }
  return hit / stored.length;
}

/** How well the words around a place match an anchor's fingerprint (0..1); undefined without a fingerprint. */
export function fingerprintSimilarity(anchor: TextAnchor, text: string, start: number, end: number): number | undefined {
  if (!anchor.fingerprint) return undefined;
  const here = fingerprintAt(text, start, end);
  const parts = [containment(anchor.fingerprint.before, here.before), containment(anchor.fingerprint.after, here.after)].filter((n): n is number => n !== undefined);
  if (parts.length === 0) return undefined;
  // Both sides have to agree: in a short text the words after one place are the words before another.
  return Math.min(...parts);
}

/** Makes the anchor of a range of the current text. Context never starts or ends inside a character. */
export function createAnchor(text: string, hash: string, start: number, end: number): TextAnchor {
  const s = clusterStart(text, start);
  const e = Math.max(s, clusterEnd(text, end));
  return {
    exact: text.slice(s, e),
    prefix: text.slice(clusterEnd(text, Math.max(0, s - WIDE_CONTEXT)), s),
    suffix: text.slice(e, clusterStart(text, Math.min(text.length, e + WIDE_CONTEXT))),
    fingerprint: fingerprintAt(text, s, e),
    createdIn: { hash, v: TEXT_MODEL_VERSION, start: s },
  };
}

function isFiniteInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= -1 && n < 2 ** 31;
}

function hashArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff).slice(0, FINGERPRINT_WORDS);
}

/** A clean copy of an anchor from untrusted input, or undefined if it is not one. */
export function sanitizeAnchor(value: unknown): TextAnchor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const a = value as Record<string, unknown>;
  if (typeof a.exact !== 'string' || a.exact.length === 0) return undefined;
  const anchor: TextAnchor = {
    exact: a.exact,
    prefix: typeof a.prefix === 'string' ? a.prefix : '',
    suffix: typeof a.suffix === 'string' ? a.suffix : '',
  };
  const fp = a.fingerprint as Record<string, unknown> | undefined;
  if (fp && typeof fp === 'object') {
    const before = hashArray(fp.before);
    const after = hashArray(fp.after);
    if (before && after) anchor.fingerprint = { before, after };
  }
  const made = a.createdIn as Record<string, unknown> | undefined;
  if (made && typeof made === 'object' && typeof made.hash === 'string' && isFiniteInt(made.v) && isFiniteInt(made.start)) {
    anchor.createdIn = { hash: made.hash.slice(0, 64), v: made.v, start: made.start };
  }
  return anchor;
}

/** A clean copy of a derived state from untrusted input; anything doubtful is dropped (it is only a cache). */
export function sanitizeState(value: unknown): AnchorState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const s = value as Record<string, unknown>;
  const state: AnchorState = { status: s.status === 'orphaned' ? 'orphaned' : 'anchored' };
  if (typeof s.kind === 'string' && (RESOLUTION_KINDS as readonly string[]).includes(s.kind)) state.kind = s.kind as ResolutionKind;
  if (typeof s.reason === 'string' && (ORPHAN_REASONS as readonly string[]).includes(s.reason)) state.reason = s.reason as OrphanReason;
  if (typeof s.resolvedIn === 'string') state.resolvedIn = s.resolvedIn.slice(0, 64);
  const f = s.found as Record<string, unknown> | undefined;
  if (
    f &&
    typeof f === 'object' &&
    typeof f.hash === 'string' &&
    isFiniteInt(f.v) &&
    isFiniteInt(f.length) &&
    isFiniteInt(f.start) &&
    isFiniteInt(f.end) &&
    f.start >= 0 &&
    f.end > f.start &&
    (f.length < 0 || f.end <= f.length)
  ) {
    state.found = { hash: f.hash.slice(0, 64), v: f.v, length: f.length, start: f.start, end: f.end };
    if (typeof f.text === 'string' && f.text.length > 0) state.found.text = f.text;
    if (isFiniteInt(f.page) && f.page >= 0) state.found.page = f.page;
  }
  return state;
}
