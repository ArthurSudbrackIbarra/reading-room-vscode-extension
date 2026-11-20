// The glossary of a document: terms the reader defined, and where each of them is written in the
// text of the document. The data model, its limits and its validation, and the search for the
// terms, shared by the host (storage, import) and the viewer. No runtime dependencies.

/** Most terms one document can have. */
export const MAX_TERMS = 2000;
/** Most characters of a term (a word, an acronym, a short phrase). */
export const MAX_TERM_LENGTH = 100;
/** Most characters of a definition. */
export const MAX_DEFINITION_LENGTH = 4000;

export interface GlossaryTerm {
  id: string;
  /** The term as the reader wrote it: one line, single spaces. Never empty. */
  term: string;
  /** What it means; lines are separated by "\n". Never empty. */
  definition: string;
  createdAt: string;
  updatedAt: string;
}

/** A place where a term is written: characters [start, end) of the text. */
export interface TermMatch {
  start: number;
  end: number;
  /** The term that is written there. */
  id: string;
}

/** A term as it may be stored: one line, white space as single spaces, none at its ends. */
export function cleanTerm(value: string): string {
  const clean = value
    // Control characters have no place in a term (line breaks and tabs become spaces below).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return clean.length > MAX_TERM_LENGTH ? clean.slice(0, MAX_TERM_LENGTH).trim() : clean;
}

/** A definition as it may be stored: line breaks as "\n", no other control characters, no white space at its ends. */
export function cleanDefinition(value: string): string {
  const clean = value
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .trim();
  return clean.length > MAX_DEFINITION_LENGTH ? clean.slice(0, MAX_DEFINITION_LENGTH).trim() : clean;
}

/**
 * Lower case that never changes the length of the text, so a place found in the lowered text is
 * the same place in the text itself. (A few characters have a lower case of another length, like
 * the dotted capital I of Turkish: those stay as they are.)
 */
export function lowerSameLength(text: string): string {
  const lowered = text.toLowerCase();
  // Lowering never makes a character shorter, so the same length means character for character.
  if (lowered.length === text.length) return lowered;
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/**
 * Whether a term is written in capitals only ("MLP", "IT", "GPT-4"): at least one capital letter
 * and no small one. Such a term is looked for exactly as written ("IT" is not "it"); any other
 * term is found whatever its capitals ("Backpropagation" at the start of a sentence too).
 */
export function isAcronym(term: string): boolean {
  return /\p{Lu}/u.test(term) && !/\p{Ll}/u.test(term);
}

/**
 * What makes two terms the same term: they are written in the same places. A document has one
 * definition per key. ("IT" and "it" are two terms: the first is only found in capitals.)
 */
export function termKey(term: string): string {
  const clean = cleanTerm(term);
  return isAcronym(clean) ? `=${clean}` : `~${lowerSameLength(clean)}`;
}

function isIdLike(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Checks a term from disk or from a viewer and returns a clean copy of the known fields, or undefined if it is not usable. */
export function sanitizeTerm(value: unknown): GlossaryTerm | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isIdLike(raw.id) || typeof raw.term !== 'string' || typeof raw.definition !== 'string') return undefined;
  const term = cleanTerm(raw.term);
  const definition = cleanDefinition(raw.definition);
  if (!term || !definition) return undefined;
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : createdAt;
  return { id: raw.id, term, definition, createdAt, updatedAt };
}

/**
 * A list of terms from disk or from a viewer: the usable ones, each id once, each key once (the
 * one changed last stays), no more than `MAX_TERMS`.
 */
export function sanitizeTerms(value: unknown): GlossaryTerm[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, GlossaryTerm>();
  for (const item of value) {
    const term = sanitizeTerm(item);
    if (term && !byId.has(term.id)) byId.set(term.id, term);
  }
  return uniqueKeys([...byId.values()]).slice(0, MAX_TERMS);
}

/** One term per key: of two with the same key, the one changed last stays (in the place of the first). */
export function uniqueKeys(terms: GlossaryTerm[]): GlossaryTerm[] {
  const byKey = new Map<string, GlossaryTerm>();
  for (const term of terms) {
    const key = termKey(term.term);
    const other = byKey.get(key);
    if (!other || term.updatedAt > other.updatedAt) byKey.set(key, term);
  }
  return [...byKey.values()];
}

