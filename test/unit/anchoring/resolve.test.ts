// The resolver on plain texts: every kind of edit around one anchor, with the previous text known
// (diff mapping) and unknown (search). Layout, drawings and the marker are in the scenario tests.
import { describe, expect, it } from 'vitest';
import { clusterEnd, clusterStart, createAnchor, fingerprintSimilarity, WIDE_CONTEXT } from '../../../src/anchoring/anchor';
import { categoryOf, compareWithQuote, DISTINCTIVE_LENGTH, EDITED_MIN_SURVIVOR, PARTIAL_MIN_CHARS, PARTIAL_MIN_SURVIVOR, resolveAnchor } from '../../../src/anchoring/resolve';
import { hashText, TEXT_MODEL_VERSION } from '../../../src/anchoring/textModel';
import { step, textOf, track } from './track';

const INTRO = 'This report describes two experiments on the reading habits of students in their first year. ';
const BODY =
  'In the first experiment the quick brown fox jumps over the lazy dog while the students take notes. ' +
  'In the second experiment the same students read a longer text about rivers and write a summary of it. ';
const END = 'Both experiments show that notes taken by hand are remembered longer than typed notes.';
const BASE = INTRO + BODY + END;

/** Runs the same edit with the old text known and unknown and returns both results. */
function both(exact: string, edit: (text: string) => string, occurrence = 0) {
  const edited = edit(BASE);
  const withDiff = track(BASE, exact, occurrence);
  const a = step(withDiff, edited);
  const blind = track(BASE, exact, occurrence);
  const b = step(blind, edited, { noSnapshot: true });
  return { edited, diff: a, search: b, diffText: textOf(edited, a), searchText: textOf(edited, b) };
}

describe('edits elsewhere', () => {
  it('A1: follows its text when something is inserted or deleted before it', () => {
    for (const edit of [(t: string) => `A new first sentence. ${t}`, (t: string) => t.replace(INTRO, ''), (t: string) => t.replace('In the first', 'During the very first')]) {
      const r = both('lazy dog', edit);
      expect(r.diff).toMatchObject({ status: 'anchored', kind: 'shifted', via: 'diff' });
      expect(r.search).toMatchObject({ status: 'anchored', kind: 'shifted' });
      expect([r.diffText, r.searchText]).toEqual(['lazy dog', 'lazy dog']);
    }
  });

  it('A2: stays exact when something changes after it', () => {
    const r = both('lazy dog', (t) => `${t} One more closing sentence.`);
    expect(r.diff).toMatchObject({ kind: 'exact', via: 'diff' });
    expect(r.search).toMatchObject({ kind: 'exact' });
  });

  it('reuses its offsets when the text is the same', () => {
    const t = track(BASE, 'lazy dog');
    expect(step(t, BASE)).toMatchObject({ kind: 'exact', via: 'same', confidence: 1 });
  });

  it('A16: is exact again when only the rest of the text is rewrapped (same normalized text)', () => {
    const t = track(BASE, 'longer text about rivers');
    expect(step(t, BASE)).toMatchObject({ kind: 'exact' });
  });
});

