import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { create } from '../src/worktreeCreate.js';
import { branchPrefixProblem, hasOriginRemote, isRepo } from '../src/worktreeGit.js';
import { inspect } from '../src/worktreeInspect.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { decide, retire } from '../src/worktreeRetire.js';
import {
  commitAll,
  gitIn,
  gitOk,
  makeRepo,
  removeTempRepos,
  tempDir,
  writeFile,
} from './fixtures/gitRepos.js';
import { clearTestHome, removeInTempDir } from './helpers/removeTempDir.js';

afterEach(() => {
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

/** A name generator handing out `names` in order. */
function names(...list: string[]): () => string {
  let i = 0;
  return () => list[Math.min(i++, list.length - 1)];
}

async function created(repo: string, options: Parameters<typeof create>[1] = {}) {
  const result = await create({ path: repo }, options);
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return result.worktree;
}

describe('isRepo', () => {
  it('is true for a repo root and false for a plain folder', () => {
    expect(isRepo(makeRepo())).toBe(true);
    expect(isRepo(tempDir())).toBe(false);
    expect(isRepo(path.join(tempDir(), 'missing'))).toBe(false);
  });
});

describe('hasOriginRemote', () => {
  it('is false for a repo with no origin and for a plain folder', () => {
    const repo = makeRepo();
    gitIn(repo, 'remote', 'add', 'upstream', 'https://example.com/u.git');
    expect(hasOriginRemote(repo)).toBe(false);
    expect(hasOriginRemote(tempDir())).toBe(false);
  });

  it("is true once origin is added, and in a linked worktree (its main repo's config)", () => {
    const repo = makeRepo();
    gitIn(repo, 'remote', 'add', 'origin', 'https://example.com/o.git');
    expect(hasOriginRemote(repo)).toBe(true);
    const linked = path.join(tempDir(), 'linked');
    gitIn(repo, 'worktree', 'add', '-b', 'side', linked);
    expect(hasOriginRemote(linked)).toBe(true);
  });
});

describe('create: naming', () => {
  it('makes a checkout at .claude/worktrees/<name> on branch prefix + name', async () => {
    const repo = makeRepo();
    const worktree = await created(repo, { prefix: 'feature/', pickName: names('brave-otter') });

    expect(worktree.name).toBe('brave-otter');
    expect(worktree.branch).toBe('feature/brave-otter');
    expect(worktree.path).toBe(path.join(repo, '.claude', 'worktrees', 'brave-otter'));
    expect(fs.readFileSync(path.join(worktree.path, 'README.md'), 'utf-8')).toBe('# test\n');
    expect(gitIn(worktree.path, 'branch', '--show-current')).toBe('feature/brave-otter');
  });

  it('generates a two-word kebab name by default', async () => {
    const worktree = await created(makeRepo());
    expect(worktree.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(worktree.branch).toBe(worktree.name);
  });

  it('retries past names taken by a folder or a branch', async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, '.claude', 'worktrees', 'taken-folder'), { recursive: true });
    gitIn(repo, 'branch', 'taken-branch');

    const worktree = await created(repo, {
      pickName: names('taken-folder', 'taken-branch', 'free-name'),
    });
    expect(worktree.name).toBe('free-name');
  });

  it('gives up with a reason when every name is taken, leaving nothing behind', async () => {
    const repo = makeRepo();
    gitIn(repo, 'branch', 'always-taken');
    const result = await create({ path: repo }, { pickName: names('always-taken') });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no free worktree name/i);
    expect(readRegistry()).toEqual([]);
  });

  it('refuses a folder that is not a repo, and a repo with no commits', async () => {
    const plain = await create({ path: tempDir() });
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.reason).toMatch(/not a git repository/);

    const empty = tempDir();
    gitIn(empty, 'init', '--quiet');
    const unborn = await create({ path: empty });
    expect(unborn.ok).toBe(false);
    if (!unborn.ok) expect(unborn.reason).toMatch(/no commits/);
  });

  it('refuses a prefix git would not accept in a branch name', async () => {
    const result = await create({ path: makeRepo() }, { prefix: 'bad..prefix/' });
    expect(result.ok).toBe(false);
    expect(branchPrefixProblem('bad..prefix/')).not.toBeNull();
    expect(branchPrefixProblem('feature/')).toBeNull();
    expect(branchPrefixProblem('')).toBeNull();
  });
});

