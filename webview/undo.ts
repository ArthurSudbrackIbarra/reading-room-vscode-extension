// Undo/redo for the reader's edits: highlights, their colors and notes, and the reading marker.
// Each edit is recorded as an operation; undoing applies its inverse. No DOM access, so it is
// unit-testable.
import type { Highlight, HighlightColor, ReadingMarker } from '../src/shared/types';

/** Changeable properties of a highlight. `note: ''` means "no note". */
export interface HighlightChanges {
  color?: HighlightColor;
  note?: string;
}

export type EditOp =
  | { kind: 'create'; highlight: Highlight }
  | { kind: 'delete'; highlight: Highlight }
  | { kind: 'update'; id: string; before: HighlightChanges; after: HighlightChanges }
  | { kind: 'marker'; before: ReadingMarker | null; after: ReadingMarker | null }
  | { kind: 'batch'; ops: EditOp[] };

export interface UndoStep {
  op: EditOp;
  /** What the user did, e.g. "Delete highlight". */
  label: string;
}

export function inverse(op: EditOp): EditOp {
  switch (op.kind) {
    case 'create':
      return { kind: 'delete', highlight: op.highlight };
    case 'delete':
      return { kind: 'create', highlight: op.highlight };
    case 'update':
      return { kind: 'update', id: op.id, before: op.after, after: op.before };
    case 'marker':
      return { kind: 'marker', before: op.after, after: op.before };
    case 'batch':
      return { kind: 'batch', ops: op.ops.map(inverse).reverse() };
  }
}

export class UndoStack {
  private readonly done: UndoStep[] = [];
  private readonly undone: UndoStep[] = [];

  constructor(private readonly limit = 500) {}

  /** Records an edit that was just applied. Clears the redo history. */
  record(op: EditOp, label: string): void {
    this.done.push({ op: structuredClone(op), label });
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
  }

  /** The operation that reverts the last edit (already moved to the redo history), if any. */
  undo(): UndoStep | undefined {
    const step = this.done.pop();
    if (!step) return undefined;
    this.undone.push(step);
    return { op: inverse(structuredClone(step.op)), label: step.label };
  }

  /** The operation that re-applies the last undone edit, if any. */
  redo(): UndoStep | undefined {
    const step = this.undone.pop();
    if (!step) return undefined;
    this.done.push(step);
    return { op: structuredClone(step.op), label: step.label };
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
  }
}