describe('edits inside', () => {
  it('A3: grows over words inserted inside it', () => {
    const r = both('quick brown fox', (t) => t.replace('quick brown', 'quick dark brown'));
    expect(r.diff).toMatchObject({ status: 'anchored', kind: 'edited', text: 'quick dark brown fox' });
    expect(r.search).toMatchObject({ status: 'anchored', kind: 'edited', text: 'quick dark brown fox' });
  });

  it('A4: shrinks over words deleted inside it', () => {
    const r = both('quick brown fox jumps', (t) => t.replace('brown fox ', ''));
    expect(r.diff).toMatchObject({ kind: 'edited', text: 'quick jumps' });
    expect(r.search).toMatchObject({ kind: 'edited', text: 'quick jumps' });
  });

  it('A5: keeps a typo fix inside it', () => {
    const r = both('students take notes', (t) => t.replace('students take notes', 'students took notes'));
    expect(r.diff).toMatchObject({ kind: 'edited', text: 'students took notes' });
    expect(r.search).toMatchObject({ kind: 'edited', text: 'students took notes' });
  });

  it('A19: a change of case only is an edit', () => {
    const r = both('quick brown fox', (t) => t.replace('quick brown fox', 'Quick Brown Fox'));
    expect(r.diff).toMatchObject({ kind: 'edited', text: 'Quick Brown Fox' });
    expect(r.search).toMatchObject({ kind: 'edited', text: 'Quick Brown Fox' });
  });

  it('A6: a rewritten middle keeps it while enough is left, and orphans it as replaced below that', () => {
    const exact = 'the quick brown fox jumps over the lazy dog while';
    const light = both(exact, (t) => t.replace('brown fox jumps', 'red hen walks'));
    expect(light.diff).toMatchObject({ kind: 'edited' });
    expect(light.diffText).toBe('the quick red hen walks over the lazy dog while');
    const heavy = both(exact, (t) => t.replace('quick brown fox jumps over the lazy dog', 'slow green turtle crawls under a busy road'));
    expect(heavy.diff).toMatchObject({ status: 'orphaned', reason: 'replaced' });
    expect(heavy.edited.slice(heavy.diff.candidate!.start, heavy.diff.candidate!.end)).toBe('the slow green turtle crawls under a busy road while');
    expect(heavy.search).toMatchObject({ status: 'orphaned', reason: 'replaced' });
  });

  it('A11: spans both parts when a break is inserted inside it', () => {
    const r = both('fox jumps over', (t) => t.replace('fox jumps over', 'fox jumps. Results: over'));
    expect(r.diff).toMatchObject({ kind: 'edited', text: 'fox jumps. Results: over' });
  });

  it('cuts back to the larger side when a lot of text is typed in the middle', () => {
    const long = ' and then a very long passage of new words is typed right in the middle of it, far more than the passage itself ever had,'.repeat(3);
    const r = both('quick brown fox jumps over the lazy dog', (t) => t.replace('fox jumps', `fox${long} jumps`));
    expect(r.diff).toMatchObject({ kind: 'partial', text: 'jumps over the lazy dog' });
  });
});

