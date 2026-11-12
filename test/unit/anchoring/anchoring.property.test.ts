// Random documents, random edit scripts, random annotations. Properties:
//  P1  nothing throws;
//  P2  every resolution is anchored (a valid range) or orphaned (with a reason), at every step;
//  P3  the anchor itself is never changed by resolving;
//  P4  an annotation whose words and wide context no edit touched stays on them (exact text, at
//      the place the edits put those very words);
//  P5  A -> ... -> A brings every annotation back, exact, at its first place;
//  P6  going through the intermediate versions ends where going directly ends (for P4's annotations);
//      exception: passages that are in the document twice with identical surroundings (see below);
//  P7  the same inputs give the same result.
// The generator is seeded; a failure prints its seed. ANCHORING_PROPERTY_CASES=5000 runs longer.
import { describe, expect, it } from 'vitest';
import { createAnchor, type AnchorState, type TextAnchor } from '../../../src/anchoring/anchor';
import { diffTexts, mapRange } from '../../../src/anchoring/diff';
import { resolveAnchor, type ResolveContext, type Resolution } from '../../../src/anchoring/resolve';
import { hashText } from '../../../src/anchoring/textModel';

const CASES = Number(process.env.ANCHORING_PROPERTY_CASES) || 500;
/** Tokens of unchanged context required on each side for P4. */
const CONTEXT = 24;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'su', 'ta', 'ri', 'vo', 'du', 'pe', 'gan', 'tor', 'lim', 'bas', 'fen', 'qui', 'zor', 'hal', 'wex', 'jun'];

interface Token {
  id: number;
  word: string;
}

class Doc {
  paragraphs: Token[][] = [];
  private nextId = 1;

  constructor(private readonly random: () => number) {}

  int(n: number): number {
    return Math.floor(this.random() * n);
  }

  word(): string {
    // A small vocabulary of short words, so phrases repeat now and then.
    const syllables = 1 + this.int(3);
    let w = '';
    for (let i = 0; i < syllables; i++) w += SYLLABLES[this.int(this.random() < 0.7 ? 8 : SYLLABLES.length)];
    return w;
  }

  tokens(count: number): Token[] {
    const out: Token[] = [];
    for (let i = 0; i < count; i++) {
      let word = this.word();
      if (i % 11 === 10 || i === count - 1) word += '.';
      out.push({ id: this.nextId++, word });
    }
    return out;
  }

  paragraph(): Token[] {
    return this.tokens(25 + this.int(50));
  }

  /** The text, and where every token is in it. */
  render(): { text: string; at: Map<number, [number, number]>; order: number[] } {
    const at = new Map<number, [number, number]>();
    const order: number[] = [];
    let text = '';
    for (const paragraph of this.paragraphs) {
      for (const token of paragraph) {
        if (text) text += ' ';
        at.set(token.id, [text.length, text.length + token.word.length]);
        order.push(token.id);
        text += token.word;
      }
    }
    return { text, at, order };
  }

  clone(): Token[][] {
    return this.paragraphs.map((p) => p.map((t) => ({ ...t })));
  }
}

interface Annotation {
  ids: number[];
  /** The ids around it in the first version: CONTEXT before and after (fewer at the edges). */
  before: number[];
  after: number[];
  anchor: TextAnchor;
  frozen: string;
  start: number;
  stepped?: AnchorState;
  history?: string[];
}

type Edit = (doc: Doc) => string;

