import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { create } from '../src/worktreeCreate.js';
import { git, gitIn as gitInFolder, isOwnCheckout } from '../src/worktreeGit.js';
import { inspect } from '../src/worktreeInspect.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { decide, retire } from '../src/worktreeRetire.js';
import { sweep } from '../src/worktreeSweep.js';
import {
  commitAll,
  gitIn,
  gitOk,
  linkTo,
  makeRepo,
  removeTempRepos,
  writeFile,
} from './fixtures/gitRepos.js';
import { clearTestHome, removeInTempDir } from './helpers/removeTempDir.js';

/**
 * The edge the leave rules must never misread: a Worktree folder that is
 * still on disk but is no longer a readable linked worktree (its `.git` file
 * deleted). It is not "gone" — it may hold the agent's uncommitted work — and
 * git run inside it must never walk up into the main checkout.
 */

afterEach(() => {
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

let counter = 0;
async function created(repo: string) {
  const name = `safe-${++counter}`;
  const result = await create({ path: repo }, { pickName: () => name });
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return result.worktree;
}

function branchExists(repo: string, branch: string): boolean {
  return gitOk(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
}

function stateOf(worktreePath: string): string | undefined {
  return readRegistry().find((e) => e.path === worktreePath)?.state;
}

/** Remove the Worktree's `.git` file, leaving the folder and its files. */
function breakGitFile(worktreePath: string): void {
  fs.rmSync(path.join(worktreePath, '.git'));
}

describe('a Worktree folder that is there but unreadable (no .git file)', () => {
  it('retire: the branch stays, the entry needs a decision, the folder is untouched', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'uncommitted work\n');
    breakGitFile(worktree.path);

    expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'needsDecision' });
    expect(branchExists(repo, worktree.branch)).toBe(true);
    expect(stateOf(worktree.path)).toBe('needsDecision');
    expect(fs.readFileSync(path.join(worktree.path, 'work.txt'), 'utf-8')).toBe(
      'uncommitted work\n',
    );
  });

  it('inspect reports it as present and holding changes, never as gone', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    breakGitFile(worktree.path);

    const state = await inspect(worktree);
    expect(state?.folderExists).toBe(true);
    expect(state?.uncommittedFiles).toBe(Number.MAX_SAFE_INTEGER);
    expect(state?.sizeBytes).toBeGreaterThan(0);
  });

  it('save is refused and the main checkout is left exactly as it was', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'work\n');
    await retire(worktree);
    // The user's own uncommitted work in the main checkout.
    writeFile(repo, 'README.md', '# the user is editing this\n');
    writeFile(repo, 'mine.txt', 'not the agent\n');
    const headBefore = gitIn(repo, 'rev-parse', 'HEAD');
    const statusBefore = gitIn(repo, 'status', '--porcelain');
    breakGitFile(worktree.path);

    const result = await decide(worktree, { choice: 'save' });

    expect(result.ok).toBe(false);
    expect(gitIn(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(gitIn(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(gitIn(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(fs.existsSync(path.join(worktree.path, 'work.txt'))).toBe(true);
  });

  it('discard is refused: git will not remove a folder without its .git file', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'work\n');
    await retire(worktree);
    breakGitFile(worktree.path);

    const result = await decide(worktree, { choice: 'discard', confirmedFiles: 1 });

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'work.txt'))).toBe(true);
    expect(branchExists(repo, worktree.branch)).toBe(true);
  });

  it('keep keeps it', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'work\n');
    await retire(worktree);
    breakGitFile(worktree.path);

    expect(await decide(worktree, { choice: 'keep' })).toMatchObject({ ok: true, outcome: 'kept' });
    expect(fs.existsSync(path.join(worktree.path, 'work.txt'))).toBe(true);
  });

  it('the sweep neither retires a kept one nor settles a parked one whose folder came back', async () => {
    const repo = makeRepo();
    const kept = await created(repo);
    writeFile(kept.path, 'notes.txt', 'mine\n');
    await retire(kept);
    await decide(kept, { choice: 'keep' });
    breakGitFile(kept.path);

    // A parked Worktree whose branch is now merged, and something at its path again.
    const parked = await created(repo);
    writeFile(parked.path, 'feature.txt', 'feature\n');
    commitAll(parked.path, 'feature');
    expect(await retire(parked)).toMatchObject({ outcome: 'parked' });
    gitIn(repo, 'merge', '--quiet', '--ff-only', parked.branch);
    writeFile(parked.path, 'restored-by-hand.txt', 'hands off\n');

    await sweep({ inUse: () => false });

    expect(branchExists(repo, kept.branch)).toBe(true);
    expect(fs.readFileSync(path.join(kept.path, 'notes.txt'), 'utf-8')).toBe('mine\n');
    expect(stateOf(kept.path)).toBeDefined();
    expect(branchExists(repo, parked.branch)).toBe(true);
    expect(stateOf(parked.path)).toBe('parked');
    expect(fs.existsSync(path.join(parked.path, 'restored-by-hand.txt'))).toBe(true);
  });
});

