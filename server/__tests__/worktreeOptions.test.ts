import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { create } from '../src/worktreeCreate.js';
import { worktreeNameProblem } from '../src/worktreeNames.js';
import { launchWorktreeChoices, worktreeOptionsFor } from '../src/worktreeOptions.js';
import {
  commitAll,
  gitIn,
  gitOk,
  makeRepo,
  removeTempRepos,
  tempDir,
  writeFile,
} from './fixtures/gitRepos.js';
import { clearTestHome } from './helpers/removeTempDir.js';

/** The new-worktree modal: a name the user gives and a branch to start from. */

afterEach(() => {
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

/** A repo whose origin (a bare repo) has `main` plus a newer commit on it
 *  that the repo has fetched, and `upstream-only`, a branch only origin has. */
function repoWithOrigin(): string {
  const repo = makeRepo();
  const origin = tempDir('pxl-origin-');
  gitIn(origin, 'init', '--quiet', '--bare');
  gitIn(repo, 'remote', 'add', 'origin', origin);
  gitIn(repo, 'push', '--quiet', 'origin', 'main');
  const other = tempDir('pxl-clone-');
  gitIn(other, 'clone', '--quiet', origin, '.');
  gitIn(other, 'checkout', '--quiet', '-b', 'upstream-only');
  writeFile(other, 'upstream.txt', 'from origin\n');
  commitAll(other, 'upstream work');
  gitIn(other, 'push', '--quiet', 'origin', 'upstream-only');
  gitIn(repo, 'fetch', '--quiet', 'origin');
  return repo;
}

describe('worktreeOptionsFor', () => {
  it('lists local and origin branches, the current one marked, and suggests a free name', async () => {
    const repo = repoWithOrigin();
    gitIn(repo, 'branch', 'feature/old');
    const options = await worktreeOptionsFor(
      { path: repo, worktreeBranchPrefix: 'feature/' },
      () => 'calm-heron',
    );
    if (!options.ok) throw new Error(options.reason);
    const { message } = options;
    expect(message).toMatchObject({
      type: 'worktreeOptions',
      name: 'calm-heron',
      prefix: 'feature/',
    });
    expect(message.branches).toEqual(
      expect.arrayContaining([
        { name: 'main', location: 'local', current: true },
        { name: 'feature/old', location: 'local' },
        { name: 'main', location: 'origin' },
        { name: 'upstream-only', location: 'origin' },
      ]),
    );
    expect(message.branches.some((b) => b.name === 'HEAD')).toBe(false);
    // Base `head` (the default): the current branch.
    expect(message.defaultBase).toEqual({ name: 'main', location: 'local', current: true });
  });

  it("base fresh: the default is origin's default branch", async () => {
    const repo = repoWithOrigin();
    const options = await worktreeOptionsFor({ path: repo, worktreeBase: 'fresh' });
    if (!options.ok) throw new Error(options.reason);
    expect(options.message.defaultBase).toEqual({ name: 'main', location: 'origin' });
  });

  it('skips a generated name whose branch is taken', async () => {
    const repo = makeRepo();
    gitIn(repo, 'branch', 'calm-heron');
    const picks = ['calm-heron', 'brave-otter'];
    const options = await worktreeOptionsFor({ path: repo }, () => picks.shift()!);
    if (!options.ok) throw new Error(options.reason);
    expect(options.message.name).toBe('brave-otter');
  });

  it('a detached checkout has no default branch', async () => {
    const repo = makeRepo();
    gitIn(repo, 'checkout', '--quiet', '--detach');
    const options = await worktreeOptionsFor({ path: repo });
    if (!options.ok) throw new Error(options.reason);
    expect(options.message.defaultBase).toBeUndefined();
  });

  it('refuses a folder that is no repo', async () => {
    const options = await worktreeOptionsFor({ path: tempDir() });
    expect(options.ok).toBe(false);
  });
});

describe('create with a chosen name and branch', () => {
  it('uses the given name for the folder and, after the prefix, the branch', async () => {
    const repo = makeRepo();
    const result = await create({ path: repo }, { name: 'login-fix', prefix: 'feature/' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.worktree.name).toBe('login-fix');
    expect(result.worktree.branch).toBe('feature/login-fix');
    expect(result.worktree.path).toBe(path.join(repo, '.claude', 'worktrees', 'login-fix'));
  });

  it('refuses a taken branch or an invalid name, leaving nothing behind', async () => {
    const repo = makeRepo();
    gitIn(repo, 'branch', 'feature/taken');
    const taken = await create({ path: repo }, { name: 'taken', prefix: 'feature/' });
    expect(taken).toEqual({ ok: false, reason: 'A branch named "feature/taken" already exists.' });
    const invalid = await create({ path: repo }, { name: '../escape' });
    expect(invalid.ok).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude', 'worktrees'))).toBe(false);
  });

  it('starts from a local branch other than the current one', async () => {
    const repo = makeRepo();
    gitIn(repo, 'checkout', '--quiet', '-b', 'other');
    writeFile(repo, 'other.txt', 'other\n');
    const otherTip = commitAll(repo, 'other work');
    gitIn(repo, 'checkout', '--quiet', 'main');

    const result = await create({ path: repo }, { from: { name: 'other', location: 'local' } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.worktree.base).toEqual({ mode: 'head', ref: 'other', commit: otherTip });
    expect(fs.existsSync(path.join(result.worktree.path, 'other.txt'))).toBe(true);
  });

  it('starts from an origin branch the repo has no local copy of', async () => {
    const repo = repoWithOrigin();
    const result = await create(
      { path: repo },
      { from: { name: 'upstream-only', location: 'origin' } },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.worktree.base.mode).toBe('fresh');
    expect(result.worktree.base.ref).toBe('origin/upstream-only');
    expect(fs.existsSync(path.join(result.worktree.path, 'upstream.txt'))).toBe(true);
    // Its own new branch, never a checkout of origin's.
    expect(gitOk(repo, 'rev-parse', '--verify', 'refs/heads/upstream-only')).toBe(false);
  });

  it('refuses a branch that does not exist', async () => {
    const repo = makeRepo();
    const result = await create({ path: repo }, { from: { name: 'nope', location: 'local' } });
    expect(result).toEqual({ ok: false, reason: "The branch nope doesn't exist." });
  });
});

describe('worktreeNameProblem', () => {
  it('accepts generated-style and plain names, refuses paths and bad branch parts', () => {
    expect(worktreeNameProblem('calm-heron')).toBeNull();
    expect(worktreeNameProblem('Fix_login.2')).toBeNull();
    for (const bad of [
      '',
      'a/b',
      '../x',
      '-x',
      '.x',
      'x.',
      'x.lock',
      'a..b',
      'a b',
      'x'.repeat(65),
    ]) {
      expect(worktreeNameProblem(bad)).not.toBeNull();
    }
  });
});

describe('launchWorktreeChoices', () => {
  it('keeps well-formed choices only', () => {
    expect(
      launchWorktreeChoices({
        worktreeName: ' x ',
        worktreeFrom: { name: 'main', location: 'origin' },
      }),
    ).toEqual({ name: 'x', from: { name: 'main', location: 'origin' } });
    expect(
      launchWorktreeChoices({ worktreeFrom: { name: 'main', location: 'elsewhere' } }),
    ).toEqual({});
  });
});
