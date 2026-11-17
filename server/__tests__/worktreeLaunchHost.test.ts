import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { directoryAt } from '../src/directories.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { create } from '../src/worktreeCreate.js';
import { prepareWorktreeLaunch, retireUnlaunched } from '../src/worktreeLaunch.js';
import { holdWorktreesOf, retireWhenUnused, sweepWorktrees } from '../src/worktreeLeave.js';
import { readRegistry, recordSession } from '../src/worktreeRegistry.js';
import {
  GIT_TEST_TIMEOUT_MS,
  gitIn,
  gitOk,
  makeRepo,
  removeTempRepos,
  waitForGit,
} from './fixtures/gitRepos.js';
import { clearTestHome, removeTempDir } from './helpers/removeTempDir.js';

// Waits follow git spawns (see waitForGit): room for them under a loaded run.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

/**
 * The launch into a Worktree as any host sees it (worktreeLaunch.ts): the
 * standalone PTY and VS Code's editor terminal both hand it a `launch`. Here
 * the host is VS Code-shaped — an async launch into one of several workspace
 * folders (multi-root) — and the outcome is what exists on disk afterwards
 * and where the host was asked to run.
 */

function freshStore(): AgentStateStore {
  const store = new AgentStateStore();
  store.setAdapter(new FileStateAdapter({ namespace: 'vscode' }));
  return store;
}

