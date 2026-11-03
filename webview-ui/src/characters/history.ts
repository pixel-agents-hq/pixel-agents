/**
 * Undo/redo with the Characters view's step grouping, DOM-free (the view reports presses).
 *
 * A press starts a new step and every change until its release joins it (a drag, a
 * stroke); otherwise changes within `mergeMs` of the last one merge (typing a name). Each
 * entry remembers the editor frame its change was made on.
 */

export interface HistoryEntry<T> {
  state: T;
  /** The editor frame the change was made on, so undoing it there shows that frame. */
  frame: number | null;
}

export class History<T> {
  private undoStack: HistoryEntry<T>[] = [];
  private redoStack: HistoryEntry<T>[] = [];
  private lastChangeAt = -Infinity;
  /** A press is down: its changes are one step. */
  private held = false;
  /** A press began since the last change: the next change starts a step. */
  private fresh = false;

  private readonly opts: { mergeMs: number; limit: number };

  constructor(opts: { mergeMs: number; limit: number }) {
    this.opts = opts;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** A press began: the next change starts a step, and changes join it until endStep. */
  beginStep(): void {
    this.held = true;
    this.fresh = true;
  }

  /** The press ended: changes merge by time again. */
  endStep(): void {
    this.held = false;
  }

  /** A change at `now` is replacing `before`: open a step for it or join the current one. */
  record(before: T, frame: number | null, now: number): void {
    const startsStep =
      !this.undoStack.length ||
      this.fresh ||
      (!this.held && now - this.lastChangeAt > this.opts.mergeMs);
    if (startsStep) {
      this.undoStack.push({ state: before, frame });
      if (this.undoStack.length > this.opts.limit) this.undoStack.shift();
    }
    this.fresh = false;
    this.lastChangeAt = now;
    this.redoStack = [];
  }

  /** Step back from `current`: the entry to restore, or null when there is none. */
  undo(current: T): HistoryEntry<T> | null {
    return this.step(this.undoStack, this.redoStack, current);
  }

  redo(current: T): HistoryEntry<T> | null {
    return this.step(this.redoStack, this.undoStack, current);
  }

  /** Forget every step (the state they lead back to is gone). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastChangeAt = -Infinity;
  }

  private step(from: HistoryEntry<T>[], to: HistoryEntry<T>[], current: T) {
    const entry = from.pop();
    if (!entry) return null;
    to.push({ state: current, frame: entry.frame });
    this.lastChangeAt = -Infinity; // the next change is a step of its own
    return entry;
  }
}
