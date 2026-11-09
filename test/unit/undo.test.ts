import { describe, expect, it } from 'vitest';
import { UndoStack, inverse, type EditOp } from '../../webview/undo';
import type { ReadingMarker } from '../../src/shared/types';
import { makeHighlight } from './helpers';

const marker = (pageIndex: number): ReadingMarker => ({ pageIndex, y: 0.3, createdAt: '2026-11-09T00:00:00.000Z' });

describe('inverse', () => {
  it('turns creates into deletes and back', () => {
    const highlight = makeHighlight('x');
    expect(inverse({ kind: 'create', highlight })).toEqual({ kind: 'delete', highlight });
    expect(inverse({ kind: 'delete', highlight })).toEqual({ kind: 'create', highlight });
  });

  it('swaps before and after of updates and marker changes', () => {
    expect(inverse({ kind: 'update', id: 'h', before: { color: 'yellow', note: '' }, after: { color: 'pink', note: 'why' } })).toEqual({
      kind: 'update',
      id: 'h',
      before: { color: 'pink', note: 'why' },
      after: { color: 'yellow', note: '' },
    });
    expect(inverse({ kind: 'marker', before: null, after: marker(2) })).toEqual({ kind: 'marker', before: marker(2), after: null });
  });

  it('inverts batches in reverse order', () => {
    const a = makeHighlight('a');
    const b = makeHighlight('b');
    const op: EditOp = { kind: 'batch', ops: [{ kind: 'delete', highlight: a }, { kind: 'delete', highlight: b }] };
    expect(inverse(op)).toEqual({ kind: 'batch', ops: [{ kind: 'create', highlight: b }, { kind: 'create', highlight: a }] });
  });
});

describe('UndoStack', () => {
  it('undoes and redoes in order', () => {
    const stack = new UndoStack();
    const h = makeHighlight('one');
    stack.record({ kind: 'create', highlight: h }, 'Highlight');
    stack.record({ kind: 'update', id: h.id, before: { note: '' }, after: { note: 'n' } }, 'Edit note');
    expect(stack.undo()).toEqual({ op: { kind: 'update', id: h.id, before: { note: 'n' }, after: { note: '' } }, label: 'Edit note' });
    expect(stack.undo()).toEqual({ op: { kind: 'delete', highlight: h }, label: 'Highlight' });
    expect(stack.undo()).toBeUndefined();
    expect(stack.redo()).toEqual({ op: { kind: 'create', highlight: h }, label: 'Highlight' });
    expect(stack.canRedo).toBe(true);
    expect(stack.redo()?.label).toBe('Edit note');
    expect(stack.redo()).toBeUndefined();
  });

  it('a new edit clears the redo history', () => {
    const stack = new UndoStack();
    stack.record({ kind: 'marker', before: null, after: marker(1) }, 'Mark');
    stack.undo();
    expect(stack.canRedo).toBe(true);
    stack.record({ kind: 'marker', before: null, after: marker(4) }, 'Mark');
    expect(stack.canRedo).toBe(false);
  });

  it('stores copies, so later changes to the objects do not leak in', () => {
    const stack = new UndoStack();
    const h = makeHighlight('copy');
    stack.record({ kind: 'delete', highlight: h }, 'Delete');
    h.color = 'blue';
    const step = stack.undo();
    expect(step?.op.kind === 'create' && step.op.highlight.color).toBe('yellow');
  });

  it('forgets the oldest steps beyond its limit', () => {
    const stack = new UndoStack(3);
    for (let i = 0; i < 5; i++) stack.record({ kind: 'marker', before: null, after: marker(i) }, `step ${i}`);
    expect([stack.undo(), stack.undo(), stack.undo(), stack.undo()].map((s) => s?.label)).toEqual(['step 4', 'step 3', 'step 2', undefined]);
  });
});
