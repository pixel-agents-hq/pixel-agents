/**
 * The leave rules, applied once a Worktree's last agent has gone (and by the
 * startup sweep to crash leftovers), and the user's own actions on one:
 *   - no uncommitted changes, no commits of its own → folder and branch deleted
 *   - commits of its own → folder deleted, branch kept (parked)
 *   - uncommitted changes, or a folder git can't read → nothing touched; the
 *     user decides (save, keep or discard)
 *
 * Every path here that deletes anything first proves the Worktree is ours
 * (`ownedEntry`: registered, at `<its Directory>/<worktrees folder>/<name>`,
 * and a linked worktree of that repo by git's own list), re-inspects it on
 * fresh state inside the repo's queue, and lets git refuse what git would
 * refuse: a folder is removed without --force unless the user chose Discard
 * (with the file count they were shown), and a branch is deleted only when
 * nothing on it is missing from its base, or the user confirmed how many
 * commits it would lose (`deleteParkedBranch`).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  WORKTREE_FALLBACK_EMAIL,
  WORKTREE_FALLBACK_NAME,
  WORKTREE_REMOVING_PREFIX,
  WORKTREE_SAVE_SUBJECT,
  WORKTREE_SAVED_TRAILER,
} from './constants.js';
import { exists } from './pathKey.js';
import {
  git,
  gitIn,
  gitReason,
  isHalfRemoved,
  isLinkedWorktreeFolder,
  isLinkedWorktreeOf,
  isOwnCheckout,
  lockedWorktreeOf,
  lockFolder,
  makeDirLink,
} from './worktreeGit.js';
import {
  commitsOfItsOwn,
  inspectEntry,
  linksIn,
  uncommittedFileCount,
  unmergedCommits,
} from './worktreeInspect.js';
import {
  heldElsewhere,
  ownedEntry,
  refused,
  serialized,
  updateEntry,
  type WorktreeEntry,
  type WorktreeRef,
} from './worktreeRegistry.js';

/** What the leave rules did: `removed` (folder and branch deleted, entry
 *  dropped), `parked` (folder deleted, branch kept), `needsDecision`
 *  (uncommitted changes, nothing touched), `kept` (the folder stays). */
export type WorktreeOutcome = 'removed' | 'parked' | 'needsDecision' | 'kept';

export type WorktreeActionResult =
  { ok: true; outcome: WorktreeOutcome; entry: WorktreeEntry } | { ok: false; reason: string };

/** The user's answer for a Worktree with uncommitted changes. */
export type WorktreeChoice = 'save' | 'keep' | 'discard';

/** The user's answer, as `decide` takes it. A discard carries the file count
 *  the user was shown and confirmed losing: the only `--force` removal there
 *  is can't be asked for without it, and is refused when more files are
 *  uncommitted now than that. */
export type WorktreeDecision =
  { choice: 'save' } | { choice: 'keep' } | { choice: 'discard'; confirmedFiles: number };

/**
 * Apply the leave rules to a Worktree whose agents have all gone. The caller
 * proves no live agent of ITS OWN runs in it (the module can't see agents);
 * one another live process holds (`heldElsewhere`) is refused here, whoever
 * asks. Serialized per repo with every other git operation of this module.
 */
export function retire(worktree: WorktreeRef): Promise<WorktreeActionResult> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return Promise.resolve(refused(worktree.path, owned.reason));
  return serialized(path.resolve(owned.entry.directoryPath), async () => {
    const fresh = ownedEntry(worktree);
    if (!fresh.ok) return refused(worktree.path, fresh.reason);
    const held = heldElsewhere(fresh.entry);
    if (held) return refused(worktree.path, held);
    return retireEntry(fresh.entry);
  });
}

/**
 * The user's answer for a Worktree that needs a decision (or any of ours no
 * agent runs in): `save` commits every change, untracked files included,
 * with a `Pixel-Agents-Saved: true` trailer, then applies the leave rules
 * (so it parks); `keep` leaves the folder as it is; `discard` force-removes
 * the folder and deletes the branch only when it has no commits of its own
 * (else parks). Decided on the Worktree's state now, not when it was asked.
 */
export function decide(
  worktree: WorktreeRef,
  decision: WorktreeDecision,
): Promise<WorktreeActionResult> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return Promise.resolve(refused(worktree.path, owned.reason));
  return serialized(path.resolve(owned.entry.directoryPath), async () => {
    const fresh = ownedEntry(worktree);
    if (!fresh.ok) return refused(worktree.path, fresh.reason);
    const entry = fresh.entry;
    if (entry.state === 'active') {
      return { ok: false, reason: `An agent is still running in ${entry.branch}.` };
    }
    return applyDecision(entry, decision);
  });
}

