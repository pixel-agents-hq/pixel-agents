/**
 * Bringing a Worktree back for a resumed conversation. The same guards hold
 * here as for leaving: ownership proven through `ownedEntry` and re-checked
 * inside the repo's queue right before acting. `restore` rebuilds only at the
 * registered path from the registered branch, refuses when anything already
 * sits there, and undoes only a tip that is a save commit (the trailer) — as
 * a mixed reset, so the saved changes come back uncommitted and nothing is
 * lost.
 */

import * as fs from 'fs';
import * as path from 'path';

import { WORKTREE_SAVED_TRAILER } from './constants.js';
import { exists } from './pathKey.js';
import { excludeWorktreesFolder, fitOut } from './worktreeCreate.js';
import {
  git,
  gitIn,
  gitReason,
  isLinkedWorktreeFolder,
  isLinkedWorktreeOf,
  isOwnCheckout,
} from './worktreeGit.js';
import {
  ownedEntry,
  refused,
  serialized,
  thisProcess,
  updateEntry,
  type WorktreeEntry,
  type WorktreeRef,
  type WorktreeState,
} from './worktreeRegistry.js';
import { forgetVanishedFolder, removeFolder } from './worktreeRetire.js';

export interface RestoreOptions {
  /** Folders linked into the rebuilt Worktree instead of copied, as for `create`. */
  symlinkDirectories?: readonly string[];
  /** The session about to run in it, recorded with the entry. */
  sessionId?: string;
}

export type RestoreResult =
  | {
      ok: true;
      /** Whether its folder was rebuilt (false: it was there, resumed in place). */
      rebuilt: boolean;
      /** Whether a save commit was undone, its changes back as uncommitted. */
      unsaved: boolean;
      /** The entry as it now stands (`active`). */
      entry: WorktreeEntry;
      /** Its state before, for putting a failed resume back. */
      priorState: WorktreeState;
    }
  | { ok: false; reason: string };

/**
 * Bring a Worktree of ours back for a resumed conversation, and mark it
 * `active` (an agent is about to run in it). A folder still there (kept, or
 * waiting on a decision) is resumed in place, untouched. A removed one is
 * rebuilt at its registered path from its registered branch — locked, its
 * symlink folders linked and its `.worktreeinclude` files copied, as `create`
 * does — and when the branch's tip is a save commit (`Pixel-Agents-Saved:
 * true`), that commit is undone with a mixed reset so its changes come back
 * uncommitted. Refused when the branch is gone, or anything else sits at the
 * path.
 */
export function restore(
  worktree: WorktreeRef,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return Promise.resolve(refused(worktree.path, owned.reason));
  return serialized(path.resolve(owned.entry.directoryPath), async () => {
    const fresh = ownedEntry(worktree);
    if (!fresh.ok) return refused(worktree.path, fresh.reason);
    return restoreEntry(fresh.entry, options);
  });
}

async function restoreEntry(entry: WorktreeEntry, options: RestoreOptions): Promise<RestoreResult> {
  const root = path.resolve(entry.directoryPath);
  const folder = path.resolve(entry.path);
  const priorState = entry.state;
  const inUse = () =>
    updateEntry(entry, {
      state: 'active',
      activatedAt: Date.now(),
      holder: thisProcess(),
      sessionIds:
        options.sessionId && !entry.sessionIds.includes(options.sessionId)
          ? [...entry.sessionIds, options.sessionId]
          : entry.sessionIds,
    });

  if (isLinkedWorktreeFolder(folder)) {
    if (!(await isLinkedWorktreeOf(root, folder))) {
      return refused(folder, `git does not list it as a linked worktree of ${root}.`);
    }
    return { ok: true, rebuilt: false, unsaved: false, entry: inUse(), priorState };
  }
  if (exists(folder)) {
    return refused(folder, `something that is not this Worktree sits at ${folder}.`);
  }
  const tip = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${entry.branch}^{commit}`,
  ]);
  if (!tip.ok) {
    return {
      ok: false,
      reason: `The branch ${entry.branch} was deleted, so its Worktree can't be rebuilt.`,
    };
  }

  // A folder deleted by hand leaves git's record of it behind (locked, it
  // keeps the branch checked out there). Drop only that record: a repo-wide
  // prune would also drop records of other tools' worktrees.
  await forgetVanishedFolder(entry);
  const excluded = await excludeWorktreesFolder(root);
  if (!excluded.ok) return excluded;
  fs.mkdirSync(path.dirname(folder), { recursive: true });
  const added = await git(root, ['worktree', 'add', folder, entry.branch]);
  if (!added.ok) return { ok: false, reason: gitReason(added) };

  try {
    await fitOut(root, folder, options.symlinkDirectories ?? []);
  } catch (err) {
    // A fresh checkout of the branch, nothing in it yet: git removes it
    // without --force, or refuses and it stays (the branch has it all).
    await removeFolder(entry, { force: false });
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const unsaved = await undoSaveCommit(folder);
  return { ok: true, rebuilt: true, unsaved, entry: inUse(), priorState };
}

/**
 * When the checkout's tip is a save commit (its message carries the save
 * trailer, it has exactly one parent), undo it with a mixed reset: the branch
 * moves back to the parent and the saved files stay in the folder as
 * uncommitted changes (untracked ones untracked again). Anything else is left
 * alone. Returns whether it undid one.
 */
async function undoSaveCommit(folder: string): Promise<boolean> {
  const message = await gitIn(folder, ['log', '-1', '--format=%B', 'HEAD']);
  if (!message.ok) return false;
  const isSave = message.stdout.split('\n').some((line) => line.trim() === WORKTREE_SAVED_TRAILER);
  if (!isSave) return false;
  const parents = await gitIn(folder, ['rev-list', '--parents', '-n', '1', 'HEAD']);
  const ids = parents.ok ? parents.stdout.trim().split(/\s+/) : [];
  if (ids.length !== 2) return false;
  if (!(await isOwnCheckout(folder))) return false;
  const reset = await gitIn(folder, ['reset', '--quiet', '--mixed', ids[1]]);
  if (!reset.ok) {
    console.warn(
      `[Pixel Agents] Worktrees: couldn't undo the save commit in ${folder}: ${gitReason(reset)}`,
    );
    return false;
  }
  return true;
}
