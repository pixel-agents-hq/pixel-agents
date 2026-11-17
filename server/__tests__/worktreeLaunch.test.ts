import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCreatedMessage } from '../src/agentMessages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { ClientMessageContext } from '../src/clientMessageHandler.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { IPty, PtyModule, PtySpawnOptions } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import type { AgentState } from '../src/types.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import {
  commitAll,
  GIT_TEST_TIMEOUT_MS,
  gitIn,
  gitOk,
  makeRepo,
  removeTempRepos,
  tempDir,
  waitForGit,
  writeFile,
} from './fixtures/gitRepos.js';
import { removeTempDir } from './helpers/removeTempDir.js';

// Waits follow git spawns (see waitForGit): room for them under a loaded run.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

/**
 * A launch into a Worktree, end to end on the server: the launch message from
 * the drawer's worktree button, a real git repo, the real runtime and store,
 * and a fake PTY (what it was asked to spawn, and where, is the outcome).
 */

class FakePty implements IPty {
  readonly pid = 4242;
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(): void {}
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener;
  }
  write(): void {}
  resize(): void {}
  /** A killed process exits a moment later, as a real one does. */
  kill(): void {
    setImmediate(() => this.exit(143));
  }
  /** Test driver: the process exits (`/exit`, the terminal ending). */
  exit(exitCode = 0): void {
    const listener = this.exitListener;
    this.exitListener = null;
    listener?.({ exitCode });
  }
}

