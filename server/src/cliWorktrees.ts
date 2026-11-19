/**
 * The CLI's own worktrees (Claude Code: `claude -w`, EnterWorktree): linked
 * worktrees under a Directory's worktrees folder (Claude Code:
 * `.claude/worktrees/`) that are not in our registry. Listed for the office
 * and read without writing (no index refresh, no lock). The one action taken
 * on one is the user's Remove from the Worktrees list, once no CLI session is
 * in it (`removeCliWorktree`): Claude Code only offers to clean one up when
 * its session ends from inside, so one whose agent was stopped from outside
 * would otherwise stay for good.
 *
 * Nothing here reads a CLI's own formats: the lock's reason is the
 * provider's to read (its `WorktreeConvention.lockHolder`), and the CLI is
 * named in a refusal by the provider's `displayName`, the provider being the
 * one whose convention the office follows (`worktreesCli`). Where none
 * declares one, the CLI has no worktrees of its own: none are listed.
 */

import * as path from 'path';

import { realPath, sameFolder } from './pathKey.js';
import {
  git,
  gitIn,
  gitReason,
  isLinkedWorktreeFolder,
  isRepo,
  type LinkedWorktree,
  listLinkedWorktrees,
} from './worktreeGit.js';
import { folderSize } from './worktreeInspect.js';
import {
  isWorktreeName,
  worktreeDirectoryOf,
  worktreePathIn,
  worktreesCli,
} from './worktreeLocation.js';
import { readRegistry, serialized } from './worktreeRegistry.js';

/** A worktree the CLI made itself under a Directory's worktrees folder
 *  (Claude Code: `claude -w`, EnterWorktree, under `.claude/worktrees/`):
 *  not in our registry, so never ours. */
export interface CliWorktree {
  name: string;
  path: string;
  /** Its branch, or its short commit when detached. */
  branch: string;
  /** Its commit. */
  head: string;
}

/** What one of the CLI's own worktrees holds, read without writing. */
export interface CliWorktreeHoldings {
  uncommittedFiles: number;
  /** Commits on it that the main checkout's current commit lacks. */
  uniqueCommits: number;
  sizeBytes: number;
}

/**
 * Where the CLI's own worktrees of a Directory are: the linked worktrees
 * git lists whose folder is `<directoryPath>/<worktrees folder>/<name>` and
 * that are not in our registry; none when no provider declares a worktrees
 * convention. Cheap (one `git worktree list`); what each
 * holds is `cliWorktreeHoldings`.
 */
export function listCliWorktrees(directoryPath: string): Promise<CliWorktree[]> {
  const root = path.resolve(directoryPath);
  return serialized(root, async () => (await cliWorktreesIn(root)).map(({ worktree }) => worktree));
}

/** The CLI's own worktrees of the repo at `root`, with git's own line on
 *  each (its lock). Unserialized: callers hold the repo's queue. */
async function cliWorktreesIn(
  root: string,
): Promise<Array<{ worktree: CliWorktree; linked: LinkedWorktree }>> {
  if (!worktreesCli() || !isRepo(root)) return [];
  const listed = await listLinkedWorktrees(root);
  if (!listed) return [];
  const registry = readRegistry();
  const out: Array<{ worktree: CliWorktree; linked: LinkedWorktree }> = [];
  for (const linked of listed) {
    const { path: folder, head, branch } = linked;
    if (!isLinkedWorktreeFolder(folder)) continue;
    // Under this Directory's worktrees folder, wherever its symlinks lead.
    const at = worktreeDirectoryOf(realPath(folder));
    if (!at || !sameFolder(at.directoryPath, root)) continue;
    if (registry.some((e) => sameFolder(e.path, folder))) continue;
    out.push({
      worktree: { name: at.name, path: folder, branch: branch ?? head.slice(0, 7), head },
      linked,
    });
  }
  return out;
}

/** What one of the CLI's own worktrees holds: uncommitted files, commits the
 *  main checkout lacks, size. Read with --no-optional-locks: nothing of
 *  theirs is ever written, not even the index. */
export function cliWorktreeHoldings(
  directoryPath: string,
  worktree: CliWorktree,
): Promise<CliWorktreeHoldings> {
  const root = path.resolve(directoryPath);
  return serialized(root, async () => ({
    uncommittedFiles: await uncommittedIn(worktree.path),
    uniqueCommits: await commitsMissingFromHead(root, worktree.head),
    sizeBytes: await folderSize(worktree.path),
  }));
}

/** Uncommitted files in a worktree, untracked ones included, read without
 *  writing its index. Unreadable reads as none: a remove then leaves it to
 *  git, which refuses a folder that holds changes. */
async function uncommittedIn(folder: string): Promise<number> {
  const status = await gitIn(folder, [
    '--no-optional-locks',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (!status.ok) return 0;
  let files = 0;
  const fields = status.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].length < 4) continue;
    files++;
    if (/[RC]/.test(fields[i].slice(0, 2))) i++;
  }
  return files;
}

/** Commits at `head` the main checkout's current commit lacks. */
async function commitsMissingFromHead(root: string, head: string): Promise<number> {
  if (!head) return 0;
  const count = await git(root, ['rev-list', '--count', `HEAD..${head}`]);
  return count.ok ? Number(count.stdout.trim()) || 0 : 0;
}

