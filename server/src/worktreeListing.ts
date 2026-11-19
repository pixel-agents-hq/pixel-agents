/**
 * A Directory's Worktrees, as every list of them reads them: ours (from the
 * registry), then the CLI's own (from git), each with where it is and, when
 * asked for `details`, what it holds. The office's Worktrees list
 * (`worktreesLoaded`) and the conversations' worktree lookup both map this.
 */

import type { WorktreeOwner } from '../../core/src/messages.js';
import { cliWorktreeHoldings, listCliWorktrees } from './cliWorktrees.js';
import { sameFolder } from './pathKey.js';
import { list } from './worktreeInspect.js';
import { ownedEntry, readRegistry, type WorktreeEntry } from './worktreeRegistry.js';

/** What a Worktree holds, as the list shows it. */
export interface WorktreeHoldings {
  uncommittedFiles: number;
  uniqueCommits: number;
  sizeBytes: number;
}

/** One of a Directory's Worktrees. */
export interface ListedWorktree {
  name: string;
  path: string;
  branch: string;
  owner: WorktreeOwner;
  /** Ours: its registry entry (state, sessions). */
  entry?: WorktreeEntry;
  /** With `details`: what it holds. */
  holds?: WorktreeHoldings;
}

/** `directoryPath`'s Worktrees: ours, then the CLI's own. `details` reads
 *  what each holds (git status, commits, size); without it only where they
 *  are, which is cheap. */
export async function worktreesOf(
  directoryPath: string,
  { details }: { details: boolean },
): Promise<ListedWorktree[]> {
  const ours: ListedWorktree[] = details
    ? (await list(directoryPath)).map(({ entry, inspection }) => ({
        ...where(entry, 'pixelAgents'),
        entry,
        holds: {
          uncommittedFiles: inspection.uncommittedFiles,
          uniqueCommits: inspection.uniqueCommits,
          sizeBytes: inspection.sizeBytes,
        },
      }))
    : readRegistry()
        .filter((e) => sameFolder(e.directoryPath, directoryPath) && ownedEntry(e).ok)
        .map((entry) => ({ ...where(entry, 'pixelAgents'), entry }));
  const theirs: ListedWorktree[] = [];
  for (const worktree of await listCliWorktrees(directoryPath)) {
    theirs.push({
      ...where(worktree, 'cli'),
      ...(details ? { holds: await cliWorktreeHoldings(directoryPath, worktree) } : {}),
    });
  }
  return [...ours, ...theirs];
}

function where(
  worktree: { name: string; path: string; branch: string },
  owner: WorktreeOwner,
): Pick<ListedWorktree, 'name' | 'path' | 'branch' | 'owner'> {
  return { name: worktree.name, path: worktree.path, branch: worktree.branch, owner };
}