/**
 * A Worktree whose agent is leaving with the user's answer already given (the
 * card's × asked before the agent was stopped): the leave rules, with that
 * answer applied when it holds uncommitted changes, all in one turn of the
 * repo's queue, so it never shows as needing a decision in between. A discard
 * that now finds more files than the user agreed to falls back to the plain
 * leave rules (`needsDecision`: the office asks again).
 */
export function retireWith(
  worktree: WorktreeRef,
  decision: WorktreeDecision,
): Promise<WorktreeActionResult> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return Promise.resolve(refused(worktree.path, owned.reason));
  return serialized(path.resolve(owned.entry.directoryPath), async () => {
    const fresh = ownedEntry(worktree);
    if (!fresh.ok) return refused(worktree.path, fresh.reason);
    const held = heldElsewhere(fresh.entry);
    if (held) return refused(worktree.path, held);
    // Nothing uncommitted any more (the agent committed or cleaned up while
    // it shut down): the answer is moot, the plain leave rules apply.
    if ((await uncommittedFileCount(fresh.entry)) === 0) return retireEntry(fresh.entry);
    const decided = await applyDecision(fresh.entry, decision);
    return decided.ok ? decided : retireEntry(fresh.entry);
  });
}

/** `decide`'s answer on fresh state. Runs inside the repo's queue. */
async function applyDecision(
  entry: WorktreeEntry,
  decision: WorktreeDecision,
): Promise<WorktreeActionResult> {
  const state = await inspectEntry(entry);
  if (!state.folderExists) return retireEntry(entry);
  switch (decision.choice) {
    case 'keep':
      return { ok: true, outcome: 'kept', entry: updateEntry(entry, { state: 'kept' }) };
    case 'save': {
      if (state.uncommittedFiles > 0) {
        const saved = await saveChanges(entry);
        if (!saved.ok) return saved;
      }
      return retireEntry(entry);
    }
    case 'discard': {
      const confirmed = decision.confirmedFiles;
      // Checked here, not only on the wire: whoever calls, the force
      // removal needs the number the user was shown.
      if (typeof confirmed !== 'number' || !Number.isInteger(confirmed) || confirmed < 0) {
        return refused(entry.path, 'discarding needs the number of files you confirmed losing.');
      }
      if (state.uncommittedFiles > confirmed) {
        return {
          ok: false,
          reason: `${entry.branch} now has ${state.uncommittedFiles} uncommitted files, more than the ${confirmed} you agreed to discard.`,
        };
      }
      const removed = await removeFolder(entry, { force: true });
      if (!removed.ok) return removed;
      return settleBranch(entry);
    }
    default:
      return refused(entry.path, 'unknown choice.');
  }
}

/** The leave rules on fresh state. Runs inside the repo's queue. */
export async function retireEntry(entry: WorktreeEntry): Promise<WorktreeActionResult> {
  const state = await inspectEntry(entry);
  if (state.folderExists) {
    if (state.uncommittedFiles > 0) {
      return {
        ok: true,
        outcome: 'needsDecision',
        entry: updateEntry(entry, { state: 'needsDecision' }),
      };
    }
    const removed = await removeFolder(entry, { force: false });
    if (!removed.ok) {
      // git refused (a change appeared, a process holds the folder): the
      // folder stays, and so does everything in it.
      return {
        ok: true,
        outcome: 'needsDecision',
        entry: updateEntry(entry, { state: 'needsDecision' }),
      };
    }
  } else {
    // Gone by hand: drop git's record of it (a lock would keep it, and with
    // it the branch checked out there) — of this one only, never a prune.
    await forgetVanishedFolder(entry);
  }
  return settleBranch(entry);
}

/** After the folder is gone: delete a branch with no commits of its own (and
 *  the entry with it), park one that has some. */
export async function settleBranch(entry: WorktreeEntry): Promise<WorktreeActionResult> {
  const root = path.resolve(entry.directoryPath);
  const commits = await commitsOfItsOwn(root, entry);
  if (!commits.branchExists) {
    return { ok: true, outcome: 'removed', entry: updateEntry(entry, null) };
  }
  if (commits.uniqueCommits > 0) {
    return { ok: true, outcome: 'parked', entry: updateEntry(entry, { state: 'parked' }) };
  }
  const deleted = await git(root, ['branch', '-D', entry.branch]);
  if (!deleted.ok) {
    console.warn(`[Pixel Agents] Worktrees: kept branch ${entry.branch}: ${gitReason(deleted)}`);
    return { ok: true, outcome: 'parked', entry: updateEntry(entry, { state: 'parked' }) };
  }
  return { ok: true, outcome: 'removed', entry: updateEntry(entry, null) };
}

