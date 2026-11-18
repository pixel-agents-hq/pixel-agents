/**
 * Creating a Worktree for a launch. We create worktrees ourselves rather than
 * through `claude --worktree` (owning their cleanup is the point), but keep
 * the CLI's conventions so an agent feels the same either way: the folder
 * is `<repo root>/<worktrees folder>/<name>` (Claude Code:
 * `.claude/worktrees/<name>`; worktreeLocation.ts), the repo's
 * `.worktreeinclude` lists the gitignored files to copy in, and the provider's symlink setting
 * (`worktree.symlinkDirectories` for Claude) lists folders to link rather
 * than copy. This module knows no provider: the caller hands it those folders.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { WorktreeBranch } from '../../core/src/messages.js';
import {
  WORKTREE_FETCH_TIMEOUT_MS,
  WORKTREE_INCLUDE_FILE,
  WORKTREE_NAME_ATTEMPTS,
} from './constants.js';
import { exists, sameFolder } from './pathKey.js';
import {
  branchPrefixProblem,
  git,
  gitReason,
  isRepo,
  lockFolder,
  makeDirLink,
} from './worktreeGit.js';
import { worktreePathIn, worktreesExcludeLine, worktreesFolder } from './worktreeLocation.js';
import { randomWorktreeName, worktreeNameProblem } from './worktreeNames.js';
import {
  readRegistry,
  serialized,
  thisProcess,
  type Worktree,
  type WorktreeBaseChoice,
  type WorktreeBaseRecord,
  writeRegistry,
} from './worktreeRegistry.js';

export interface CreateWorktreeOptions {
  base?: WorktreeBaseChoice;
  /** The branch to start from, chosen by the user; overrides `base`. */
  from?: WorktreeBranch;
  /** The name the user gave it; absent = a generated one. Refused when taken
   *  (as a folder, or with the prefix as a branch) or invalid. */
  name?: string;
  /** Put before the generated name to make the branch (`feature/` → `feature/brave-otter`). */
  prefix?: string;
  /** Folders (relative to the repo root) linked into the Worktree instead of
   *  copied — the provider's setting, read by the caller. */
  symlinkDirectories?: readonly string[];
  /** The session about to run in it, recorded with the entry. */
  sessionId?: string;
  /** Tests only: the name generator. */
  pickName?: () => string;
  /** Tests only: how long base `fresh` waits on the fetch. */
  fetchTimeoutMs?: number;
}

export type CreateWorktreeResult = { ok: true; worktree: Worktree } | { ok: false; reason: string };

/**
 * Create a Worktree for a launch into `directory`: a generated name (its
 * branch = prefix + name, retried while either is taken), a new branch and
 * folder at `<repo root>/<worktrees folder>/<name>` from the chosen base, the
 * `.worktreeinclude` files copied in (gitignored ones only, never overwriting,
 * skipping symlinks), the symlink folders linked, the worktrees folder hidden
 * in the repo's local exclude file (once), the Worktree locked while its agent
 * runs, and the entry recorded in the registry.
 *
 * Fails with a user-facing reason (not a repo, no commits yet, no free name,
 * a bad prefix, git's own error) and leaves nothing behind: whatever was made
 * before the failure is removed.
 */
export function create(
  directory: { path: string },
  options: CreateWorktreeOptions = {},
): Promise<CreateWorktreeResult> {
  const root = path.resolve(directory.path);
  return serialized(root, () => createNow(root, options));
}

async function createNow(
  root: string,
  options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  if (!isRepo(root)) {
    return { ok: false, reason: `${root} is not a git repository.` };
  }
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { ok: false, reason: gitReason(top) };
  if (!sameFolder(top.stdout.trim(), root)) {
    return { ok: false, reason: `${root} is inside a git repository, not its root.` };
  }
  if (!(await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).ok) {
    return { ok: false, reason: `${root} has no commits yet.` };
  }

  const prefix = options.prefix ?? '';
  const prefixProblem = branchPrefixProblem(prefix);
  if (prefixProblem) return { ok: false, reason: prefixProblem };

  let name: string;
  if (options.name !== undefined) {
    const problem = worktreeNameProblem(options.name);
    if (problem) return { ok: false, reason: problem };
    const taken = await nameTaken(root, prefix, options.name);
    if (taken) return { ok: false, reason: taken };
    name = options.name;
  } else {
    const generated = await freeGeneratedName(root, prefix, options.pickName);
    if (generated === null) {
      return {
        ok: false,
        reason: `No free worktree name after ${WORKTREE_NAME_ATTEMPTS} tries: every one was taken by a folder or a branch.`,
      };
    }
    name = generated;
  }

  const base = options.from
    ? await chosenBase(root, options.from, options.fetchTimeoutMs)
    : await resolveBase(root, options.base ?? 'head', options.fetchTimeoutMs);
  if (!base) return { ok: false, reason: `Couldn't read ${root}'s current commit.` };
  if ('reason' in base) return { ok: false, reason: base.reason };

  const branch = `${prefix}${name}`;
  const worktreePath = worktreePathIn(root, name);

  const excluded = await excludeWorktreesFolder(root);
  if (!excluded.ok) return excluded;

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const added = await git(root, ['worktree', 'add', '-b', branch, worktreePath, base.commit]);
  if (!added.ok) {
    // `worktree add` cleans up after itself, except a branch it already made.
    await git(root, ['branch', '-D', branch]);
    return { ok: false, reason: gitReason(added) };
  }

  try {
    await fitOut(root, worktreePath, options.symlinkDirectories ?? []);

    const now = Date.now();
    const entries = readRegistry().filter((e) => !sameFolder(e.path, worktreePath));
    entries.push({
      directoryPath: root,
      name,
      path: worktreePath,
      branch,
      base,
      createdAt: now,
      lastUsedAt: now,
      activatedAt: now,
      state: 'active',
      sessionIds: options.sessionId ? [options.sessionId] : [],
      holder: thisProcess(),
    });
    writeRegistry(entries);
  } catch (err) {
    await git(root, ['worktree', 'unlock', worktreePath]);
    await git(root, ['worktree', 'remove', '--force', worktreePath]);
    await git(root, ['branch', '-D', branch]);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, worktree: { name, path: worktreePath, branch, base } };
}