describe('partial and full deletion', () => {
  it('A7: shrinks to the rest when the head or the tail is deleted', () => {
    const head = both('quick brown fox jumps over', (t) => t.replace('quick brown ', ''));
    expect(head.diff).toMatchObject({ kind: 'partial', text: 'fox jumps over' });
    expect(head.search).toMatchObject({ kind: 'partial', text: 'fox jumps over' });
    const tail = both('quick brown fox jumps over', (t) => t.replace(' fox jumps over', ''));
    expect(tail.diff).toMatchObject({ kind: 'partial', text: 'quick brown' });
    expect(tail.search).toMatchObject({ kind: 'partial', text: 'quick brown' });
  });

  it('A7: counts as deleted when only a scrap is left', () => {
    const r = both('the quick brown fox jumps over the lazy dog while', (t) => t.replace('the quick brown fox jumps over the lazy dog ', ''));
    expect(r.diff).toMatchObject({ status: 'orphaned', reason: 'deleted' });
    expect(r.search).toMatchObject({ status: 'orphaned', reason: 'deleted' });
  });

  it('A8: deleting exactly its text orphans it as deleted, with a tombstone between prefix and suffix', () => {
    const r = both('quick brown fox', (t) => t.replace('quick brown fox ', ''));
    for (const res of [r.diff, r.search]) {
      expect(res).toMatchObject({ status: 'orphaned', reason: 'deleted' });
      expect(r.edited.slice(res.tombstone! - 4, res.tombstone! + 5)).toBe('the jumps');
    }
    expect(r.diff.candidate).toBeUndefined();
  });

  it('A9: deleting its paragraph, or everything from it to the end, orphans it as deleted', () => {
    const paragraph = both('quick brown fox', (t) => t.replace(BODY, ''));
    expect(paragraph.diff).toMatchObject({ status: 'orphaned', reason: 'deleted' });
    expect(paragraph.diff.tombstone).toBe(INTRO.length);
    const rest = both('quick brown fox', (t) => t.slice(0, t.indexOf('quick')).trimEnd());
    expect(rest.diff).toMatchObject({ status: 'orphaned', reason: 'deleted' });
  });

  it('A10: replacing it with other text orphans it as replaced, with that text as the candidate', () => {
    const r = both('quick brown fox', (t) => t.replace('quick brown fox', 'tired old horse'));
    for (const res of [r.diff, r.search]) {
      expect(res).toMatchObject({ status: 'orphaned', reason: 'replaced' });
      expect(r.edited.slice(res.candidate!.start, res.candidate!.end)).toBe('tired old horse');
    }
  });

  it('never rewrites the last place it was found while it is orphaned, and comes back exact', () => {
    const t = track(BASE, 'quick brown fox');
    const found = structuredClone(t.state!.found);
    const without = BASE.replace(BODY, '');
    expect(step(t, without)).toMatchObject({ status: 'orphaned', reason: 'deleted' });
    expect(t.state!.found).toEqual(found);
    expect(step(t, '')).toMatchObject({ status: 'orphaned', reason: 'not-found' });
    expect(step(t, 'Something else entirely, written by another person about another subject.')).toMatchObject({ status: 'orphaned', reason: 'not-found' });
    expect(t.state!.found).toEqual(found);
    expect(step(t, BASE)).toMatchObject({ status: 'anchored', kind: 'exact', start: found!.start });
  });

  it('comes back at its full extent after being shrunk or edited (A -> B -> A)', () => {
    for (const edit of [(t: string) => t.replace('quick brown ', ''), (t: string) => t.replace('brown', 'red'), (t: string) => t.replace('quick brown fox ', '')]) {
      for (const noSnapshot of [false, true]) {
        const t = track(BASE, 'quick brown fox');
        step(t, edit(BASE), { noSnapshot });
        const back = step(t, BASE, { noSnapshot });
        expect(back).toMatchObject({ status: 'anchored', kind: 'exact' });
        expect(textOf(BASE, back)).toBe('quick brown fox');
        expect(back.text).toBeUndefined();
      }
    }
  });
});

