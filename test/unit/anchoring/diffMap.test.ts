import { describe, expect, it } from 'vitest';
import { applyCopyHints, diffTexts, insertedShare, mapPointLeft, mapPointRight, mapRange, tokenStarts, type TextDiff } from '../../../src/anchoring/diff';
import { rangeOf } from './track';

function check(diff: TextDiff, a: string, b: string): void {
  let x = 0;
  let y = 0;
  for (const s of diff.segments) {
    expect([s.a0, s.b0]).toEqual([x, y]);
    if (s.equal) expect(a.slice(s.a0, s.a1).toLowerCase()).toBe(b.slice(s.b0, s.b1).toLowerCase());
    x = s.a1;
    y = s.b1;
  }
  expect([x, y]).toEqual([a.length, b.length]);
}

function mapped(a: string, b: string, exact: string, occurrence = 0) {
  const diff = diffTexts(a, b)!;
  check(diff, a, b);
  const [s, e] = rangeOf(a, exact, occurrence);
  const m = mapRange(diff, a, b, s, e);
  return { ...m, text: b.slice(m.start, m.end), between: b.slice(m.gap[0], m.gap[1]) };
}

const A = 'The quick brown fox jumps over the lazy dog. A second sentence follows it here.';

describe('diffTexts', () => {
  it('covers both texts with alternating segments', () => {
    const b = A.replace('brown', 'red').replace('second', 'third and last');
    check(diffTexts(A, b)!, A, b);
    check(diffTexts('', A)!, '', A);
    check(diffTexts(A, '')!, A, '');
    expect(diffTexts(A, A)!.segments).toEqual([{ a0: 0, a1: A.length, b0: 0, b1: A.length, equal: true }]);
  });

  it('splits text into words, separators and single CJK characters, never inside a surrogate pair', () => {
    const text = 'naïve café, 漢字と 😀x';
    const starts = tokenStarts(text);
    const tokens = starts.slice(0, -1).map((s, i) => text.slice(s, starts[i + 1]));
    expect(tokens).toEqual(['naïve', ' ', 'café', ',', ' ', '漢', '字', 'と', ' ', '😀', 'x']);
  });

  it('gives up when the time budget runs out; a stretch that differs too much is one replaced stretch', () => {
    const a = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const b = Array.from({ length: 400 }, (_, i) => `other${i}`).join(' ');
    let clock = 0;
    expect(diffTexts(a, b, { budgetMs: 5, now: () => (clock += 10) })).toBeUndefined();
    const whole = diffTexts(`Same start. ${a} Same end.`, `Same start. ${b} Same end.`, { maxEdits: 100 })!;
    check(whole, `Same start. ${a} Same end.`, `Same start. ${b} Same end.`);
    expect(whole.segments.map((s) => s.equal)).toEqual([true, false, true]);
    expect(diffTexts(a, b)).toBeDefined();
  });

  it('aligns on whole sentences first: a long insertion does not pair up stray words of unrelated passages', () => {
    const intro = 'This report describes two experiments on the reading habits of students. It was written over one summer and revised twice.';
    const p1 = 'In the first experiment the quick brown fox jumps over the lazy dog while the students take notes by hand.';
    const rest = 'The second experiment repeats the first one with a longer text. Both experiments show that notes taken by hand are remembered longer.';
    const long = 'A paragraph that was added later. ' + 'It has many more words than the others and takes a lot of room on the page. '.repeat(14);
    const a = `Title ${intro} ${p1} Edited copy: ${p1} ${rest}`;
    const b = `Title ${long}${intro} ${p1} ${rest}`;
    const diff = diffTexts(a, b)!;
    check(diff, a, b);
    // The sentences that are there once in both keep their place, however much was added before them.
    const [s, e] = rangeOf(a, 'reading habits of students');
    const m = mapRange(diff, a, b, s, e);
    expect(b.slice(m.start, m.end)).toBe('reading habits of students');
    expect(m).toMatchObject({ changed: false });
    expect(diff.segments.filter((seg) => seg.equal && seg.a0 > 0 && seg.a1 - seg.a0 < 12)).toEqual([]);
    // A short word left between two rewritten stretches is not taken as kept text.
    const x = 'Start here. alpha beta gamma delta the epsilon zeta eta theta iota. End here.';
    const y = 'Start here. one two three four five the six seven eight nine ten. End here.';
    const [ts, te] = rangeOf(x, 'delta the epsilon');
    expect(mapRange(diffTexts(x, y)!, x, y, ts, te).kept).toBe(0);
  });

  it('refines a replaced word to characters only when the words are alike', () => {
    const alike = diffTexts('fix teh typo', 'fix the typo')!;
    expect(alike.segments.filter((s) => !s.equal).every((s) => s.a1 - s.a0 <= 2)).toBe(true);
    const unlike = diffTexts('the quick fox', 'the green fox')!;
    expect(unlike.segments.find((s) => !s.equal)).toMatchObject({ a0: 4, a1: 9, b0: 4, b1: 9 });
  });
});

