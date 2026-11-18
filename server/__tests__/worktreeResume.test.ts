import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
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
import { create } from '../src/worktreeCreate.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { decide, retire } from '../src/worktreeRetire.js';
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

// Waits follow git spawns (see waitForGit): room for them under a loaded run.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });

/**
 * A Directory's Worktree conversations on the server: listed under the
 * Directory carrying their Worktree, resumed into the Worktree (rebuilt from
 * its branch when its folder was removed), and the Worktrees list's actions —
 * a real git repo, the real runtime and store, a fake PTY.
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

describe('Worktree conversations', () => {
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

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  /** A transcript where Claude Code files a session run in `cwd`. */
  function transcript(cwd: string, sessionId: string, title: string): string {
    const dir = path.join(os.homedir(), '.claude', 'projects', normalizeProjectPath(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: title }) + '\n');
    return file;
  }

  /** A Directory with one Worktree whose agent left changes, saved & removed. */
  async function parkedWorktree(sessionId = uuid(1)) {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    const made = await create({ path: repo }, { sessionId });
    if (!made.ok) throw new Error(made.reason);
    const worktree = made.worktree;
    transcript(worktree.path, sessionId, 'Build the thing');
    writeFile(worktree.path, 'README.md', '# edited\n');
    writeFile(worktree.path, 'notes/new.txt', 'untracked\n');
    await retire(worktree);
    expect(await decide(worktree, { choice: 'save' })).toMatchObject({ outcome: 'parked' });
    return { repo, worktree };
  }

  async function conversations() {
    sent.length = 0;
    dispatch({ type: 'requestConversations' });
    await waitForGit(() => expect(sent.some((m) => m.type === 'conversationsLoaded')).toBe(true));
    const loaded = sent.find((m) => m.type === 'conversationsLoaded') as {
      directories: Array<{ path: string; conversations: Array<Record<string, unknown>> }>;
    };
    return loaded.directories;
  }

  async function worktreesOf(repo: string) {
    sent.length = 0;
    dispatch({ type: 'requestWorktrees', directoryPath: repo });
    await waitForGit(() => expect(sent.some((m) => m.type === 'worktreesLoaded')).toBe(true));
    return (
      sent.find((m) => m.type === 'worktreesLoaded') as {
        worktrees: Array<Record<string, unknown>>;
      }
    ).worktrees;
  }

  it("lists a Worktree's sessions under its Directory, carrying the Worktree", async () => {
    const { repo, worktree } = await parkedWorktree();
    transcript(repo, uuid(2), 'In the main checkout');

    const directory = (await conversations()).find((d) => d.path === repo)!;
    expect(directory.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: uuid(1),
          title: 'Build the thing',
          worktree: { name: worktree.name, branch: worktree.branch },
        }),
        expect.objectContaining({ sessionId: uuid(2), title: 'In the main checkout' }),
      ]),
    );
    const main = directory.conversations.find((c) => c.sessionId === uuid(2))!;
    expect(main.worktree).toBeUndefined();
  });

  it('resuming a parked Worktree rebuilds it, saved changes uncommitted, and resumes there', async () => {
    const { repo, worktree } = await parkedWorktree();

    dispatch({ type: 'resumeConversation', sessionId: uuid(1), directoryPath: repo });
    await waitForGit(() => expect(store.size).toBe(1));

    expect(spawns).toHaveLength(1);
    expect(spawns[0].cwd).toBe(worktree.path);
    expect(gitIn(worktree.path, 'branch', '--show-current')).toBe(worktree.branch);
    expect(fs.readFileSync(path.join(worktree.path, 'README.md'), 'utf-8')).toBe('# edited\n');
    expect(
      gitIn(worktree.path, 'status', '--porcelain')
        .split('\n')
        .map((l) => l.trim())
        .sort(),
    ).toEqual(['?? notes/', 'M README.md']);
    const [id, agent] = [...store][0];
    expect(agent.sessionId).toBe(uuid(1));
    expect(agent.directoryName).toBe('Side Project');
    expect(created).toEqual([
      expect.objectContaining({
        id,
        directoryName: 'Side Project',
        worktree: { name: worktree.name, branch: worktree.branch },
      }),
    ]);
    expect(readRegistry()[0].state).toBe('active');
    expect(sent.filter((m) => m.type === 'worktreeRejected')).toEqual([]);

    // Its agent leaves again: the restored changes make it wait on a decision.
    ptys[0].exit(0);
    await waitForGit(() => expect(readRegistry()[0]?.state).toBe('needsDecision'));
  });

  it('a kept folder is resumed in place', async () => {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    const made = await create({ path: repo }, { sessionId: uuid(1) });
    if (!made.ok) throw new Error(made.reason);
    const worktree = made.worktree;
    transcript(worktree.path, uuid(1), 'Kept one');
    writeFile(worktree.path, 'work.txt', 'in progress\n');
    await retire(worktree);
    await decide(worktree, { choice: 'keep' });

    dispatch({ type: 'resumeConversation', sessionId: uuid(1), directoryPath: repo });
    await waitForGit(() => expect(store.size).toBe(1));
    expect(spawns[0].cwd).toBe(worktree.path);
    expect(fs.readFileSync(path.join(worktree.path, 'work.txt'), 'utf-8')).toBe('in progress\n');
  });

  it('a resume whose branch was deleted is refused, saying why, and launches nothing', async () => {
    const { repo, worktree } = await parkedWorktree();
    gitIn(repo, 'branch', '-D', worktree.branch);

    dispatch({ type: 'resumeConversation', sessionId: uuid(1), directoryPath: repo });
    await waitForGit(() =>
      expect(sent).toContainEqual({
        type: 'worktreeRejected',
        directoryPath: repo,
        reason: expect.stringMatching(/was deleted/) as unknown,
      }),
    );
    expect(spawns).toEqual([]);
    expect(store.size).toBe(0);
    expect(fs.existsSync(worktree.path)).toBe(false);
  });

  it('the Worktrees list: latest conversation, remove by the leave rules, delete a parked branch', async () => {
    const { repo, worktree } = await parkedWorktree();
    expect(await worktreesOf(repo)).toEqual([
      expect.objectContaining({
        name: worktree.name,
        owner: 'pixelAgents',
        state: 'parked',
        uniqueCommits: 1,
        latestSessionId: uuid(1),
      }),
    ]);

    // A parked branch with a commit merged nowhere: refused unconfirmed.
    sent.length = 0;
    dispatch({
      type: 'decideWorktree',
      directoryPath: repo,
      name: worktree.name,
      choice: 'deleteBranch',
    });
    await waitForGit(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'worktreeDecisionRejected', name: worktree.name }),
      ),
    );
    expect(gitOk(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${worktree.branch}`)).toBe(
      true,
    );

    dispatch({
      type: 'decideWorktree',
      directoryPath: repo,
      name: worktree.name,
      choice: 'deleteBranch',
      confirmedCommits: 1,
    });
    await waitForGit(() => expect(readRegistry()).toEqual([]));
    expect(gitOk(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${worktree.branch}`)).toBe(
      false,
    );
  });

  it('remove applies the leave rules to a kept folder', async () => {
    const repo = makeRepo();
    const made = await create({ path: repo });
    if (!made.ok) throw new Error(made.reason);
    const worktree = made.worktree;
    writeFile(worktree.path, 'feature.txt', 'work\n');
    commitAll(worktree.path, 'agent work');
    writeFile(worktree.path, 'scratch.txt', 'x\n');
    await retire(worktree);
    await decide(worktree, { choice: 'keep' });

    // Still uncommitted: it comes back needing a decision, nothing touched.
    dispatch({
      type: 'decideWorktree',
      directoryPath: repo,
      name: worktree.name,
      choice: 'remove',
    });
    await waitForGit(() => expect(readRegistry()[0]?.state).toBe('needsDecision'));
    expect(fs.existsSync(path.join(worktree.path, 'scratch.txt'))).toBe(true);

    // Clean but with a commit: the folder goes, the branch is parked.
    fs.rmSync(path.join(worktree.path, 'scratch.txt'));
    dispatch({
      type: 'decideWorktree',
      directoryPath: repo,
      name: worktree.name,
      choice: 'remove',
    });
    await waitForGit(() => expect(readRegistry()[0]?.state).toBe('parked'));
    expect(fs.existsSync(worktree.path)).toBe(false);
  });

  it("Claude Code's worktrees are listed as Claude's, with their conversations, and only removed", async () => {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    const theirs = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'worktree-claude-made', theirs);
    writeFile(theirs, 'draft.txt', 'claude work\n');
    transcript(theirs, uuid(3), 'Claude on its own');

    expect(await worktreesOf(repo)).toEqual([
      expect.objectContaining({
        name: 'claude-made',
        branch: 'worktree-claude-made',
        owner: 'cli',
        state: 'kept',
        uncommittedFiles: 1,
        latestSessionId: uuid(3),
      }),
    ]);
    // The list names the CLI they belong to, for their badge.
    expect(sent.find((m) => m.type === 'worktreesLoaded')).toMatchObject({
      cliName: 'Claude Code',
    });
    const directory = (await conversations()).find((d) => d.path === repo)!;
    expect(directory.conversations).toContainEqual(
      expect.objectContaining({
        sessionId: uuid(3),
        worktree: { name: 'claude-made', branch: 'worktree-claude-made' },
      }),
    );

    for (const choice of ['deleteBranch', 'discard', 'save', 'keep']) {
      sent.length = 0;
      dispatch({
        type: 'decideWorktree',
        directoryPath: repo,
        name: 'claude-made',
        choice,
        confirmedFiles: 99,
        confirmedCommits: 99,
      });
      await waitForGit(() =>
        expect(sent).toContainEqual({
          type: 'worktreeDecisionRejected',
          directoryPath: repo,
          name: 'claude-made',
          reason: expect.stringMatching(/Claude Code's/) as unknown,
        }),
      );
    }
    expect(fs.readFileSync(path.join(theirs, 'draft.txt'), 'utf-8')).toBe('claude work\n');
    expect(gitOk(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/worktree-claude-made')).toBe(
      true,
    );
    expect(readRegistry()).toEqual([]);

    // Resumed in place, wearing the marker; still not ours.
    dispatch({ type: 'resumeConversation', sessionId: uuid(3), directoryPath: repo });
    await waitForGit(() => expect(store.size).toBe(1));
    expect(spawns[0].cwd).toBe(theirs);
    expect(created[0]).toMatchObject({
      worktree: { name: 'claude-made', branch: 'worktree-claude-made' },
    });
    ptys[0].exit(0);
    await waitForGit(() => expect(store.size).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.existsSync(path.join(theirs, 'draft.txt'))).toBe(true);
    expect(readRegistry()).toEqual([]);
  });

  it("Remove on one of Claude Code's: folder and branch, only once nothing is in it and the losses were confirmed", async () => {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    const theirs = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'worktree-claude-made', theirs);
    writeFile(theirs, 'committed.txt', 'kept on the branch\n');
    gitIn(theirs, 'add', 'committed.txt');
    gitIn(theirs, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'work');
    writeFile(theirs, 'draft.txt', 'claude work\n');
    const remove = async (extra: Record<string, unknown>) => {
      sent.length = 0;
      broadcasts.length = 0;
      dispatch({
        type: 'decideWorktree',
        directoryPath: repo,
        name: 'claude-made',
        choice: 'remove',
        ...extra,
      });
      // Every answer ends with the Worktrees as they stand, sent to every office.
      await waitForGit(() =>
        expect(broadcasts.some((m) => m.type === 'worktreesLoaded')).toBe(true),
      );
      return sent.find((m) => m.type === 'worktreeDecisionRejected')?.reason as string | undefined;
    };

    // Claude's lock names a live session: this test's own process.
    gitIn(
      repo,
      'worktree',
      'lock',
      '--reason',
      `claude session claude-made (pid ${process.pid} start x)`,
      theirs,
    );
    expect(await remove({ confirmedFiles: 1, confirmedCommits: 1 })).toMatch(/Claude Code session/);
    // Its session is over (a pid no process has): the lock no longer holds it.
    gitIn(repo, 'worktree', 'unlock', theirs);
    gitIn(
      repo,
      'worktree',
      'lock',
      '--reason',
      'claude session claude-made (pid 2147483646 start x)',
      theirs,
    );

    // More than the user confirmed losing.
    expect(await remove({})).toMatch(/1 uncommitted file/);
    expect(await remove({ confirmedFiles: 1 })).toMatch(/1 commit merged nowhere else/);
    expect(fs.existsSync(path.join(theirs, 'draft.txt'))).toBe(true);

    expect(await remove({ confirmedFiles: 1, confirmedCommits: 1 })).toBeUndefined();
    expect(fs.existsSync(theirs)).toBe(false);
    expect(gitOk(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/worktree-claude-made')).toBe(
      false,
    );
    expect(await worktreesOf(repo)).toEqual([]);
    expect(readRegistry()).toEqual([]);
  });

  it("Remove on one of Claude Code's is refused while an office agent runs in it", async () => {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    const theirs = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'worktree-claude-made', theirs);
    transcript(theirs, uuid(4), 'Claude on its own');
    dispatch({ type: 'resumeConversation', sessionId: uuid(4), directoryPath: repo });
    await waitForGit(() => expect(store.size).toBe(1));

    sent.length = 0;
    dispatch({
      type: 'decideWorktree',
      directoryPath: repo,
      name: 'claude-made',
      choice: 'remove',
    });
    await waitForGit(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'worktreeDecisionRejected',
          reason: expect.stringMatching(/agent is still running/) as unknown,
        }),
      ),
    );
    expect(fs.existsSync(theirs)).toBe(true);
    ptys[0].exit(0);
    await waitForGit(() => expect(store.size).toBe(0));
  });

  it("a removed Worktree's conversation stays listed under its Directory and resumes in its checkout, moved there", async () => {
    const repo = makeRepo();
    dispatch({ type: 'saveDirectory', name: 'Side Project', path: repo });
    const theirs = path.join(repo, '.claude', 'worktrees', 'claude-made');
    gitIn(repo, 'worktree', 'add', '--quiet', '-b', 'worktree-claude-made', theirs);
    const old = transcript(theirs, uuid(5), 'Work in the worktree');
    fs.mkdirSync(path.join(path.dirname(old), uuid(5), 'subagents'), { recursive: true });

    sent.length = 0;
    broadcasts.length = 0;
    dispatch({
      type: 'decideWorktree',
      directoryPath: repo,
      name: 'claude-made',
      choice: 'remove',
    });
    await waitForGit(() => expect(broadcasts.some((m) => m.type === 'worktreesLoaded')).toBe(true));
    expect(fs.existsSync(theirs)).toBe(false);

    // Still listed, as the Directory's own now.
    const listed = (await conversations())
      .find((d) => d.path === repo)!
      .conversations.find((c) => c.sessionId === uuid(5));
    expect(listed).toMatchObject({ title: 'Work in the worktree' });
    expect(listed).not.toHaveProperty('worktree');

    dispatch({ type: 'resumeConversation', sessionId: uuid(5), directoryPath: repo });
    await waitForGit(() => expect(store.size).toBe(1));
    expect(fs.realpathSync(spawns[0].cwd!)).toBe(fs.realpathSync(repo));
    expect(created[0].worktree).toBeUndefined();
    // Moved where the CLI looks for the checkout's sessions, folder and all.
    const home = path.join(
      os.homedir(),
      '.claude',
      'projects',
      normalizeProjectPath(fs.realpathSync(repo)),
    );
    expect(fs.existsSync(path.join(home, `${uuid(5)}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(home, uuid(5), 'subagents'))).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    ptys[0].exit(0);
    await waitForGit(() => expect(store.size).toBe(0));
  });

  it("a parked Worktree's conversation is not taken for a removed one's", async () => {
    const { repo, worktree } = await parkedWorktree(uuid(6));
    transcript(worktree.path, uuid(6), 'Parked work');
    const listed = (await conversations())
      .find((d) => d.path === repo)!
      .conversations.find((c) => c.sessionId === uuid(6));
    expect(listed).toMatchObject({ worktree: { name: worktree.name } });
  });
});