describe('moves and duplicates', () => {
  const moved = (t: string) => {
    const sentence = t.slice(t.indexOf('In the first'), t.indexOf('In the second'));
    return `${t.replace(sentence, '')} ${sentence.trim()}`;
  };

  it('A13: follows a sentence that was cut and pasted elsewhere', () => {
    const r = both('quick brown fox', moved);
    expect(r.diff).toMatchObject({ status: 'anchored', kind: 'moved', via: 'diff' });
    expect(r.diffText).toBe('quick brown fox');
    expect(r.search.status).toBe('anchored');
    expect(r.searchText).toBe('quick brown fox');
  });

  it('A13: also with a save between the cut and the paste', () => {
    const t = track(BASE, 'quick brown fox');
    const sentence = BASE.slice(BASE.indexOf('In the first'), BASE.indexOf('In the second'));
    expect(step(t, BASE.replace(sentence, ''))).toMatchObject({ status: 'orphaned', reason: 'deleted' });
    const pasted = `${BASE.replace(sentence, '')} ${sentence.trim()}`;
    const back = step(t, pasted);
    expect(back).toMatchObject({ status: 'anchored', kind: 'moved' });
    expect(textOf(pasted, back)).toBe('quick brown fox');
  });

  it('A14: stays on the original when a copy is pasted below or above it', () => {
    const sentence = BASE.slice(BASE.indexOf('In the first'), BASE.indexOf('In the second'));
    const below = BASE.replace(sentence, sentence + sentence);
    const t1 = track(BASE, 'quick brown fox');
    expect(step(t1, below)).toMatchObject({ status: 'anchored', start: below.indexOf('quick brown fox') });
    const above = BASE.replace(sentence, sentence.replace('quick', 'rather quick') + sentence);
    const t2 = track(BASE, 'quick brown fox');
    expect(step(t2, above)).toMatchObject({ status: 'anchored', start: above.lastIndexOf('quick brown fox') });
  });

  it("A14b: with the editor's hint, stays on the original when an unedited copy is pasted above and then edited", () => {
    const sentence = BASE.slice(BASE.indexOf('In the first'), BASE.indexOf('In the second'));
    const doubled = BASE.replace(sentence, sentence + sentence);
    const t = track(BASE, 'quick brown fox');
    const r = step(t, doubled, { hints: [{ text: sentence, side: 'before' }] });
    expect(r).toMatchObject({ status: 'anchored', start: doubled.lastIndexOf('quick brown fox') });
    const edited = doubled.replace('quick brown fox', 'slow brown fox');
    expect(step(t, edited)).toMatchObject({ status: 'anchored', kind: 'shifted', start: edited.indexOf('quick brown fox') });
  });

  it('A15: stays when only the text around it changes and identical passages exist elsewhere', () => {
    const text = 'One: the file was not found. Two: the file was saved to disk. Three: the file was closed again.';
    const t = track(text, 'the file was', 1);
    const edited = text.replace('Two:', 'Second,').replace('saved to disk', 'written to the disk');
    const r = step(t, edited);
    expect(r).toMatchObject({ status: 'anchored', start: edited.indexOf('the file was', edited.indexOf('Second')) });
    const blind = track(text, 'the file was', 1);
    expect(step(blind, edited, { noSnapshot: true })).toMatchObject({ start: r.start });
  });

  it('A27: stays when an identical passage with identical context appears elsewhere', () => {
    const copy = BODY;
    const edited = `${INTRO}${BODY}${END} ${copy}`;
    const t = track(BASE, 'quick brown fox');
    expect(step(t, edited)).toMatchObject({ status: 'anchored', kind: 'exact', start: BASE.indexOf('quick brown fox') });
    const before = `${copy}${BASE}`;
    const t2 = track(BASE, 'quick brown fox');
    expect(step(t2, before)).toMatchObject({ status: 'anchored', kind: 'shifted', start: copy.length + BASE.indexOf('quick brown fox') });
  });

  it('of two identical neighboring passages, the one that is left keeps the annotation whichever the diff calls deleted', () => {
    const p1 = 'In the first experiment the quick brown fox jumps over the lazy dog while the students take notes by hand.';
    const doubled = BASE.replace(BODY, `${p1} Edited copy: ${p1} ${BODY}`);
    const single = `A new opening sentence. ${BASE.replace(BODY, `${p1} ${BODY}`)}`;
    for (const occurrence of [0, 1]) {
      const t = track(doubled, 'quick brown fox', occurrence);
      const r = step(t, single);
      expect(r).toMatchObject({ status: 'anchored', kind: 'shifted' });
      expect(textOf(single, r)).toBe('quick brown fox');
      expect(r.start).toBe(single.indexOf('quick brown fox'));
    }
  });

  it('does not jump to an occurrence that was already there when its own text is deleted', () => {
    const text = 'First the red door opens. Then, much later in the story, the red door opens once more and nobody notices it at all.';
    const t = track(text, 'the red door opens', 1);
    const edited = text.replace(', the red door opens once more', ', nothing happens once more');
    expect(step(t, edited)).toMatchObject({ status: 'orphaned' });
    const blind = track(text, 'the red door opens', 1);
    expect(step(blind, edited, { noSnapshot: true })).toMatchObject({ status: 'orphaned' });
  });

  it('without the old text, takes a long quote found once elsewhere as moved, a short one not', () => {
    const long = 'the quick brown fox jumps over the lazy dog';
    expect(long.replace(/ /g, '').length).toBeGreaterThanOrEqual(DISTINCTIVE_LENGTH);
    const cut = BASE.replace(`${long} `, '');
    const pasted = `${long}. ${cut}`;
    const t = track(BASE, long);
    expect(step(t, pasted, { noSnapshot: true })).toMatchObject({ status: 'anchored', kind: 'moved', start: 0 });
    const short = track(BASE, 'lazy dog');
    const shortCut = BASE.replace('lazy dog ', '');
    expect(step(short, `lazy dog. ${shortCut}`, { noSnapshot: true })).toMatchObject({ status: 'orphaned', reason: 'deleted' });
  });
});

