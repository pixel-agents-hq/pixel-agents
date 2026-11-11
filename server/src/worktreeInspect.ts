/**
 * What a Worktree holds, read-only: uncommitted files (not gitignored ones,
 * not the folders `create` linked in), commits of its own measured against
 * its recorded base by patch-equivalence, its size, and when it was last
 * touched. The leave rules (worktreeRetire.ts) and the sweep decide on these
 * readings, always taken fresh inside the repo's queue.
 */

import * as fs from 'fs';
import * as path from 'path';

import { WORKTREE_SQUASH_SCAN_COMMITS } from './constants.js';
import { sameFolder } from './pathKey.js';
import { folderState, git, gitDirOf, gitIn } from './worktreeGit.js';
import {
  ownedEntry,
  readRegistry,
  serialized,
  type WorktreeEntry,
  type WorktreeRef,
} from './worktreeRegistry.js';

/** What a Worktree holds right now. */
export interface WorktreeInspection {
  folderExists: boolean;
  branchExists: boolean;
  /** Changed, added, deleted and untracked files (not gitignored ones, and not
   *  the folders `create` linked in). 0 when the folder is gone. */
  uncommittedFiles: number;
  /** Commits on the branch whose changes are not in the base: measured
   *  against the recorded base (`base.ref`'s tip now, else `base.commit`) with
   *  patch-equivalence, so work that was merged, rebased or squash-merged
   *  there counts as no commits of its own. */
  uniqueCommits: number;
  /** Whether everything on the branch is in the base (true for a branch with
   *  no commits, or no branch at all). */
  merged: boolean;
  /** Bytes the folder takes on disk (symlinks not followed). 0 when gone. */
  sizeBytes: number;
}

/** A Directory's Worktree with what it holds, for the office's list. */
export interface WorktreeListing {
  entry: WorktreeEntry;
  inspection: WorktreeInspection;
}

/**
 * What a Worktree holds: uncommitted files, commits of its own and whether
 * they are merged, its size. Read-only. Null when it isn't a Worktree we
 * made (not in the registry, or not where ours live).
 */
export async function inspect(worktree: WorktreeRef): Promise<WorktreeInspection | null> {
  const owned = ownedEntry(worktree);
  if (!owned.ok) return null;
  return inspectEntry(owned.entry);
}

/** A Directory's Worktrees (the ones we made), each with what it holds. */
export function list(directoryPath: string): Promise<WorktreeListing[]> {
  const root = path.resolve(directoryPath);
  return serialized(root, async () => {
    const entries = readRegistry().filter((e) => sameFolder(e.directoryPath, root));
    const out: WorktreeListing[] = [];
    for (const entry of entries) {
      const owned = ownedEntry(entry);
      if (!owned.ok) continue;
      out.push({ entry: owned.entry, inspection: await inspectEntry(owned.entry) });
    }
    return out;
  });
}

export async function inspectEntry(entry: WorktreeEntry): Promise<WorktreeInspection> {
  const root = path.resolve(entry.directoryPath);
  const folder = path.resolve(entry.path);
  const commits = await commitsOfItsOwn(root, entry);
  switch (folderState(folder)) {
    case 'absent':
      return { folderExists: false, ...commits, uncommittedFiles: 0, sizeBytes: 0 };
    case 'unreadable':
      // There, but not a linked worktree git can read (its `.git` file is
      // gone): it may hold the agent's work, so it counts as changed — never
      // removed, never its branch settled, on a guess.
      return {
        folderExists: true,
        ...commits,
        uncommittedFiles: Number.MAX_SAFE_INTEGER,
        sizeBytes: await folderSize(folder),
      };
    case 'readable': {
      const changes = await uncommittedPaths(root, folder);
      return {
        folderExists: true,
        ...commits,
        // A folder git can't read counts as changed: never removed on a guess.
        uncommittedFiles: changes === null ? Number.MAX_SAFE_INTEGER : changes.length,
        sizeBytes: await folderSize(folder),
      };
    }
  }
}

/**
 * How many files a Worktree holds uncommitted, without the rest of
 * `inspectEntry` (commits, size): what the card's × asks about before it
 * stops an agent. 0 when the folder is gone; a folder git can't read counts
 * as changed, as everywhere.
 */
export async function uncommittedFileCount(entry: WorktreeEntry): Promise<number> {
  const folder = path.resolve(entry.path);
  switch (folderState(folder)) {
    case 'absent':
      return 0;
    case 'unreadable':
      return Number.MAX_SAFE_INTEGER;
    case 'readable': {
      const changes = await uncommittedPaths(path.resolve(entry.directoryPath), folder);
      return changes === null ? Number.MAX_SAFE_INTEGER : changes.length;
    }
  }
}

/**
 * The uncommitted paths in a Worktree (tracked changes and untracked files,
 * never gitignored ones), leaving out the folder links `create` made — a
 * symlink git sees as an untracked file, but it's ours, not the agent's work.
 * Null when git can't read the folder.
 */
async function uncommittedPaths(root: string, folder: string): Promise<string[] | null> {
  const status = await gitIn(folder, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (!status.ok) return null;
  const fields = status.stdout.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    paths.push(record.slice(3));
    // A rename or copy carries its origin as the next field.
    if (xy.includes('R') || xy.includes('C')) i++;
  }
  const links = new Set(ourLinks(root, folder, paths));
  return paths.filter((p) => !links.has(p));
}

/** Of `candidates` (paths relative to the Worktree), the ones that are links
 *  to the same path in the main checkout: the folders `create` linked in. */
function ourLinks(root: string, folder: string, candidates: string[]): string[] {
  const out: string[] = [];
  for (const rel of candidates) {
    const clean = rel.replace(/\/+$/, '');
    const link = path.join(folder, clean);
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      if (fs.realpathSync(link) !== fs.realpathSync(path.join(root, clean))) continue;
      out.push(rel);
    } catch {
      // A dangling link, or no such folder in the main checkout: not ours.
    }
  }
  return out;
}