/** Why `name` is taken in `root`'s repo (its folder exists, or the branch
 *  `prefix + name` does), or null when it is free. */
async function nameTaken(root: string, prefix: string, name: string): Promise<string | null> {
  if (fs.existsSync(worktreePathIn(root, name))) {
    return `A worktree folder named "${name}" already exists.`;
  }
  if ((await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${prefix}${name}`])).ok) {
    return `A branch named "${prefix}${name}" already exists.`;
  }
  return null;
}

/** A generated name free as a folder and as a branch (retried while taken),
 *  or null after WORKTREE_NAME_ATTEMPTS tries. */
export async function freeGeneratedName(
  root: string,
  prefix: string,
  pickName: () => string = () => randomWorktreeName(),
): Promise<string | null> {
  for (let attempt = 0; attempt < WORKTREE_NAME_ATTEMPTS; attempt++) {
    const candidate = pickName();
    if ((await nameTaken(root, prefix, candidate)) === null) return candidate;
  }
  return null;
}

/** The branch the user chose to start from. An origin branch is fetched
 *  first (a failed or slow fetch falls back to what was last fetched). */
async function chosenBase(
  root: string,
  from: WorktreeBranch,
  fetchTimeoutMs = WORKTREE_FETCH_TIMEOUT_MS,
): Promise<WorktreeBaseRecord | { reason: string }> {
  const shown = from.location === 'origin' ? `origin/${from.name}` : from.name;
  if (typeof from.name !== 'string' || from.name.length === 0) {
    return { reason: 'No branch to start from.' };
  }
  if (from.location === 'origin') {
    const fetched = await git(root, ['fetch', '--quiet', '--no-tags', 'origin'], {
      timeoutMs: fetchTimeoutMs,
    });
    if (!fetched.ok) {
      console.warn(
        `[Pixel Agents] Worktrees: couldn't fetch origin for ${root}; starting from ${shown} as last fetched.`,
      );
    }
  }
  const ref =
    from.location === 'origin' ? `refs/remotes/origin/${from.name}` : `refs/heads/${from.name}`;
  const commit = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!commit.ok || !commit.stdout.trim()) return { reason: `The branch ${shown} doesn't exist.` };
  return {
    mode: from.location === 'origin' ? 'fresh' : 'head',
    ref: shown,
    commit: commit.stdout.trim(),
  };
}

/** The base to branch from. `fresh` fetches origin and takes its default
 *  branch, falling back to `head` when there is no origin, the fetch fails or
 *  times out, or no default branch can be told. */
async function resolveBase(
  root: string,
  choice: WorktreeBaseChoice,
  fetchTimeoutMs = WORKTREE_FETCH_TIMEOUT_MS,
): Promise<WorktreeBaseRecord | null> {
  if (choice === 'fresh') {
    const fresh = await freshBase(root, fetchTimeoutMs);
    if (fresh) return fresh;
    console.warn(
      `[Pixel Agents] Worktrees: couldn't reach origin's default branch for ${root}; using the current commit.`,
    );
  }
  const head = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!head.ok) return null;
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return {
    mode: 'head',
    commit: head.stdout.trim(),
    ...(branch.ok && branch.stdout.trim() ? { ref: branch.stdout.trim() } : {}),
  };
}

async function freshBase(root: string, timeoutMs: number): Promise<WorktreeBaseRecord | null> {
  if (!(await git(root, ['remote', 'get-url', 'origin'])).ok) return null;
  const fetched = await git(root, ['fetch', '--quiet', '--no-tags', 'origin'], { timeoutMs });
  if (!fetched.ok) return null;
  const candidates: string[] = [];
  const originHead = await git(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead.ok && originHead.stdout.trim()) candidates.push(originHead.stdout.trim());
  candidates.push('origin/main', 'origin/master');
  for (const ref of candidates) {
    const commit = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (commit.ok) return { mode: 'fresh', ref, commit: commit.stdout.trim() };
  }
  return null;
}

