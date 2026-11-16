/**
 * Standalone's Directory name for an external agent: the git repository it
 * works in.
 *
 * VS Code resolves an agent's cwd to its workspace folder (adapters/vscode).
 * Standalone registered no resolver, so a session fell back to its folder or
 * its encoded project dir. A linked worktree, the usual layout for running
 * several sessions on one repo, then showed only its own folder name
 * (`fix-login-redirect`, or `2bc2ed` from `busy-fox-2bc2ed`) with nothing
 * saying which repo it belongs to, and could never match that repo's Area.
 *
 * Here a cwd resolves to the main checkout of its repository, so every worktree
 * of a repo shares one label and one Area mapping. A Directory registered at
 * that checkout names it; otherwise the checkout folder's name does. Only plain
 * fs reads: no `git` spawn per agent. A cwd outside any repository returns
 * undefined, leaving the existing fallback in place.
 */

import * as fs from 'fs';
import * as path from 'path';

import { type HostDirectoryEntry, listDirectories, normalizeDirectoryPath } from './directories.js';
import type { DirectoryNameResolver } from './fileWatcher.js';
import { directoryNameFor } from './hostDirectory.js';

/** The main checkout of the git repository containing `dir`, or undefined. */
export function repoRootFor(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return current;
    if (stat?.isFile()) return checkoutForGitFile(current, dotGit);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * A `.git` file points at the checkout's real git dir. In a linked worktree
 * that dir holds a `commondir` file leading to the main repository's `.git`,
 * whose parent is the main checkout. A submodule or a `--separate-git-dir`
 * checkout has no `commondir`, so it is its own repository.
 */
function checkoutForGitFile(checkout: string, dotGitFile: string): string {
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGitFile, 'utf-8'));
    if (!match) return checkout;
    const gitDir = path.resolve(checkout, match[1]);
    const commonDir = path.resolve(
      gitDir,
      fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim(),
    );
    // A bare repository's worktrees share `<name>.git` itself; it has no checkout.
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  } catch {
    return checkout;
  }
}

/** Display name for a repository root: a bare `<name>.git` shows as `<name>`. */
function repoNameFor(repoRoot: string): string {
  return directoryNameFor(repoRoot).replace(/\.git$/, '') || directoryNameFor(repoRoot);
}

/**
 * The standalone host's resolver. `hostDirectories` is read per call, like the
 * Directory list itself, so a Directory added or renamed in the office names the
 * agents created after it. The repo lookup is cached per cwd: a folder doesn't
 * change repositories while agents run in it.
 */
export function createStandaloneDirectoryNameResolver(
  hostDirectories: () => HostDirectoryEntry[],
): DirectoryNameResolver {
  const repoRoots = new Map<string, string>();
  return ({ cwd }) => {
    if (!cwd) return undefined;
    let repoRoot = repoRoots.get(cwd);
    if (!repoRoot) {
      repoRoot = repoRootFor(cwd);
      if (!repoRoot) return undefined;
      repoRoots.set(cwd, repoRoot);
    }
    const key = normalizeDirectoryPath(repoRoot);
    const registered = listDirectories(hostDirectories()).find(
      (directory) => normalizeDirectoryPath(directory.path) === key,
    );
    return registered?.name ?? repoNameFor(repoRoot);
  };
}
