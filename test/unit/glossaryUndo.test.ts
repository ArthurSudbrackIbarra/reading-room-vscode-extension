// Defining, changing, deleting and importing terms of the glossary can be undone like every other
// edit, and those steps are kept on disk with the rest of the undo history.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GlossaryTerm } from '../../src/shared/glossary';
import { applyHistoryChange, type StoredHistory, type UndoStep } from '../../src/shared/history';
import { recordKey, type DocumentRef } from '../../src/store/HighlightStore';
import { HistoryStore, sanitizeHistoryChange, sanitizeHistoryFile, sanitizeStep } from '../../src/store/HistoryStore';
import { UndoStack, inverse, type EditOp } from '../../webview/undo';

const AT = '2026-11-19T10:00:00.000Z';
const term = (id: string, text: string, definition = `what ${text} means`): GlossaryTerm => ({ id, term: text, definition, createdAt: AT, updatedAt: AT });
const mlp = term('t1', 'MLP', 'Multi-Layer Perceptron');
const mlpChanged = { ...mlp, definition: 'A multi-layer perceptron', updatedAt: '2026-11-19T11:00:00.000Z' };
const relu = term('t2', 'ReLU');

describe('the inverse of a change to the glossary', () => {
  it('a defined term is deleted, a deleted one comes back, a changed one is as before', () => {
    expect(inverse({ kind: 'term', before: null, after: mlp })).toEqual({ kind: 'term', before: mlp, after: null });
    expect(inverse({ kind: 'term', before: mlp, after: null })).toEqual({ kind: 'term', before: null, after: mlp });
    expect(inverse({ kind: 'term', before: mlp, after: mlpChanged })).toEqual({ kind: 'term', before: mlpChanged, after: mlp });
  });

  it('an import is taken back as a whole, last term first', () => {
    const op: EditOp = {
      kind: 'batch',
      ops: [
        { kind: 'term', before: null, after: mlp },
        { kind: 'term', before: null, after: relu },
      ],
    };
    expect(inverse(op)).toEqual({
      kind: 'batch',
      ops: [
        { kind: 'term', before: relu, after: null },
        { kind: 'term', before: mlp, after: null },
      ],
    });
  });

  it('undo and redo go through the steps of the glossary like through any other', () => {
    const stack = new UndoStack();
    stack.record({ kind: 'term', before: null, after: mlp }, 'Define term');
    stack.record({ kind: 'term', before: mlp, after: mlpChanged }, 'Edit term');
    stack.record({ kind: 'term', before: mlpChanged, after: null }, 'Delete term');
    expect(stack.nextUndo).toBe('Delete term');
    expect(stack.undo()).toEqual({ op: { kind: 'term', before: null, after: mlpChanged }, label: 'Delete term' });
    expect(stack.undo()).toEqual({ op: { kind: 'term', before: mlpChanged, after: mlp }, label: 'Edit term' });
    expect(stack.undo()).toEqual({ op: { kind: 'term', before: mlp, after: null }, label: 'Define term' });
    expect(stack.undo()).toBeUndefined();
    expect(stack.redo()).toEqual({ op: { kind: 'term', before: null, after: mlp }, label: 'Define term' });
  });
});

describe('steps of the glossary that are stored are checked', () => {
  const steps: UndoStep[] = [
    { op: { kind: 'term', before: null, after: mlp }, label: 'Define term' },
    { op: { kind: 'term', before: mlp, after: mlpChanged }, label: 'Edit term' },
    { op: { kind: 'term', before: mlpChanged, after: null }, label: 'Delete term' },
    {
      op: {
        kind: 'batch',
        ops: [
          { kind: 'term', before: null, after: mlp },
          { kind: 'term', before: null, after: relu },
        ],
      },
      label: 'Import 2 terms',
    },
  ];

  it('keeps them as they were made', () => {
    for (const step of steps) expect(sanitizeStep(structuredClone(step))).toEqual(step);
    expect(sanitizeHistoryChange({ kind: 'push', step: steps[0] })).toEqual({ kind: 'push', step: steps[0] });
    expect(sanitizeHistoryFile({ done: steps, undone: [] }).done).toEqual(steps);
  });

  it('cleans the terms in them', () => {
    const step = sanitizeStep({ label: 'Define term', op: { kind: 'term', before: null, after: { ...mlp, term: '  MLP \n', extra: 'dropped' } } });
    expect(step?.op).toEqual({ kind: 'term', before: null, after: mlp });
  });

  it('refuses what is not a change to a term', () => {
    const bad = (op: unknown) => expect(sanitizeStep({ label: 'x', op }), JSON.stringify(op)).toBeUndefined();
    bad({ kind: 'term', before: null, after: null });
    bad({ kind: 'term', before: null });
    bad({ kind: 'term', after: mlp });
    bad({ kind: 'term', before: null, after: { id: 't1', term: 'MLP' } });
    bad({ kind: 'term', before: { id: 't1', term: '', definition: 'x' }, after: null });
    // A change is of one term: not one term before and another after.
    bad({ kind: 'term', before: mlp, after: relu });
    bad({ kind: 'batch', ops: [{ kind: 'term', before: null, after: mlp }, { kind: 'term' }] });
  });
});

describe('the stored history', () => {
  let dir: string;
  const ref: DocumentRef = { uri: 'file:///docs/a.md', scheme: 'file', fsPath: '/docs/a.md' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reading-room-glossary-undo-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the steps of the glossary through a restart, so they can still be undone', async () => {
    const open = () => new HistoryStore({ dir, keyOf: (r) => recordKey(r, 'linux'), coalesceMs: 5 });
    const first = open();
    const stored: StoredHistory = { done: [], undone: [] };
    // (The host stores the changes one after the other, in the order the viewer reports them.)
    let storing: Promise<void> = Promise.resolve();
    const stack = new UndoStack(500, (change) => {
      if (!change) return;
      applyHistoryChange(stored, structuredClone(change));
      const checked = sanitizeHistoryChange(structuredClone(change));
      storing = storing.then(() => first.change(ref, checked));
    });
    stack.record({ kind: 'term', before: null, after: mlp }, 'Define term');
    stack.record({ kind: 'term', before: null, after: relu }, 'Define term');
    stack.record({ kind: 'term', before: mlp, after: mlpChanged }, 'Edit term');
    stack.undo();
    await storing;
    await first.flush();
    expect(stored.done.map((s) => s.label)).toEqual(['Define term', 'Define term']);

    const later = new UndoStack();
    later.load(await open().get(ref));
    expect(later.nextUndo).toBe('Define term');
    expect(later.redo()?.op).toEqual({ kind: 'term', before: mlp, after: mlpChanged });
    expect(later.undo()?.op).toEqual({ kind: 'term', before: mlpChanged, after: mlp });
    expect(later.undo()?.op).toEqual({ kind: 'term', before: relu, after: null });
  });
});
