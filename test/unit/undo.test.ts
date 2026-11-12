import { describe, expect, it } from 'vitest';
import { UndoStack, inverse, type EditOp } from '../../webview/undo';
import type { ReadingMarker } from '../../src/shared/types';
import { makeDrawing, makeHighlight } from './helpers';

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
    const op: EditOp = {
      kind: 'batch',
      ops: [
        { kind: 'delete', highlight: a },
        { kind: 'delete', highlight: b },
      ],
    };
    expect(inverse(op)).toEqual({
      kind: 'batch',
      ops: [
        { kind: 'create', highlight: b },
        { kind: 'create', highlight: a },
      ],
    });
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

describe('drawing operations', () => {
  it('turn drawn into deleted and back', () => {
    const drawing = makeDrawing({
      tool: 'pen',
      points: [
        [1, 2],
        [3, 4],
        [5, 3],
      ],
    });
    expect(inverse({ kind: 'createDrawing', drawing })).toEqual({ kind: 'deleteDrawing', drawing });
    expect(inverse({ kind: 'deleteDrawing', drawing })).toEqual({ kind: 'createDrawing', drawing });
  });

  it('swap a drawing before and after a move, a new color or width', () => {
    const before = makeDrawing({ color: 'red', width: 'thin' });
    const moved = { ...before, points: before.points.map(([x, y]): [number, number] => [x + 10, y - 5]) };
    const recolored = { ...before, color: 'blue' as const, width: 'thick' as const };
    expect(inverse({ kind: 'updateDrawing', before, after: moved })).toEqual({ kind: 'updateDrawing', before: moved, after: before });
    expect(inverse({ kind: 'updateDrawing', before, after: recolored })).toEqual({ kind: 'updateDrawing', before: recolored, after: before });
  });

  it('undo an eraser gesture or Delete All in one step, in reverse order', () => {
    const [a, b, c] = [makeDrawing(), makeDrawing({ tool: 'rect' }), makeDrawing({ tool: 'ellipse' })];
    const stack = new UndoStack();
    stack.record({ kind: 'batch', ops: [a, b, c].map((drawing): EditOp => ({ kind: 'deleteDrawing', drawing })) }, 'Erase 3 drawings');
    const step = stack.undo();
    expect(step?.label).toBe('Erase 3 drawings');
    expect(step?.op).toEqual({ kind: 'batch', ops: [c, b, a].map((drawing) => ({ kind: 'createDrawing', drawing })) });
    expect(stack.redo()?.op).toEqual({ kind: 'batch', ops: [a, b, c].map((drawing) => ({ kind: 'deleteDrawing', drawing })) });
  });

  it('mix with highlight and marker steps in one history', () => {
    const stack = new UndoStack();
    const h = makeHighlight('mixed');
    const d = makeDrawing({ tool: 'arrow' });
    stack.record({ kind: 'create', highlight: h }, 'Highlight');
    stack.record({ kind: 'createDrawing', drawing: d }, 'Draw an arrow');
    stack.record({ kind: 'marker', before: null, after: marker(0) }, 'Mark');
    expect([stack.undo(), stack.undo(), stack.undo()].map((s) => s?.op.kind)).toEqual(['marker', 'deleteDrawing', 'delete']);
    d.color = 'black';
    const redo = stack.redo();
    expect(redo?.op.kind === 'create' && redo.op.highlight.id).toBe(h.id);
    const redoDrawing = stack.redo();
    expect(redoDrawing?.op.kind === 'createDrawing' && redoDrawing.op.drawing.color).toBe('red');
  });
});

describe('rebased highlights and bound drawings', () => {
  it('a highlight rebased on other text (Accept, Attach) is one step that swaps the whole highlight', () => {
    const before = makeHighlight('quick brown fox');
    const after = {
      ...before,
      target: { ...before.target, selector: [{ ...before.target.selector[0], exact: 'quick red fox' }, before.target.selector[1]] as typeof before.target.selector },
      anchor: { exact: 'quick red fox', prefix: 'the ', suffix: ' jumps' },
    };
    const op: EditOp = { kind: 'replace', before, after };
    expect(inverse(op)).toEqual({ kind: 'replace', before: after, after: before });
    const stack = new UndoStack();
    stack.record(op, 'Keep highlight on changed text');
    expect(stack.undo()).toEqual({ op: { kind: 'replace', before: after, after: before }, label: 'Keep highlight on changed text' });
    expect(stack.redo()).toEqual({ op, label: 'Keep highlight on changed text' });
  });

  it('D3: drawings keep their binding through undo and redo, so they are resolved again where their content is', () => {
    const binding = {
      mode: 'page' as const,
      anchors: [],
      ref: [],
      page: 0,
      pageSize: [612, 792] as [number, number],
      frame: [1, 0, 0, -1, 0, 792] as [number, number, number, number, number, number],
      for: '2026-11-10T10:00:00.000Z',
    };
    const stored = { ...makeDrawing(), binding };
    const moved = {
      ...stored,
      points: [
        [20, 30],
        [120, 230],
      ] as [number, number][],
      binding: { ...binding, mode: 'line' as const },
    };
    const stack = new UndoStack();
    stack.record({ kind: 'createDrawing', drawing: stored }, 'Line');
    stack.record({ kind: 'updateDrawing', before: stored, after: moved }, 'Move drawing');
    stack.record({ kind: 'batch', ops: [{ kind: 'deleteDrawing', drawing: moved }] }, 'Delete orphaned annotations');
    expect(stack.undo()!.op).toEqual({ kind: 'batch', ops: [{ kind: 'createDrawing', drawing: moved }] });
    expect(stack.undo()!.op).toEqual({ kind: 'updateDrawing', before: moved, after: stored });
    expect(stack.undo()!.op).toEqual({ kind: 'deleteDrawing', drawing: stored });
    expect(stack.redo()!.op).toEqual({ kind: 'createDrawing', drawing: stored });
    // What the stack hands out is a copy: changing it does not change the history.
    const again = stack.redo()!.op as Extract<EditOp, { kind: 'updateDrawing' }>;
    again.after.points[0][0] = 999;
    expect((stack.undo()!.op as Extract<EditOp, { kind: 'updateDrawing' }>).before.points[0][0]).toBe(20);
  });
});

describe('what the undo button shows', () => {
  it('names the next change to take back, and is told about every change of the history', () => {
    let changes = 0;
    const stack = new UndoStack(500, () => changes++);
    expect(stack.nextUndo).toBeUndefined();
    stack.record({ kind: 'create', highlight: makeHighlight('a') }, 'Highlight');
    stack.record({ kind: 'delete', highlight: makeHighlight('a') }, 'Delete highlight');
    expect(stack.nextUndo).toBe('Delete highlight');
    stack.undo();
    expect(stack.nextUndo).toBe('Highlight');
    stack.redo();
    expect(stack.nextUndo).toBe('Delete highlight');
    stack.clear();
    expect(stack.nextUndo).toBeUndefined();
    expect(changes).toBe(5);
  });

  it('is not told when there was nothing to undo or redo', () => {
    let changes = 0;
    const stack = new UndoStack(500, () => changes++);
    expect(stack.undo()).toBeUndefined();
    expect(stack.redo()).toBeUndefined();
    expect(changes).toBe(0);
  });
});