function edits(doc: Doc): Edit[] {
  const pick = () => doc.int(doc.paragraphs.length);
  return [
    (d) => {
      d.paragraphs.splice(d.int(d.paragraphs.length + 1), 0, d.paragraph());
      return 'insert paragraph';
    },
    (d) => {
      if (d.paragraphs.length > 2) d.paragraphs.splice(pick(), 1);
      return 'delete paragraph';
    },
    (d) => {
      const p = d.paragraphs[pick()];
      const from = d.int(p.length);
      p.splice(from, 1 + d.int(6), ...d.tokens(1 + d.int(6)));
      return 'replace words';
    },
    (d) => {
      const p = d.paragraphs[pick()];
      p.splice(d.int(p.length + 1), 0, ...d.tokens(1 + d.int(8)));
      return 'insert words';
    },
    (d) => {
      const p = d.paragraphs[pick()];
      if (p.length > 8) p.splice(d.int(p.length - 4), 1 + d.int(4));
      return 'delete words';
    },
    (d) => {
      if (d.paragraphs.length < 3) return 'move (skipped)';
      const [moved] = d.paragraphs.splice(pick(), 1);
      // Moving text makes it new text where it lands: its tokens get new identities.
      d.paragraphs.splice(d.int(d.paragraphs.length + 1), 0, d.tokens(0).concat(moved.map((t) => ({ id: -t.id, word: t.word }))));
      return 'move paragraph';
    },
    (d) => {
      const from = pick();
      const to = d.int(d.paragraphs.length + 1);
      // A copy right next to its original cannot be told from it: not a case for P4.
      if (Math.abs(to - from) < 2 && to !== from + 2) return 'duplicate (skipped)';
      d.paragraphs.splice(to, 0, d.tokens(0).concat(d.paragraphs[from].map((t) => ({ id: -1e9 - t.id - d.int(1e6), word: t.word }))));
      return 'duplicate paragraph';
    },
    () => 'whitespace only',
  ];
}

