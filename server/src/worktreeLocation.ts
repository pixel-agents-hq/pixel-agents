/**
 * Attribution by location: which Directory, and which of its worktrees, a
 * path is under. Any folder at `<Directory>/.claude/worktrees/<name>` (or
 * below it) belongs to that Directory, whoever made the worktree — Pixel
 * Agents or Claude Code itself (`claude -w`, background sessions). This says
 * nothing about OWNERSHIP: only the registry (worktreeRegistry.ts) proves a worktree
 * is ours to manage, and nothing here ever touches one.
 *
 * Two readings of the same location: a working folder (`cwd`, from a hook or
 * a transcript), and a provider project dir, whose name is the folder's
 * project hash (core/src/normalizeProjectPath.ts: every character that isn't
 * a letter, digit or `-` becomes `-`), so a worktree of the Directory hashed
 * `H` files its sessions under `H--claude-worktrees-<name>` — the Directory's
 * "family" of project dirs.
 *
 * This module is the one owner of that shape: `worktreePathIn` builds a
 * worktree's folder, `worktreeDirectoryOf` reads it back, and everything
 * else (ownership, Claude's worktrees, a session's project dirs, a moved
 * agent's Directory) goes through them. The readings resolve symlinks
 * (`directorySpellings`); `worktreeForProjectDir` also lists the worktrees
 * folder, because a hash can't be turned back into a folder name.
 */

import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { WORKTREES_SUBDIR } from './constants.js';
import { realPath } from './pathKey.js';

/** The worktrees folder's path segments under a repo root (`.claude`, `worktrees`). */
const WORKTREES_SEGMENTS = WORKTREES_SUBDIR.split('/');

/** What a worktree's project dir name adds after its Directory's hash:
 *  `--claude-worktrees-`. */
export const WORKTREE_PROJECT_DIR_INFIX = normalizeProjectPath(`/${WORKTREES_SUBDIR}/`);

/** Where a worktree sits: the Directory it belongs to, its folder name, and
 *  its folder (`<directory.path>/.claude/worktrees/<name>`). */
export interface WorktreeLocation<D extends { path: string }> {
  directory: D;
  name: string;
  path: string;
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** Where a Directory's worktree named `name` lives:
 *  `<directoryPath>/.claude/worktrees/<name>`, in the Directory's spelling. */
export function worktreePathIn(directoryPath: string, name: string): string {
  return path.join(path.resolve(directoryPath), ...WORKTREES_SEGMENTS, name);
}

/** Whether `name` can name a worktree folder: one path segment, not `.` or `..`. */
export function isWorktreeName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && name === path.basename(name);
}

/**
 * The Directory and name a worktree folder belongs to, read from its path:
 * exactly `<directoryPath>/.claude/worktrees/<name>` (not below it), as
 * spelled — no symlinks resolved. Null for anything else. The inverse of
 * `worktreePathIn`.
 */
export function worktreeDirectoryOf(
  worktreePath: string,
): { directoryPath: string; name: string } | null {
  const folder = path.resolve(worktreePath);
  const name = path.basename(folder);
  if (!isWorktreeName(name)) return null;
  let parent = path.dirname(folder);
  for (const segment of [...WORKTREES_SEGMENTS].reverse()) {
    if (path.basename(parent) !== segment) return null;
    parent = path.dirname(parent);
  }
  if (parent === folder || worktreePathIn(parent, name) !== folder) return null;
  return { directoryPath: parent, name };
}

/**
 * The worktree `cwd` is in, when it is at or below
 * `<some Directory>/.claude/worktrees/<name>`. The most specific Directory
 * wins (a Directory nested in another). A Directory's own checkout, or
 * anything elsewhere under it, is no worktree. Each Directory is matched by
 * its path and its symlink-resolved one (a hook reports the folder the CLI
 * runs in, symlinks resolved); the worktree's `path` is always spelled from
 * the Directory's own path.
 */
export function worktreeLocationOf<D extends { path: string }>(
  cwd: string,
  directories: readonly D[],
): WorktreeLocation<D> | null {
  let best: WorktreeLocation<D> | null = null;
  let bestDepth = -1;
  for (const directory of directories) {
    for (const root of directorySpellings(directory.path)) {
      const rel = path.relative(root, path.resolve(cwd));
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const parts = segmentsOf(rel);
      if (parts.length <= WORKTREES_SEGMENTS.length) continue;
      if (!WORKTREES_SEGMENTS.every((segment, i) => parts[i] === segment)) continue;
      const name = parts[WORKTREES_SEGMENTS.length];
      const depth = segmentsOf(root).length;
      if (depth <= bestDepth) continue;
      best = { directory, name, path: worktreePathIn(directory.path, name) };
      bestDepth = depth;
    }
  }
  return best;
}

/** Whether `p` is at or below some `.claude/worktrees/<name>` folder: never a
 *  Directory of its own (the suggestions leave these out). */
export function isInWorktreesFolder(p: string): boolean {
  const parts = segmentsOf(path.resolve(p));
  for (let i = 0; i + WORKTREES_SEGMENTS.length < parts.length; i++) {
    if (WORKTREES_SEGMENTS.every((segment, j) => parts[i + j] === segment)) return true;
  }
  return false;
}

/** The prefix every worktree project dir of the folder hashed `hash` starts with. */
export function worktreeProjectDirPrefix(hash: string): string {
  return `${hash}${WORKTREE_PROJECT_DIR_INFIX}`;
}

/** Whether the project dir named `dirName` is one of the worktrees of the
 *  folder whose project dir is named `hash` (its family). */
export function isWorktreeProjectDirOf(dirName: string, hash: string): boolean {
  const prefix = worktreeProjectDirPrefix(hash);
  return hash.length > 0 && dirName.length > prefix.length && dirName.startsWith(prefix);
}

/** A Directory's path and its symlink-resolved one (the CLI files sessions
 *  under the resolved one), deduped. */
export function directorySpellings(directoryPath: string): string[] {
  const out = [path.resolve(directoryPath)];
  const real = realPath(directoryPath);
  if (!out.includes(real)) out.push(real);
  return out;
}

/**
 * The worktree whose sessions are filed in `projectDir`, when it is in some
 * Directory's family. The folder name is found by listing the Directory's
 * worktrees folder (a hash loses `.` and `_`); a worktree whose folder is
 * gone falls back to the hash's own spelling of it.
 */
export function worktreeForProjectDir<D extends { path: string }>(
  projectDir: string,
  directories: readonly D[],
): WorktreeLocation<D> | null {
  const dirName = path.basename(projectDir);
  let best: WorktreeLocation<D> | null = null;
  for (const directory of directories) {
    for (const spelling of directorySpellings(directory.path)) {
      const hash = normalizeProjectPath(spelling);
      if (!isWorktreeProjectDirOf(dirName, hash)) continue;
      if (best && path.resolve(best.directory.path).length >= spelling.length) continue;
      const worktreesDir = path.dirname(worktreePathIn(spelling, '_'));
      let name = dirName.slice(worktreeProjectDirPrefix(hash).length);
      try {
        const match = fs
          .readdirSync(worktreesDir)
          .find((entry) => normalizeProjectPath(path.join(worktreesDir, entry)) === dirName);
        if (match) name = match;
      } catch {
        // No worktrees folder: the hash's spelling it is.
      }
      best = { directory, name, path: worktreePathIn(directory.path, name) };
    }
  }
  return best;
}