describe('create: base', () => {
  it('head: starts from the main checkout current commit, unpushed work included', async () => {
    const repo = makeRepo();
    writeFile(repo, 'local.txt', 'unpushed\n');
    const tip = commitAll(repo, 'local work');

    const worktree = await created(repo, { base: 'head' });
    expect(worktree.base).toEqual({ mode: 'head', ref: 'main', commit: tip });
    expect(gitIn(worktree.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(fs.existsSync(path.join(worktree.path, 'local.txt'))).toBe(true);
  });

  it('fresh: starts from the latest default branch on origin', async () => {
    // origin = a bare repo another clone pushed a newer commit to.
    const repo = makeRepo();
    const origin = tempDir('pxl-origin-');
    gitIn(origin, 'init', '--quiet', '--bare');
    gitIn(repo, 'remote', 'add', 'origin', origin);
    gitIn(repo, 'push', '--quiet', 'origin', 'main');
    const other = tempDir('pxl-clone-');
    gitIn(other, 'clone', '--quiet', origin, '.');
    writeFile(other, 'upstream.txt', 'from origin\n');
    const upstream = commitAll(other, 'upstream work');
    gitIn(other, 'push', '--quiet', 'origin', 'main');

    const worktree = await created(repo, { base: 'fresh' });
    expect(worktree.base.mode).toBe('fresh');
    expect(worktree.base.commit).toBe(upstream);
    expect(fs.existsSync(path.join(worktree.path, 'upstream.txt'))).toBe(true);
  });

  it('fresh with an unreachable origin falls back to head', async () => {
    const repo = makeRepo();
    const tip = gitIn(repo, 'rev-parse', 'HEAD');
    gitIn(repo, 'remote', 'add', 'origin', path.join(tempDir(), 'no-such-remote.git'));

    const worktree = await created(repo, { base: 'fresh', fetchTimeoutMs: 5_000 });
    expect(worktree.base).toEqual({ mode: 'head', ref: 'main', commit: tip });
  });
});

describe('create: what the Worktree gets', () => {
  it('copies only the gitignored files .worktreeinclude matches, never overwriting', async () => {
    const repo = makeRepo({
      '.gitignore': '.env\n.env.local\nsecrets/\nbuild/\n',
      '.worktreeinclude': '.env\nsecrets/\nconfig.json\n',
      // Tracked and matched by .worktreeinclude: git checks it out; never copied over.
      'config.json': '{"tracked":true}\n',
    });
    writeFile(repo, '.env', 'KEY=1\n');
    writeFile(repo, '.env.local', 'NOT=included\n');
    writeFile(repo, 'secrets/token.txt', 'token\n');
    writeFile(repo, 'build/out.js', 'ignored but not included\n');
    writeFile(repo, 'config.json', '{"tracked":"edited in main"}\n');
    fs.symlinkSync(path.join(repo, '.env'), path.join(repo, 'secrets', 'link.txt'));

    const worktree = await created(repo);
    const read = (rel: string) => fs.readFileSync(path.join(worktree.path, rel), 'utf-8');
    expect(read('.env')).toBe('KEY=1\n');
    expect(read('secrets/token.txt')).toBe('token\n');
    expect(fs.existsSync(path.join(worktree.path, '.env.local'))).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'build'))).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'secrets', 'link.txt'))).toBe(false);
    // The committed version, not the main checkout's edit.
    expect(read('config.json')).toBe('{"tracked":true}\n');
  });

  it('never copies an untracked file that is not gitignored', async () => {
    const repo = makeRepo({ '.worktreeinclude': 'notes.txt\n' });
    writeFile(repo, 'notes.txt', 'untracked, not ignored\n');
    const worktree = await created(repo);
    expect(fs.existsSync(path.join(worktree.path, 'notes.txt'))).toBe(false);
  });

  it('links the symlink folders to the main checkout instead of copying them', async () => {
    const repo = makeRepo({
      '.gitignore': 'node_modules/\n',
      '.worktreeinclude': 'node_modules/\n',
    });
    writeFile(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');

    const worktree = await created(repo, {
      symlinkDirectories: ['node_modules', '../outside', '/abs', 'missing'],
    });
    const linked = path.join(worktree.path, 'node_modules');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linked)).toBe(path.join(repo, 'node_modules'));
    expect(fs.existsSync(path.join(worktree.path, 'missing'))).toBe(false);
  });

  it('the linked folders are ignored in the Worktree too, through one exclude line each', async () => {
    const repo = makeRepo({ '.gitignore': 'node_modules/\n' });
    writeFile(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    const mainStatus = gitIn(repo, 'status', '--porcelain');

    const first = await created(repo, { symlinkDirectories: ['node_modules'] });
    const second = await created(repo, { symlinkDirectories: ['node_modules'] });

    expect(fs.lstatSync(path.join(first.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(gitIn(first.path, 'status', '--porcelain')).toBe('');
    expect(gitIn(second.path, 'status', '--porcelain')).toBe('');
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.split('\n').filter((l) => l === '/node_modules')).toHaveLength(1);
    expect(gitIn(repo, 'status', '--porcelain')).toBe(mainStatus);
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8')).toBe('node_modules/\n');
  });

  it('hides the worktrees folder from git status through the local exclude, written once', async () => {
    const repo = makeRepo();
    await created(repo);
    await created(repo);

    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.split('\n').filter((l) => l === '/.claude/worktrees/')).toHaveLength(1);
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
    // The committed .gitignore is the user's: never touched.
    expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
  });

  it('records the Worktree in the registry and locks it while its agent runs', async () => {
    const repo = makeRepo();
    const before = Date.now();
    const worktree = await created(repo, { sessionId: 'session-1', pickName: names('calm-heron') });

    expect(readRegistry()).toEqual([
      {
        directoryPath: repo,
        name: 'calm-heron',
        path: worktree.path,
        branch: 'calm-heron',
        base: worktree.base,
        createdAt: expect.any(Number),
        lastUsedAt: expect.any(Number),
        activatedAt: expect.any(Number),
        state: 'active',
        sessionIds: ['session-1'],
        // This process: other Pixel Agents processes leave it alone.
        holder: { pid: process.pid, host: os.hostname() },
      },
    ]);
    expect(readRegistry()[0].createdAt).toBeGreaterThanOrEqual(before);

    const list = gitIn(repo, 'worktree', 'list', '--porcelain');
    expect(list).toContain(`worktree ${worktree.path}`);
    expect(list).toMatch(/locked Pixel Agents/);
    // Locked: git refuses to remove it (and a prune to drop it) while its agent runs.
    expect(gitOk(repo, 'worktree', 'remove', worktree.path)).toBe(false);
  });

  it('two creates at once in one repo get different names', async () => {
    const repo = makeRepo();
    const [a, b] = await Promise.all([
      create({ path: repo }, { pickName: names('same-name', 'other-name') }),
      create({ path: repo }, { pickName: names('same-name', 'other-name') }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.worktree.name).not.toBe(b.worktree.name);
    expect(readRegistry()).toHaveLength(2);
  });
});

// ── Leaving ─────────────────────────────────────────────────

function branchExists(repo: string, branch: string): boolean {
  return gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
}

function stateOf(worktreePath: string) {
  return readRegistry().find((e) => e.path === worktreePath)?.state;
}

describe('retire: the leave rules', () => {
  it('no changes and no commits of its own: folder, branch and entry all go', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);

    const result = await retire(worktree);
    expect(result).toMatchObject({ ok: true, outcome: 'removed' });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(false);
    expect(readRegistry()).toEqual([]);
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.path);
  });

  it('commits of its own: the folder goes, the branch is parked', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'feature.txt', 'work\n');
    const tip = commitAll(worktree.path, 'agent work');

    const result = await retire(worktree);
    expect(result).toMatchObject({ ok: true, outcome: 'parked' });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(gitIn(repo, 'rev-parse', worktree.branch)).toBe(tip);
    expect(stateOf(worktree.path)).toBe('parked');
  });

  it('uncommitted changes: nothing is touched and the Worktree needs a decision', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'README.md', '# edited\n');
    writeFile(worktree.path, 'new/untracked.txt', 'new\n');

    expect(await inspect(worktree)).toMatchObject({
      folderExists: true,
      uncommittedFiles: 2,
      uniqueCommits: 0,
    });
    const result = await retire(worktree);
    expect(result).toMatchObject({ ok: true, outcome: 'needsDecision' });
    expect(fs.readFileSync(path.join(worktree.path, 'README.md'), 'utf-8')).toBe('# edited\n');
    expect(fs.existsSync(path.join(worktree.path, 'new/untracked.txt'))).toBe(true);
    expect(branchExists(repo, worktree.branch)).toBe(true);
    expect(stateOf(worktree.path)).toBe('needsDecision');
  });

  it('gitignored files and the linked folders are not changes; the main checkout keeps its folder', async () => {
    const repo = makeRepo({
      '.gitignore': 'node_modules/\n.env\n',
      '.worktreeinclude': '.env\n',
    });
    writeFile(repo, '.env', 'KEY=1\n');
    writeFile(repo, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
    const worktree = await created(repo, { symlinkDirectories: ['node_modules'] });
    expect(fs.lstatSync(path.join(worktree.path, 'node_modules')).isSymbolicLink()).toBe(true);

    expect(await inspect(worktree)).toMatchObject({ uncommittedFiles: 0 });
    expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'removed' });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'node_modules/pkg/index.js'), 'utf-8')).toBe(
      'module.exports = 1;\n',
    );
  });

  it('a link left unignored (a Worktree made before links were excluded) is still not a change', async () => {
    const repo = makeRepo({ '.gitignore': 'node_modules/\n' });
    writeFile(repo, 'node_modules/pkg/index.js', 'x\n');
    const worktree = await created(repo, { symlinkDirectories: ['node_modules'] });
    const excludeFile = path.join(repo, '.git', 'info', 'exclude');
    fs.writeFileSync(
      excludeFile,
      fs.readFileSync(excludeFile, 'utf-8').replace('/node_modules\n', ''),
    );
    expect(gitIn(worktree.path, 'status', '--porcelain')).toBe('?? node_modules');

    expect(await inspect(worktree)).toMatchObject({ uncommittedFiles: 0 });
    expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'removed' });
    expect(fs.existsSync(path.join(repo, 'node_modules/pkg/index.js'))).toBe(true);
  });

  it('a squash-merged branch counts as merged: its branch is deleted', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'a.txt', 'a\n');
    commitAll(worktree.path, 'first');
    writeFile(worktree.path, 'b.txt', 'b\n');
    commitAll(worktree.path, 'second');
    // Squash-merge into main, with main moving on first.
    writeFile(repo, 'other.txt', 'other\n');
    commitAll(repo, 'unrelated work on main');
    gitIn(repo, 'merge', '--squash', worktree.branch);
    gitIn(repo, 'commit', '--quiet', '-m', 'squash merge');

    expect(await inspect(worktree)).toMatchObject({ uniqueCommits: 0, merged: true });
    expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'removed' });
    expect(branchExists(repo, worktree.branch)).toBe(false);
  });

  it('a rebase-merged branch counts as merged too', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'a.txt', 'a\n');
    const commit = commitAll(worktree.path, 'agent work');
    writeFile(repo, 'other.txt', 'other\n');
    commitAll(repo, 'unrelated work on main');
    gitIn(repo, 'cherry-pick', commit);

    expect(await inspect(worktree)).toMatchObject({ uniqueCommits: 0, merged: true });
  });

  it('only part of the branch merged: the rest is its own, the branch is parked', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'a.txt', 'a\n');
    const first = commitAll(worktree.path, 'first');
    writeFile(worktree.path, 'b.txt', 'b\n');
    commitAll(worktree.path, 'second');
    gitIn(repo, 'cherry-pick', first);

    expect(await inspect(worktree)).toMatchObject({ uniqueCommits: 1, merged: false });
    expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'parked' });
    expect(branchExists(repo, worktree.branch)).toBe(true);
  });

  it('a folder deleted by hand: git forgets it and the leave rules still apply', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    removeInTempDir(worktree.path);

    expect(await retire(worktree)).toMatchObject({ ok: true, outcome: 'removed' });
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.path);
    expect(readRegistry()).toEqual([]);
  });
});