function runCase(seed: number): void {
  const random = mulberry32(seed);
  const doc = new Doc(random);
  for (let i = 0, n = 4 + doc.int(5); i < n; i++) doc.paragraphs.push(doc.paragraph());
  const first = doc.render();
  const original = doc.clone();
  const texts = new Map<string, string>([[hashText(first.text), first.text]]);

  const annotations: Annotation[] = [];
  for (let i = 0, n = 3 + doc.int(5); i < n; i++) {
    const at = doc.int(first.order.length - 8);
    const ids = first.order.slice(at, at + 1 + doc.int(7));
    const start = first.at.get(ids[0])![0];
    const end = first.at.get(ids[ids.length - 1])![1];
    const anchor = createAnchor(first.text, hashText(first.text), start, end);
    annotations.push({
      ids,
      before: first.order.slice(Math.max(0, at - CONTEXT), at),
      after: first.order.slice(at + ids.length, at + ids.length + CONTEXT),
      anchor,
      frozen: JSON.stringify(anchor),
      start,
    });
  }

  const context = (text: string, known: Map<string, string>): ResolveContext => ({ current: { text, hash: hashText(text) }, oldText: (h) => known.get(h), diffs: new Map() });
  const check = (r: Resolution, text: string, a: Annotation, label: string): void => {
    if (r.status === 'anchored') {
      if (!(Number.isInteger(r.start) && Number.isInteger(r.end) && r.start! >= 0 && r.end! > r.start! && r.end! <= text.length))
        throw new Error(`${label}: bad range ${r.start}-${r.end}`);
      if (!r.kind) throw new Error(`${label}: anchored without a kind`);
    } else if (!r.reason || r.start !== undefined) {
      throw new Error(`${label}: orphaned without a reason, or with a position`);
    }
    if (JSON.stringify(a.anchor) !== a.frozen) throw new Error(`${label}: the anchor was changed`);
  };

  // The first version: everything is where it was made.
  let ctx = context(first.text, texts);
  for (const a of annotations) {
    const r = resolveAnchor(a.anchor, undefined, ctx);
    check(r, first.text, a, 'first');
    if (r.status !== 'anchored' || r.start !== a.start) throw new Error(`first: not found where it was made (${r.status} ${r.start} vs ${a.start})`);
    a.stepped = r.state;
  }

  const script = edits(doc);
  const log: string[] = [];
  let transient: Token[][] | undefined;
  for (let step = 0, n = 4 + doc.int(4); step < n; step++) {
    if (transient) {
      // The file is whole again after having been cut short.
      doc.paragraphs = transient;
      transient = undefined;
      log.push('restore');
    } else if (random() < 0.12 && doc.paragraphs.length > 2) {
      transient = doc.clone();
      doc.paragraphs = doc.paragraphs.slice(0, 1 + doc.int(doc.paragraphs.length - 1));
      log.push('truncate');
    } else {
      log.push(script[doc.int(script.length)](doc));
    }
    const now = doc.render();
    ctx = context(now.text, texts);
    let found = false;
    for (const a of annotations) {
      const label = `step ${step} (${log.join(', ')})`;
      const previous = a.stepped;
      const r = resolveAnchor(a.anchor, a.stepped, ctx);
      check(r, now.text, a, label);
      if (step === 0 || random() < 0.2) {
        // P7.
        const again = resolveAnchor(a.anchor, a.stepped, context(now.text, texts));
        if (JSON.stringify(again) !== JSON.stringify(r)) throw new Error(`${label}: not deterministic`);
      }
      a.stepped = r.state;
      (a.history ??= []).push(`${r.status}/${r.kind ?? r.reason}/${r.via}@${r.start ?? r.tombstone}`);
      if (r.status === 'anchored') found = true;
      // P4: untouched words with untouched context.
      const position = now.order.indexOf(a.ids[0]);
      const untouched =
        position >= 0 &&
        a.ids.every((id, k) => now.order[position + k] === id) &&
        a.before.every((id, k) => now.order[position - a.before.length + k] === id) &&
        a.after.every((id, k) => now.order[position + a.ids.length + k] === id) &&
        a.before.length === CONTEXT &&
        a.after.length === CONTEXT;
      // The exception: a passage that is in the document twice with the same words around it (a
      // duplicated paragraph). The two are the same text; when blocks around them are reordered,
      // or one of them is gone for a while, the annotation can end up on the other one: nothing
      // in the text says which one the reader annotated.
      const surroundings = first.text.slice(Math.max(0, a.start - 24), a.start + a.anchor.exact.length + 24);
      const twice = now.text.indexOf(surroundings) !== now.text.lastIndexOf(surroundings);
      if (untouched && !twice) {
        const expected = now.at.get(a.ids[0])![0];
        if (r.status !== 'anchored' || r.start !== expected || now.text.slice(r.start, r.end) !== a.anchor.exact) {
          if (process.env.ANCHORING_PROPERTY_SEED && previous?.found && texts.get(previous.found.hash)) {
            console.log('P4 previous', JSON.stringify(previous.found), 'lengths', texts.get(previous.found.hash)!.length, now.text.length);
            explain(texts.get(previous.found.hash)!, now.text, previous.found.start, previous.found.end, expected);
            console.log('P4 got', JSON.stringify(now.text.slice(r.start! - 70, r.end! + 70)));
          }
          throw new Error(
            `${label}: untouched "${a.anchor.exact}" expected at ${expected}, got ${r.status} ${r.kind ?? r.reason} at ${r.start} via ${r.via} [${a.history?.join(' ')}] prefix ${a.anchor.prefix.length} suffix ${a.anchor.suffix.length}`,
          );
        }
        // P6: straight from the first version, the same place.
        const direct = resolveAnchor(a.anchor, undefined, context(now.text, new Map([[hashText(first.text), first.text]])));
        const directWithState = resolveAnchor(
          a.anchor,
          { status: 'anchored', kind: 'exact', found: { hash: hashText(first.text), v: 1, length: first.text.length, start: a.start, end: a.start + a.anchor.exact.length } },
          context(now.text, new Map([[hashText(first.text), first.text]])),
        );
        for (const d of [direct, directWithState]) {
          if (d.status !== 'anchored' || d.start !== expected) {
            if (process.env.ANCHORING_PROPERTY_SEED) explain(first.text, now.text, a.start, a.start + a.anchor.exact.length, expected);
            throw new Error(`${label}: directly from the first version "${a.anchor.exact}" expected at ${expected}, got ${d.status} at ${d.start} via ${d.via}`);
          }
        }
      }
    }
    if (found) texts.set(hashText(now.text), now.text);
  }

  // P5: back to the first version.
  doc.paragraphs = original;
  const back = doc.render();
  if (back.text !== first.text) throw new Error('the generator did not restore the first version');
  ctx = context(back.text, texts);
  for (const a of annotations) {
    const r = resolveAnchor(a.anchor, a.stepped, ctx);
    check(r, back.text, a, 'back');
    if (r.status !== 'anchored' || r.start !== a.start || back.text.slice(r.start, r.end) !== a.anchor.exact || r.text !== undefined) {
      if (process.env.ANCHORING_PROPERTY_SEED) {
        const f = a.stepped?.found;
        const old = f ? texts.get(f.hash) : undefined;
        console.log('BACK state', JSON.stringify(a.stepped), 'old known', old !== undefined, 'old slice', old && JSON.stringify(old.slice(f!.start - 20, f!.end + 20)));
        console.log('BACK anchor', JSON.stringify({ prefix: a.anchor.prefix, suffix: a.anchor.suffix, start: a.start }));
        console.log('BACK text', JSON.stringify(back.text.slice(a.start - 70, a.start + 72)));
        if (old && f) explain(old, back.text, f.start, f.end, a.start);
        const t = back.text;
        const ex = a.anchor.exact;
        const hits: number[] = [];
        for (let at = t.indexOf(ex); at !== -1; at = t.indexOf(ex, at + 1)) {
          if (t.slice(Math.max(0, at - a.anchor.prefix.length), at) === a.anchor.prefix && t.slice(at + ex.length, at + ex.length + a.anchor.suffix.length) === a.anchor.suffix)
            hits.push(at);
        }
        console.log('BACK hits', JSON.stringify(hits), 'again', JSON.stringify(resolveAnchor(a.anchor, a.stepped, context(back.text, texts))).slice(0, 300));
      }
      throw new Error(
        `back (${log.join(', ')}): "${a.anchor.exact}" expected exact at ${a.start}, got ${r.status} ${r.kind ?? r.reason} at ${r.start} via ${r.via} [${a.history?.join(' ')}]`,
      );
    }
  }
}