describe('thresholds', () => {
  it('EDITED_MIN_SURVIVOR: on both sides', () => {
    const exact = 'aa bbbb cccc dddd zz';
    // 16 characters that are not spaces; "aa" and "zz" stay.
    const keep = (middle: string) => compareWithQuote(exact, `aa ${middle} zz`);
    expect(4 / 16).toBeLessThan(EDITED_MIN_SURVIVOR);
    expect(keep('xxxx yyyy wwww')).toBe('replaced');
    expect(8 / 16).toBeGreaterThanOrEqual(EDITED_MIN_SURVIVOR);
    expect(keep('bbbb yyyy wwww')).toBe('edited');
  });

  it('PARTIAL_MIN: three characters and 15 % of the quote, on both sides', () => {
    expect(compareWithQuote('alpha beta gamma delta', 'delta')).toBe('partial');
    expect(compareWithQuote('alpha beta gamma delta', 'de')).toBe('gone');
    expect(PARTIAL_MIN_CHARS).toBe(3);
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
    const ink = long.replace(/ /g, '').length;
    expect(3 / ink).toBeLessThan(PARTIAL_MIN_SURVIVOR);
    expect(compareWithQuote(long, 'one')).toBe('gone');
    expect(compareWithQuote(long, 'one two three four')).toBe('partial');
  });

  it('describes what a place holds compared with the quote', () => {
    expect(compareWithQuote('quick brown fox', 'quick brown fox')).toBe('exact');
    expect(compareWithQuote('quick brown fox', 'quick red fox')).toBe('edited');
    expect(compareWithQuote('quick brown fox', 'slick brown fox')).toBe('edited');
    expect(compareWithQuote('quick brown fox', 'brown fox')).toBe('partial');
    expect(compareWithQuote('quick brown fox', 'quick brown')).toBe('partial');
    expect(compareWithQuote('quick brown fox', 'entirely other words')).toBe('gone');
  });

  it('names the category a change is reported by', () => {
    expect(categoryOf({ status: 'anchored', kind: 'exact' })).toBe('ok');
    expect(categoryOf({ status: 'anchored', kind: 'shifted' })).toBe('ok');
    expect(categoryOf({ status: 'anchored', kind: 'edited' })).toBe('edited');
    expect(categoryOf({ status: 'orphaned', reason: 'deleted' })).toBe('orphaned:deleted');
    expect(categoryOf(undefined)).toBe('ok');
  });
});

