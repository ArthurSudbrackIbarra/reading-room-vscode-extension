// The translate tool without the translator: languages and routes, the text as it is given to
// the translator, the list of language packs, and telling which language a text is in.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_NAMES,
  chunkText,
  defaultTarget,
  joinTranslated,
  languagesOf,
  packFromEnglish,
  packIntoEnglish,
  packLabel,
  readingText,
  routeFor,
} from '../../src/shared/translate';
import { detectLanguage } from '../../src/translate/detect';
import { downloadBytes, megabytes, packsOfRegistry, parsePackList, selectEntry } from '../../src/translate/registry';

const shipped = parsePackList(readFileSync(join(__dirname, '..', '..', 'src', 'translate', 'models.json'), 'utf8'));
const pairs = Object.keys(shipped.packs);
const has = (pair: string): boolean => pair in shipped.packs;

describe('the shipped list of language packs', () => {
  it('has a pack to or from English for every language, each with a name', () => {
    expect(pairs.length).toBeGreaterThan(100);
    for (const pair of pairs) {
      const [from, to] = pair.split('-');
      expect(from === 'en' || to === 'en', pair).toBe(true);
      const other = from === 'en' ? to : from;
      // (The pack of the macrolanguage serves three languages that have names of their own.)
      if (other !== 'hbs') expect(LANGUAGE_NAMES[other], other).toBeTruthy();
    }
  });

  it('has what a download is checked against, and where to get it', () => {
    for (const pack of Object.values(shipped.packs)) {
      expect(pack.model.sha256, pack.pair).toMatch(/^[0-9a-f]{64}$/);
      expect(pack.model.size, pack.pair).toBeGreaterThan(1_000_000);
      expect(pack.vocabs.length === 1 || pack.vocabs.length === 2, pack.pair).toBe(true);
      for (const file of [pack.model, pack.shortlist, ...pack.vocabs]) {
        if (file) expect(file.path, pack.pair).toMatch(/^models\/[A-Za-z0-9._\-/]+\.gz$/);
      }
      expect(downloadBytes(pack), pack.pair).toBeGreaterThan(5_000_000);
      expect(downloadBytes(pack), pack.pair).toBeLessThan(80_000_000);
    }
    expect(megabytes(26_021_945)).toBe('26 MB');
  });

  it('lists the languages by name, with what each can do', () => {
    const languages = languagesOf(pairs);
    const of = (code: string) => languages.find((l) => l.code === code);
    expect(of('en')).toMatchObject({ from: true, to: true });
    expect(of('ja')).toMatchObject({ name: 'Japanese', from: true, to: true });
    expect(of('pt')).toMatchObject({ from: true, to: true });
    // Croatian has no released pack of its own into English: the pack of the macrolanguage serves it.
    expect(of('hr')).toMatchObject({ from: true, to: true });
    // Nynorsk can be read, not written.
    expect(of('nn')).toMatchObject({ from: true, to: false });
    // Norwegian is listed once.
    expect(of('nb')).toBeDefined();
    expect(of('no')).toBeUndefined();
    expect(of('hbs')).toBeUndefined();
    expect(languages.map((l) => l.name)).toEqual([...languages.map((l) => l.name)].sort((a, b) => a.localeCompare(b, 'en')));
  });
});

describe('the way from one language to another', () => {
  it('is one pack with English at an end, two otherwise', () => {
    expect(routeFor('ja', 'en', has)).toEqual({ packs: ['ja-en'] });
    expect(routeFor('en', 'pt', has)).toEqual({ packs: ['en-pt'] });
    expect(routeFor('pt', 'ja', has)).toEqual({ packs: ['pt-en', 'en-ja'] });
    expect(routeFor('hr', 'en', has)).toEqual({ packs: ['hbs-en'] });
    expect(routeFor('sr', 'de', has)).toEqual({ packs: ['hbs-en', 'en-de'] });
  });

  it('says why there is none', () => {
    expect(routeFor('pt', 'pt', has)).toEqual({ problem: 'same' });
    expect(routeFor('xx', 'en', has)).toEqual({ problem: 'no-source' });
    expect(routeFor('en', 'nn', has)).toEqual({ problem: 'no-target' });
    expect(packIntoEnglish('xx', has)).toBeUndefined();
    expect(packFromEnglish('ja', has)).toBe('en-ja');
  });

  it('names a pack and picks the first language to translate into', () => {
    expect(packLabel('ja-en')).toBe('Japanese → English');
    expect(packLabel('hbs-en')).toBe('Bosnian, Croatian and Serbian → English');
    const languages = languagesOf(pairs);
    expect(defaultTarget('pt-br', languages)).toBe('pt');
    expect(defaultTarget('en', languages)).toBe('en');
    expect(defaultTarget('zh-tw', languages)).toBe('zh_hant');
    expect(defaultTarget('zh-cn', languages)).toBe('zh');
    expect(defaultTarget('no', languages)).toBe('nb');
    expect(defaultTarget('xx', languages)).toBe('en');
  });
});

