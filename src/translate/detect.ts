// Telling which language a text is in, among the languages there are packs for. On this computer,
// like the translation itself: two small detectors bundled with the extension, and the scripts.
//  - Scripts that belong to one language (kana, hangul) decide at once.
//  - A long text is told by its letter trigrams (franc), which knows every language there is a
//    pack for but needs length.
//  - A sentence by tinyld, which is good at short text but knows fewer languages: where the
//    document around the sentence is in a language tinyld does not know, the document is believed.
//  - A few words by the document around them: they say little, the page they are on says a lot.
import { franc } from 'franc';
import { detect as detectShort } from 'tinyld';

/** franc's codes (ISO 639-3) for the languages of the packs. */
const FRANC_CODES: Record<string, string> = {
  afr: 'af',
  arb: 'ar',
  azj: 'az',
  bel: 'be',
  bul: 'bg',
  ben: 'bn',
  bos: 'bs',
  cat: 'ca',
  ces: 'cs',
  dan: 'da',
  deu: 'de',
  ell: 'el',
  eng: 'en',
  spa: 'es',
  ekk: 'et',
  pes: 'fa',
  fin: 'fi',
  fra: 'fr',
  glg: 'gl',
  guj: 'gu',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kan: 'kn',
  kor: 'ko',
  lit: 'lt',
  lvs: 'lv',
  mal: 'ml',
  mar: 'mr',
  zlm: 'ms',
  nob: 'nb',
  nld: 'nl',
  nno: 'nn',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  rus: 'ru',
  slk: 'sk',
  slv: 'sl',
  als: 'sq',
  srp: 'sr',
  swe: 'sv',
  tam: 'ta',
  tel: 'te',
  tha: 'th',
  tgl: 'tl',
  tur: 'tr',
  uig: 'ug',
  ukr: 'uk',
  urd: 'ur',
  vie: 'vi',
  cmn: 'zh',
};

/** A sample with this many letters is long enough for trigrams, and a text this long is told by itself alone. */
const LONG_LETTERS = 160;
/** A text with fewer letters than this is a few words: the document around it says what language they are in. */
const FEW_LETTERS = 40;
/** Languages of the packs that the detector of short texts does not know (it answers with a neighbor of theirs). */
const UNKNOWN_WHEN_SHORT = new Set(['az', 'bs', 'ca', 'eu', 'gl', 'hr', 'ml', 'mr', 'ms', 'nn', 'sl', 'sq', 'ug']);

const LETTER = /\p{L}/gu;
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/g;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/g;

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Japanese, Korean or Chinese, when most of the letters are theirs. (Japanese is Han characters with kana among them.) */
function byScript(text: string): string | undefined {
  const letters = count(text, LETTER);
  if (letters === 0) return undefined;
  const kana = count(text, KANA);
  const han = count(text, HAN);
  const hangul = count(text, HANGUL);
  if (hangul > letters * 0.3) return 'ko';
  if (kana + han > letters * 0.3) return kana > 0 && kana >= (kana + han) * 0.04 ? 'ja' : 'zh';
  return undefined;
}

function bySample(sample: string, allowed: Set<string>): string | undefined {
  const letters = count(sample, LETTER);
  if (letters < 2) return undefined;
  if (letters < LONG_LETTERS) {
    const short = detectShort(sample);
    const code = short === 'no' && !allowed.has('no') ? 'nb' : short;
    if (code && allowed.has(code)) return code;
  }
  const only = Object.keys(FRANC_CODES).filter((iso) => allowed.has(FRANC_CODES[iso]));
  const found = FRANC_CODES[franc(sample, { only, minLength: 2 })];
  return found && allowed.has(found) ? found : undefined;
}

/**
 * The language of `text`, as one of the `allowed` codes, or undefined when it cannot be told.
 * `context`: the document around the text (with the text in it).
 */
export function detectLanguage(text: string, context: string | undefined, allowed: string[]): string | undefined {
  const codes = new Set(allowed);
  const script = byScript(text);
  if (script) return codes.has(script) ? script : undefined;
  const own = count(text, LETTER);
  if (own >= LONG_LETTERS || !context || count(context, LETTER) <= own) return bySample(text, codes);
  // The document around the text (which may be in a script of its own).
  const aroundScript = byScript(context);
  const around = aroundScript ? (codes.has(aroundScript) ? aroundScript : undefined) : bySample(context, codes);
  if (own < FEW_LETTERS) return around ?? bySample(text, codes);
  // A sentence: it says what it is (a document can quote another language), unless the document
  // is in a language a sentence cannot be told to be in.
  const self = bySample(text, codes);
  if (!self) return around;
  return around && around !== self && UNKNOWN_WHEN_SHORT.has(around) ? around : self;
}