/**
 * Fit out a fresh checkout as every Worktree is (a new one, or one a resume
 * rebuilt): locked while its agent runs, the `.worktreeinclude` files copied
 * in, the symlink folders linked, and each link ignored. Throws with a
 * user-facing reason; the caller removes the checkout.
 */
export async function fitOut(
  root: string,
  folder: string,
  symlinkDirectories: readonly string[],
): Promise<void> {
  const locked = await lockFolder(root, folder);
  if (!locked.ok) throw new Error(gitReason(locked));
  const linked = normalizedLinkDirs(symlinkDirectories);
  await copyIncludedFiles(root, folder, linked);
  const madeLinks = linkDirectories(root, folder, linked);
  // A `node_modules/` pattern matches directories only, and a link is not
  // one to git: without its own slash-less line the agent would see the
  // link as an untracked file, and could commit it.
  const linksIgnored = await excludeLines(
    root,
    madeLinks.map((rel) => `/${rel.split(path.sep).join('/')}`),
  );
  if (!linksIgnored.ok) throw new Error(linksIgnored.reason);
}

/** Add the worktrees folder to the repo's local exclude file, once. Never the
 *  committed .gitignore: that is the user's. */
export function excludeWorktreesFolder(
  root: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return excludeLines(root, [worktreesExcludeLine()]);
}

/** Append each of `lines` to the repo's local exclude file
 *  (`<git common dir>/info/exclude`, read at every worktree's root) unless
 *  it is already there. Never the committed .gitignore. */
async function excludeLines(
  root: string,
  lines: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (lines.length === 0) return { ok: true };
  const common = await git(root, ['rev-parse', '--git-common-dir']);
  if (!common.ok) return { ok: false, reason: gitReason(common) };
  const excludeFile = path.join(path.resolve(root, common.stdout.trim()), 'info', 'exclude');
  try {
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : '';
    const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const missing = [...new Set(lines)].filter((line) => !present.has(line));
    if (missing.length === 0) return { ok: true };
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludeFile, `${separator}${missing.join('\n')}\n`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Couldn't write ${excludeFile}: ${String(err)}` };
  }
}

/** The symlink folders as clean repo-relative paths; anything absolute or
 *  reaching outside the repo is dropped. */
function normalizedLinkDirs(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.trim() === '' || path.isAbsolute(dir)) continue;
    const rel = path.normalize(dir.trim()).replace(/[\\/]+$/, '');
    if (rel === '.' || rel === '' || rel.startsWith('..')) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

function isUnder(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(dir + path.sep) || rel.startsWith(dir + '/');
}

/**
 * Copy the repo's `.worktreeinclude` matches into the Worktree: untracked
 * files matching its patterns that are ALSO gitignored (a tracked or merely
 * untracked file is git's business, not ours), never over a file already
 * there, never a symlink, never anything inside the worktrees folder or a
 * folder about to be linked.
 */
async function copyIncludedFiles(root: string, worktree: string, linked: string[]): Promise<void> {
  const includeFile = path.join(root, WORKTREE_INCLUDE_FILE);
  if (!fs.existsSync(includeFile)) return;
  const matching = await git(root, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    `--exclude-from=${includeFile}`,
  ]);
  if (!matching.ok) throw new Error(gitReason(matching));
  const candidates = matching.stdout
    .split('\0')
    .filter((rel) => rel.length > 0 && !rel.endsWith('/'))
    .filter((rel) => !isUnder(path.normalize(rel), worktreesFolder()))
    .filter((rel) => !linked.some((dir) => isUnder(path.normalize(rel), dir)));
  if (candidates.length === 0) return;
  // check-ignore prints exactly the paths the repo's own ignore rules ignore
  // (exit 1 = none of them, not an error).
  const ignored = await git(root, ['check-ignore', '-z', '--stdin'], {
    input: candidates.join('\0') + '\0',
  });
  const ignoredSet = new Set(ignored.stdout.split('\0').filter((p) => p.length > 0));
  for (const rel of candidates) {
    if (!ignoredSet.has(rel)) continue;
    const source = path.join(root, rel);
    const target = path.join(worktree, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (exists(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}

/** Link each folder that exists in the main checkout and not yet in the
 *  Worktree (a tracked folder of that name is checked out, so stays).
 *  Returns the ones it linked. */
function linkDirectories(root: string, worktree: string, linked: string[]): string[] {
  const made: string[] = [];
  for (const rel of linked) {
    const source = path.join(root, rel);
    const target = path.join(worktree, rel);
    try {
      if (!fs.statSync(source).isDirectory()) continue;
    } catch {
      continue;
    }
    if (exists(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    makeDirLink(source, target);
    made.push(rel);
  }
  return made;
}
