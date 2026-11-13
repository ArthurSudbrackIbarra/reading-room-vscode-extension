// The undo history of a document: what the reader did, as operations that can be reverted and
// applied again. It is kept with the annotations (see store/HistoryStore.ts), so it lasts when the
// tab or VS Code is closed. Shared by the viewer and the extension host; no runtime dependencies.
import type { Drawing } from './drawings';
import type { Highlight, HighlightColor, ReadingMarker } from './types';

/** Changeable properties of a highlight. `note: ''` means "no note". */
export interface HighlightChanges {
  color?: HighlightColor;
  note?: string;
}

export type EditOp =
  | { kind: 'create'; highlight: Highlight }
  | { kind: 'delete'; highlight: Highlight }
  | { kind: 'update'; id: string; before: HighlightChanges; after: HighlightChanges }
  /** A highlight rebased on its current text (Accept) or attached to other text: the whole highlight before and after. */
  | { kind: 'replace'; before: Highlight; after: Highlight }
  | { kind: 'marker'; before: ReadingMarker | null; after: ReadingMarker | null }
  | { kind: 'createDrawing'; drawing: Drawing }
  | { kind: 'deleteDrawing'; drawing: Drawing }
  /** A drawing's color, width or position changed: the whole drawing before and after. */
  | { kind: 'updateDrawing'; before: Drawing; after: Drawing }
  | { kind: 'batch'; ops: EditOp[] };

export interface UndoStep {
  op: EditOp;
  /** What the user did, e.g. "Delete highlight". */
  label: string;
}

/** Most steps that can be undone (and as many that can be redone). */
export const MAX_HISTORY_STEPS = 500;
/** A step's label is cut to this. */
export const MAX_STEP_LABEL = 120;

/** The history as it is stored and sent to the viewer: `done` oldest first, `undone` with the next redo last. */
export interface StoredHistory {
  done: UndoStep[];
  undone: UndoStep[];
}

/** What the viewer tells the host each time the history changes, so the stored copy follows. */
export type HistoryChange = { kind: 'push'; step: UndoStep } | { kind: 'undo' } | { kind: 'redo' } | { kind: 'clear' };

export function inverse(op: EditOp): EditOp {
  switch (op.kind) {
    case 'create':
      return { kind: 'delete', highlight: op.highlight };
    case 'delete':
      return { kind: 'create', highlight: op.highlight };
    case 'update':
      return { kind: 'update', id: op.id, before: op.after, after: op.before };
    case 'replace':
      return { kind: 'replace', before: op.after, after: op.before };
    case 'marker':
      return { kind: 'marker', before: op.after, after: op.before };
    case 'createDrawing':
      return { kind: 'deleteDrawing', drawing: op.drawing };
    case 'deleteDrawing':
      return { kind: 'createDrawing', drawing: op.drawing };
    case 'updateDrawing':
      return { kind: 'updateDrawing', before: op.after, after: op.before };
    case 'batch':
      return { kind: 'batch', ops: op.ops.map(inverse).reverse() };
  }
}

/**
 * Applies a change of the viewer's history to the stored copy, the same way the viewer's own
 * stack does it. An undo or redo with nothing left (the stored copy keeps less than the viewer
 * when it is cut to its size limit) changes nothing.
 */
export function applyHistoryChange(history: StoredHistory, change: HistoryChange, limit = MAX_HISTORY_STEPS): void {
  switch (change.kind) {
    case 'push':
      history.done.push(change.step);
      if (history.done.length > limit) history.done.splice(0, history.done.length - limit);
      history.undone.length = 0;
      break;
    case 'undo': {
      const step = history.done.pop();
      if (step) history.undone.push(step);
      break;
    }
    case 'redo': {
      const step = history.undone.pop();
      if (step) history.done.push(step);
      break;
    }
    case 'clear':
      history.done.length = 0;
      history.undone.length = 0;
      break;
  }
}
