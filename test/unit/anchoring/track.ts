// Test helper: follows one anchor through versions of a text, with or without the old text known.
import { createAnchor, type AnchorState, type TextAnchor } from '../../../src/anchoring/anchor';
import type { CopyHint } from '../../../src/anchoring/diff';
import { resolveAnchor, type Resolution } from '../../../src/anchoring/resolve';
import { hashText } from '../../../src/anchoring/textModel';

export interface Tracked {
  anchor: TextAnchor;
  state?: AnchorState;
  /** Texts by hash (the snapshots). */
  texts: Map<string, string>;
  last?: Resolution;
}

export function rangeOf(text: string, exact: string, occurrence = 0): [number, number] {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(exact, start + 1);
  if (start < 0) throw new Error(`"${exact}" not found`);
  return [start, start + exact.length];
}

export interface StepOptions {
  /** Forget the old texts first: the resolver has to search. */
  noSnapshot?: boolean;
  hints?: CopyHint[];
}

/** Resolves in a new version of the text and keeps the state. Checks the invariants of one resolution. */
export function step(t: Tracked, text: string, options: StepOptions = {}): Resolution {
  const hash = hashText(text);
  if (options.noSnapshot) t.texts.clear();
  const anchorBefore = JSON.stringify(t.anchor);
  const ctx = () => ({ current: { text, hash }, oldText: (h: string) => t.texts.get(h), hints: options.hints });
  const r = resolveAnchor(t.anchor, t.state, ctx());
  if (JSON.stringify(t.anchor) !== anchorBefore) throw new Error('the resolver changed the anchor');
  if (r.status === 'anchored') {
    if (r.start === undefined || r.end === undefined || r.start < 0 || r.end <= r.start || r.end > text.length) throw new Error(`bad range ${r.start}-${r.end}`);
    if (r.kind === undefined) throw new Error('anchored without a kind');
  } else {
    if (r.reason === undefined) throw new Error('orphaned without a reason');
    if (r.start !== undefined || r.end !== undefined) throw new Error('orphaned with a position');
  }
  // Determinism: the same inputs give the same result.
  const again = resolveAnchor(t.anchor, t.state, ctx());
  if (JSON.stringify(again) !== JSON.stringify(r)) throw new Error('the resolver is not deterministic');
  if (r.status === 'anchored') t.texts.set(hash, text);
  t.state = r.state;
  t.last = r;
  return r;
}

/** An anchor made on `exact` in `text` and resolved there once. */
export function track(text: string, exact: string, occurrence = 0): Tracked {
  const [start, end] = rangeOf(text, exact, occurrence);
  const t: Tracked = { anchor: createAnchor(text, hashText(text), start, end), texts: new Map() };
  step(t, text);
  return t;
}

export function textOf(text: string, r: Resolution): string | undefined {
  return r.status === 'anchored' ? text.slice(r.start, r.end) : undefined;
}
