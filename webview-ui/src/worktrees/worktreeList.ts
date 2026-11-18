/**
 * The Worktrees list's rules (pure, Node-tested): what each listed Worktree
 * says about itself and which actions it offers. `open` and `resume` are what
 * pressing the row does; `remove` and `deleteBranch` its trash button.
 *
 * - Running (an agent in it): Go to the agent.
 * - Ours, no agent: Resume its latest conversation (when it has one); Remove
 *   its folder while there is one (the leave rules, which may ask for a
 *   decision); Delete the branch once it is parked (confirmed when its
 *   commits are its own).
 * - Claude Code's, no agent: Resume, and Remove — its folder and branch at
 *   once, as Claude's own exit prompt would (confirmed when that loses
 *   uncommitted files or commits). Never Delete branch: it has no parked
 *   state.
 */

import type { WorktreeSummary } from '../../../core/src/messages.js';

export type WorktreeAction = 'open' | 'resume' | 'remove' | 'deleteBranch';

/** The user-facing word for a Worktree's state. */
export function worktreeStateLabel(worktree: WorktreeSummary): string {
  if (worktree.agentId !== undefined || worktree.state === 'active') return 'running';
  switch (worktree.state) {
    case 'kept':
      return 'kept';
    case 'parked':
      return 'parked';
    case 'needsDecision':
      return 'needs a decision';
  }
}

/** What a listed Worktree's row offers, in the order they show. */
export function worktreeActions(worktree: WorktreeSummary): WorktreeAction[] {
  if (worktree.agentId !== undefined) return ['open'];
  const actions: WorktreeAction[] = [];
  if (worktree.latestSessionId !== undefined) actions.push('resume');
  if (worktree.state === 'active') return actions;
  if (worktree.owner === 'cli') {
    if (worktree.state === 'kept') actions.push('remove');
    return actions;
  }
  if (worktree.state === 'parked') actions.push('deleteBranch');
  else actions.push('remove');
  return actions;
}

/** Whether deleting a parked Worktree's branch needs a confirmation first:
 *  it holds commits of its own (the server checks again, and counts them). */
export function deleteNeedsConfirmation(worktree: WorktreeSummary): boolean {
  return worktree.uniqueCommits > 0;
}

/** Whether removing a Worktree asks under its row first. One of Claude
 *  Code's: when it would lose uncommitted files or commits (it takes the
 *  branch with it; the server counts again). Ours: when it holds uncommitted
 *  files, asking save or discard there (as the leave dialog would) — clean,
 *  the leave rules remove it and park a branch with commits, losing nothing. */
export function removeNeedsConfirmation(worktree: WorktreeSummary): boolean {
  if (worktree.owner === 'cli') {
    return worktree.uncommittedFiles > 0 || worktree.uniqueCommits > 0;
  }
  return worktree.uncommittedFiles > 0;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** A size on disk, short: "0 B", "512 B", "12 KB", "1.5 MB", "230 MB". */
export function formatSize(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  // 1023.6 KB rounds up to "1024 KB": say "1 MB" instead.
  if (shown >= 1024 && unit < UNITS.length - 1) return `1 ${UNITS[unit + 1]}`;
  return `${shown} ${UNITS[unit]}`;
}
