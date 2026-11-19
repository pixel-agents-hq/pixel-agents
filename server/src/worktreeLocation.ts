/**
 * Attribution by location: which Directory, and which of its worktrees, a
 * path is under. Any folder at `<Directory>/<worktrees folder>/<name>` (or
 * below it) belongs to that Directory, whoever made the worktree — Pixel
 * Agents or the CLI itself (Claude Code: `claude -w`, background sessions).
 * This says nothing about OWNERSHIP: only the registry (worktreeRegistry.ts)
 * proves a worktree is ours to manage, and nothing here ever touches one.
 *
 * Two readings of the same location: a working folder (`cwd`, from a hook or
 * a transcript), and a provider project dir, named after the folder its
 * sessions ran in, so the worktrees of a Directory file their sessions under
 * dirs named after the Directory's own — the Directory's "family" of project
 * dirs.
 *
 * Where the worktrees folder is and how a project dir is named are the
 * CLI's: both come from the provider's `worktrees` convention
 * (core/src/provider.ts `WorktreeConvention`; Claude Code's is
 * `.claude/worktrees` and `<repo's dir>--claude-worktrees-<name>`), and no
 * other shared module knows either. Our own Worktrees go in the same folder,
 * so the CLI files their sessions with the Directory's.
 *
 * This module is the one owner of that shape: `worktreePathIn` builds a
 * worktree's folder, `worktreeDirectoryOf` reads it back, and everything
 * else (ownership, the CLI's own worktrees, a session's project dirs, a
 * moved agent's Directory) goes through them. The readings resolve symlinks
 * (`directorySpellings`); `worktreeForProjectDir` also lists the worktrees
 * folder, because a project dir's name can't be turned back into a folder
 * name.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider, WorktreeConvention } from '../../core/src/provider.js';
import { FALLBACK_WORKTREES_FOLDER } from './constants.js';
import { realPath } from './pathKey.js';
import { hookProviders } from './providers/index.js';

/** The provider whose worktrees convention the office follows: the first
 *  bundled one that declares one. Which CLI's folder our Worktrees would
 *  share when several declare one is not decided; today one provider is
 *  bundled.
 *
 *  Entries in worktrees.json do not record the folder they were made under,
 *  so a change of convention (another provider chosen here, or none) leaves
 *  the existing entries unowned: they drop out of listing, sweep and
 *  retire. */
export function worktreesProviderOf<P extends Pick<HookProvider, 'worktrees'>>(
  providers: readonly P[],
): P | undefined {
  return providers.find((p) => p.worktrees);
}

/** The convention the office follows (`worktreesProviderOf`'s). */
export function worktreeConventionOf(
  providers: readonly Pick<HookProvider, 'worktrees'>[],
): WorktreeConvention | undefined {
  return worktreesProviderOf(providers)?.worktrees;
}

/** The CLI whose worktrees folder the office shares, and whose own worktrees
 *  it lists: the one place the provider for the folder, the session dirs'
 *  naming, the lock, the symlink setting and the CLI's name in the
 *  Worktrees list and its refusals is chosen. Undefined = none declares a
 *  convention: the CLI has no worktrees of its own. */
export function worktreesCli(): HookProvider | undefined {
  return worktreesProviderOf(hookProviders);
}

function convention(): WorktreeConvention | undefined {
  return worktreesCli()?.worktrees;
}

/** Folders a new Worktree of `repoPath` links to the main checkout rather
 *  than copying, as the CLI's own settings list them; none where it has no
 *  such setting. */
export function symlinkDirectoriesFor(repoPath: string): string[] | undefined {
  return convention()?.symlinkDirectories?.(repoPath);
}

/** The worktrees folder's path segments under a repo root. With no
 *  convention to follow, the office's own folder. */
function worktreesSegments(): readonly string[] {
  return convention()?.folder ?? FALLBACK_WORKTREES_FOLDER;
}

/** The worktrees folder relative to a repo root, in this platform's
 *  spelling. */
export function worktreesFolder(): string {
  return path.join(...worktreesSegments());
}

/** The line that keeps the worktrees folder out of a repo's status (git
 *  exclude syntax). */
export function worktreesExcludeLine(): string {
  return `/${worktreesSegments().join('/')}/`;
}

