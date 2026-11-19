/**
 * git, for the Worktrees modules: the ONLY place the server runs git (`git`,
 * `gitIn`, `branchPrefixProblem`), plus the reads of a checkout's `.git` that
 * need no git process (`folderState`, `branchAt`).
 *
 * git runs with a scrubbed environment: a server started from inside a git
 * hook or a worktree may carry GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE, which
 * would silently point every command at the wrong repo. A command run INSIDE
 * a Worktree's folder (`gitIn`) also gets a ceiling at the worktrees folder:
 * with its `.git` file missing, git would otherwise walk up and act on the
 * main checkout.
 */

import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  WORKTREE_BRANCH_CACHE_MS,
  WORKTREE_GIT_TIMEOUT_MS,
  WORKTREE_LOCK_REASON,
} from './constants.js';
import { exists, realPath, sameFolder } from './pathKey.js';

/** Variables that point git at a repo other than the one in `cwd`. */
const REPO_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

function gitEnv(ceiling?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of REPO_LOCATION_VARS) delete env[key];
  // Never wait on a credential prompt nobody can see.
  env.GIT_TERMINAL_PROMPT = '0';
  // Set after the scrub: ours, never an inherited one. git compares ceiling
  // entries against the realpath of where it is, so the entry is resolved too.
  if (ceiling !== undefined) env.GIT_CEILING_DIRECTORIES = realPath(ceiling);
  return env;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  timeoutMs?: number;
  input?: string;
}

/** git run at the repo level, in `cwd` (a Directory's root). */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return runGit(cwd, args, opts, gitEnv());
}

/**
 * git run INSIDE a Worktree's folder. With its `.git` file missing, plain
 * git would walk up and act on the main checkout (status reporting the
 * user's files, a save committing them), so the search for a repo stops at
 * the worktrees folder above it: such a folder gets "not a git repository".
 * Repo-level commands (`git(root, …)`) don't need it.
 */
export function gitIn(folder: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return runGit(folder, args, opts, gitEnv(path.dirname(path.resolve(folder))));
}

/** Whether git, run in `folder`, finds `folder` itself as its checkout's root:
 *  asked right before anything writes there, so a `.git` file that vanished
 *  since the folder was inspected can't redirect the write. */
export async function isOwnCheckout(folder: string): Promise<boolean> {
  const top = await gitIn(folder, ['rev-parse', '--show-toplevel']);
  return top.ok && sameFolder(top.stdout.trim(), folder);
}

function runGit(
  cwd: string,
  args: string[],
  opts: GitOptions,
  env: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        env,
        timeout: opts.timeoutMs ?? WORKTREE_GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf-8',
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || err?.message || '') });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** The first line git wrote to stderr, as a user-facing reason. */
export function gitReason(result: GitResult): string {
  const line = result.stderr
    .split('\n')
    .map((l) => l.replace(/^(fatal|error): /, '').trim())
    .find((l) => l.length > 0);
  return line ?? 'git failed';
}

/**
 * Whether a Directory is a git repo's root (its own checkout, main or linked):
 * the Directories the worktree button applies to. A filesystem check, not a
 * git call — the drawer's list is built often and synchronously — so a broken
 * repo still reads as one, and `create` is where it fails with git's reason.
 * A linked worktree's folder (its `.git` is a file) counts too, on purpose: a
 * Directory that is itself a linked worktree gets Worktrees nested under its
 * own worktrees folder (Claude Code: `.claude/worktrees/`), which git
 * allows (`create` checks it is the checkout's root with `--show-toplevel`).
 */
export function isRepo(directoryPath: string): boolean {
  return fs.existsSync(path.join(directoryPath, '.git'));
}

/**
 * Whether a repo's root has an `origin` remote, so a Worktree can start from
 * its default branch ("Latest from origin"). Read from the repo's config file
 * rather than asked of git, for the same reason as `isRepo`; a linked
 * worktree's config is its main repo's (`gitdir:` then `commondir`). Unsure
 * (unreadable, an origin set only through an include) reads as none: the
 * create still falls back to the current commit.
 */