describe('decide', () => {
  async function dirty(repo: string) {
    const worktree = await created(repo);
    writeFile(worktree.path, 'README.md', '# edited\n');
    writeFile(worktree.path, 'notes/new.txt', 'untracked\n');
    expect(await retire(worktree)).toMatchObject({ outcome: 'needsDecision' });
    return worktree;
  }

  it('save: commits everything, untracked included, with the trailer, then parks', async () => {
    const repo = makeRepo();
    const worktree = await dirty(repo);

    expect(await decide(worktree, { choice: 'save' })).toMatchObject({
      ok: true,
      outcome: 'parked',
    });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(stateOf(worktree.path)).toBe('parked');
    const message = gitIn(repo, 'log', '-1', '--format=%B', worktree.branch);
    expect(message).toContain('Pixel-Agents-Saved: true');
    expect(gitIn(repo, 'show', `${worktree.branch}:README.md`)).toBe('# edited');
    expect(gitIn(repo, 'show', `${worktree.branch}:notes/new.txt`)).toBe('untracked');
    // No identity configured (the tests' HOME is empty): the fallback one.
    expect(gitIn(repo, 'log', '-1', '--format=%an <%ae>', worktree.branch)).toBe(
      'Pixel Agents <pixel-agents@localhost>',
    );
  });

  it('save leaves gitignored files and the linked folders out of the commit', async () => {
    const repo = makeRepo({ '.gitignore': 'node_modules/\n.env\n' });
    writeFile(repo, 'node_modules/pkg/index.js', 'x\n');
    const worktree = await created(repo, { symlinkDirectories: ['node_modules'] });
    writeFile(worktree.path, '.env', 'SECRET=1\n');
    writeFile(worktree.path, 'work.txt', 'work\n');
    await retire(worktree);

    expect(await decide(worktree, { choice: 'save' })).toMatchObject({
      ok: true,
      outcome: 'parked',
    });
    const files = gitIn(repo, 'show', '--name-only', '--format=', worktree.branch);
    expect(files.split('\n')).toEqual(['work.txt']);
    expect(fs.existsSync(path.join(repo, 'node_modules/pkg/index.js'))).toBe(true);
  });

  it('keep: the folder stays exactly as it is', async () => {
    const repo = makeRepo();
    const worktree = await dirty(repo);

    expect(await decide(worktree, { choice: 'keep' })).toMatchObject({ ok: true, outcome: 'kept' });
    expect(fs.readFileSync(path.join(worktree.path, 'README.md'), 'utf-8')).toBe('# edited\n');
    expect(stateOf(worktree.path)).toBe('kept');
  });

  it('discard: the changes, the folder and a branch with no commits of its own all go', async () => {
    const repo = makeRepo();
    const worktree = await dirty(repo);

    expect(await decide(worktree, { choice: 'discard', confirmedFiles: 2 })).toMatchObject({
      ok: true,
      outcome: 'removed',
    });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(branchExists(repo, worktree.branch)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('discard keeps a branch that has commits of its own', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'feature.txt', 'work\n');
    const tip = commitAll(worktree.path, 'agent work');
    writeFile(worktree.path, 'scratch.txt', 'throwaway\n');
    await retire(worktree);

    expect(await decide(worktree, { choice: 'discard', confirmedFiles: 1 })).toMatchObject({
      ok: true,
      outcome: 'parked',
    });
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(gitIn(repo, 'rev-parse', worktree.branch)).toBe(tip);
    expect(stateOf(worktree.path)).toBe('parked');
  });

  it('discard is refused when more files changed than the user agreed to lose', async () => {
    const repo = makeRepo();
    const worktree = await dirty(repo);
    writeFile(worktree.path, 'late.txt', 'written after the question\n');

    const result = await decide(worktree, { choice: 'discard', confirmedFiles: 2 });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'late.txt'))).toBe(true);
    expect(stateOf(worktree.path)).toBe('needsDecision');
  });

  it('save on a Worktree that got clean in the meantime just applies the leave rules', async () => {
    const repo = makeRepo();
    const worktree = await dirty(repo);
    gitIn(worktree.path, 'checkout', '--', 'README.md');
    removeInTempDir(path.join(worktree.path, 'notes'));

    expect(await decide(worktree, { choice: 'save' })).toMatchObject({
      ok: true,
      outcome: 'removed',
    });
    expect(branchExists(repo, worktree.branch)).toBe(false);
  });

  it('is refused while an agent runs in it', async () => {
    const repo = makeRepo();
    const worktree = await created(repo);
    writeFile(worktree.path, 'work.txt', 'in progress\n');

    expect((await decide(worktree, { choice: 'discard', confirmedFiles: 1 })).ok).toBe(false);
    expect(fs.existsSync(path.join(worktree.path, 'work.txt'))).toBe(true);
  });
});