describe('mapRange', () => {
  it('keeps a range whose text did not change, wherever it went', () => {
    expect(mapped(A, `New words first. ${A}`, 'lazy dog')).toMatchObject({ text: 'lazy dog', changed: false, kept: 7, total: 7 });
    expect(mapped(A, A.replace('The quick ', ''), 'lazy dog')).toMatchObject({ text: 'lazy dog', changed: false });
    expect(mapped(A, `${A} More at the end.`, 'lazy dog')).toMatchObject({ text: 'lazy dog', changed: false });
  });

  it('does not take in text typed right before or right after the range', () => {
    expect(mapped(A, A.replace('quick brown', 'very quick brown'), 'quick brown')).toMatchObject({ text: 'quick brown', changed: false });
    expect(mapped(A, A.replace('quick brown', 'quick brown and red'), 'quick brown')).toMatchObject({ text: 'quick brown', changed: false });
  });

  it('takes in text inserted inside the range', () => {
    expect(mapped(A, A.replace('quick brown', 'quick dark brown'), 'quick brown fox')).toMatchObject({ text: 'quick dark brown fox', changed: true, kept: 13 });
  });

  it('shrinks to what is left when the head or the tail is deleted', () => {
    expect(mapped(A, A.replace('quick brown ', ''), 'quick brown fox jumps')).toMatchObject({ text: 'fox jumps', kept: 8, total: 18 });
    expect(mapped(A, A.replace(' fox jumps', ''), 'quick brown fox jumps')).toMatchObject({ text: 'quick brown', kept: 10 });
  });

  it('keeps a first or last word that was fixed in place, not one that was swapped for another', () => {
    expect(mapped('see teh quick fox run', 'see the quick fox run', 'teh quick fox').text).toBe('the quick fox');
    expect(mapped('see the quick fxo run', 'see the quick fox run', 'the quick fxo').text).toBe('the quick fox');
    expect(mapped('see the quick fox run', 'see a quick fox run', 'the quick fox').text.trim()).toBe('quick fox');
  });

  it('maps a fully deleted range to an empty one, with the place it was', () => {
    const shorter = A.replace('brown fox jumps ', '');
    const gone = mapped(A, shorter, 'fox jumps');
    expect(gone).toMatchObject({ kept: 0, text: '', between: '' });
    expect(shorter.slice(0, gone.gap[0])).toBe('The quick ');
    const replaced = mapped(A, A.replace('brown fox jumps', 'cat sleeps'), 'brown fox jumps');
    expect(replaced).toMatchObject({ kept: 0, between: 'cat sleeps' });
  });

  it('maps boundaries from the left and from the right around an insertion', () => {
    const b = A.replace('fox ', 'fox really ');
    const diff = diffTexts(A, b)!;
    const at = A.indexOf('jumps');
    expect(b.slice(mapPointLeft(diff, at))).toMatch(/^really jumps/);
    expect(b.slice(mapPointRight(diff, at))).toMatch(/^jumps/);
    expect(mapPointLeft(diff, 0)).toBe(0);
    expect(mapPointRight(diff, A.length)).toBe(b.length);
  });

  it('knows which text is new', () => {
    const b = `${A} The quick brown fox again.`;
    const diff = diffTexts(A, b)!;
    const copy = b.lastIndexOf('quick brown fox');
    expect(insertedShare(diff, copy, copy + 15)).toBe(1);
    expect(insertedShare(diff, 4, 19)).toBe(0);
  });

  it('keeps a duplicated block on the original: the copy below by default, either side with a hint', () => {
    const p = 'A paragraph that gets copied.';
    const a = `Intro text. ${p} Closing text.`;
    const b = `Intro text. ${p} ${p} Closing text.`;
    const plain = diffTexts(a, b)!;
    const [s, e] = rangeOf(a, 'gets copied');
    expect(mapRange(plain, a, b, s, e).start).toBe(b.indexOf('gets copied'));
    const above = applyCopyHints(plain, b, [{ text: `${p}\n`, side: 'before' }]);
    check(above, a, b);
    expect(mapRange(above, a, b, s, e).start).toBe(b.lastIndexOf('gets copied'));
    const below = applyCopyHints(above, b, [{ text: p, side: 'after' }]);
    check(below, a, b);
    expect(mapRange(below, a, b, s, e).start).toBe(b.indexOf('gets copied'));
    // A hint about other text changes nothing.
    expect(applyCopyHints(plain, b, [{ text: 'Something else entirely', side: 'before' }])).toEqual(plain);
  });
});
