/**
 * The startup sweep: what a crash or a closed window left behind, tidied once
 * at startup. The same guards as the leave rules apply to everything here
 * that deletes: ownership proven by `ownedEntry`, fresh state inside the
 * repo's queue, git refusing what git would refuse (no --force), a branch
 * deleted only with no commits of its own. A worktree not in the registry
 * (Claude's, the user's own) is never touched — not locked, not removed, not
 * pruned.
 */

import * as path from 'path';

import { WORKTREE_KEPT_STALE_MS } from './constants.js';
import { exists, sameFolder } from './pathKey.js';
import { isLinkedWorktreeFolder, isRepo, lockedWorktreeOf, lockFolder } from './worktreeGit.js';
import { commitsOfItsOwn, lastTouchedAt } from './worktreeInspect.js';
import {
  heldElsewhere,
  ownedEntry,
  readRegistry,
  refused,
  serialized,
  updateEntry,
  type WorktreeEntry,
} from './worktreeRegistry.js';
import {
  forgetVanishedFolder,
  retireEntry,
  settleBranch,
  type WorktreeOutcome,
} from './worktreeRetire.js';

/** What the startup sweep did to one Worktree. `retired`: an `active` entry
 *  whose agent is gone went through the leave rules (`outcome` says how they
 *  ended). `flagged`: a kept folder untouched for a week needs a decision
 *  again. `reconciled`: its folder vanished, so the leave rules settled the
 *  branch. `branchDeleted`: a parked branch was merged, branch and entry
 *  went. `dropped`: a parked entry whose branch vanished was forgotten.
 *  `locked`: a running Worktree was locked again. */
export type SweepAction =
  'retired' | 'flagged' | 'reconciled' | 'branchDeleted' | 'dropped' | 'locked';

export interface SweepEvent {
  directoryPath: string;
  name: string;
  branch: string;
  action: SweepAction;
  outcome?: WorktreeOutcome;
}

export interface SweepReport {
  events: SweepEvent[];
  /** A repo or entry the sweep skipped because something failed (logged). */
  failures: { directoryPath: string; name?: string; reason: string }[];
  /** Every Directory whose Worktrees changed, to tell the offices. */
  changedDirectories: string[];
}

export interface SweepOptions {
  /** Whether a live agent runs in the Worktree at this path: the caller's
   *  agents, restored and reattached ones included. Such a Worktree is
   *  locked, never retired. */
  inUse: (worktreePath: string) => boolean;
  /** Tests only: the clock. */
  now?: number;
}

/**
 * Startup reconciliation of the registry with the disk, serialized per repo
 * with every other git operation here; repos run side by side, and a failure
 * in one repo or entry is logged and skipped, never thrown:
 *   - running (inUse) → locked against prune and other tools' cleanup
 *   - `active` with no live agent (a crash, a closed window, a retire cut
 *     short by a shutdown) → the leave rules
 *   - `kept` untouched for WORKTREE_KEPT_STALE_MS → `needsDecision`
 *   - `kept` / `needsDecision` whose folder vanished → the leave rules
 *     (git's record of that folder dropped, the branch settled)
 *   - `parked` whose branch vanished → the entry dropped; whose branch is
 *     merged into its base → branch and entry deleted
 * A repo that is gone from disk (an unplugged drive) is skipped whole: its
 * entries are not evidence of anything.
 */
export async function sweep(options: SweepOptions): Promise<SweepReport> {
  const report: SweepReport = { events: [], failures: [], changedDirectories: [] };
  const started = options.now ?? Date.now();
  const roots: string[] = [];
  for (const entry of readRegistry()) {
    const root = path.resolve(entry.directoryPath);
    if (!roots.includes(root)) roots.push(root);
  }
  await Promise.all(
    roots.map((root) =>
      serialized(root, () => sweepRepo(root, options, started, report)).catch((err: unknown) => {
        report.failures.push({ directoryPath: root, reason: String(err) });
        console.error(`[Pixel Agents] Worktrees: sweep of ${root} failed:`, err);
      }),
    ),
  );
  return report;
}

async function sweepRepo(
  root: string,
  options: SweepOptions,
  started: number,
  report: SweepReport,
): Promise<void> {
  if (!isRepo(root)) {
    console.warn(`[Pixel Agents] Worktrees: sweep skipped ${root}: not a git repository now.`);
    return;
  }
  const entries = readRegistry().filter((e) => sameFolder(e.directoryPath, root));
  for (const listed of entries) {
    try {
      const event = await sweepEntry(listed, options, started);
      if (!event) continue;
      report.events.push(event);
      if (event.action !== 'locked' && !report.changedDirectories.includes(root)) {
        report.changedDirectories.push(root);
      }
      console.log(
        `[Pixel Agents] Worktrees: sweep - ${event.branch}: ${event.action}${event.outcome ? ` (${event.outcome})` : ''}`,
      );
    } catch (err) {
      report.failures.push({ directoryPath: root, name: listed.name, reason: String(err) });
      console.error(`[Pixel Agents] Worktrees: sweep of ${listed.branch} failed:`, err);
    }
  }
}

/** One entry, on fresh state, inside its repo's queue. Null = left as it is. */
async function sweepEntry(
  listed: WorktreeEntry,
  options: SweepOptions,
  started: number,
): Promise<SweepEvent | null> {
  const owned = ownedEntry(listed);
  if (!owned.ok) {
    refused(listed.path, owned.reason);
    return null;
  }
  const entry = owned.entry;
  const root = path.resolve(entry.directoryPath);
  const folder = path.resolve(entry.path);
  const event = (action: SweepAction, outcome?: WorktreeOutcome): SweepEvent => ({
    directoryPath: entry.directoryPath,
    name: entry.name,
    branch: entry.branch,
    action,
    ...(outcome ? { outcome } : {}),
  });

  if (options.inUse(entry.path)) {
    if (!isLinkedWorktreeFolder(folder) || (await lockedWorktreeOf(root, folder)) !== false) {
      return null;
    }
    const locked = await lockFolder(root, folder);
    return locked.ok ? event('locked') : null;
  }

  switch (entry.state) {
    case 'active': {
      // Made (or resumed into) after the sweep began: its agent is on its way.
      if ((entry.activatedAt ?? entry.lastUsedAt) > started) return null;
      // Another process's agent is in it: that process retires it when its
      // agent leaves, or a later sweep once that process is gone.
      if (heldElsewhere(entry)) return null;
      const result = await retireEntry(entry);
      return result.ok ? event('retired', result.outcome) : null;
    }
    case 'kept':
    case 'needsDecision': {
      // Only a folder that is truly gone; one there without its `.git` file
      // stays as it is (it may hold the agent's work).
      if (!exists(folder)) {
        const result = await retireEntry(entry);
        return result.ok ? event('reconciled', result.outcome) : null;
      }
      if (entry.state === 'kept' && started - lastTouchedAt(entry) >= WORKTREE_KEPT_STALE_MS) {
        updateEntry(entry, { state: 'needsDecision' });
        return event('flagged');
      }
      return null;
    }
    case 'parked': {
      // A parked Worktree has no folder; one that has a folder again is being
      // brought back (or something else sits there), and is left alone.
      if (exists(folder)) return null;
      const commits = await commitsOfItsOwn(root, entry);
      if (!commits.branchExists) {
        await forgetVanishedFolder(entry);
        updateEntry(entry, null);
        return event('dropped');
      }
      if (commits.uniqueCommits > 0) return null;
      await forgetVanishedFolder(entry);
      const result = await settleBranch(entry);
      return result.ok && result.outcome === 'removed' ? event('branchDeleted') : null;
    }
  }
}
