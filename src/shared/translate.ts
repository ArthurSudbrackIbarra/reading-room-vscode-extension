// What the translate tool needs on both sides: the languages, the way from one language to
// another (every language pack is to or from English), and the text as it is given to the
// translator. No `vscode` and no DOM here, so it is unit-tested as it runs.

/** "Detect the language" as a source language. */
export const AUTO = 'auto';

/** The most characters translated at once (about eight pages). */
export const MAX_TRANSLATE_CHARS = 20_000;
/** How much of the document around a short selection is used to tell its language. */
export const CONTEXT_CHARS = 1_600;

/** The languages Mozilla's packs are named after, as the interface says them. */
export const LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans',
  ar: 'Arabic',
  az: 'Azerbaijani',
  be: 'Belarusian',
  bg: 'Bulgarian',
  bn: 'Bengali',
  bs: 'Bosnian',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  et: 'Estonian',
  eu: 'Basque',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  gl: 'Galician',
  gu: 'Gujarati',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  is: 'Icelandic',
  it: 'Italian',
  ja: 'Japanese',
  kn: 'Kannada',
  ko: 'Korean',
  lt: 'Lithuanian',
  lv: 'Latvian',
  ml: 'Malayalam',
  mr: 'Marathi',
  ms: 'Malay',
  nb: 'Norwegian',
  nl: 'Dutch',
  nn: 'Norwegian Nynorsk',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sq: 'Albanian',
  sr: 'Serbian',
  sv: 'Swedish',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tl: 'Tagalog',
  tr: 'Turkish',
  ug: 'Uyghur',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Chinese (Simplified)',
  zh_hant: 'Chinese (Traditional)',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/** A language of the menus: whether text in it can be translated (`from`), and whether text can be translated into it (`to`). */
export interface TranslateLanguage {
  code: string;
  name: string;
  from: boolean;
  to: boolean;
}

/** One pack serves Bosnian, Croatian and Serbian as a source (Mozilla names it after the macrolanguage). */
const SERBO_CROATIAN = new Set(['bs', 'hr', 'sr']);
const SERBO_CROATIAN_PACK = 'hbs-en';

/** The pack that translates `code` into English, among the packs there are. */
export function packIntoEnglish(code: string, hasPack: (pair: string) => boolean): string | undefined {
  if (SERBO_CROATIAN.has(code) && hasPack(SERBO_CROATIAN_PACK)) return SERBO_CROATIAN_PACK;
  return hasPack(`${code}-en`) ? `${code}-en` : undefined;
}

/** The pack that translates English into `code`. */
export function packFromEnglish(code: string, hasPack: (pair: string) => boolean): string | undefined {
  return hasPack(`en-${code}`) ? `en-${code}` : undefined;
}

/**
 * The languages of the menus, by name, from the packs there are. Norwegian has two codes for the
 * same written language (`nb` and `no`): only one of them is listed.
 */
