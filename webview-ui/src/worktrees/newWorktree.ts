/**
 * The new-worktree modal's rules (pure, Node-tested): which branches it lists
 * and in what order, what a filter keeps, and what a typed name can't be.
 * The server checks the name again (and whether it is taken by a folder);
 * this only saves a round trip for the common mistakes.
 */

import type {
  WorktreeBranch,
  WorktreeBranchLocation,
  WorktreeOptions,
} from '../../../core/src/messages.js';

/** The same rule as the server's `worktreeNameProblem`. */
export const WORKTREE_NAME_MAX_LENGTH = 64;

export function sameBranch(a: WorktreeBranch | undefined, b: WorktreeBranch | undefined): boolean {
  return !!a && !!b && a.name === b.name && a.location === b.location;
}

export function branchKey(branch: WorktreeBranch): string {
  return `${branch.location}:${branch.name}`;
}

/** The list as shown: the default first, then the current branch, then the
 *  rest in the server's order (newest commit first). */
export function orderedBranches(options: WorktreeOptions): WorktreeBranch[] {
  const rank = (b: WorktreeBranch) => (sameBranch(b, options.defaultBase) ? 0 : b.current ? 1 : 2);
  return options.branches
    .map((branch, index) => ({ branch, index }))
    .sort((a, b) => rank(a.branch) - rank(b.branch) || a.index - b.index)
    .map(({ branch }) => branch);
}

const LOCATIONS: readonly WorktreeBranchLocation[] = ['local', 'origin'];

/** The locations the repo has branches in (the location chips show only
 *  when there are both). */
export function offeredLocations(options: WorktreeOptions): WorktreeBranchLocation[] {
  return LOCATIONS.filter((loc) => options.branches.some((b) => b.location === loc));
}

/** The locations listed when the modal opens: local, plus the default
 *  branch's own so the picked row is in view (origin alone when there is no
 *  local branch). */
export function initialLocations(options: WorktreeOptions): WorktreeBranchLocation[] {
  const offered = offeredLocations(options);
  const shown = new Set<WorktreeBranchLocation>(offered.includes('local') ? ['local'] : offered);
  if (options.defaultBase) shown.add(options.defaultBase.location);
  return LOCATIONS.filter((loc) => shown.has(loc));
}

/** A location chip pressed: shown ↔ hidden, never leaving none shown. */
export function toggleLocation(
  shown: readonly WorktreeBranchLocation[],
  location: WorktreeBranchLocation,
): WorktreeBranchLocation[] {
  if (!shown.includes(location))
    return LOCATIONS.filter((l) => l === location || shown.includes(l));
  if (shown.length === 1) return [...shown];
  return shown.filter((l) => l !== location);
}

/** The branches in a shown location whose name holds every word of
 *  `filter` (any case). */
export function filterBranches(
  branches: WorktreeBranch[],
  filter: string,
  locations: readonly WorktreeBranchLocation[] = LOCATIONS,
): WorktreeBranch[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return branches.filter((b) => {
    if (!locations.includes(b.location)) return false;
    const label = `${b.location === 'origin' ? 'origin/' : ''}${b.name}`.toLowerCase();
    return words.every((word) => label.includes(word));
  });
}

/** Why `name` can't name the Worktree, or null when it can (as far as the
 *  office can tell: a taken folder is the server's to say). */
export function newWorktreeNameProblem(name: string, options: WorktreeOptions): string | null {
  if (name.length === 0) return 'Give the worktree a name.';
  if (name.length > WORKTREE_NAME_MAX_LENGTH) {
    return `At most ${WORKTREE_NAME_MAX_LENGTH} characters.`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return 'Use letters, digits, ".", "_" and "-", starting with a letter or digit.';
  }
  if (name.includes('..') || name.endsWith('.') || name.toLowerCase().endsWith('.lock')) {
    return `"${name}" can't be a branch name.`;
  }
  const branch = `${options.prefix}${name}`;
  if (options.branches.some((b) => b.location === 'local' && b.name === branch)) {
    return `A branch named ${branch} already exists.`;
  }
  return null;
}