describe('discard needs the confirmed file count', () => {
  it('is refused without one, whoever calls', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'work\n');
    await retire(worktree);

    const result = await decide(worktree, { choice: 'discard' } as unknown as Parameters<
      typeof decide
    >[1]);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'work.txt'))).toBe(true);
    expect(stateOf(worktree.path)).toBe('needsDecision');
  });
});

describe('git run inside a Worktree stops at its folder', () => {
  it('without the .git file, plain git walks up to the main checkout; gitIn does not', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(repo, 'mine.txt', 'the main checkout\n');
    expect(await isOwnCheckout(worktree.path)).toBe(true);
    breakGitFile(worktree.path);

    // The hazard: git finds the main checkout above the folder.
    const plain = await git(worktree.path, ['status', '--porcelain']);
    expect(plain.ok).toBe(true);
    expect(plain.stdout).toContain('mine.txt');

    const ceiled = await gitInFolder(worktree.path, ['status', '--porcelain']);
    expect(ceiled.ok).toBe(false);
    expect(ceiled.stderr).toMatch(/not a git repository/);
    expect(await isOwnCheckout(worktree.path)).toBe(false);
  });

  it('holds when the repo is reached through a symlink', async () => {
    const repo = makeRepo();
    const result = await create({ path: linkTo(repo) }, { pickName: () => 'linked' });
    if (!result.ok) throw new Error(result.reason);
    const { path: folder } = result.worktree;
    expect(folder).not.toBe(fs.realpathSync(folder));
    expect(await isOwnCheckout(folder)).toBe(true);
    expect((await gitInFolder(folder, ['status', '--porcelain'])).ok).toBe(true);
    breakGitFile(folder);

    expect((await gitInFolder(folder, ['status', '--porcelain'])).ok).toBe(false);
  });
});

/**
 * `git worktree remove` deletes the folder first and its record last, and drops
 * the record even when part of the folder can't be deleted (a container's
 * mount, a file it may not delete): the folder is then half gone and no longer
 * a worktree git knows. Here a read-only, gitignored folder stands in for what
 * another program holds.
 */
describe('a removal git leaves half done', () => {
  /** A gitignored `held/sub/f` that can't be deleted until `release`. */
  function holdPartOf(repo: string, worktreePath: string): { release: () => void } {
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'held/\n');
    const sub = path.join(worktreePath, 'held', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'f'), 'x');
    fs.chmodSync(sub, 0o555);
    const worktrees = path.dirname(worktreePath);
    return {
      release: () => {
        for (const name of fs.readdirSync(worktrees)) {
          const held = path.join(worktrees, name, 'held', 'sub');
          if (fs.existsSync(held)) fs.chmodSync(held, 0o755);
        }
      },
    };
  }

  it('retire finishes it: the folder is gone and the branch settled', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    const held = holdPartOf(repo, worktree.path);
    try {
      expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'removed' });
      expect(fs.existsSync(worktree.path)).toBe(false);
      expect(branchExists(repo, worktree.branch)).toBe(false);
      expect(stateOf(worktree.path)).toBeUndefined();
    } finally {
      held.release();
    }
  });

  it('one already left that way: discard finishes it, save and retire leave it', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'tracked.txt', 'kept\n');
    commitAll(worktree.path, 'work');
    const held = holdPartOf(repo, worktree.path);
    try {
      // What the office found after the leave: git's record gone, the folder
      // (its .git file included) still there.
      gitIn(repo, 'worktree', 'unlock', worktree.path);
      removeInTempDir(path.join(repo, '.git', 'worktrees', path.basename(worktree.path)));

      expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'needsDecision' });
      expect((await decide(worktree, { choice: 'save' })).ok).toBe(false);
      expect(fs.existsSync(path.join(worktree.path, 'tracked.txt'))).toBe(true);

      const result = await decide(worktree, {
        choice: 'discard',
        confirmedFiles: Number.MAX_SAFE_INTEGER,
      });
      expect(result).toMatchObject({ ok: true, outcome: 'parked' });
      expect(fs.existsSync(worktree.path)).toBe(false);
      expect(branchExists(repo, worktree.branch)).toBe(true);
    } finally {
      held.release();
    }
  });

  it('a folder git still lists is never finished by hand', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'work\n');

    expect(await retire(worktree)).toMatchObject({ outcome: 'needsDecision' });
    expect(fs.existsSync(path.join(worktree.path, 'work.txt'))).toBe(true);
    expect(gitOk(repo, 'worktree', 'list')).toBe(true);
    expect(gitIn(repo, 'worktree', 'list')).toContain(path.basename(worktree.path));
  });
});