describe('the text given to the translator', () => {
  /** A text with "|" where a line ends: the text model has one space there. */
  const lines = (marked: string): string => {
    const text = marked.replace(/\|/g, ' ');
    const ends = new Set<number>();
    for (let i = 0; i < marked.length; i++) if (marked[i] === '|') ends.add(i);
    return readingText(text, (i) => ends.has(i));
  };

  it('joins a word that was cut at the end of a line', () => {
    expect(lines('names and long sen-|tences, and they know')).toBe('names and long sentences, and they know');
    expect(lines('the docu-|ment')).toBe('the document');
  });

  it('keeps hyphens that are not at the end of a line, and those before a capital or a digit', () => {
    expect(lines('pre- and post-processing of a well-known|method')).toBe('pre- and post-processing of a well-known method');
    expect(lines('the Navier-|Stokes equations')).toBe('the Navier- Stokes equations');
    expect(lines('pages 10-|12')).toBe('pages 10- 12');
  });

  it('joins lines of a script written without spaces, and keeps the space between words', () => {
    expect(lines('機械翻訳には長い|歴史がある。')).toBe('機械翻訳には長い歴史がある。');
    expect(lines('機械翻訳 MT|は長い')).toBe('機械翻訳 MT は長い');
    expect(lines('one line|next line')).toBe('one line next line');
  });

  it('takes out soft hyphens and the space around the text', () => {
    expect(readingText(' trans\u00adla\u00adtion ')).toBe('translation');
  });

  it('cuts a long text at the ends of sentences', () => {
    const sentence = 'This is a sentence of about fifty characters, more or less. ';
    const text = sentence.repeat(40).trim();
    const chunks = chunkText(text, 300);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect(chunk.endsWith('.')).toBe(true);
    }
    expect(chunks.join(' ')).toBe(text);
    expect(chunkText('Short one.')).toEqual(['Short one.']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('cuts a sentence that is too long at a space, and text without spaces anywhere', () => {
    const long = `${'word '.repeat(200).trim()}.`;
    const chunks = chunkText(long, 120);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(chunks.join(' ')).toBe(long);
    const japanese = '吾輩は猫である'.repeat(60);
    const cut = chunkText(japanese, 100);
    for (const chunk of cut) expect(chunk.length).toBeLessThanOrEqual(100);
    expect(cut.join('')).toBe(japanese);
    const sentences = '吾輩は猫である。名前はまだ無い。'.repeat(20);
    expect(chunkText(sentences, 64).every((chunk) => chunk.endsWith('。'))).toBe(true);
  });

  it('joins the translated pieces as the language is written', () => {
    expect(joinTranslated([' One. ', 'Two.'], 'en')).toBe('One. Two.');
    expect(joinTranslated(['一。', '二。'], 'ja')).toBe('一。二。');
  });
});

describe("Mozilla's registry", () => {
  const file = (name: string) => ({ path: `models/xx-en/run/exported/${name}.gz` });
  const model = { path: 'models/xx-en/run/exported/model.bin.gz', uncompressedSize: 30_000_000, uncompressedHash: 'a'.repeat(64) };
  const entry = (releaseStatus: string | null, architecture: string) => ({
    releaseStatus,
    architecture,
    files: { model, lexicalShortlist: file('lex'), vocab: file('vocab') },
  });

  it('picks a released model, and of two the one that takes less memory', () => {
    expect(selectEntry([entry(null, 'base'), entry('Release', 'tiny')])).toMatchObject({ architecture: 'tiny' });
    expect(selectEntry([entry('Release', 'tiny'), entry('Release', 'base-memory')])).toMatchObject({ architecture: 'base-memory' });
    expect(selectEntry([entry('Release Desktop', 'base'), entry('Release Android', 'base-memory')])).toMatchObject({ architecture: 'base-memory' });
    expect(selectEntry([entry('Nightly', 'tiny'), entry(null, 'base-memory')])).toMatchObject({ releaseStatus: 'Nightly' });
    expect(selectEntry([entry(null, 'tiny')])).toBeUndefined();
    expect(selectEntry('nothing')).toBeUndefined();
  });

  it('keeps only what is as expected', () => {
    const list = packsOfRegistry(
      {
        models: {
          'xx-en': [entry('Release', 'base-memory')],
          'en-yy': [{ ...entry('Release', 'tiny'), files: { model, srcVocab: file('src'), trgVocab: file('trg') } }],
          // A path that leaves the folder of the models, a model without a hash, a pair that is not one.
          'aa-en': [{ ...entry('Release', 'tiny'), files: { model: { ...model, path: 'models/../secret.gz' }, vocab: file('vocab') } }],
          'bb-en': [{ ...entry('Release', 'tiny'), files: { model: { path: model.path }, vocab: file('vocab') } }],
          'cc-en': [{ ...entry('Release', 'tiny'), files: { model, vocab: { path: 'https://example.com/vocab.gz' } } }],
          '../x': [entry('Release', 'tiny')],
        },
      },
      '2026-01-01',
    );
    expect(Object.keys(list.packs)).toEqual(['en-yy', 'xx-en']);
    expect(list.packs['xx-en']).toMatchObject({ architecture: 'base-memory', vocabs: [file('vocab')], shortlist: file('lex') });
    expect(list.packs['en-yy'].vocabs).toEqual([file('src'), file('trg')]);
    expect(packsOfRegistry(undefined, 'x').packs).toEqual({});
    // The list survives being written and read again.
    expect(parsePackList(JSON.stringify(list))).toEqual(list);
    expect(() => parsePackList('{}')).toThrow();
  });
});

describe('telling the language', () => {
  const allowed = languagesOf(pairs)
    .filter((l) => l.from)
    .map((l) => l.code);

  const paragraphs: Record<string, string> = {
    en: 'Machine translation has a long history. The first systems, built in the 1950s, relied on hand-written rules and bilingual dictionaries, and their output was often barely readable. Statistical methods arrived in the late 1980s.',
    pt: 'A tradução automática tem uma longa história. Os primeiros sistemas, construídos na década de 1950, dependiam de regras escritas à mão e de dicionários bilíngues, e o resultado muitas vezes mal podia ser lido. Os métodos estatísticos chegaram no fim dos anos 1980.',
    es: 'La traducción automática tiene una larga historia. Los primeros sistemas, construidos en la década de 1950, dependían de reglas escritas a mano y de diccionarios bilingües, y su resultado a menudo apenas se podía leer. Los métodos estadísticos llegaron a finales de los años ochenta.',
    fr: 'La traduction automatique a une longue histoire. Les premiers systèmes, construits dans les années 1950, reposaient sur des règles écrites à la main et des dictionnaires bilingues, et leur résultat était souvent à peine lisible. Les méthodes statistiques sont arrivées à la fin des années 1980.',
    de: 'Die maschinelle Übersetzung hat eine lange Geschichte. Die ersten Systeme, die in den 1950er Jahren gebaut wurden, stützten sich auf handgeschriebene Regeln und zweisprachige Wörterbücher, und ihre Ausgabe war oft kaum lesbar. Statistische Verfahren kamen Ende der 1980er Jahre auf.',
    it: 'La traduzione automatica ha una lunga storia. I primi sistemi, costruiti negli anni Cinquanta, si basavano su regole scritte a mano e su dizionari bilingui, e il loro risultato era spesso a malapena leggibile. I metodi statistici arrivarono alla fine degli anni Ottanta.',
    ca: 'La traducció automàtica té una llarga història. Els primers sistemes, construïts a la dècada de 1950, depenien de regles escrites a mà i de diccionaris bilingües, i el seu resultat sovint amb prou feines es podia llegir. Els mètodes estadístics van arribar a finals dels anys vuitanta.',
    nl: 'Machinevertaling heeft een lange geschiedenis. De eerste systemen, gebouwd in de jaren vijftig, steunden op met de hand geschreven regels en tweetalige woordenboeken, en hun uitvoer was vaak nauwelijks leesbaar. Statistische methoden kwamen aan het einde van de jaren tachtig.',
    ru: 'Машинный перевод имеет долгую историю. Первые системы, созданные в 1950-х годах, опирались на написанные вручную правила и двуязычные словари, и их результат часто едва можно было прочитать. Статистические методы появились в конце 1980-х годов.',
    uk: 'Машинний переклад має довгу історію. Перші системи, створені у 1950-х роках, спиралися на написані вручну правила та двомовні словники, і їхній результат часто ледве можна було прочитати. Статистичні методи з’явилися наприкінці 1980-х років.',
    pl: 'Tłumaczenie maszynowe ma długą historię. Pierwsze systemy, zbudowane w latach pięćdziesiątych, opierały się na ręcznie pisanych regułach i słownikach dwujęzycznych, a ich wynik często ledwo dawał się czytać. Metody statystyczne pojawiły się pod koniec lat osiemdziesiątych.',
    tr: 'Makine çevirisinin uzun bir geçmişi vardır. 1950’lerde kurulan ilk sistemler elle yazılmış kurallara ve iki dilli sözlüklere dayanıyordu ve çıktıları çoğu zaman güçlükle okunabiliyordu. İstatistiksel yöntemler 1980’lerin sonunda ortaya çıktı.',
    ja: '機械翻訳には長い歴史がある。1950年代に作られた最初のシステムは、人手で書かれた規則と対訳辞書に頼っており、その出力はほとんど読めないことも多かった。',
    zh: '机器翻译有着悠久的历史。最早的系统建于二十世纪五十年代，依靠人工编写的规则和双语词典，其输出往往难以阅读。',
    ko: '기계 번역은 오랜 역사를 가지고 있다. 1950년대에 만들어진 최초의 시스템은 사람이 직접 쓴 규칙과 이중 언어 사전에 의존했다.',
    ar: 'للترجمة الآلية تاريخ طويل. اعتمدت الأنظمة الأولى التي بنيت في الخمسينيات على قواعد مكتوبة باليد وقواميس ثنائية اللغة، وكان ناتجها في كثير من الأحيان بالكاد مقروءا.',
    el: 'Η μηχανική μετάφραση έχει μακρά ιστορία. Τα πρώτα συστήματα, που κατασκευάστηκαν τη δεκαετία του 1950, βασίζονταν σε κανόνες γραμμένους με το χέρι και σε δίγλωσσα λεξικά.',
    hi: 'मशीनी अनुवाद का एक लंबा इतिहास है। 1950 के दशक में बनी पहली प्रणालियाँ हाथ से लिखे नियमों और द्विभाषी शब्दकोशों पर निर्भर थीं, और उनका परिणाम अक्सर मुश्किल से पढ़ा जा सकता था।',
  };

  it('tells a paragraph by itself', () => {
    for (const [code, text] of Object.entries(paragraphs)) expect(detectLanguage(text, undefined, allowed), code).toBe(code);
  });

  it('tells a sentence by itself', () => {
    expect(detectLanguage('Neste trabalho, avaliamos o desempenho de três algoritmos.', undefined, allowed)).toBe('pt');
    expect(detectLanguage('In this work we evaluate three algorithms.', undefined, allowed)).toBe('en');
    expect(detectLanguage('Dans ce travail, nous évaluons les performances de trois algorithmes.', undefined, allowed)).toBe('fr');
    expect(detectLanguage('吾輩は猫である。', undefined, allowed)).toBe('ja');
    // Japanese written with few kana is not Chinese.
    expect(detectLanguage('機械翻訳の歴史は長い', undefined, allowed)).toBe('ja');
    expect(detectLanguage('안녕하세요', undefined, allowed)).toBe('ko');
  });

  it('tells a few words by the document around them', () => {
    // (By themselves these two words could be several languages.)
    expect(detectLanguage('longa história', paragraphs.pt, allowed)).toBe('pt');
    expect(detectLanguage('larga historia', paragraphs.es, allowed)).toBe('es');
    expect(detectLanguage('1950', paragraphs.de, allowed)).toBe('de');
    // A script of its own says more than the document around it.
    expect(detectLanguage('吾輩は猫である', paragraphs.en, allowed)).toBe('ja');
  });

  it('tells a sentence by itself, whatever the document around it is in', () => {
    const sentence = 'Os primeiros sistemas dependiam de regras escritas à mão e de dicionários bilíngues.';
    const mixed = `${paragraphs.en} ${sentence} ${paragraphs.en} ${paragraphs.de}`;
    expect(detectLanguage(sentence, mixed, allowed)).toBe('pt');
    expect(detectLanguage('Die ersten Systeme stützten sich auf handgeschriebene Regeln und Wörterbücher.', mixed, allowed)).toBe('de');
    // Except where the document is in a language that a sentence alone is taken for a neighbor of.
    expect(detectLanguage('Els primers sistemes depenien de regles escrites a mà i de diccionaris.', paragraphs.ca, allowed)).toBe('ca');
  });

  it('answers only with a language that is asked for, or not at all', () => {
    expect(detectLanguage(paragraphs.ja, undefined, ['en', 'pt'])).toBeUndefined();
    expect(detectLanguage('12345 67890', undefined, allowed)).toBeUndefined();
    expect(detectLanguage('', undefined, allowed)).toBeUndefined();
    expect(['pt', 'es']).toContain(detectLanguage(paragraphs.pt, undefined, ['pt', 'es']));
  });
});