/** Commits on `branch` that deleting it loses: in no other branch, remote
 *  branch or tag, nor the main checkout's commit. */
async function commitsOnlyOn(root: string, branch: string, head: string): Promise<number> {
  const count = await git(root, [
    'rev-list',
    '--count',
    head,
    '--not',
    `--exclude=${branch}`,
    '--branches',
    '--remotes',
    '--tags',
    'HEAD',
  ]);
  // Unreadable: count every commit the main checkout lacks, so the user's
  // confirmation has to have covered them.
  return count.ok ? Number(count.stdout.trim()) || 0 : commitsMissingFromHead(root, head);
}

/** The CLI session a worktree's lock names, if that process is still alive.
 *  Which process a lock names is the provider's reading of its own reason. */
function liveCliSession(lockReason: string | undefined): number | null {
  const pid = lockReason ? (worktreesCli()?.worktrees?.lockHolder?.(lockReason) ?? null) : null;
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM: alive, just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

export interface RemoveCliWorktreeOptions {
  /** How many uncommitted files the user confirmed losing. */
  confirmedFiles?: number;
  /** How many commits the user confirmed losing. */
  confirmedCommits?: number;
  /** Whether an agent in the office runs in this folder. */
  inUse: (folder: string) => boolean;
}

/**
 * Remove one of the CLI's worktrees, as its own exit prompt would: the
 * folder (`git worktree remove`, --force only over files the user confirmed
 * losing) and then its branch. Refused while an office agent or a live CLI
 * session (the process its lock names) is in it, and when it would lose more
 * uncommitted files or commits than the user confirmed. A branch git won't
 * delete is left, and said so in the log: the folder is what was asked for.
 */
export function removeCliWorktree(
  directoryPath: string,
  name: string,
  options: RemoveCliWorktreeOptions,
): Promise<{ ok: true; branchKept: boolean } | { ok: false; reason: string }> {
  const root = path.resolve(directoryPath);
  const cli = cliName();
  return serialized(root, async () => {
    const found = (await cliWorktreesIn(root)).find((w) => w.worktree.name === name);
    if (!found) return { ok: false, reason: `There is no ${cli} worktree ${name} here.` };
    const { worktree, linked } = found;
    if (options.inUse(worktree.path)) {
      return { ok: false, reason: `An agent is still running in ${worktree.branch}.` };
    }
    const pid = liveCliSession(linked.lockReason);
    if (pid !== null) {
      return {
        ok: false,
        reason: `A ${cli} session (pid ${pid}) is still running in ${worktree.branch}.`,
      };
    }
    const files = await uncommittedIn(worktree.path);
    if (files > (options.confirmedFiles ?? 0)) {
      return {
        ok: false,
        reason: `${worktree.branch} holds ${files} uncommitted ${files === 1 ? 'file' : 'files'}; confirm losing ${files === 1 ? 'it' : 'them'} first.`,
      };
    }
    const lost = linked.branch ? await commitsOnlyOn(root, linked.branch, worktree.head) : 0;
    if (lost > (options.confirmedCommits ?? 0)) {
      return {
        ok: false,
        reason: `${worktree.branch} has ${lost} ${lost === 1 ? 'commit' : 'commits'} merged nowhere else; confirm losing ${lost === 1 ? 'it' : 'them'} first.`,
      };
    }

    if (linked.locked) await git(root, ['worktree', 'unlock', worktree.path]);
    const removed = await git(root, [
      'worktree',
      'remove',
      ...(files > 0 ? ['--force'] : []),
      worktree.path,
    ]);
    if (!removed.ok) {
      // Leave it as it was, the CLI's lock included.
      if (linked.locked) {
        await git(root, [
          'worktree',
          'lock',
          ...(linked.lockReason ? ['--reason', linked.lockReason] : []),
          worktree.path,
        ]);
      }
      return { ok: false, reason: gitReason(removed) };
    }
    if (!linked.branch) return { ok: true, branchKept: false };
    const deleted = await git(root, ['branch', '-D', linked.branch]);
    if (!deleted.ok) {
      console.warn(
        `[Pixel Agents] Worktrees: kept ${cli}'s branch ${linked.branch}: ${gitReason(deleted)}`,
      );
    }
    return { ok: true, branchKept: !deleted.ok };
  });
}

/** Whether `name` names a worktree the CLI made itself in the Directory: a
 *  linked worktree's folder at `<directoryPath>/<worktrees folder>/<name>`
 *  that is not in our registry (never, when no provider declares a worktrees
 *  convention). A filesystem check: what the office's actions on it are
 *  refused by. */
export function isCliWorktree(directoryPath: string, name: string): boolean {
  if (!worktreesCli() || !isWorktreeName(name)) return false;
  const folder = worktreePathIn(directoryPath, name);
  return isLinkedWorktreeFolder(folder) && !readRegistry().some((e) => sameFolder(e.path, folder));
}

/** The CLI whose own worktrees these are, by name (its provider's
 *  `displayName`), for the refusals and the Worktrees list; `CLI` where no
 *  provider declares a worktrees convention. */
export function cliName(): string {
  return worktreesCli()?.displayName ?? 'CLI';
}
