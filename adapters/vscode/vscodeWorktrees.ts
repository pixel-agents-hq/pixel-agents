/**
 * The VS Code window's side of Worktrees, out of the view provider: this
 * window holds the Worktrees its agents run in, sweeps crash leftovers a
 * moment after activation, answers the office's Worktree messages, prepares
 * a launch into a new Worktree (and retires one whose terminal never
 * started), and stops retiring on deactivation. Everything git-side is the
 * server's (worktreeLaunch.ts, worktreeLeave.ts).
 */

import type { Directory } from '../../core/src/messages.js';
import type { AgentStateStore } from '../../server/src/agentStateStore.js';
import { WORKTREE_SHUTDOWN_WAIT_MS, WORKTREE_SWEEP_DELAY_MS } from '../../server/src/constants.js';
import {
  prepareWorktreeLaunch,
  retireUnlaunched,
  worktreeRejectedMessage,
  type WorktreeTerminalLaunch,
} from '../../server/src/worktreeLaunch.js';
import {
  handleCloseAgent,
  handleDecideWorktree,
  handleRequestWorktrees,
  holdWorktreesOf,
  stopRetiring,
  sweepWorktrees,
  worktreesSnapshot,
} from '../../server/src/worktreeLeave.js';
import {
  handleRequestWorktreeOptions,
  launchWorktreeChoices,
} from '../../server/src/worktreeOptions.js';

type Send = (message: Record<string, unknown>) => void;

export class VscodeWorktrees {
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: AgentStateStore,
    private readonly send: Send,
  ) {
    // This window holds the Worktrees its agents run in (launched or
    // restored), so another Pixel Agents process never retires them.
    holdWorktreesOf(store);
    // The startup tidy-up of the Worktrees a crash or a closed window left
    // behind: a moment after activation, so neither activation nor the
    // office's load waits on git, and in the background. Every saved agent
    // holds its Worktrees: VS Code's terminals outlive the extension host,
    // and are restored only when the office first opens (perhaps never).
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void sweepWorktrees(store, { savedAgentsHold: () => true });
    }, WORKTREE_SWEEP_DELAY_MS);
  }

  /** `requestWorktreeOptions`: what the new-worktree modal offers for the
   *  Directory the host resolved. */
  requestOptions(message: Record<string, unknown>, directory: Directory | undefined): void {
    void handleRequestWorktreeOptions(message.directoryPath, directory, this.send);
  }

  /** `requestWorktrees` / `decideWorktree`; false for any other message.
   *  This surface has a single office: the reply and the broadcast that
   *  follows a decision are the same channel. */
  handleMessage(message: Record<string, unknown>): boolean {
    if (message.type === 'requestWorktrees') {
      void handleRequestWorktrees(this.store, message, this.send);
    } else if (message.type === 'decideWorktree') {
      void handleDecideWorktree(this.store, message, this.send);
    } else {
      return false;
    }
    return true;
  }

  /** `closeAgent` (the card's ×): a Worktree agent with uncommitted files is
   *  asked about first, and `close` runs once there is nothing to ask or the
   *  answer came back. */
  closeAgent(message: Record<string, unknown>, close: (id: number) => void): void {
    handleCloseAgent(this.store, message, this.send, close).catch((err: unknown) =>
      console.error('[Pixel Agents] Close failed:', err),
    );
  }

  /** The Worktrees we made, after the restore (so a running one names its
   *  agent): one waiting on a decision opens its dialog. Async (git reads). */
  sendSnapshot(): void {
    void worktreesSnapshot(this.store)
      .then((messages) => {
        for (const m of messages) this.send({ ...m });
      })
      .catch((err: unknown) => console.error('[Pixel Agents] Worktrees: snapshot failed:', err));
  }

  /** A launch into a new Worktree of `directory`'s repo: where to run, or
   *  null when it can't be made (the office was told why). */
  async prepareLaunch(
    directoryPath: string | undefined,
    directory: Directory | undefined,
    message: Record<string, unknown>,
  ): Promise<WorktreeTerminalLaunch | null> {
    const prepared = await prepareWorktreeLaunch({
      directoryPath: directoryPath ?? '',
      directory,
      ...launchWorktreeChoices(message),
    });
    if (prepared.ok) return prepared.where;
    this.send({ ...worktreeRejectedMessage(directoryPath ?? '', prepared.reason) });
    return null;
  }

  /** The prepared launch's terminal never started: retire its Worktree now
   *  and tell the office. */
  unlaunched(directoryPath: string | undefined, where: WorktreeTerminalLaunch): void {
    const reason = retireUnlaunched(this.store, where);
    this.send({ ...worktreeRejectedMessage(directoryPath ?? '', reason) });
  }

  /** Deactivation: retire no Worktree from here on (a window reload keeps
   *  its terminals running, and the next activation's sweep handles any that
   *  really ended); resolves once git work already under way has finished. */
  stop(): Promise<void> {
    this.dispose();
    return stopRetiring(WORKTREE_SHUTDOWN_WAIT_MS);
  }

  dispose(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }
}
