/**
 * Which Worktree's decision the office asks about next (pure, Node-tested).
 *
 * The server tells every privileged office each Directory's Worktrees
 * (`worktreesLoaded`); one in state `needsDecision` is a question waiting for
 * an answer. The office asks one at a time, in a stable order, skipping the
 * ones this office already answered (until the server's next list says how
 * it went) and the ones it put off for later — until one comes to need a
 * decision again (`newlyPending`): that is a new question.
 */

import type { WorktreeSummary } from '../../../core/src/messages.js';

/** Each Directory's Worktrees, as the server last listed them. */
export type WorktreesByDirectory = Readonly<Record<string, readonly WorktreeSummary[]>>;

export interface PendingDecision {
  directoryPath: string;
  worktree: WorktreeSummary;
}

/** One Worktree's identity across messages. */
export function decisionKey(directoryPath: string, name: string): string {
  return `${directoryPath}\u0000${name}`;
}

/** The Worktrees waiting on a decision, Directory by Directory, by name. */
export function pendingDecisions(byDirectory: WorktreesByDirectory): PendingDecision[] {
  const out: PendingDecision[] = [];
  for (const directoryPath of Object.keys(byDirectory).sort()) {
    const waiting = byDirectory[directoryPath]
      .filter((w) => w.state === 'needsDecision')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const worktree of waiting) out.push({ directoryPath, worktree });
  }
  return out;
}

/** The Worktrees (by decisionKey) that need a decision in `next` and did not
 *  in `prev`: new questions, asked even where an earlier one was put off or
 *  answered (a Remove that found changes, a kept folder flagged again). */
export function newlyPending(prev: WorktreesByDirectory, next: WorktreesByDirectory): string[] {
  const key = (p: PendingDecision) => decisionKey(p.directoryPath, p.worktree.name);
  const before = new Set(pendingDecisions(prev).map(key));
  return pendingDecisions(next)
    .map(key)
    .filter((k) => !before.has(k));
}

/** The question to show now: the first pending one not in `hidden`. */
export function nextDecision(
  byDirectory: WorktreesByDirectory,
  hidden: ReadonlySet<string>,
): PendingDecision | null {
  return (
    pendingDecisions(byDirectory).find(
      (p) => !hidden.has(decisionKey(p.directoryPath, p.worktree.name)),
    ) ?? null
  );
}