export function hasOriginRemote(directoryPath: string): boolean {
  try {
    const dotGit = path.join(directoryPath, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!pointer) return false;
      gitDir = path.resolve(directoryPath, pointer[1].trim());
      const commonDir = path.join(gitDir, 'commondir');
      if (fs.existsSync(commonDir)) {
        gitDir = path.resolve(gitDir, fs.readFileSync(commonDir, 'utf8').trim());
      }
    }
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    return /^\s*\[remote\s+"origin"\]/m.test(config);
  } catch {
    return false;
  }
}

/**
 * Why `prefix` can't start a branch name, or null when it can (also when git
 * itself is missing: the create then says so). Read when a Directory's prefix
 * is saved, so a bad one is refused there and not at the next launch.
 */
export function branchPrefixProblem(prefix: string): string | null {
  if (prefix.length === 0) return null;
  try {
    execFileSync('git', ['check-ref-format', '--branch', `${prefix}name`], {
      env: gitEnv(),
      stdio: 'ignore',
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    });
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `"${prefix}" can't start a git branch name.`;
  }
}

/** Lock a linked worktree against `git worktree prune` and other tools'
 *  cleanup, with our reason. */
export function lockFolder(root: string, folder: string): Promise<GitResult> {
  return git(root, ['worktree', 'lock', '--reason', WORKTREE_LOCK_REASON, folder]);
}

/** Link `target` to the folder `source` (a junction on Windows, which needs no
 *  privilege). */
export function makeDirLink(source: string, target: string): void {
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}

// ── A checkout's .git, read without git ─────────────────────

/** What a checkout's `.git` says: a main checkout's directory, a linked
 *  worktree's file (pointing at its git dir), or neither. */
type DotGit =
  | { kind: 'directory'; gitDir: string }
  | { kind: 'file'; gitDir: string | null }
  | { kind: 'none' };

function readDotGit(folder: string): DotGit {
  const dotGit = path.join(folder, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dotGit);
  } catch {
    return { kind: 'none' };
  }
  if (stat.isSymbolicLink()) {
    // A main checkout may link its `.git` directory elsewhere; a linked
    // worktree's `.git` is always a plain file.
    try {
      return fs.statSync(dotGit).isDirectory()
        ? { kind: 'directory', gitDir: dotGit }
        : { kind: 'none' };
    } catch {
      return { kind: 'none' };
    }
  }
  if (stat.isDirectory()) return { kind: 'directory', gitDir: dotGit };
  if (!stat.isFile()) return { kind: 'none' };
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    return { kind: 'file', gitDir: match ? path.resolve(folder, match[1]) : null };
  } catch {
    return { kind: 'file', gitDir: null };
  }
}

/** A linked worktree's folder: it exists and holds a `.git` FILE (a main
 *  checkout holds a `.git` directory). */
export function isLinkedWorktreeFolder(folder: string): boolean {
  return readDotGit(folder).kind === 'file';
}

/**
 * What is at a Worktree's folder: nothing (`absent`: gone, by hand or by
 * us), a linked worktree git can read (`readable`: a `.git` FILE), or
 * something that is neither (`unreadable`: its `.git` file deleted or
 * replaced). Only `absent` is ever treated as gone.
 */
export function folderState(folder: string): 'absent' | 'readable' | 'unreadable' {
  if (!exists(folder)) return 'absent';
  return isLinkedWorktreeFolder(folder) ? 'readable' : 'unreadable';
}

/** A linked worktree's git dir (`<common dir>/worktrees/<id>`), read from its
 *  `.git` file; a main checkout's `.git` directory. Null when unreadable. */
export function gitDirOf(folder: string): string | null {
  const dotGit = readDotGit(folder);
  return dotGit.kind === 'none' ? null : dotGit.gitDir;
}

const branchCache = new Map<string, { branch: string | null; at: number }>();