describe('never touching what is not ours', () => {
  it('refuses a worktree that is not in the registry', async () => {
    const repo = makeRepo();
    const theirs = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'claude-made', theirs);

    expect(await inspect({ path: theirs })).toBeNull();
    expect((await retire({ path: theirs })).ok).toBe(false);
    expect((await decide({ path: theirs }, { choice: 'discard', confirmedFiles: 0 })).ok).toBe(
      false,
    );
    expect(fs.existsSync(path.join(theirs, 'README.md'))).toBe(true);
    expect(branchExists(repo, 'claude-made')).toBe(true);
  });

  it('refuses a registry entry pointing at the main checkout or outside the worktrees folder', async () => {
    const repo = makeRepo();
    const elsewhere = path.join(repo, 'elsewhere');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'elsewhere', elsewhere);
    const base = { mode: 'head', commit: gitIn(repo, 'rev-parse', 'HEAD') };
    const entry = (p: string, name: string, branch: string) => ({
      directoryPath: repo,
      name,
      path: p,
      branch,
      base,
      createdAt: 0,
      lastUsedAt: 0,
      state: 'parked',
      sessionIds: [],
    });
    const registry = path.join(os.homedir(), '.pixel-agents', 'worktrees.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(
      registry,
      JSON.stringify([
        entry(repo, path.basename(repo), 'main'),
        entry(elsewhere, 'elsewhere', 'elsewhere'),
      ]),
    );

    for (const target of [repo, elsewhere]) {
      expect((await retire({ path: target })).ok).toBe(false);
      expect((await decide({ path: target }, { choice: 'discard', confirmedFiles: 0 })).ok).toBe(
        false,
      );
    }
    expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, 'README.md'))).toBe(true);
    expect(branchExists(repo, 'main')).toBe(true);
    expect(branchExists(repo, 'elsewhere')).toBe(true);
  });
});