/**
 * Remove a Worktree's folder through git: unlocked first (every Worktree is
 * locked at create), the links `create` made taken out (git would see them as
 * untracked files), then `git worktree remove` — WITHOUT --force unless the
 * user chose Discard, so git itself refuses a folder that holds changes.
 * Refuses anything git doesn't list as a linked worktree of this repo.
 */
export async function removeFolder(
  entry: WorktreeEntry,
  { force }: { force: boolean },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const root = path.resolve(entry.directoryPath);
  const folder = path.resolve(entry.path);
  if (!isLinkedWorktreeFolder(folder)) {
    return refused(folder, 'its .git file is missing, so git cannot tell what it holds.');
  }
  if (!(await isLinkedWorktreeOf(root, folder))) {
    // An earlier removal stopped halfway (git's record dropped, the rest left):
    // Discard finishes it.
    if (force && (await isHalfRemoved(root, folder))) return finishRemoval(folder);
    return refused(folder, `git does not list it as a linked worktree of ${root}.`);
  }
  await git(root, ['worktree', 'unlock', folder]);
  const links = await linksIn(root, folder);
  for (const rel of links) {
    try {
      fs.unlinkSync(path.join(folder, rel));
    } catch {
      // Already gone.
    }
  }
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), folder];
  const removed = await git(root, args);
  if (!removed.ok) {
    // git refuses up front (a change appeared) with the folder untouched; it
    // fails halfway (something held part of the folder) only after deleting
    // part of it and then its record. That folder is no checkout any more,
    // and removing it was already settled (clean, or Discard): finish it.
    // git listed it a moment ago, so a record gone now is this call's doing,
    // whether or not its `.git` file was among what got deleted.
    if (!(await isLinkedWorktreeOf(root, folder))) {
      console.warn(
        `[Pixel Agents] Worktrees: git removed only part of ${folder} (${gitReason(removed)}); finishing it.`,
      );
      return finishRemoval(folder);
    }
    // Leave it as it was: linked and locked.
    for (const rel of links) {
      try {
        makeDirLink(path.join(root, rel), path.join(folder, rel));
      } catch {
        // Best effort.
      }
    }
    await lockFolder(root, folder);
    return { ok: false, reason: gitReason(removed) };
  }
  return { ok: true };
}

/**
 * Delete what a half-done `git worktree remove` left. Moved aside first (a
 * rename works on a folder another program holds, which deleting in place
 * does not), so the Worktree's path is free whatever happens next, then
 * deleted; what still can't be deleted stays in the aside folder and is
 * logged. Links inside are removed, never followed.
 */