/** For looking into one failing seed: how the diff sees the passage. */
function explain(oldText: string, newText: string, start: number, end: number, expected: number): void {
  const diff = diffTexts(oldText, newText)!;
  const near = diff.segments.filter((s) => (s.a1 > start - 120 && s.a0 < end + 120) || (s.b1 > expected - 120 && s.b0 < expected + 120));
  console.log('EXPLAIN old', JSON.stringify(oldText.slice(start - 60, end + 60)));
  console.log('EXPLAIN new', JSON.stringify(newText.slice(expected - 60, expected + (end - start) + 60)));
  for (const s of near)
    console.log(
      'EXPLAIN seg',
      s.equal ? '=' : '~',
      s.a0,
      s.a1,
      s.b0,
      s.b1,
      JSON.stringify(oldText.slice(s.a0, s.a1).slice(0, 50)),
      '=>',
      JSON.stringify(newText.slice(s.b0, s.b1).slice(0, 50)),
    );
  console.log('EXPLAIN map', JSON.stringify(mapRange(diff, oldText, newText, start, end)));
}

describe('anchoring properties', () => {
  it(`hold for ${CASES} random documents and edit scripts`, () => {
    const failures: string[] = [];
    const only = Number(process.env.ANCHORING_PROPERTY_SEED) || undefined;
    for (let i = 0; i < (only ? 1 : CASES); i++) {
      const seed = only ?? 20261111 + i * 7919;
      try {
        runCase(seed);
      } catch (err) {
        failures.push(`seed ${seed}: ${err instanceof Error ? err.message : String(err)}`);
        if (failures.length >= 5) break;
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