describe('search without the old text', () => {
  it('finds the place from the prefix or the suffix alone', () => {
    const t = track(BASE, 'quick brown fox');
    const edited = BASE.replace('quick brown fox jumps over the lazy dog while the students take notes', 'quick red fox sits still');
    const r = step(t, edited, { noSnapshot: true });
    expect(r).toMatchObject({ status: 'anchored', kind: 'edited', via: 'context' });
    expect(textOf(edited, r)).toBe('quick red fox');
  });

  it('uses the fingerprint to tell identical passages with identical near context apart', () => {
    const block = 'The measured value was within the expected range for this sample and the test passed without remarks. ';
    const filler = (n: number) => Array.from({ length: 30 }, (_, i) => `Section ${n} item ${i} has its own words like w${n}x${i}.`).join(' ') + ' ';
    const text = filler(1) + block + filler(2) + block + filler(3);
    const second = text.lastIndexOf('within the expected range');
    const anchor = createAnchor(text, hashText(text), second, second + 'within the expected range'.length);
    // New text before both, so offsets are no help; no snapshot.
    const edited = `${filler(9)}${text}`;
    const r = resolveAnchor(anchor, undefined, { current: { text: edited, hash: hashText(edited) }, oldText: () => undefined });
    expect(r).toMatchObject({ status: 'anchored' });
    expect(r.start).toBe(edited.lastIndexOf('within the expected range'));
    const first = edited.indexOf('within the expected range');
    expect(fingerprintSimilarity(anchor, edited, r.start!, r.end!)!).toBeGreaterThan(fingerprintSimilarity(anchor, edited, first, first + 25)!);
  });

  it('falls back to an approximate match near where it was, then anywhere', () => {
    const text = `${'Filler sentence number one is here. '.repeat(40)}The committee approved the annual budget on Tuesday evening. ${'More filler follows after it. '.repeat(40)}`;
    const t = track(text, 'approved the annual budget on Tuesday');
    // Context rewritten and a word changed: only the fuzzy search can find it.
    const edited = text
      .replace('The committee approved the annual budget on Tuesday evening.', 'Our board approved the yearly budget on Tuesday night!')
      .replace(/Filler sentence number one is here\. /g, 'Other words. ')
      .replace(/More filler follows after it\. /g, 'Else. ');
    const r = step(t, edited, { noSnapshot: true });
    expect(r).toMatchObject({ status: 'anchored', kind: 'edited', via: 'fuzzy' });
    expect(textOf(edited, r)).toContain('approved the yearly budget on Tuesday');
    const fast = resolveAnchor(t.anchor, undefined, { current: { text: edited, hash: 'x' }, oldText: () => undefined }, { fuzzy: false });
    expect(fast).toMatchObject({ status: 'orphaned', reason: 'not-found' });
  });

  it('upgrades anchors of the old format: 32 characters of context, no fingerprint, a position hint only', () => {
    const at = BASE.indexOf('quick brown fox');
    const legacy = { exact: 'quick brown fox', prefix: BASE.slice(at - 32, at), suffix: BASE.slice(at + 15, at + 47) };
    const state = { status: 'anchored' as const, found: { hash: 'old', v: TEXT_MODEL_VERSION, length: -1, start: at, end: at + 15 } };
    const edited = `Preface. ${BASE}`;
    const r = resolveAnchor(legacy, state, { current: { text: edited, hash: hashText(edited) }, oldText: () => undefined });
    expect(r).toMatchObject({ status: 'anchored', kind: 'shifted', start: at + 9 });
  });

  it('ignores positions from another text model version', () => {
    const t = track(BASE, 'quick brown fox');
    t.state!.found!.v = TEXT_MODEL_VERSION + 1;
    const edited = `Preface. ${BASE}`;
    const r = step(t, edited);
    expect(r).toMatchObject({ status: 'anchored', via: 'search' });
    expect(textOf(edited, r)).toBe('quick brown fox');
  });
});

