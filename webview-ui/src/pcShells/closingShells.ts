/**
 * Shells being closed so their PCs can be deleted (the layout editor's delete;
 * CONTEXT.md → PC shell): closed one at a time — each may come back with the
 * question a running command raises — and `then` (the delete) runs once none is
 * live. Cancelling (Keep Running) drops it: the PCs stay. Pure: the store hands
 * it the live list and sends what it asks.
 */
export class ClosingShells {
  private pending: { ids: number[]; then: () => void } | null = null;

  private readonly close: (id: number) => void;

  /** `close(id)` asks the server to close shell `id` (unconfirmed). */
  constructor(close: (id: number) => void) {
    this.close = close;
  }

  /** Whether a delete is waiting on shells to close. */
  get active(): boolean {
    return this.pending !== null;
  }

  start(ids: readonly number[], then: () => void): void {
    this.pending = { ids: [...ids], then };
  }

  cancel(): void {
    this.pending = null;
  }

  /**
   * The live list or the open question changed: run the delete when none of
   * its shells is live any more, else ask for the next one — unless its
   * question is already on screen.
   */
  advance(live: ReadonlySet<number>, askedId: number | null): void {
    if (!this.pending) return;
    const next = this.pending.ids.find((id) => live.has(id));
    if (next === undefined) {
      const { then } = this.pending;
      this.pending = null;
      then();
      return;
    }
    if (askedId !== next) this.close(next);
  }
}