afterEach(() => {
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

describe('launching into a Worktree from any host', () => {
  it('prepares a new Worktree of the workspace folder it names (multi-root), for the host to run in', async () => {
    const first = makeRepo();
    const second = makeRepo();
    const folders = [
      { name: 'first', path: first },
      { name: 'second', path: second },
    ];

    const prepared = await prepareWorktreeLaunch({
      directoryPath: second,
      directory: directoryAt(second, folders),
    });

    if (!prepared.ok) throw new Error(prepared.reason);
    const [entry] = readRegistry();
    expect(entry.directoryPath).toBe(second);
    expect(prepared.where).toEqual({
      cwd: entry.path,
      worktree: { name: entry.name, path: entry.path, branch: entry.branch },
      sessionId: entry.sessionIds[0],
    });
    expect(entry.path.startsWith(path.join(second, '.claude', 'worktrees') + path.sep)).toBe(true);
    expect(gitIn(entry.path, 'branch', '--show-current')).toBe(entry.branch);
    // The other folder is untouched.
    expect(fs.existsSync(path.join(first, '.claude'))).toBe(false);
  });

  it('a terminal that fails to start leaves no Worktree behind, and says why', async () => {
    const repo = makeRepo();
    const store = freshStore();
    const prepared = await prepareWorktreeLaunch({
      directoryPath: repo,
      directory: directoryAt(repo, [{ name: 'repo', path: repo }]),
    });
    if (!prepared.ok) throw new Error(prepared.reason);

    // The host's launch started nothing.
    const reason = retireUnlaunched(store, prepared.where);

    expect(reason).toContain(prepared.where.worktree.branch);
    // A new Worktree is clean: retired entirely, folder and branch.
    await waitForGit(() => expect(readRegistry()).toEqual([]));
    expect(fs.readdirSync(path.join(repo, '.claude', 'worktrees'))).toEqual([]);
    expect(gitIn(repo, 'branch', '--format=%(refname:short)')).toBe('main');
  });

  it('makes nothing when the terminal is unavailable or the path is no Directory', async () => {
    const repo = makeRepo();

    const noShell = await prepareWorktreeLaunch({
      directoryPath: repo,
      directory: directoryAt(repo, [{ name: 'repo', path: repo }]),
      terminalUnavailable: 'No shell.',
    });
    const nowhere = await prepareWorktreeLaunch({
      directoryPath: '/nowhere',
      directory: undefined,
    });

    expect(noShell).toEqual({ ok: false, reason: 'No shell.' });
    expect(nowhere).toEqual({ ok: false, reason: expect.stringContaining('/nowhere') as unknown });
    expect(readRegistry()).toEqual([]);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });
});

describe('the startup sweep with agents the host has not restored yet', () => {
  it('leaves a Worktree a saved terminal agent holds; retires one nobody holds', async () => {
    const repo = makeRepo();
    const held = await create({ path: repo }, { pickName: () => 'held' });
    const left = await create({ path: repo }, { pickName: () => 'left' });
    if (!held.ok || !left.ok) throw new Error('create failed');
    const store = freshStore();
    // A terminal agent saved by the last window holds `held` (VS Code
    // restores it only when the office opens, so every saved agent counts).
    store.getAdapter()!.saveAgents([
      {
        id: 1,
        sessionId: 's-1',
        terminalName: 'Claude Code #1',
        jsonlFile: '/p/s-1.jsonl',
        projectDir: '/p',
        worktree: { name: 'held', path: held.worktree.path, branch: held.worktree.branch },
      },
    ]);
    await sweepWorktrees(store, { savedAgentsHold: () => true });

    expect(fs.existsSync(path.join(held.worktree.path, 'README.md'))).toBe(true);
    expect(fs.existsSync(left.worktree.path)).toBe(false);
    expect(gitOk(repo, 'rev-parse', '--verify', `refs/heads/${left.worktree.branch}`)).toBe(false);
    expect(readRegistry().map((e) => [e.name, e.state])).toEqual([['held', 'active']]);
  });
});

describe('an office holding its Worktrees', () => {
  const registryFile = () => path.join(os.homedir(), '.pixel-agents', 'worktrees.json');
  const me = () => ({ pid: process.pid, host: os.hostname() });

  /** Rewrite every entry's holder (what another process left recorded). */
  function setHolder(holder: { pid: number; host: string }): void {
    fs.writeFileSync(registryFile(), JSON.stringify(readRegistry().map((e) => ({ ...e, holder }))));
  }

  function agentIn(
    id: number,
    worktree: { name: string; path: string; branch: string },
    extra: { isExternal: boolean; leadAgentId?: number },
  ) {
    return createAgentState({
      id,
      sessionId: `s-${id}`,
      projectDir: '/p',
      jsonlFile: `/p/s-${id}.jsonl`,
      worktree,
      ...extra,
    });
  }

  async function made(name: string) {
    const repo = makeRepo();
    const result = await create({ path: repo }, { pickName: () => name });
    if (!result.ok) throw new Error(result.reason);
    const { path: p, branch } = result.worktree;
    return { repo, worktree: { name, path: p, branch } };
  }

  it('an agent whose terminal this process owns makes this process the holder', async () => {
    const { worktree } = await made('reattached');
    // Left behind by a process that has since gone (a reload, a restart).
    setHolder({ pid: 999_999, host: os.hostname() });

    const store = freshStore();
    const stop = holdWorktreesOf(store);
    store.set(1, agentIn(1, worktree, { isExternal: false }));
    stop();

    expect(readRegistry()[0].holder).toEqual(me());
  });

  it('an owned agent that moved out of its Worktree still claims it', async () => {
    const { worktree } = await made('moved-from');
    setHolder({ pid: 999_999, host: os.hostname() });

    const store = freshStore();
    const stop = holdWorktreesOf(store);
    // Restored after moving itself into one of Claude's worktrees: the move
    // recorded its session in ours.
    recordSession(worktree, 's-1');
    const agent = agentIn(1, worktree, { isExternal: false });
    agent.worktree = { name: 'claude-made', path: '/elsewhere/claude-made', branch: 'worktree-x' };
    store.set(1, agent);
    stop();

    expect(readRegistry()[0].holder).toEqual(me());
  });

  it('an adopted agent, a Teammate or a Sub-agent in it never claims it', async () => {
    const { worktree } = await made('adopted');
    const owner = { pid: 999_999, host: os.hostname() };
    setHolder(owner);

    const store = freshStore();
    const stop = holdWorktreesOf(store);
    store.set(1, agentIn(1, worktree, { isExternal: true }));
    store.set(2, agentIn(2, worktree, { isExternal: true, leadAgentId: 1 }));
    store.set(3, agentIn(3, worktree, { isExternal: false, leadAgentId: 1 }));
    stop();

    expect(readRegistry()[0].holder).toEqual(owner);
  });

  it('an agent naming its Worktree by another spelling (a symlinked Directory) still holds it', async () => {
    const repo = makeRepo();
    // The Directory is reached through a symlink, so the registry spells the
    // Worktree through it, while a hook's cwd names the resolved folder.
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-link-')), 'repo');
    fs.symlinkSync(repo, link, 'dir');
    const result = await create({ path: link }, { pickName: () => 'spelled' });
    if (!result.ok) throw new Error(result.reason);
    const registered = result.worktree;
    const resolved = { ...registered, path: fs.realpathSync(registered.path) };
    expect(resolved.path).not.toBe(registered.path);

    const store = freshStore();
    store.set(1, agentIn(1, resolved, { isExternal: false }));
    await retireWhenUnused(store, registered);

    expect(fs.existsSync(path.join(registered.path, 'README.md'))).toBe(true);
    expect(readRegistry().map((e) => e.state)).toEqual(['active']);
    removeTempDir(path.dirname(link));
  });

  it("the launching office's leave retires it, though another office adopted the same session", async () => {
    // The launcher (this process) made it and runs its terminal.
    const { repo, worktree } = await made('two-offices');
    const launcher = freshStore();
    const stopLauncher = holdWorktreesOf(launcher);
    launcher.set(1, agentIn(1, worktree, { isExternal: false }));

    // Another office hears the session's hooks and adopts it by location.
    const adopter = freshStore();
    const stopAdopter = holdWorktreesOf(adopter);
    adopter.set(7, agentIn(7, worktree, { isExternal: true }));
    expect(readRegistry()[0].holder).toEqual(me());

    // The adopter sees an agent in it, so it retires nothing...
    await retireWhenUnused(adopter, worktree);
    expect(fs.existsSync(path.join(worktree.path, 'README.md'))).toBe(true);

    // ...and the launcher's terminal closing applies the leave rules.
    launcher.delete(1);
    await retireWhenUnused(launcher, worktree);
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(gitOk(repo, 'rev-parse', '--verify', `refs/heads/${worktree.branch}`)).toBe(false);
    expect(readRegistry()).toEqual([]);
    stopLauncher();
    stopAdopter();
  });
});