export function languagesOf(pairs: Iterable<string>): TranslateLanguage[] {
  const all = new Set(pairs);
  const has = (pair: string): boolean => all.has(pair);
  const codes = new Set<string>(['en']);
  for (const pair of all) {
    const [from, to] = pair.split('-');
    for (const code of [from, to]) if (code in LANGUAGE_NAMES) codes.add(code);
  }
  for (const code of SERBO_CROATIAN) if (all.has(SERBO_CROATIAN_PACK)) codes.add(code);
  if (codes.has('nb')) codes.delete('no');
  return [...codes]
    .map((code) => ({
      code,
      name: languageName(code),
      from: code === 'en' || packIntoEnglish(code, has) !== undefined,
      to: code === 'en' || packFromEnglish(code, has) !== undefined,
    }))
    .filter((language) => language.from || language.to)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export type RouteProblem = 'same' | 'no-source' | 'no-target';

/**
 * The packs that translate `from` into `to`, in the order they are used: one when English is at
 * either end, two (by way of English) otherwise.
 */
export function routeFor(from: string, to: string, hasPack: (pair: string) => boolean): { packs: string[] } | { problem: RouteProblem } {
  if (from === to) return { problem: 'same' };
  const packs: string[] = [];
  if (from !== 'en') {
    const first = packIntoEnglish(from, hasPack);
    if (!first) return { problem: 'no-source' };
    packs.push(first);
  }
  if (to !== 'en') {
    const second = packFromEnglish(to, hasPack);
    if (!second) return { problem: 'no-target' };
    packs.push(second);
  }
  return { packs };
}

/** "Japanese → English": a pack as the interface says it. */
export function packLabel(pair: string): string {
  const [from, to] = pair.split('-');
  return `${from === 'hbs' ? 'Bosnian, Croatian and Serbian' : languageName(from)} → ${languageName(to)}`;
}

/** The language the interface of VS Code is in, as a language to translate into (English when there is no pack for it). */
export function defaultTarget(displayLanguage: string, languages: TranslateLanguage[]): string {
  const tag = displayLanguage.toLowerCase();
  const code = /^zh[-_](tw|hk|mo|hant)/.test(tag) ? 'zh_hant' : tag.split(/[-_]/)[0] === 'no' ? 'nb' : tag.split(/[-_]/)[0];
  return languages.some((language) => language.code === code && language.to) ? code : 'en';
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const LOWER = /\p{Ll}/u;

/**
 * Text taken from the pages, as it reads. The text model has one space where a line ends, so a
 * word cut at the end of a line comes as "sen- tence", and two lines of Japanese come with a space
 * between them. `isLineEnd(i)` says whether the space at `i` stands for the end of a line: there,
 * a hyphen between two lowercase letters is taken out with the space, and so is a space between
 * two characters of a script that is written without spaces. Soft hyphens are taken out everywhere.
 */
export function readingText(text: string, isLineEnd: (index: number) => boolean = () => false): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\u00ad') continue;
    if (ch === ' ' && isLineEnd(i)) {
      const before = out[out.length - 1] ?? '';
      const next = text[i + 1] ?? '';
      if (before === '-' && LOWER.test(out[out.length - 2] ?? '') && LOWER.test(next)) {
        out = out.slice(0, -1);
        continue;
      }
      if (CJK.test(before) && CJK.test(next)) continue;
    }
    out += ch;
  }
  return out.trim();
}

/** Where a sentence ends: after its closing punctuation (and what closes a quote or a bracket), or at a line break. */
const SENTENCE = /[^.!?。！？…\n]*(?:[.!?。！？…]+["'”’»)\]」』]*|\n+|$)\s*/gu;

/**
 * Cuts a text into pieces of at most `max` characters for the translator, at the ends of
 * sentences where there are any (a longer sentence is cut at a space, and one without spaces
 * anywhere). The pieces are trimmed: they are joined again with `joinTranslated`.
 */
export function chunkText(text: string, max = 1_200): string[] {
  const chunks: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const sentence of text.match(SENTENCE) ?? []) {
    let rest = sentence;
    if (current.length + rest.length <= max) {
      current += rest;
      continue;
    }
    push();
    while (rest.length > max) {
      const space = rest.lastIndexOf(' ', max);
      const cut = space > max / 2 ? space + 1 : max;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    current = rest;
  }
  push();
  return chunks.filter((chunk) => chunk.length > 0);
}

/** The translated pieces as one text: a space between them, except in languages written without spaces. */
export function joinTranslated(pieces: string[], to: string): string {
  return pieces
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join(to === 'ja' || to === 'zh' || to === 'zh_hant' ? '' : ' ');
}

/** What a viewer asks for. */
export interface TranslateRequest {
  requestId: number;
  text: string;
  /** The document around the text, to tell the language of a short selection. */
  context?: string;
  /** A language code, or `AUTO`. */
  from: string;
  to: string;
}

export type TranslationStep = 'detecting' | 'asking' | 'downloading' | 'translating';

/** Why there is no translation. */
export type TranslationProblem =
  /** The language of the text could not be told. */
  | 'undetected'
  /** The text is in a language there is no pack for (`from` names it). */
  | 'unsupported'
  /** The text is already in the language asked for. */
  | 'same'
  /** A pack would have to be downloaded, and the reader said no (or the setting forbids it). */
  | 'declined'
  | 'download-failed'
  | 'too-long'
  | 'failed';

/** What the host tells the viewer about its request, as it goes. */
export type TranslationUpdate =
  | { status: 'working'; step: TranslationStep; from?: string; to: string; /** Downloading: 0 to 1. */ progress?: number; /** What is translated so far. */ text?: string }
  | { status: 'done'; from: string; to: string; text: string; /** Translated in two steps, by way of English. */ pivot: boolean; detected: boolean }
  | { status: 'error'; problem: TranslationProblem; message: string; from?: string; to: string };