/**
 * The branch checked out in the worktree (or checkout) at `folder`, read from
 * its HEAD without running or writing anything: Claude's own worktrees are
 * shown with their branch, and nothing of theirs is ever changed. A detached
 * HEAD reads as its short commit; null when `folder` isn't a checkout. Cached
 * for WORKTREE_BRANCH_CACHE_MS, so a caller on a timer never re-reads.
 */
export function branchAt(folder: string, now = Date.now()): string | null {
  const key = path.resolve(folder);
  const cached = branchCache.get(key);
  if (cached && now - cached.at < WORKTREE_BRANCH_CACHE_MS) return cached.branch;
  let branch: string | null = null;
  const gitDir = gitDirOf(key);
  if (gitDir) {
    try {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (ref) branch = ref[1];
      else if (/^[0-9a-f]{7,64}$/i.test(head)) branch = head.slice(0, 7);
    } catch {
      // No HEAD: not a checkout.
    }
  }
  branchCache.set(key, { branch, at: now });
  return branch;
}

// ── git's list of a repo's worktrees ────────────────────────

/** One worktree as `git worktree list --porcelain` names it. */
export interface LinkedWorktree {
  path: string;
  /** Its commit (empty for a bare entry). */
  head: string;
  /** Its branch without `refs/heads/`, absent when detached. */
  branch?: string;
  locked: boolean;
  /** The reason it was locked with, when it gave one. */
  lockReason?: string;
}

/**
 * The repo's LINKED worktrees as git lists them (never its main checkout,
 * which git names first). Null when git can't list them. Read-only.
 */
export async function listLinkedWorktrees(root: string): Promise<LinkedWorktree[] | null> {
  const listed = await git(root, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return null;
  const all: LinkedWorktree[] = [];
  for (const block of listed.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const head = lines.find((line) => line.startsWith('worktree '));
    if (!head) continue;
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    all.push({
      path: head.slice('worktree '.length),
      head: lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
      ...(ref ? { branch: ref.replace(/^refs\/heads\//, '') } : {}),
      locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
      ...lockReasonOf(lines),
    });
  }
  const [main, ...linked] = all;
  return main ? linked.filter((w) => !sameFolder(w.path, main.path)) : [];
}

/** `git worktree list --porcelain` prints a lock's reason after `locked `. */
function lockReasonOf(lines: string[]): { lockReason?: string } {
  const reason = lines.find((line) => line.startsWith('locked '))?.slice('locked '.length);
  return reason ? { lockReason: reason } : {};
}

/** Whether git lists `folder` as one of `root`'s linked worktrees (never its
 *  main checkout). */
export async function isLinkedWorktreeOf(root: string, folder: string): Promise<boolean> {
  return (await listLinkedWorktrees(root))?.some((w) => sameFolder(w.path, folder)) ?? false;
}

/**
 * Whether `folder` is what a `git worktree remove` left when it could not
 * delete everything (a file it may not delete, a folder another program holds,
 * like a container's mount): git deletes the folder first and its own record
 * of it last, and drops the record even when the folder failed. So: a linked
 * worktree's `.git` file pointing at a missing `<root's git dir>/worktrees/<id>`,
 * and a folder git no longer lists. Nothing in it is reachable through git.
 */
export async function isHalfRemoved(root: string, folder: string): Promise<boolean> {
  const gitDir = gitDirOf(folder);
  if (!isLinkedWorktreeFolder(folder) || !gitDir || exists(gitDir)) return false;
  const common = await git(root, ['rev-parse', '--git-common-dir']);
  if (!common.ok) return false;
  const worktreesDir = path.resolve(root, common.stdout.trim(), 'worktrees');
  if (!sameFolder(path.dirname(gitDir), worktreesDir)) return false;
  return (await listLinkedWorktrees(root))?.some((w) => sameFolder(w.path, folder)) === false;
}

/** Whether git has `folder` locked (null when git doesn't list it). */
export async function lockedWorktreeOf(root: string, folder: string): Promise<boolean | null> {
  const found = (await listLinkedWorktrees(root))?.find((w) => sameFolder(w.path, folder));
  return found ? found.locked : null;
}
