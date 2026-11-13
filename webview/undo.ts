// Undo/redo for the reader's edits: highlights, their colors and notes, the reading marker, and
// drawings. Each edit is recorded as an operation; undoing applies its inverse. No DOM access, so
// it is unit-testable. Every change is reported, so the host can keep the history on disk.
import { MAX_HISTORY_STEPS, inverse, type EditOp, type HistoryChange, type StoredHistory, type UndoStep } from '../src/shared/history';

export { inverse };
export type { EditOp, HighlightChanges, HistoryChange, StoredHistory, UndoStep } from '../src/shared/history';

export class UndoStack {
  private readonly done: UndoStep[] = [];
  private readonly undone: UndoStep[] = [];

  /**
   * `onChange`: called whenever what can be undone or redone changed, with the change to store
   * (none when the history was only loaded).
   */
  constructor(
    private readonly limit = MAX_HISTORY_STEPS,
    private readonly onChange?: (change?: HistoryChange) => void,
  ) {}

  /** Takes over a stored history (the document was opened again). Nothing is reported to store. */
  load(history: StoredHistory | undefined): void {
    this.done.length = 0;
    this.undone.length = 0;
    if (history) {
      this.done.push(...structuredClone(history.done).slice(-this.limit));
      this.undone.push(...structuredClone(history.undone).slice(-this.limit));
    }
    this.onChange?.();
  }

  /** Records an edit that was just applied. Clears the redo history. */
  record(op: EditOp, label: string): void {
    const step = { op: structuredClone(op), label };
    this.done.push(step);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    this.onChange?.({ kind: 'push', step });
  }

  /** The operation that reverts the last edit (already moved to the redo history), if any. */
  undo(): UndoStep | undefined {
    const step = this.done.pop();
    if (!step) return undefined;
    this.undone.push(step);
    this.onChange?.({ kind: 'undo' });
    return { op: inverse(structuredClone(step.op)), label: step.label };
  }

  /** The operation that re-applies the last undone edit, if any. */
  redo(): UndoStep | undefined {
    const step = this.undone.pop();
    if (!step) return undefined;
    this.done.push(step);
    this.onChange?.({ kind: 'redo' });
    return { op: structuredClone(step.op), label: step.label };
  }

  /** What the next undo would take back, e.g. "Delete highlight". */
  get nextUndo(): string | undefined {
    return this.done[this.done.length - 1]?.label;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  clear(): void {
    const had = this.done.length > 0 || this.undone.length > 0;
    this.done.length = 0;
    this.undone.length = 0;
    this.onChange?.(had ? { kind: 'clear' } : undefined);
  }
}