/** The untracked links `create` made in the Worktree (relative paths). */
export async function linksIn(root: string, folder: string): Promise<string[]> {
  const untracked = await gitIn(folder, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (!untracked.ok) return [];
  return ourLinks(
    root,
    folder,
    untracked.stdout.split('\0').filter((p) => p.length > 0),
  );
}

/** Bytes under `folder`, not following symlinks. */
export async function folderSize(folder: string): Promise<number> {
  let total = 0;
  const pending = [folder];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        const stat = await fs.promises.lstat(p);
        total += stat.size;
        if (stat.isDirectory()) pending.push(p);
      } catch {
        // Gone mid-walk.
      }
    }
  }
  return total;
}

/**
 * The branch's commits that are not in its base, by patch-equivalence: the
 * base is the branch the Worktree started from as it is now (`base.ref`),
 * else the recorded commit. A branch tip already in the base (a merge or a
 * fast-forward), every commit's patch already there (`git cherry`: a rebase
 * or cherry-pick merge), or the whole branch's diff landing as one commit
 * there (a squash merge) all count as merged: no commits of its own.
 */
export async function commitsOfItsOwn(
  root: string,
  entry: WorktreeEntry,
): Promise<{ branchExists: boolean; uniqueCommits: number; merged: boolean }> {
  const tip = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${entry.branch}^{commit}`,
  ]);
  if (!tip.ok) return { branchExists: false, uniqueCommits: 0, merged: true };
  const tipCommit = tip.stdout.trim();
  const base = entry.base.commit;

  let target = base;
  if (entry.base.ref) {
    const ref = await git(root, ['rev-parse', '--verify', '--quiet', `${entry.base.ref}^{commit}`]);
    if (ref.ok && ref.stdout.trim()) target = ref.stdout.trim();
  }

  const count = await git(root, ['rev-list', '--count', `${base}..${tipCommit}`]);
  // Unreadable history: assume the branch holds work (never deleted on a guess).
  if (!count.ok) return { branchExists: true, uniqueCommits: 1, merged: false };
  if (Number(count.stdout.trim()) === 0) {
    return { branchExists: true, uniqueCommits: 0, merged: true };
  }
  if ((await git(root, ['merge-base', '--is-ancestor', tipCommit, target])).ok) {
    return { branchExists: true, uniqueCommits: 0, merged: true };
  }

  const cherry = await git(root, ['cherry', target, tipCommit, base]);
  if (!cherry.ok) return { branchExists: true, uniqueCommits: 1, merged: false };
  const unique = cherry.stdout.split('\n').filter((line) => line.startsWith('+')).length;
  if (unique === 0) return { branchExists: true, uniqueCommits: 0, merged: true };

  if (target !== base && (await squashMergedInto(root, base, tipCommit, target))) {
    return { branchExists: true, uniqueCommits: 0, merged: true };
  }
  return { branchExists: true, uniqueCommits: unique, merged: false };
}

/** Whether the whole of `base..tip` landed in `base..target` as one commit
 *  with the same patch (a squash merge). */
async function squashMergedInto(
  root: string,
  base: string,
  tip: string,
  target: string,
): Promise<boolean> {
  const diff = await git(root, ['diff', '--no-color', '--no-ext-diff', base, tip]);
  if (!diff.ok || diff.stdout.trim() === '') return false;
  const branchId = await git(root, ['patch-id', '--stable'], { input: diff.stdout });
  const wanted = branchId.stdout.trim().split(/\s+/)[0];
  if (!branchId.ok || !wanted) return false;
  const log = await git(root, [
    'log',
    '-p',
    '--no-color',
    '--no-ext-diff',
    '--no-merges',
    `-n${WORKTREE_SQUASH_SCAN_COMMITS}`,
    `${base}..${target}`,
  ]);
  if (!log.ok || log.stdout.trim() === '') return false;
  const ids = await git(root, ['patch-id', '--stable'], { input: log.stdout });
  if (!ids.ok) return false;
  return ids.stdout.split('\n').some((line) => line.split(/\s+/)[0] === wanted);
}

/** The branch's commits that deleting it would lose: its own commits (by
 *  patch-equivalence against its base), none when another branch, remote or
 *  tag holds its tip. */
export async function unmergedCommits(
  root: string,
  entry: WorktreeEntry,
  tip: string,
): Promise<number> {
  const commits = await commitsOfItsOwn(root, entry);
  if (commits.merged || commits.uniqueCommits === 0) return 0;
  const holders = await git(root, [
    'for-each-ref',
    '--format=%(refname)',
    `--contains=${tip}`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  if (!holders.ok) return commits.uniqueCommits;
  const elsewhere = holders.stdout
    .split('\n')
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0 && ref !== `refs/heads/${entry.branch}`);
  return elsewhere.length > 0 ? 0 : commits.uniqueCommits;
}

/** When a kept Worktree was last touched: its registry stamp, or later
 *  git activity in it (an index refresh, a commit, a checkout) or a change
 *  to its top folder, whichever is newest. */
export function lastTouchedAt(entry: WorktreeEntry): number {
  let newest = entry.lastUsedAt;
  const folder = path.resolve(entry.path);
  const gitDir = gitDirOf(folder);
  const candidates = [folder];
  if (gitDir)
    candidates.push(
      path.join(gitDir, 'index'),
      path.join(gitDir, 'HEAD'),
      path.join(gitDir, 'logs', 'HEAD'),
    );
  for (const p of candidates) {
    try {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    } catch {
      // Not there: nothing to learn from it.
    }
  }
  return newest;
}
