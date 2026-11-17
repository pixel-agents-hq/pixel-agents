import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WORKTREE_KEPT_STALE_MS } from '../src/constants.js';
import { create } from '../src/worktreeCreate.js';
import { branchAt } from '../src/worktreeGit.js';
import { hold, readRegistry, type WorktreeEntry } from '../src/worktreeRegistry.js';
import { decide, lock, retire } from '../src/worktreeRetire.js';
import { sweep } from '../src/worktreeSweep.js';
import {
  commitAll,
  gitIn,
  gitOk,
  makeRepo,
  removeTempRepos,
  writeFile,
} from './fixtures/gitRepos.js';
import { clearTestHome, removeInTempDir, removeTempDir } from './helpers/removeTempDir.js';

/**
 * The startup sweep, against real temporary repos: what a crash or a closed
 * window left behind is tidied by the leave rules, and nothing that isn't
 * ours — or that an agent still runs in — is ever touched.
 */

afterEach(() => {
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

let counter = 0;
async function created(repo: string): Promise<WorktreeEntry> {
  const name = `wt-${++counter}`;
  const result = await create({ path: repo }, { pickName: () => name });
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return readRegistry().find((e) => e.path === result.worktree.path)!;
}

function registryFile(): string {
  return path.join(os.homedir(), '.pixel-agents', 'worktrees.json');
}

/** Rewrite one registry entry (a state the app would have left behind). */
function setEntry(entry: WorktreeEntry, patch: Partial<WorktreeEntry>): void {
  const entries = readRegistry().map((e) => (e.path === entry.path ? { ...e, ...patch } : e));
  fs.writeFileSync(registryFile(), JSON.stringify(entries));
}

function branchExists(repo: string, branch: string): boolean {
  return gitOk(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
}

function listed(repo: string): string {
  return gitIn(repo, 'worktree', 'list', '--porcelain');
}

const nobody = { inUse: () => false };

describe('sweep: crash leftovers (active, no live agent)', () => {
  it('a clean one goes entirely; one with commits is parked; one with changes waits, untouched', async () => {
    const repo = makeRepo();
    const clean = await created(repo);
    const committed = await created(repo);
    writeFile(committed.path, 'work.txt', 'done\n');
    commitAll(committed.path, 'agent work');
    const dirty = await created(repo);
    writeFile(dirty.path, 'draft.txt', 'not yet\n');

    const report = await sweep(nobody);

    expect(fs.existsSync(clean.path)).toBe(false);
    expect(branchExists(repo, clean.branch)).toBe(false);
    expect(fs.existsSync(committed.path)).toBe(false);
    expect(branchExists(repo, committed.branch)).toBe(true);
    expect(fs.readFileSync(path.join(dirty.path, 'draft.txt'), 'utf-8')).toBe('not yet\n');
    expect(readRegistry().map((e) => [e.name, e.state])).toEqual([
      [committed.name, 'parked'],
      [dirty.name, 'needsDecision'],
    ]);
    expect(report.changedDirectories).toEqual([repo]);
    expect(report.failures).toEqual([]);
  });

  it('only being made active after the sweep began spares one; a later touch of the entry does not', async () => {
    const repo = makeRepo();
    const touched = await created(repo);
    const fresh = await created(repo);
    const started = Date.now();
    // Activated before the sweep began, its entry written since (a session
    // recorded): still a leftover. Made active after it began: on its way.
    setEntry(touched, { activatedAt: started - 1_000, lastUsedAt: started + 1_000 });
    setEntry(fresh, { activatedAt: started + 1_000 });

    await sweep({ ...nobody, now: started });

    expect(fs.existsSync(touched.path)).toBe(false);
    expect(readRegistry().map((e) => [e.name, e.state])).toEqual([[fresh.name, 'active']]);
  });

  it('a Worktree an agent still runs in is never retired, and is locked again', async () => {
    const repo = makeRepo();
    const running = await created(repo);
    gitIn(repo, 'worktree', 'unlock', running.path);

    const report = await sweep({ inUse: (p) => p === running.path });

    expect(fs.existsSync(path.join(running.path, 'README.md'))).toBe(true);
    expect(readRegistry()[0].state).toBe('active');
    expect(listed(repo)).toMatch(/locked/);
    expect(report.events).toEqual([expect.objectContaining({ action: 'locked' })]);
  });

  it('a locked running Worktree survives git worktree prune, even with its folder away', async () => {
    const repo = makeRepo();
    const running = await created(repo);
    gitIn(repo, 'worktree', 'unlock', running.path);
    expect((await lock(running)).ok).toBe(true);

    // The folder briefly unreachable (an unmounted volume, a tool moving it).
    const away = `${running.path}-away`;
    fs.renameSync(running.path, away);
    gitIn(repo, 'worktree', 'prune');
    fs.renameSync(away, running.path);

    expect(listed(repo)).toContain(running.path);
    expect(gitIn(running.path, 'branch', '--show-current')).toBe(running.branch);
  });
});

describe('sweep: kept and parked Worktrees', () => {
  it('a kept folder untouched for 7 days needs a decision again; a recent one stays kept', async () => {
    const repo = makeRepo();
    const old = await created(repo);
    const recent = await created(repo);
    for (const entry of [old, recent]) {
      writeFile(entry.path, 'notes.txt', 'mine\n');
      expect((await retire(entry)).ok).toBe(true);
      expect((await decide(entry, { choice: 'keep' })).ok).toBe(true);
    }
    const now = Date.now() + WORKTREE_KEPT_STALE_MS + 60_000;
    // `recent` was touched just before the sweep; `old` a week before it.
    setEntry(old, { lastUsedAt: 0 });
    for (const p of [old.path, path.join(old.path, '.git')]) fs.utimesSync(p, 1, 1);
    setEntry(recent, { lastUsedAt: now - 1000 });

    const report = await sweep({ ...nobody, now });

    const states = Object.fromEntries(readRegistry().map((e) => [e.name, e.state]));
    expect(states).toEqual({ [old.name]: 'needsDecision', [recent.name]: 'kept' });
    // Flagging touches nothing on disk.
    expect(fs.readFileSync(path.join(old.path, 'notes.txt'), 'utf-8')).toBe('mine\n');
    expect(report.events).toContainEqual(
      expect.objectContaining({ name: old.name, action: 'flagged' }),
    );
  });

  it('a kept folder deleted by hand is reconciled: git forgets it and the branch is settled', async () => {
    const repo = makeRepo();
    const kept = await created(repo);
    writeFile(kept.path, 'notes.txt', 'mine\n');
    await retire(kept);
    await decide(kept, { choice: 'keep' });
    removeInTempDir(kept.path);

    await sweep(nobody);

    expect(listed(repo)).not.toContain(kept.path);
    // No commits of its own: nothing on the branch was lost by deleting it.
    expect(branchExists(repo, kept.branch)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('a parked branch merged into its base is deleted; an unmerged one stays parked', async () => {
    const repo = makeRepo();
    const merged = await created(repo);
    writeFile(merged.path, 'feature.txt', 'feature\n');
    commitAll(merged.path, 'feature');
    const unmerged = await created(repo);
    writeFile(unmerged.path, 'other.txt', 'other\n');
    commitAll(unmerged.path, 'other');
    await sweep(nobody); // both parked (crash leftovers with commits)
    expect(readRegistry().map((e) => e.state)).toEqual(['parked', 'parked']);

    // The first one lands on main as a squash merge.
    writeFile(repo, 'feature.txt', 'feature\n');
    commitAll(repo, 'Squashed feature (#1)');

    await sweep(nobody);

    expect(branchExists(repo, merged.branch)).toBe(false);
    expect(branchExists(repo, unmerged.branch)).toBe(true);
    expect(readRegistry().map((e) => [e.name, e.state])).toEqual([[unmerged.name, 'parked']]);
  });

  it('a parked entry whose branch was deleted by hand is dropped', async () => {
    const repo = makeRepo();
    const parked = await created(repo);
    writeFile(parked.path, 'work.txt', 'w\n');
    commitAll(parked.path, 'work');
    await sweep(nobody);
    gitIn(repo, 'branch', '-D', parked.branch);

    await sweep(nobody);

    expect(readRegistry()).toEqual([]);
  });
});

describe('sweep: never what is not ours', () => {
  it("leaves Claude's worktree (and its record, folder or not) alone, beside a vanished one of ours", async () => {
    const repo = makeRepo();
    const claudes = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'claude-made', claudes);
    writeFile(claudes, 'wip.txt', 'claude is working\n');
    const claudesGone = path.join(repo, '.claude', 'worktrees', 'claude-gone');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'claude-gone', claudesGone);
    removeInTempDir(claudesGone);

    const ours = await created(repo);
    removeInTempDir(ours.path);

    await sweep(nobody);

    // Ours: its record dropped. Claude's: both records still there — no prune.
    expect(listed(repo)).not.toContain(ours.path);
    expect(listed(repo)).toContain(claudes);
    expect(listed(repo)).toContain(claudesGone);
    expect(fs.readFileSync(path.join(claudes, 'wip.txt'), 'utf-8')).toBe('claude is working\n');
    expect(branchExists(repo, 'claude-made')).toBe(true);
    expect(branchExists(repo, 'claude-gone')).toBe(true);
  });

  it('skips a repo that is gone from disk, keeping its entries, and still sweeps the others', async () => {
    const gone = makeRepo();
    const goneEntry = await created(gone);
    removeTempDir(gone);
    const repo = makeRepo();
    const leftover = await created(repo);

    const report = await sweep(nobody);

    expect(readRegistry().map((e) => e.path)).toEqual([goneEntry.path]);
    expect(fs.existsSync(leftover.path)).toBe(false);
    expect(report.failures).toEqual([]);
  });
});

describe('branchAt', () => {
  it("reads the branch of any worktree, Claude's included, without changing it", () => {
    const repo = makeRepo();
    const claudes = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'feature/x', claudes);
    const before = listed(repo);

    expect(branchAt(claudes)).toBe('feature/x');
    expect(branchAt(repo)).toBe('main');
    expect(branchAt(path.join(repo, 'missing'))).toBeNull();
    expect(listed(repo)).toBe(before);
  });

  it('a detached worktree reads as its short commit', () => {
    const repo = makeRepo();
    const detached = path.join(repo, '.claude', 'worktrees', 'detached');
    gitIn(repo, 'worktree', 'add', '--quiet', '--detach', detached);
    expect(branchAt(detached)).toBe(gitIn(repo, 'rev-parse', 'HEAD').slice(0, 7));
  });
});

describe('another Pixel Agents process holding a Worktree', () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  /** A live process that is not this one: what another VS Code window's
   *  extension host, or the standalone server, looks like from here. */
  function otherProcess(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  }

  async function ended(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }

  it('a clean active Worktree a live foreign process holds survives the sweep; once that process is gone the next sweep retires it', async () => {
    const repo = makeRepo();
    const wt = await created(repo);
    const other = otherProcess();
    setEntry(wt, { holder: { pid: other.pid!, host: os.hostname() } });

    // This process has no agent in it, and still leaves it alone.
    await sweep(nobody);
    expect(fs.existsSync(path.join(wt.path, 'README.md'))).toBe(true);
    expect(branchExists(repo, wt.branch)).toBe(true);
    expect(readRegistry()[0]).toMatchObject({ state: 'active', holder: { pid: other.pid } });

    // Nor does the leave path of a process that isn't the holder.
    const refused = await retire(wt);
    expect(refused).toMatchObject({ ok: false });
    expect(fs.existsSync(wt.path)).toBe(true);

    await ended(other);
    await sweep(nobody);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(branchExists(repo, wt.branch)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('an entry with no holder (from before holders) is swept exactly as before', async () => {
    const repo = makeRepo();
    const free = await created(repo);
    const running = await created(repo);
    for (const wt of [free, running]) setEntry(wt, { holder: undefined });
    expect(readRegistry().every((e) => e.holder === undefined)).toBe(true);

    await sweep({ inUse: (p) => p === running.path });

    expect(fs.existsSync(free.path)).toBe(false);
    expect(fs.existsSync(path.join(running.path, 'README.md'))).toBe(true);
    expect(readRegistry().map((e) => [e.name, e.state])).toEqual([[running.name, 'active']]);
  });

  it('a holder on another host is trusted to be running: never deleted from here', async () => {
    const repo = makeRepo();
    const wt = await created(repo);
    // Its pid may well be dead here, or alive as something else: it means nothing on this host.
    setEntry(wt, { holder: { pid: 999_999, host: `${os.hostname()}-elsewhere` } });

    await sweep(nobody);
    expect(fs.existsSync(path.join(wt.path, 'README.md'))).toBe(true);
    expect(await retire(wt)).toMatchObject({ ok: false });
    expect(readRegistry()[0].state).toBe('active');
  });

  it('this process is the holder of what it creates, takes it over with hold, and drops it on leaving', async () => {
    const repo = makeRepo();
    const wt = await created(repo);
    const me = { pid: process.pid, host: os.hostname() };
    expect(readRegistry()[0].holder).toEqual(me);

    // A process restoring an agent in it claims it.
    setEntry(wt, { holder: { pid: 999_999, host: os.hostname() } });
    hold(wt);
    expect(readRegistry()[0].holder).toEqual(me);

    // Its own leave path retires it; a parked entry has no holder.
    writeFile(wt.path, 'work.txt', 'done\n');
    commitAll(wt.path, 'agent work');
    const left = await retire(wt);
    expect(left).toMatchObject({ ok: true, outcome: 'parked' });
    expect(readRegistry()[0].state).toBe('parked');
    expect(readRegistry()[0].holder).toBeUndefined();
    // hold never revives an entry that isn't running.
    hold(wt);
    expect(readRegistry()[0]).toMatchObject({ state: 'parked' });
    expect(readRegistry()[0].holder).toBeUndefined();
  });

  it('taking over from a live holder is logged, never silent', async () => {
    const repo = makeRepo();
    const wt = await created(repo);
    // Another live process on this host (our parent) holds it.
    setEntry(wt, { holder: { pid: process.ppid, host: os.hostname() } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      hold(wt);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`pid ${process.ppid}`));
    } finally {
      warn.mockRestore();
    }
    expect(readRegistry()[0].holder).toEqual({ pid: process.pid, host: os.hostname() });
  });

  it('a malformed holder reads as none', async () => {
    const repo = makeRepo();
    const wt = await created(repo);
    for (const junk of [
      { pid: 'x', host: 'h' },
      { pid: 0, host: 'h' },
      { pid: 1.5, host: 'h' },
      'pid',
      { pid: 1 },
    ]) {
      setEntry(wt, { holder: junk as never });
      const [entry] = readRegistry();
      expect(entry.name).toBe(wt.name);
      expect(entry.holder).toBeUndefined();
    }
  });
});