describe('text traps (A20, A22)', () => {
  it('never splits a surrogate pair, a combining mark or a joined emoji at the edges of quote and context', () => {
    const family = '👨\u200d👩\u200d👧';
    const text = `${'x'.repeat(WIDE_CONTEXT - 1)}😀 cafe\u0301 ${family} middle words ${family} e\u0301nd 😀${'y'.repeat(WIDE_CONTEXT - 1)}`;
    const start = text.indexOf('middle');
    const anchor = createAnchor(text, 'h', start, start + 12);
    const wellFormed = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
          i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return false;
        }
      }
      return true;
    };
    for (const piece of [anchor.prefix, anchor.suffix, anchor.exact]) {
      expect(wellFormed(piece)).toBe(true);
      expect(/^[\p{M}\u200d]/u.test(piece)).toBe(false);
    }
    const inside = text.indexOf(family) + 3;
    expect(clusterStart(text, inside)).toBe(text.indexOf(family));
    expect(clusterEnd(text, inside)).toBe(text.indexOf(family) + family.length);
    const accent = text.indexOf('e\u0301') + 1;
    expect(clusterStart(text, accent)).toBe(accent - 1);
  });

  it('follows text with ligatures, NBSP, soft hyphens, RTL and CJK through edits', () => {
    const text = 'Die ﬁnale Auswertung: 東京は日本の首都です。 שלום עולם is a greeting. A\u00a0b so\u00adft.';
    for (const exact of ['ﬁnale Auswertung', '日本の首都', 'שלום עולם', 'A\u00a0b so\u00adft']) {
      const t = track(text, exact);
      const edited = `Neu: ${text.replace('is a greeting', 'is one greeting')}`;
      const r = step(t, edited);
      expect(textOf(edited, r)).toBe(exact);
    }
    const cjk = track(text, '日本の首都');
    const edited = text.replace('日本の首都', '日本の旧首都');
    expect(step(cjk, edited)).toMatchObject({ kind: 'edited', text: '日本の旧首都' });
  });

  it('treats NFC and NFD as different text that is still found as an edit', () => {
    const nfc = 'Le café crème est servi très chaud à la terrasse.';
    const nfd = nfc.normalize('NFD');
    const t = track(nfc, 'café crème est servi');
    const r = step(t, nfd);
    expect(r.status).toBe('anchored');
    expect(textOf(nfd, r)!.normalize('NFC')).toBe('café crème est servi');
  });

  it('A22: very short and very long quotes', () => {
    const one = track(BASE, 'fox');
    const edited = `Intro. ${BASE.replace('lazy', 'sleepy')}`;
    expect(textOf(edited, step(one, edited))).toBe('fox');
    const gone = BASE.replace('fox ', '');
    expect(step(one, gone)).toMatchObject({ status: 'orphaned' });
    const long = Array.from({ length: 3000 }, (_, i) => `word${i % 97}`).join(' ');
    const doc = `Start. ${long} End.`;
    const big = track(doc, long);
    expect(big.anchor.exact.length).toBeGreaterThan(10_000);
    const shifted = `Preface here. ${doc}`;
    expect(step(big, shifted)).toMatchObject({ kind: 'shifted', start: 21 });
    const blind = track(doc, long);
    expect(step(blind, shifted, { noSnapshot: true })).toMatchObject({ status: 'anchored', start: 21 });
  });

  it('a quote of whole words is not found inside another word', () => {
    const text = 'The fox ran. Later the foxes-and-hounds came, and a firefox too.';
    const t = track(text, 'fox');
    const without = text.replace('The fox ran. ', '');
    expect(step(t, without, { noSnapshot: true })).toMatchObject({ status: 'orphaned' });
    // A quote that started inside a word may be found inside a word.
    const inside = track(text, 'oxes-and');
    const edited = `Now: ${text}`;
    expect(textOf(edited, step(inside, edited, { noSnapshot: true }))).toBe('oxes-and');
  });

  it('A21: repeated boilerplate keeps each anchor on its own occurrence', () => {
    const header = 'Name Value Unit ';
    const rows = (n: number) => Array.from({ length: 12 }, (_, i) => `row${n}-${i} ${i * n} kg `).join('');
    const text = `${header}${rows(1)}${header}${rows(2)}${header}${rows(3)}`;
    const t = track(text, 'Name Value Unit', 1);
    // The table grows: the header repeats once more, before and after.
    const edited = `${header}${rows(0)}${text}${header}${rows(4)}`;
    const r = step(t, edited);
    expect(r).toMatchObject({ status: 'anchored', start: (header + rows(0)).length + text.indexOf(header, 1) });
  });

  it('A26: overlapping, nested and identical anchors resolve independently', () => {
    const edited = `Zero. ${BASE.replace('brown', 'dark brown')}`;
    const outer = track(BASE, 'the quick brown fox jumps');
    const inner = track(BASE, 'brown fox');
    const twin = track(BASE, 'brown fox');
    expect(textOf(edited, step(outer, edited))).toBe('the quick dark brown fox jumps');
    expect(textOf(edited, step(inner, edited))).toBe('brown fox');
    expect(step(twin, edited)).toEqual(inner.last);
  });
});