/** The name of the project dir of the folder at `folderPath` (its "hash"),
 *  or null where no provider names project dirs after folders. */
export function projectDirNameOf(folderPath: string): string | null {
  return convention()?.sessionDirName(folderPath) ?? null;
}

/** Where a worktree sits: the Directory it belongs to, its folder name, and
 *  its folder (`<directory.path>/<worktrees folder>/<name>`). */
export interface WorktreeLocation<D extends { path: string }> {
  directory: D;
  name: string;
  path: string;
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** Where a Directory's worktree named `name` lives:
 *  `<directoryPath>/<worktrees folder>/<name>`, in the Directory's spelling. */
export function worktreePathIn(directoryPath: string, name: string): string {
  return path.join(path.resolve(directoryPath), ...worktreesSegments(), name);
}

/** Whether `name` can name a worktree folder: one path segment, not `.` or `..`. */
export function isWorktreeName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && name === path.basename(name);
}

/**
 * The Directory and name a worktree folder belongs to, read from its path:
 * exactly `<directoryPath>/<worktrees folder>/<name>` (not below it), as
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
  for (const segment of [...worktreesSegments()].reverse()) {
    if (path.basename(parent) !== segment) return null;
    parent = path.dirname(parent);
  }
  if (parent === folder || worktreePathIn(parent, name) !== folder) return null;
  return { directoryPath: parent, name };
}

/**
 * The worktree `cwd` is in, when it is at or below
 * `<some Directory>/<worktrees folder>/<name>`. The most specific Directory
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
  const segments = worktreesSegments();
  let best: WorktreeLocation<D> | null = null;
  let bestDepth = -1;
  for (const directory of directories) {
    for (const root of directorySpellings(directory.path)) {
      const rel = path.relative(root, path.resolve(cwd));
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const parts = segmentsOf(rel);
      if (parts.length <= segments.length) continue;
      if (!segments.every((segment, i) => parts[i] === segment)) continue;
      const name = parts[segments.length];
      const depth = segmentsOf(root).length;
      if (depth <= bestDepth) continue;
      best = { directory, name, path: worktreePathIn(directory.path, name) };
      bestDepth = depth;
    }
  }
  return best;
}

/** Whether `p` is at or below some `<worktrees folder>/<name>` folder: never
 *  a Directory of its own (the suggestions leave these out). */
export function isInWorktreesFolder(p: string): boolean {
  const segments = worktreesSegments();
  const parts = segmentsOf(path.resolve(p));
  for (let i = 0; i + segments.length < parts.length; i++) {
    if (segments.every((segment, j) => parts[i + j] === segment)) return true;
  }
  return false;
}

/** Whether the project dir named `dirName` is one of the worktrees of the
 *  folder whose project dir is named `hash` (its family). */
export function isWorktreeProjectDirOf(dirName: string, hash: string): boolean {
  return (convention()?.worktreeOfSessionDir(dirName, hash) ?? null) !== null;
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
 * worktrees folder (a project dir's name may have lost characters); a
 * worktree whose folder is gone falls back to the project dir's own spelling
 * of it.
 */
export function worktreeForProjectDir<D extends { path: string }>(
  projectDir: string,
  directories: readonly D[],
): WorktreeLocation<D> | null {
  const naming = convention();
  if (!naming) return null;
  const dirName = path.basename(projectDir);
  let best: WorktreeLocation<D> | null = null;
  for (const directory of directories) {
    for (const spelling of directorySpellings(directory.path)) {
      const spelled = naming.worktreeOfSessionDir(dirName, naming.sessionDirName(spelling));
      if (spelled === null) continue;
      if (best && path.resolve(best.directory.path).length >= spelling.length) continue;
      const worktreesDir = path.dirname(worktreePathIn(spelling, '_'));
      let name = spelled;
      try {
        const match = fs
          .readdirSync(worktreesDir)
          .find((entry) => naming.sessionDirName(path.join(worktreesDir, entry)) === dirName);
        if (match) name = match;
      } catch {
        // No worktrees folder: the project dir's spelling it is.
      }
      best = { directory, name, path: worktreePathIn(directory.path, name) };
    }
  }
  return best;
}