describe('launching an agent into a Worktree', () => {
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let created: Array<Record<string, unknown>>;
  let spawns: PtySpawnOptions[];
  let ptys: FakePty[];
  let broadcasts: Array<Record<string, unknown>>;
  let failSpawn: boolean;
  let manager: PtySessionManager;

  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, runtime, ptyManager: manager, cache: null, privileged: true, ...overrides };
  }

  function dispatch(msg: Record<string, unknown>, context = ctx()): void {
    handleClientMessage(msg, (m) => sent.push(m), context);
  }

  beforeEach(() => {
    originalHome = process.env.HOME;
    process.env.HOME = tempDir('pxl-wt-home-');
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    sent = [];
    created = [];
    spawns = [];
    ptys = [];
    broadcasts = [];
    failSpawn = false;
    store.on('broadcast', (m: Record<string, unknown>) => broadcasts.push(m));
    store.on('agentAdded', (id: number, agent: AgentState) =>
      created.push(agentCreatedMessage(id, agent)),
    );
    const module: PtyModule = {
      spawn: (_file, _args, options) => {
        if (failSpawn) throw new Error('no such command');
        spawns.push(options);
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    };
    manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    process.env.HOME = originalHome;
    removeTempRepos();
  });

  it('spawns in the Worktree, as an agent of its Directory wearing its default character', async () => {
    const repo = makeRepo();
    dispatch({
      type: 'saveDirectory',
      name: 'Side Project',
      path: repo,
      characters: [4],
      worktreeBranchPrefix: 'feature/',
    });

    dispatch({ type: 'launchAgent', directoryPath: repo, worktree: true });
    await waitForGit(() => expect(store.size).toBe(1));

    const [entry] = readRegistry();
    expect(entry.directoryPath).toBe(repo);
    expect(entry.branch).toBe(`feature/${entry.name}`);
    expect(entry.path).toBe(path.join(repo, '.claude', 'worktrees', entry.name));

    // The process runs in the Worktree, on its own branch.
    expect(spawns).toHaveLength(1);
    expect(spawns[0].cwd).toBe(entry.path);
    expect(gitIn(entry.path, 'branch', '--show-current')).toBe(entry.branch);

    // Still the Directory's agent: its name (the Area key) and its default character.
    const id = [...store][0][0];
    const agent = store.get(id)!;
    expect(agent.directoryName).toBe('Side Project');
    expect(agent.palette).toBe(4);
    expect(entry.sessionIds).toEqual([agent.sessionId]);

    expect(created).toEqual([
      expect.objectContaining({
        type: 'agentCreated',
        id,
        directoryName: 'Side Project',
        worktree: { name: entry.name, branch: entry.branch },
      }),
    ]);
    expect(sent.filter((m) => m.type === 'worktreeRejected')).toEqual([]);
  });

  it('a host Directory (the start directory) takes the defaults: no prefix', async () => {
    const repo = makeRepo();
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    try {
      dispatch({ type: 'launchAgent', worktree: true });
      await waitForGit(() => expect(store.size).toBe(1));
    } finally {
      cwd.mockRestore();
    }
    const [entry] = readRegistry();
    expect(entry.branch).toBe(entry.name);
    expect(entry.base.mode).toBe('head');
    expect(store.get([...store][0][0])?.directoryName).toBe(path.basename(repo));
  });

  it('a failed create launches nothing and tells the office why', async () => {
    const plain = tempDir('pxl-not-a-repo-');
    dispatch({ type: 'saveDirectory', name: 'Plain', path: plain });

    dispatch({ type: 'launchAgent', directoryPath: plain, worktree: true });
    await waitForGit(() =>
      expect(sent).toContainEqual({
        type: 'worktreeRejected',
        directoryPath: plain,
        reason: expect.stringMatching(/not a git repository/) as unknown,
      }),
    );

    expect(spawns).toEqual([]);
    expect(store.size).toBe(0);
    expect(readRegistry()).toEqual([]);
    expect(fs.existsSync(path.join(plain, '.claude'))).toBe(false);
  });

  it('a worktree launch from a read-only client is refused before anything is made', async () => {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });

    dispatch(
      { type: 'launchAgent', directoryPath: repo, worktree: true },
      ctx({ privileged: false }),
    );
    // Give a create every chance to have started.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(spawns).toEqual([]);
    expect(store.size).toBe(0);
    expect(readRegistry()).toEqual([]);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('a Directory reports whether it is a git repo', () => {
    const repo = makeRepo();
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-plain-')));
    try {
      dispatch({ type: 'saveDirectory', name: 'Repo', path: repo });
      dispatch({ type: 'saveDirectory', name: 'Plain', path: plain });
      const saved = sent.filter((m) => m.type === 'directorySaved');
      expect(saved.map((m) => (m.directory as { isRepo: boolean }).isRepo)).toEqual([true, false]);
    } finally {
      removeTempDir(plain);
    }
  });
  // ── When the agent leaves ──

  async function launchedIntoWorktree(repo: string) {
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    dispatch({ type: 'launchAgent', directoryPath: repo, worktree: true });
    await waitForGit(() => expect(store.size).toBe(1));
    const [entry] = readRegistry();
    return { entry, id: [...store][0][0] };
  }

  const worktreeLists = () =>
    broadcasts.filter((m) => m.type === 'worktreesLoaded') as Array<{
      directoryPath: string;
      worktrees: Array<{ name: string; state: string; uncommittedFiles: number }>;
    }>;

  it('the PTY exiting retires the Worktree: a clean one goes entirely', async () => {
    const repo = makeRepo();
    const { entry } = await launchedIntoWorktree(repo);

    ptys[0].exit(0); // `/exit`
    await waitForGit(() => expect(readRegistry()).toEqual([]));
    expect(store.size).toBe(0);
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`)).toBe(
      false,
    );
    await waitForGit(() =>
      expect(worktreeLists().at(-1)).toEqual({
        type: 'worktreesLoaded',
        directoryPath: repo,
        worktrees: [],
        cliName: 'Claude Code',
      }),
    );
  });

  it('closing the card with nothing uncommitted closes at once; the leave rules run once the process exits', async () => {
    const repo = makeRepo();
    const { entry, id } = await launchedIntoWorktree(repo);
    writeFile(entry.path, 'work.txt', 'done\n');
    commitAll(entry.path, 'agent work');

    dispatch({ type: 'closeAgent', id });
    await waitForGit(() => expect(store.size).toBe(0));
    expect(sent.filter((m) => m.type === 'agentCloseQuestion')).toEqual([]);

    await waitForGit(() => expect(readRegistry()[0]?.state).toBe('parked'));
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(gitOk(repo, 'rev-parse', '--verify', `refs/heads/${entry.branch}`)).toBe(true);
    // The list every office is sent after the leave (so nothing lands in the next test).
    await waitForGit(() =>
      expect(worktreeLists().at(-1)?.worktrees).toEqual([
        expect.objectContaining({ name: entry.name, state: 'parked' }),
      ]),
    );
  });

  it('closing the card with uncommitted files asks first, and the answer closes it', async () => {
    const repo = makeRepo();
    const { entry, id } = await launchedIntoWorktree(repo);
    writeFile(entry.path, 'draft.txt', 'unsaved\n');

    dispatch({ type: 'closeAgent', id });
    await waitForGit(() =>
      expect(sent.filter((m) => m.type === 'agentCloseQuestion')).toEqual([
        expect.objectContaining({ id, name: entry.name, uncommittedFiles: 1 }),
      ]),
    );
    // Asked, not closed: the agent and its process still run.
    expect(store.has(id)).toBe(true);
    expect(manager.has(id)).toBe(true);

    dispatch({ type: 'closeAgent', id, worktreeChoice: 'save' });
    await waitForGit(() => expect(readRegistry()[0]?.state).toBe('parked'));
    expect(store.size).toBe(0);
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(gitIn(repo, 'show', `${entry.branch}:draft.txt`)).toBe('unsaved');
    // The list every office is sent after the leave (so nothing lands in the next test).
    await waitForGit(() =>
      expect(worktreeLists().at(-1)?.worktrees).toEqual([
        expect.objectContaining({ name: entry.name, state: 'parked' }),
      ]),
    );
    // Never shown as needing a decision on the way.
    expect(
      worktreeLists().some((m) =>
        (m.worktrees as Array<{ state: string }>).some((w) => w.state === 'needsDecision'),
      ),
    ).toBe(false);
  });

  it('uncommitted changes: the Worktree needs a decision, and every office is told', async () => {
    const repo = makeRepo();
    const { entry } = await launchedIntoWorktree(repo);
    writeFile(entry.path, 'draft.txt', 'unsaved\n');

    ptys[0].exit(0);
    await waitForGit(() =>
      expect(worktreeLists().at(-1)?.worktrees).toEqual([
        expect.objectContaining({ name: entry.name, state: 'needsDecision', uncommittedFiles: 1 }),
      ]),
    );
    expect(fs.readFileSync(path.join(entry.path, 'draft.txt'), 'utf-8')).toBe('unsaved\n');

    // Answered on one device: every office gets the list without the question.
    dispatch({ type: 'decideWorktree', directoryPath: repo, name: entry.name, choice: 'save' });
    await waitForGit(() =>
      expect(worktreeLists().at(-1)?.worktrees).toEqual([
        expect.objectContaining({ name: entry.name, state: 'parked', uncommittedFiles: 0 }),
      ]),
    );
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(gitIn(repo, 'log', '-1', '--format=%B', entry.branch)).toContain(
      'Pixel-Agents-Saved: true',
    );
  });

  it('a decideWorktree from a read-only client is refused', async () => {
    const repo = makeRepo();
    const { entry } = await launchedIntoWorktree(repo);
    writeFile(entry.path, 'draft.txt', 'unsaved\n');
    ptys[0].exit(0);
    await waitForGit(() => expect(readRegistry()[0]?.state).toBe('needsDecision'));

    dispatch(
      {
        type: 'decideWorktree',
        directoryPath: repo,
        name: entry.name,
        choice: 'discard',
        confirmedFiles: 1,
      },
      ctx({ privileged: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(readRegistry()[0]?.state).toBe('needsDecision');
    expect(fs.existsSync(path.join(entry.path, 'draft.txt'))).toBe(true);
  });

  it('a discard without the confirmed file count is refused', async () => {
    const repo = makeRepo();
    const { entry } = await launchedIntoWorktree(repo);
    writeFile(entry.path, 'draft.txt', 'unsaved\n');
    ptys[0].exit(0);
    await waitForGit(() => expect(readRegistry()[0]?.state).toBe('needsDecision'));

    dispatch({ type: 'decideWorktree', directoryPath: repo, name: entry.name, choice: 'discard' });
    await waitForGit(() =>
      expect(sent).toContainEqual(expect.objectContaining({ type: 'worktreeDecisionRejected' })),
    );
    expect(fs.existsSync(path.join(entry.path, 'draft.txt'))).toBe(true);
  });

  it('is not retired while another live agent still runs in it', async () => {
    const repo = makeRepo();
    const { entry, id } = await launchedIntoWorktree(repo);
    // A second agent in the same folder (the same session resumed elsewhere).
    const other = { ...store.get(id)!, id: 99, sessionId: 'other-session' };
    store.set(99, other);

    ptys[0].exit(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readRegistry()[0]?.state).toBe('active');
    expect(fs.existsSync(entry.path)).toBe(true);
  });

  it('a Worktree whose terminal could not start is retired right away', async () => {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    failSpawn = true;

    dispatch({ type: 'launchAgent', directoryPath: repo, worktree: true });
    await waitForGit(() =>
      expect(sent).toContainEqual(expect.objectContaining({ type: 'worktreeRejected' })),
    );
    await waitForGit(() => expect(readRegistry()).toEqual([]));
    expect(store.size).toBe(0);
    expect(fs.readdirSync(path.join(repo, '.claude', 'worktrees'))).toEqual([]);
  });
});
