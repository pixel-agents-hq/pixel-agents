/**
 * When the operator last sent input into each agent's terminal over
 * `/terminal/:agentId`. Task dispatch refuses to write into a terminal the
 * operator typed into recently, so a dispatched task can never interleave with
 * (or be submitted together with) a half-typed operator line.
 *
 * Every input frame counts, including what the browser's xterm sends on its own
 * (focus reports, query answers): erring towards "the operator is here" only
 * ever refuses a dispatch. Memory only.
 */

export class OperatorInputTracker {
  private readonly lastInputAt = new Map<number, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** An input frame from the operator reached this agent's PTY. */
  record(agentId: number): void {
    this.lastInputAt.set(agentId, this.now());
  }

  /** Milliseconds since epoch of the last operator input, or undefined. */
  lastInputAtFor(agentId: number): number | undefined {
    return this.lastInputAt.get(agentId);
  }

  /** The agent is gone: forget it (an id is never reused by a live agent). */
  forget(agentId: number): void {
    this.lastInputAt.delete(agentId);
  }
}
