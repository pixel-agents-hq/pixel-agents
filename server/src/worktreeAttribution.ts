/**
 * Worktree attribution for the scanners and for moved agents. Any session
 * whose working folder is under a Directory's `.claude/worktrees/<name>`
 * belongs to that Directory, whoever made the worktree (worktreeLocation.ts).
 * Its sessions are filed under the Directory's family of project dirs
 * (`<hash>--claude-worktrees-<name>`), which the external scanner tracks like
 * the Directory's own, so `claude -w` sessions are adopted, named after the
 * Directory and marked with the worktree and its branch.
 *
 * The host's Directories are read through `setAttributionDirectories` and
 * cached: the scanners ask on every tick, for every project dir, and a fresh
 * read parses config.json. The cache is dropped whenever this process changes
 * the Directories (`invalidateAttributionDirectories`) and after
 * ATTRIBUTION_DIRECTORIES_TTL_MS otherwise (another process's edit).
 */

import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { ATTRIBUTION_DIRECTORIES_TTL_MS } from './constants.js';
import { sameFolder } from './pathKey.js';
import type { AgentState } from './types.js';
import { branchAt } from './worktreeGit.js';
import {
  directorySpellings,
  isWorktreeProjectDirOf,
  worktreeForProjectDir,
  worktreeLocationOf,
} from './worktreeLocation.js';

/** A Directory as attribution needs it: its name (the agent's label) and path. */
export interface AttributionDirectory {
  name: string;
  path: string;
}

let source: () => readonly AttributionDirectory[] = () => [];
let cached: { at: number; directories: readonly AttributionDirectory[] } | null = null;

/** Register the host's Directories (host + user). Read lazily, then cached. */
export function setAttributionDirectories(next: () => readonly AttributionDirectory[]): void {
  source = next;
  cached = null;
}

/** The Directories changed (a save, a removal, a workspace change): read
 *  them afresh at the next use. */
export function invalidateAttributionDirectories(): void {
  cached = null;
}

function currentDirectories(now = Date.now()): readonly AttributionDirectory[] {
  if (cached && now - cached.at < ATTRIBUTION_DIRECTORIES_TTL_MS) return cached.directories;
  let directories: readonly AttributionDirectory[];
  try {
    directories = source();
  } catch {
    directories = [];
  }
  cached = { at: now, directories };
  return directories;
}

/** `directoryPath` as the office lists it: the path of the Directory that
 *  folder is (however spelled — the registry's resolved root, a worktree's
 *  parent, a client's spelling), else `directoryPath` itself. What a
 *  Directory's Worktrees are keyed by on the wire. */
export function listedDirectoryPath(directoryPath: string): string {
  return currentDirectories().find((d) => sameFolder(d.path, directoryPath))?.path ?? directoryPath;
}

/** The Directory and worktree an adopted session belongs to by location:
 *  its cwd when known, else its project dir. Null = no Directory's worktree. */
export function worktreeAttribution(
  cwd: string | undefined,
  projectDir: string | undefined,
): { directoryName: string; worktree: NonNullable<AgentState['worktree']> } | null {
  const directories = currentDirectories();
  if (directories.length === 0) return null;
  let location = cwd ? worktreeLocationOf(cwd, directories) : null;
  if (!location && projectDir) location = worktreeForProjectDir(projectDir, directories);
  if (!location) return null;
  return {
    directoryName: location.directory.name,
    worktree: {
      name: location.name,
      path: location.path,
      branch: branchAt(location.path) ?? location.name,
    },
  };
}

/** The project-dir hashes whose worktree families are tracked: every
 *  tracked project dir's, and every Directory's (both spellings). Compute it
 *  once per scan and hand it to `isWorktreeFamilyDir`. */
export function familyHashes(trackedProjectDirs: Iterable<string>): Set<string> {
  const hashes = new Set<string>();
  for (const dir of trackedProjectDirs) hashes.add(path.basename(dir));
  for (const directory of currentDirectories()) {
    for (const spelling of directorySpellings(directory.path)) {
      hashes.add(normalizeProjectPath(spelling));
    }
  }
  return hashes;
}

/** Whether `dir` is a worktree project dir of one of `hashes`' folders. */
export function isWorktreeFamilyDir(dir: string, hashes: ReadonlySet<string>): boolean {
  const name = path.basename(dir);
  for (const hash of hashes) {
    if (isWorktreeProjectDirOf(name, hash)) return true;
  }
  return false;
}

/** Every worktree project dir of `hashes` under the session roots right now
 *  (the tracked dirs themselves left out). */
export function worktreeFamilyDirs(
  sessionRoots: readonly string[],
  hashes: ReadonlySet<string>,
  trackedProjectDirs: ReadonlySet<string>,
): string[] {
  if (hashes.size === 0) return [];
  const out: string[] = [];
  for (const root of sessionRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (trackedProjectDirs.has(dir)) continue;
      if (isWorktreeFamilyDir(dir, hashes)) out.push(dir);
    }
  }
  return out;
}

/** Family dirs whose existing transcripts were seeded as known. */
const seededFamilyDirs = new Set<string>();

/**
 * Seed the family dirs among `dirs` not seen before, like a tracked dir is
 * seeded: their transcripts are the past (a session that died with the last
 * server among them), adopted only once they're written to again. `seed` is
 * handed each existing transcript. Family dirs that appear later hold new
 * sessions and are scanned as they are.
 */
export function seedWorktreeFamilyDirs(
  dirs: readonly string[],
  seed: (file: string) => void,
): void {
  for (const dir of dirs) {
    if (seededFamilyDirs.has(dir)) continue;
    seededFamilyDirs.add(dir);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) seed(path.join(dir, f));
  }
}
