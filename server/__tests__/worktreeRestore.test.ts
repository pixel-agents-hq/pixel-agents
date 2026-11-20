import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { cliWorktreeHoldings, isCliWorktree, listCliWorktrees } from '../src/cliWorktrees.js';
import { create } from '../src/worktreeCreate.js';
import { worktreesOf } from '../src/worktreeListing.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { restore } from '../src/worktreeRestore.js';
import { decide, deleteParkedBranch, markIdle, retire } from '../src/worktreeRetire.js';
import {
  commitAll,
  gitIn,
  gitOk,
  makeRepo,
  removeTempRepos,
  writeFile,
} from './fixtures/gitRepos.js';
import { clearTestHome } from './helpers/removeTempDir.js';

/**
 * Bringing Worktrees back for a resume, and the Worktrees list's own actions,
 * against real temporary git repos: what is on disk and in git afterwards.
 */

afterEach(() => {
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

async function created(repo: string, options: Parameters<typeof create>[1] = {}) {
  const result = await create({ path: repo }, options);
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return result.worktree;
}

const stateOf = (p: string) => readRegistry().find((e) => e.path === p)?.state;
const branchExists = (repo: string, branch: string) =>
  gitOk(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
/** `git status --porcelain` lines, each trimmed, sorted. */
const status = (dir: string) =>
  gitIn(dir, 'status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
const isLocked = (repo: string, folder: string) =>
  gitIn(repo, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .some((block) => block.includes(`worktree ${folder}`) && /\nlocked/.test(block));

/** A Worktree whose agent left changes, saved & removed: parked on a save commit. */
async function savedAndParked(repo: string, options: Parameters<typeof create>[1] = {}) {
  const worktree = await created(repo, options);
  writeFile(worktree.path, 'README.md', '# edited\n');
  writeFile(worktree.path, 'notes/new.txt', 'untracked\n');
  await retire(worktree);
  expect(await decide(worktree, { choice: 'save' })).toMatchObject({ ok: true, outcome: 'parked' });
  expect(fs.existsSync(worktree.path)).toBe(false);
  return worktree;
}

describe('restore', () => {
  it('save → park → restore brings the changes back uncommitted, untracked files included', async () => {
    const repo = makeRepo();
    const base = gitIn(repo, 'rev-parse', 'HEAD');
    const worktree = await savedAndParked(repo);

    const result = await restore(worktree, { sessionId: 'session-2' });
    expect(result).toMatchObject({ ok: true, rebuilt: true, unsaved: true, priorState: 'parked' });
    expect(fs.readFileSync(path.join(worktree.path, 'README.md'), 'utf-8')).toBe('# edited\n');
    expect(fs.readFileSync(path.join(worktree.path, 'notes/new.txt'), 'utf-8')).toBe('untracked\n');
    expect(status(worktree.path)).toEqual(['?? notes/new.txt', 'M README.md']);
    // The save commit is gone from the branch: back on its base.
    expect(gitIn(repo, 'rev-parse', worktree.branch)).toBe(base);
    expect(gitIn(worktree.path, 'branch', '--show-current')).toBe(worktree.branch);
    expect(isLocked(repo, worktree.path)).toBe(true);
    expect(stateOf(worktree.path)).toBe('active');
    expect(readRegistry()[0].sessionIds).toContain('session-2');
  });

  it('a parked branch with real commits comes back as it was, commits kept', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'feature.txt', 'work\n');
    const tip = commitAll(worktree.path, 'agent work');
    expect(await retire(worktree)).toMatchObject({ outcome: 'parked' });

    expect(await restore(worktree)).toMatchObject({ ok: true, rebuilt: true, unsaved: false });
    expect(gitIn(worktree.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(status(worktree.path)).toEqual([]);
  });

  it('a kept folder is resumed in place, untouched', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'in progress\n');
    await retire(worktree);
    expect(await decide(worktree, { choice: 'keep' })).toMatchObject({ outcome: 'kept' });
    const head = gitIn(worktree.path, 'rev-parse', 'HEAD');

    const result = await restore(worktree);
    expect(result).toMatchObject({ ok: true, rebuilt: false, unsaved: false, priorState: 'kept' });
    expect(fs.readFileSync(path.join(worktree.path, 'work.txt'), 'utf-8')).toBe('in progress\n');
    expect(gitIn(worktree.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(status(worktree.path)).toEqual(['?? work.txt']);
    expect(stateOf(worktree.path)).toBe('active');

    // A resume that never started puts it back.
    expect(await markIdle(worktree, 'kept')).toMatchObject({ ok: true });
    expect(stateOf(worktree.path)).toBe('kept');
  });

  it('relinks the symlink folders and copies the .worktreeinclude files, as create does', async () => {
    const repo = makeRepo({ '.gitignore': 'node_modules/\n.env\n', '.worktreeinclude': '.env\n' });
    writeFile(repo, 'node_modules/pkg/index.js', 'x\n');
    writeFile(repo, '.env', 'SECRET=1\n');
    const worktree = await savedAndParked(repo, { symlinkDirectories: ['node_modules'] });

    await restore(worktree, { symlinkDirectories: ['node_modules'] });
    expect(fs.lstatSync(path.join(worktree.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(worktree.path, '.env'), 'utf-8')).toBe('SECRET=1\n');
    // This repo has no README: the saved one is new, so it comes back untracked.
    expect(status(worktree.path)).toEqual(['?? README.md', '?? notes/new.txt']);
  });

  it('is refused when the branch was deleted, leaving nothing behind', async () => {
    const repo = makeRepo();
    const worktree = await savedAndParked(repo);
    gitIn(repo, 'branch', '-D', worktree.branch);

    const result = await restore(worktree);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('was deleted');
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(stateOf(worktree.path)).toBe('parked');
  });

  it('is refused when something else sits at its path, which is left alone', async () => {
    const repo = makeRepo();
    const worktree = await savedAndParked(repo);
    writeFile(worktree.path, 'someone-else.txt', 'mine\n');

    expect((await restore(worktree)).ok).toBe(false);
    expect(fs.readdirSync(worktree.path)).toEqual(['someone-else.txt']);
    expect(gitIn(repo, 'log', '-1', '--format=%B', worktree.branch)).toContain(
      'Pixel-Agents-Saved: true',
    );
  });
});

describe('deleteParkedBranch', () => {
  async function parkedWithWork(repo: string) {
    const worktree = await created(repo);
    writeFile(worktree.path, 'feature.txt', 'work\n');
    commitAll(worktree.path, 'agent work');
    expect(await retire(worktree)).toMatchObject({ outcome: 'parked' });
    return worktree;
  }

  it('needs the user to confirm losing commits merged nowhere, then deletes branch and entry', async () => {
    const repo = makeRepo();
    const worktree = await parkedWithWork(repo);

    expect((await deleteParkedBranch(worktree)).ok).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(true);

    expect(await deleteParkedBranch(worktree, { confirmedCommits: 1 })).toMatchObject({
      ok: true,
      outcome: 'removed',
    });
    expect(branchExists(repo, worktree.branch)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('needs no confirmation when another branch holds its commits', async () => {
    const repo = makeRepo();
    const worktree = await parkedWithWork(repo);
    gitIn(repo, 'branch', 'backup', worktree.branch);

    expect(await deleteParkedBranch(worktree)).toMatchObject({ ok: true, outcome: 'removed' });
    expect(branchExists(repo, 'backup')).toBe(true);
  });

  it('is refused for a Worktree whose folder is still there', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'in progress\n');
    await retire(worktree);
    await decide(worktree, { choice: 'keep' });

    expect((await deleteParkedBranch(worktree, { confirmedCommits: 99 })).ok).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(true);
    expect(fs.existsSync(path.join(worktree.path, 'work.txt'))).toBe(true);
  });
});

describe("Claude Code's worktrees", () => {
  it('are listed when under .claude/worktrees/ and not ours; never acted on', async () => {
    const repo = makeRepo();
    const ours = await created(repo);
    const theirs = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'worktree-claude-made', theirs);
    writeFile(theirs, 'draft.txt', 'claude work\n');
    const elsewhere = path.join(repo, 'elsewhere');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'elsewhere', elsewhere);

    const listed = await listCliWorktrees(repo);
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'claude-made',
        path: theirs,
        branch: 'worktree-claude-made',
      }),
    ]);
    const holds = await cliWorktreeHoldings(repo, listed[0]);
    expect(holds).toMatchObject({ uncommittedFiles: 1, uniqueCommits: 0 });
    expect(holds.sizeBytes).toBeGreaterThan(0);
    // The one listing: ours, then Claude Code's.
    expect((await worktreesOf(repo, { details: false })).map((w) => [w.name, w.owner])).toEqual([
      [ours.name, 'pixelAgents'],
      ['claude-made', 'cli'],
    ]);
    expect(isCliWorktree(repo, 'claude-made')).toBe(true);
    expect(isCliWorktree(repo, ours.name)).toBe(false);
    expect(isCliWorktree(repo, '../elsewhere')).toBe(false);

    expect((await restore({ path: theirs })).ok).toBe(false);
    expect((await deleteParkedBranch({ path: theirs }, { confirmedCommits: 99 })).ok).toBe(false);
    expect((await markIdle({ path: theirs }, 'kept')).ok).toBe(false);
    expect(fs.readFileSync(path.join(theirs, 'draft.txt'), 'utf-8')).toBe('claude work\n');
    expect(branchExists(repo, 'worktree-claude-made')).toBe(true);
  });
});
