/**
 * What the new-worktree modal offers for a Directory: a generated name free
 * in its repo, the branch prefix, the branches a Worktree can start from
 * (local ones and origin's as last fetched, newest commit first) and the one
 * the Directory's base setting points at. Read only: nothing is fetched here
 * (the modal opens at once); a launch from an origin branch fetches then.
 */

import * as path from 'path';

import type { Directory, WorktreeBranch, WorktreeOptions } from '../../core/src/messages.js';
import { WORKTREE_OPTIONS_MAX_BRANCHES } from './constants.js';
import { freeGeneratedName } from './worktreeCreate.js';
import { git, gitReason, isRepo } from './worktreeGit.js';

const LOCAL_PREFIX = 'refs/heads/';
const ORIGIN_PREFIX = 'refs/remotes/origin/';

export async function worktreeOptionsFor(
  directory: Pick<Directory, 'path' | 'worktreeBase' | 'worktreeBranchPrefix'>,
  pickName?: () => string,
): Promise<{ ok: true; message: WorktreeOptions } | { ok: false; reason: string }> {
  const root = path.resolve(directory.path);
  if (!isRepo(root)) return { ok: false, reason: `${root} is not a git repository.` };
  if (!(await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).ok) {
    return { ok: false, reason: `${root} has no commits yet.` };
  }

  const refs = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes/origin',
  ]);
  if (!refs.ok) return { ok: false, reason: gitReason(refs) };
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const current = head.ok ? head.stdout.trim() : '';

  const branches: WorktreeBranch[] = [];
  for (const ref of refs.stdout.split('\n').map((line) => line.trim())) {
    if (branches.length >= WORKTREE_OPTIONS_MAX_BRANCHES) break;
    if (ref.startsWith(LOCAL_PREFIX)) {
      const name = ref.slice(LOCAL_PREFIX.length);
      branches.push({ name, location: 'local', ...(name === current ? { current: true } : {}) });
    } else if (ref.startsWith(ORIGIN_PREFIX)) {
      const name = ref.slice(ORIGIN_PREFIX.length);
      // origin/HEAD only points at another branch of the list.
      if (name !== 'HEAD') branches.push({ name, location: 'origin' });
    }
  }

  const defaultBase =
    (directory.worktreeBase === 'fresh' ? await originDefault(root, branches) : undefined) ??
    branches.find((b) => b.current);

  const prefix = directory.worktreeBranchPrefix ?? '';
  const name = await freeGeneratedName(root, prefix, pickName);
  return {
    ok: true,
    message: {
      type: 'worktreeOptions',
      directoryPath: directory.path,
      // No free generated name: the field starts empty and the user types one.
      name: name ?? '',
      prefix,
      branches,
      ...(defaultBase ? { defaultBase } : {}),
    },
  };
}

/** Origin's default branch as last fetched (origin/HEAD, else main or
 *  master), when the list has it. */
async function originDefault(
  root: string,
  branches: WorktreeBranch[],
): Promise<WorktreeBranch | undefined> {
  const originHead = await git(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const candidates = [
    ...(originHead.ok ? [originHead.stdout.trim().replace(/^origin\//, '')] : []),
    'main',
    'master',
  ];
  for (const name of candidates) {
    const found = branches.find((b) => b.location === 'origin' && b.name === name);
    if (found) return found;
  }
  return undefined;
}

/** `requestWorktreeOptions`, for both surfaces: the options to the sender,
 *  or `worktreeRejected` when the path is no Directory or no repo. */
export async function handleRequestWorktreeOptions(
  directoryPath: unknown,
  directory: Directory | undefined,
  send: (msg: Record<string, unknown>) => void,
): Promise<void> {
  const at = typeof directoryPath === 'string' ? directoryPath : '';
  if (!directory) {
    send({ type: 'worktreeRejected', directoryPath: at, reason: `${at} is not a Directory.` });
    return;
  }
  try {
    const options = await worktreeOptionsFor(directory);
    send(
      options.ok
        ? { ...options.message }
        : { type: 'worktreeRejected', directoryPath: at, reason: options.reason },
    );
  } catch (err) {
    console.error('[Pixel Agents] Worktrees: options failed:', err);
    send({ type: 'worktreeRejected', directoryPath: at, reason: String(err) });
  }
}

/** A launch message's own choices for its new Worktree (`worktreeName`,
 *  `worktreeFrom`), each kept only when well formed. */
export function launchWorktreeChoices(msg: Record<string, unknown>): {
  name?: string;
  from?: WorktreeBranch;
} {
  const out: { name?: string; from?: WorktreeBranch } = {};
  if (typeof msg.worktreeName === 'string') out.name = msg.worktreeName.trim();
  const from = msg.worktreeFrom as Record<string, unknown> | undefined;
  if (
    from &&
    typeof from === 'object' &&
    typeof from.name === 'string' &&
    (from.location === 'local' || from.location === 'origin')
  ) {
    out.from = { name: from.name, location: from.location };
  }
  return out;
}