function finishRemoval(folder: string): { ok: true } | { ok: false; reason: string } {
  if (!exists(folder)) return { ok: true };
  const aside = path.join(
    path.dirname(folder),
    `${WORKTREE_REMOVING_PREFIX}${path.basename(folder)}-${Date.now()}`,
  );
  try {
    fs.renameSync(folder, aside);
  } catch (err) {
    return { ok: false, reason: `couldn't move what's left of it aside: ${String(err)}` };
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[Pixel Agents] Worktrees: left ${aside} behind: ${String(err)}`);
  }
  return { ok: true };
}

/**
 * Commit every uncommitted change in the Worktree, untracked files included
 * (gitignored ones and our links left out), marked with the save trailer.
 * The user's own identity when git has one, else a fallback, so the save
 * never fails for want of a name; hooks and signing are skipped, since this
 * commit is a snapshot, not the agent's work.
 */
async function saveChanges(
  entry: WorktreeEntry,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const root = path.resolve(entry.directoryPath);
  const folder = path.resolve(entry.path);
  if (!(await isOwnCheckout(folder))) {
    return refused(folder, 'git does not read it as its own checkout, so nothing is saved.');
  }
  const links = await linksIn(root, folder);
  const added = await gitIn(folder, [
    'add',
    '-A',
    '--',
    '.',
    ...links.map((rel) => `:(exclude,literal)${rel}`),
  ]);
  if (!added.ok) return { ok: false, reason: gitReason(added) };

  const identity: string[] = [];
  const name = await gitIn(folder, ['config', 'user.name']);
  const email = await gitIn(folder, ['config', 'user.email']);
  if (!name.ok || !name.stdout.trim()) identity.push('-c', `user.name=${WORKTREE_FALLBACK_NAME}`);
  if (!email.ok || !email.stdout.trim()) {
    identity.push('-c', `user.email=${WORKTREE_FALLBACK_EMAIL}`);
  }
  const message = `${WORKTREE_SAVE_SUBJECT}\n\nSaved by Pixel Agents when the agent working in ${entry.branch} left, so its folder could be removed.\n\n${WORKTREE_SAVED_TRAILER}\n`;
  const committed = await gitIn(
    folder,
    [...identity, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-F', '-'],
    { input: message },
  );
  if (!committed.ok) return { ok: false, reason: gitReason(committed) };
  return { ok: true };
}

/**
 * Drop git's record of a Worktree of ours whose folder is gone: unlocked,
 * then `git worktree remove` of that path alone, without --force (git
 * removes a missing folder's record that way). Never `git worktree prune`,
 * which would drop every missing folder's record, Claude's included. A
 * folder still there (even without its `.git` file) is left to git, which
 * refuses to remove it.
 */
export async function forgetVanishedFolder(entry: WorktreeEntry): Promise<void> {
  const root = path.resolve(entry.directoryPath);
  const folder = path.resolve(entry.path);
  if (exists(folder)) return;
  if (!(await isLinkedWorktreeOf(root, folder))) return;
  await git(root, ['worktree', 'unlock', folder]);
  const removed = await git(root, ['worktree', 'remove', folder]);
  if (!removed.ok) {
    console.warn(
      `[Pixel Agents] Worktrees: couldn't drop git's record of ${folder}: ${gitReason(removed)}`,
    );
  }
}

/**
 * Put back the state a Worktree had before a resume that never started its
 * agent (`kept` or `needsDecision`: the folder was there and stays). A
 * rebuilt one goes through the leave rules instead (`retire`).
 */
export function markIdle(
  worktree: WorktreeRef,
  state: 'kept' | 'needsDecision',
): Promise<WorktreeActionResult> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return Promise.resolve(refused(worktree.path, owned.reason));
  return serialized(path.resolve(owned.entry.directoryPath), async () => {
    const fresh = ownedEntry(worktree);
    if (!fresh.ok) return refused(worktree.path, fresh.reason);
    return { ok: true, outcome: 'kept', entry: updateEntry(fresh.entry, { state }) };
  });
}

export interface DeleteBranchOptions {
  /** How many commits the user confirmed losing (the ones merged nowhere
   *  else). Refused when more would be lost now. */
  confirmedCommits?: number;
}

/**
 * Delete a parked Worktree's branch (the Worktrees list's action) and drop its
 * entry. Only for a `parked` entry of ours whose folder is gone. A branch
 * whose commits are in its base or in any other branch, remote or tag loses
 * nothing; one with commits merged nowhere needs `confirmedCommits` of at
 * least that many.
 */
export function deleteParkedBranch(
  worktree: WorktreeRef,
  options: DeleteBranchOptions = {},
): Promise<WorktreeActionResult> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return Promise.resolve(refused(worktree.path, owned.reason));
  return serialized(path.resolve(owned.entry.directoryPath), async () => {
    const fresh = ownedEntry(worktree);
    if (!fresh.ok) return refused(worktree.path, fresh.reason);
    const entry = fresh.entry;
    if (entry.state !== 'parked' || exists(path.resolve(entry.path))) {
      return { ok: false, reason: `${entry.branch} is not parked: its folder is still there.` };
    }
    const root = path.resolve(entry.directoryPath);
    const tip = await git(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${entry.branch}^{commit}`,
    ]);
    if (!tip.ok) return { ok: true, outcome: 'removed', entry: updateEntry(entry, null) };
    const unmerged = await unmergedCommits(root, entry, tip.stdout.trim());
    if (unmerged > (options.confirmedCommits ?? 0)) {
      return {
        ok: false,
        reason: `${entry.branch} has ${unmerged} ${unmerged === 1 ? 'commit' : 'commits'} merged nowhere else; confirm losing ${unmerged === 1 ? 'it' : 'them'} first.`,
      };
    }
    const deleted = await git(root, ['branch', '-D', entry.branch]);
    if (!deleted.ok) return { ok: false, reason: gitReason(deleted) };
    return { ok: true, outcome: 'removed', entry: updateEntry(entry, null) };
  });
}

/**
 * Lock a Worktree of ours against `git worktree prune` and other tools'
 * cleanup (a running Worktree). Already locked is fine. Refused for anything
 * not ours.
 */
export function lock(worktree: WorktreeRef): Promise<{ ok: true } | { ok: false; reason: string }> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return Promise.resolve(refused(worktree.path, owned.reason));
  return serialized(path.resolve(owned.entry.directoryPath), async () => {
    const fresh = ownedEntry(worktree);
    if (!fresh.ok) return refused(worktree.path, fresh.reason);
    const root = path.resolve(fresh.entry.directoryPath);
    const folder = path.resolve(fresh.entry.path);
    const locked = await lockedWorktreeOf(root, folder);
    if (locked === null) return { ok: false, reason: `git does not list ${folder}.` };
    if (locked) return { ok: true };
    const done = await lockFolder(root, folder);
    return done.ok ? { ok: true } : { ok: false, reason: gitReason(done) };
  });
}
