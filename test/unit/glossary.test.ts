// The glossary: what a term is, and where the terms are found in the text of a document.
import { describe, expect, it } from 'vitest';
import {
  MAX_DEFINITION_LENGTH,
  MAX_TERMS,
  MAX_TERM_LENGTH,
  cleanDefinition,
  cleanTerm,
  countMatches,
  findTerms,
  firstMatchIn,
  isAcronym,
  isWholeWord,
  lowerSameLength,
  occursIn,
  sanitizeTerm,
  sanitizeTerms,
  sortTerms,
  termKey,
  termsWrittenIn,
  uniqueKeys,
  type GlossaryTerm,
} from '../../src/shared/glossary';

const AT = '2026-11-19T10:00:00.000Z';
const term = (id: string, text: string, definition = `what ${text} means`, updatedAt = AT): GlossaryTerm => ({ id, term: text, definition, createdAt: AT, updatedAt });
/** The texts found, in order, with the term each belongs to. */
const found = (text: string, terms: GlossaryTerm[]) => findTerms(text, terms).map((m) => `${m.id}:${text.slice(m.start, m.end)}@${m.start}`);

describe('a term and its definition as they are stored', () => {
  it('a term is one line with single spaces', () => {
    expect(cleanTerm('  Multi-Layer \n  Perceptron\t')).toBe('Multi-Layer Perceptron');
    expect(cleanTerm('MLP')).toBe('MLP');
    expect(cleanTerm(' \n ')).toBe('');
    expect(cleanTerm(`a${String.fromCharCode(7)}b`)).toBe('ab');
  });

  it('a term is cut at its limit, without a space at the end', () => {
    const long = `${'x'.repeat(MAX_TERM_LENGTH - 1)} yz`;
    expect(cleanTerm(long)).toBe('x'.repeat(MAX_TERM_LENGTH - 1));
    expect(cleanTerm('y'.repeat(300))).toHaveLength(MAX_TERM_LENGTH);
  });

  it('a definition keeps its lines, with one kind of line break', () => {
    expect(cleanDefinition('  first\r\nsecond\rthird  \n')).toBe('first\nsecond\nthird');
    expect(cleanDefinition(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`)).toBe('a\nb\nc');
    expect(cleanDefinition(`tab\there${String.fromCharCode(0)}`)).toBe('tab\there');
    expect(cleanDefinition('z'.repeat(MAX_DEFINITION_LENGTH + 50))).toHaveLength(MAX_DEFINITION_LENGTH);
  });

  it('tells a term in capitals from any other', () => {
    for (const acronym of ['MLP', 'IT', 'GPT-4', 'US', '3D', 'R&D']) expect(isAcronym(acronym), acronym).toBe(true);
    for (const other of ['ReLU', 'mlp', 'Backpropagation', 'pH', '42', '勾配', 'gradient descent']) expect(isAcronym(other), other).toBe(false);
  });

  it('two terms are the same when they are found in the same places', () => {
    expect(termKey('Gradient   Descent')).toBe(termKey('gradient descent'));
    expect(termKey('ReLU')).toBe(termKey('relu'));
    // A term in capitals is only found in capitals: it is another term than the word.
    expect(termKey('IT')).not.toBe(termKey('it'));
    expect(termKey('MLP')).toBe(termKey(' MLP '));
  });

  it('lower case never changes the length of a text', () => {
    expect(lowerSameLength('MLP and ReLU')).toBe('mlp and relu');
    // The dotted capital I has a lower case of two characters: it stays as it is.
    const dotted = String.fromCharCode(0x130);
    const text = `${dotted}STANBUL ${dotted} Term`;
    expect(text.toLowerCase().length).not.toBe(text.length);
    const lowered = lowerSameLength(text);
    expect(lowered).toHaveLength(text.length);
    expect(lowered).toBe(`${dotted}stanbul ${dotted} term`);
  });

  it('checks a term from disk or from a viewer', () => {
    expect(sanitizeTerm({ id: 'a', term: '  MLP ', definition: ' Multi-Layer\r\nPerceptron ', createdAt: AT, updatedAt: AT, extra: 1 })).toEqual({
      id: 'a',
      term: 'MLP',
      definition: 'Multi-Layer\nPerceptron',
      createdAt: AT,
      updatedAt: AT,
    });
    // Dates that are missing are filled in.
    const bare = sanitizeTerm({ id: 'a', term: 'MLP', definition: 'x' });
    expect(bare?.createdAt).toBe(new Date(0).toISOString());
    expect(bare?.updatedAt).toBe(bare?.createdAt);
    for (const bad of [
      null,
      'MLP',
      [],
      { term: 'MLP', definition: 'x' },
      { id: '', term: 'MLP', definition: 'x' },
      { id: 'a', term: '  ', definition: 'x' },
      { id: 'a', term: 'MLP', definition: ' \n' },
      { id: 'a', term: 7, definition: 'x' },
      { id: 'x'.repeat(200), term: 'MLP', definition: 'x' },
    ]) {
      expect(sanitizeTerm(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('keeps each id once and each term once, the one changed last', () => {
    const list = [term('a', 'MLP', 'old', '2026-11-01T00:00:00.000Z'), term('a', 'Other'), { nope: true }, term('b', 'mlp'), term('c', 'MLP', 'new', '2026-11-02T00:00:00.000Z')];
    const clean = sanitizeTerms(list);
    expect(clean.map((t) => `${t.id}:${t.term}:${t.definition}`)).toEqual(['c:MLP:new', 'b:mlp:what mlp means']);
    expect(sanitizeTerms('MLP')).toEqual([]);
    expect(uniqueKeys([term('a', 'ReLU'), term('b', 'relu')]).map((t) => t.id)).toEqual(['a']);
  });

  it('keeps no more terms than a document can have', () => {
    const many = Array.from({ length: MAX_TERMS + 25 }, (_, i) => term(`id-${i}`, `term${i}`));
    expect(sanitizeTerms(many)).toHaveLength(MAX_TERMS);
  });

  it('lists the terms by the alphabet, whatever their capitals', () => {
    expect(sortTerms([term('1', 'relu'), term('2', 'MLP'), term('3', 'attention'), term('4', 'GPT-4'), term('5', 'GPT-10')]).map((t) => t.term)).toEqual([
      'attention',
      'GPT-4',
      'GPT-10',
      'MLP',
      'relu',
    ]);
  });
});

describe('where the terms are written', () => {
  it('finds every place where a term stands as a word of its own', () => {
    const text = 'The MLP, two MLPs and an AMLP; (MLP) "MLP". MLP';
    expect(found(text, [term('m', 'MLP')])).toEqual(['m:MLP@4', 'm:MLP@32', 'm:MLP@38', 'm:MLP@44']);
  });

  it('a digit or an underscore next to the term continues the word too', () => {
    expect(found('GPT-4 then GPT-40, GPT-4o and GPT-4.', [term('g', 'GPT-4')])).toEqual(['g:GPT-4@0', 'g:GPT-4@30']);
    expect(found('x_MLP MLP_x MLP', [term('m', 'MLP')])).toEqual(['m:MLP@12']);
  });

  it('a hyphen or an apostrophe ends a word', () => {
    expect(found('state-of-the-art art', [term('a', 'art')])).toEqual(['a:art@13', 'a:art@17']);
  });

  it('a letter with a mark on it is one letter', () => {
    const accented = `cafe${String.fromCharCode(0x301)}`;
    expect(found(`${accented} and cafe`, [term('c', 'cafe')])).toEqual(['c:cafe@10']);
    expect(isWholeWord(`${accented} x`, 0, 4)).toBe(false);
  });

  it('a term in capitals is found exactly as written', () => {
    expect(found('it is IT. It was it, IT', [term('i', 'IT')])).toEqual(['i:IT@6', 'i:IT@21']);
    expect(found('us and the US', [term('u', 'US')])).toEqual(['u:US@11']);
  });

  it('any other term is found whatever its capitals', () => {
    const text = 'Backpropagation works. BACKPROPAGATION and backpropagation too.';
    expect(found(text, [term('b', 'backpropagation')])).toEqual(['b:Backpropagation@0', 'b:BACKPROPAGATION@23', 'b:backpropagation@43']);
    expect(found('relu, ReLU and RELU', [term('r', 'ReLU')])).toEqual(['r:relu@0', 'r:ReLU@6', 'r:RELU@15']);
  });

  it('a phrase is found across what was a line break (white space is one space in the text)', () => {
    expect(found('uses gradient descent. Gradient Descent is', [term('g', 'gradient  descent')])).toEqual(['g:gradient descent@5', 'g:Gradient Descent@23']);
  });

  it('scripts written without spaces have no word boundary to respect', () => {
    expect(found('勾配降下法は勾配を使う', [term('k', '勾配')])).toEqual(['k:勾配@0', 'k:勾配@6']);
    // A term in Latin letters right next to such a script is a word of its own.
    expect(found('これはMLPです', [term('m', 'MLP')])).toEqual(['m:MLP@3']);
    expect(found('ภาษาไทย', [term('t', 'ไทย')])).toEqual(['t:ไทย@4']);
  });

  it('places never overlap: the longer term is there, and one that starts inside another is not', () => {
    const terms = [term('n', 'neural'), term('nn', 'neural network'), term('w', 'network')];
    expect(found('a neural network, a network and a neural net', terms)).toEqual(['nn:neural network@2', 'w:network@20', 'n:neural@34']);
    // "work" starts inside "network": it is not marked there.
    expect(found('network work', [term('w', 'network'), term('k', 'work')])).toEqual(['w:network@0', 'k:work@8']);
  });

  it('where a term in capitals and the same word are both defined, each has its places', () => {
    const terms = [term('word', 'it'), term('acronym', 'IT')];
    expect(found('IT it It', terms)).toEqual(['acronym:IT@0', 'word:it@3', 'word:It@6']);
  });

  it('gives places in the text itself, whatever comes before them', () => {
    const dotted = String.fromCharCode(0x130);
    const text = `${dotted}zmir 😀 and the Term here`;
    const [match] = findTerms(text, [term('t', 'term')]);
    expect(text.slice(match.start, match.end)).toBe('Term');
    expect(match.start).toBe(text.indexOf('Term'));
  });

  it('finds nothing in an empty text, or without terms', () => {
    expect(findTerms('', [term('m', 'MLP')])).toEqual([]);
    expect(findTerms('MLP', [])).toEqual([]);
    expect(findTerms('MLP', [{ id: 'x', term: '   ' }])).toEqual([]);
  });

  it('tells whether a term is written in a text at all', () => {
    const text = 'An MLP learns with backpropagation.';
    expect(occursIn(text, 'MLP')).toBe(true);
    expect(occursIn(text, 'mlp')).toBe(true);
    expect(occursIn(text, 'ML')).toBe(false);
    expect(occursIn(text, 'Backpropagation')).toBe(true);
    expect(occursIn('', 'MLP')).toBe(false);
    expect(termsWrittenIn(text, ['MLP', 'CNN', 'backpropagation', 'learn', ''])).toEqual(['MLP', 'backpropagation']);
  });

  it('counts how often each term is written, and finds the places of a page', () => {
    const text = 'MLP one. MLP two. CNN three. MLP four.';
    const matches = findTerms(text, [term('m', 'MLP'), term('c', 'CNN'), term('r', 'RNN')]);
    const counts = countMatches(matches);
    expect([counts.get('m'), counts.get('c'), counts.get('r')]).toEqual([3, 1, undefined]);
    // The places from character 9 on (a page that starts there): the second MLP is the first of them.
    expect(firstMatchIn(matches, 9)).toBe(1);
    expect(firstMatchIn(matches, 10)).toBe(1);
    expect(firstMatchIn(matches, 12)).toBe(2);
    expect(firstMatchIn(matches, 0)).toBe(0);
    expect(firstMatchIn(matches, text.length)).toBe(matches.length);
  });

  it('finds the terms of a long document quickly', () => {
    const paragraph = 'The MLP is a network. Backpropagation trains the MLP with gradient descent, as in GPT-4 and other models. ';
    const text = paragraph.repeat(8000);
    const terms = ['MLP', 'backpropagation', 'gradient descent', 'GPT-4', 'network', ...Array.from({ length: 95 }, (_, i) => `unused${i}`)].map((t, i) => term(`t${i}`, t));
    const started = performance.now();
    const matches = findTerms(text, terms);
    expect(matches).toHaveLength(8000 * 6);
    expect(performance.now() - started).toBeLessThan(4000);
  });
});