/** The terms in the order of a glossary: by the alphabet, whatever their capitals. */
export function sortTerms<T extends Pick<GlossaryTerm, 'term'>>(terms: readonly T[]): T[] {
  return [...terms].sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base', numeric: true }) || a.term.localeCompare(b.term));
}

// ---------- Where the terms are written ----------

/** A character that is part of a word: a letter, a digit, a mark on a letter, or an underscore. */
const WORD = /[\p{L}\p{N}\p{M}_]/u;
/** Scripts written without spaces between words: there, any stretch of text may be a word. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** The character (a whole one, whatever its length) that starts at `index`. */
function charAt(text: string, index: number): string {
  const code = text.codePointAt(index);
  return code === undefined ? '' : String.fromCodePoint(code);
}

/** The character (a whole one) that ends at `index`. */
function charBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const low = text.charCodeAt(index - 1);
  const pair = index >= 2 && low >= 0xdc00 && low <= 0xdfff && text.charCodeAt(index - 2) >= 0xd800 && text.charCodeAt(index - 2) <= 0xdbff;
  return text.slice(index - (pair ? 2 : 1), index);
}

/** Whether two characters next to each other are part of one word. */
function joined(a: string, b: string): boolean {
  if (!a || !b || !WORD.test(a) || !WORD.test(b)) return false;
  return !UNSPACED.test(a) && !UNSPACED.test(b);
}

/** Whether characters [start, end) of a text stand there as whole words: no word goes on before or after them. */
export function isWholeWord(text: string, start: number, end: number): boolean {
  return !joined(charBefore(text, start), charAt(text, start)) && !joined(charBefore(text, end), charAt(text, end));
}

/** The text in lower case, made when it is first needed (terms in capitals do not need it). */
function lazyLower(text: string): () => string {
  let lowered: string | undefined;
  return () => (lowered ??= lowerSameLength(text));
}

/** The places where one term stands in a text as whole words: [start, end, found exactly as written]. */
function* placesOf(text: string, lowered: () => string, term: string): Generator<[start: number, end: number, exact: boolean]> {
  const clean = cleanTerm(term);
  if (!clean) return;
  const exact = isAcronym(clean);
  const hay = exact ? text : lowered();
  const needle = exact ? clean : lowerSameLength(clean);
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (isWholeWord(text, at, at + needle.length)) yield [at, at + needle.length, exact];
  }
}

/**
 * Every place where the terms are written in a text (the text of a document, with its white space
 * as single spaces), in the order of the text.
 *  - Whole words only: "MLP" is not found in "MLPs" or in "AMLP".
 *  - A term in capitals is found exactly as written; any other whatever its capitals.
 *  - Places never overlap: of two terms that start at the same character the longer one is
 *    there, and a term that starts inside another is not.
 */
export function findTerms(text: string, terms: readonly Pick<GlossaryTerm, 'id' | 'term'>[]): TermMatch[] {
  if (text.length === 0 || terms.length === 0) return [];
  const lowered = lazyLower(text);
  const found: (TermMatch & { exact: boolean })[] = [];
  for (const { id, term } of terms) {
    for (const [start, end, exact] of placesOf(text, lowered, term)) found.push({ start, end, id, exact });
  }
  // The first in the text first; at the same place the longer one, then the one written exactly so.
  found.sort((a, b) => a.start - b.start || b.end - a.end || Number(b.exact) - Number(a.exact));
  const matches: TermMatch[] = [];
  let free = 0;
  for (const { start, end, id } of found) {
    if (start < free) continue;
    matches.push({ start, end, id });
    free = end;
  }
  return matches;
}

/** Those of `terms` that are written in a text at least once. */
export function termsWrittenIn(text: string, terms: readonly string[]): string[] {
  if (text.length === 0) return [];
  const lowered = lazyLower(text);
  return terms.filter((term) => !placesOf(text, lowered, term).next().done);
}

/** Whether a term is written in a text at least once. */
export function occursIn(text: string, term: string): boolean {
  return termsWrittenIn(text, [term]).length > 0;
}

/** How many times each term is written, from the places found. */
export function countMatches(matches: readonly TermMatch[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) counts.set(match.id, (counts.get(match.id) ?? 0) + 1);
  return counts;
}

/** The first place at or after `from` that reaches into [from, to): where the places of a page start. */
export function firstMatchIn(matches: readonly TermMatch[], from: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].end <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
