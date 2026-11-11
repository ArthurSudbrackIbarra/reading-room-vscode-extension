// When a block of text is duplicated next to itself (Copy Line Up/Down, a paste right above or
// below the original), the rendered text cannot tell which of the two identical blocks is the
// copy. The editor can: the change event says what was inserted, and the cursor says which block
// the reader is working on. The viewer uses that to keep annotations on the original.
// Pure functions (no vscode), so they are unit-testable.
import type { CopyHint } from '../anchoring/diff';

export interface TextChange {
  /** Where the change starts in the document. */
  offset: number;
  /** The text that was inserted. */
  text: string;
  /** How many characters it replaced. */
  removed: number;
}

export interface Duplicate {
  /** Start of the first and of the second of the two identical blocks. */
  first: number;
  second: number;
  /** The block's text, trimmed. */
  text: string;
  /** Whether the inserted block is the first one. */
  insertedFirst: boolean;
  /** Where the inserted text ends. */
  insertedEnd: number;
}

/** Shortest inserted text (without white space around it) that is looked at. */
export const MIN_COPY_LENGTH = 8;

/** Whether a change inserted a copy right before or right after identical text. `after` is the document's text after the change. */
export function duplicateOf(after: string, change: TextChange): Duplicate | undefined {
  const core = change.text.trim();
  if (change.removed > 0 || core.length < MIN_COPY_LENGTH) return undefined;
  const start = change.offset;
  const end = start + change.text.length;
  const lead = change.text.length - change.text.trimStart().length;
  const following = after.slice(end, end + change.text.length + 8);
  const gap = following.length - following.trimStart().length;
  if (following.trimStart().startsWith(core)) {
    return { first: start + lead, second: end + gap, text: core, insertedFirst: true, insertedEnd: end };
  }
  const preceding = after.slice(Math.max(0, start - change.text.length - 8), start).trimEnd();
  if (preceding.endsWith(core)) {
    const first = Math.max(0, start - change.text.length - 8) + preceding.length - core.length;
    return { first, second: start + lead, text: core, insertedFirst: false, insertedEnd: end };
  }
  return undefined;
}

/**
 * Which of the two blocks is the copy: the one the cursor is in. Right after a paste the cursor
 * stands at the end of what was pasted, and without a cursor nothing else is known: then the
 * inserted block is the copy.
 */
export function hintFor(duplicate: Duplicate, cursor?: number): CopyHint {
  let copyIsFirst = duplicate.insertedFirst;
  if (cursor !== undefined && cursor !== duplicate.insertedEnd) {
    if (cursor >= duplicate.first && cursor < duplicate.second) copyIsFirst = true;
    else if (cursor >= duplicate.second && cursor <= duplicate.second + duplicate.text.length) copyIsFirst = false;
  }
  return { text: duplicate.text.slice(0, 2000), side: copyIsFirst ? 'before' : 'after' };
}
