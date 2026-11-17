import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { WORKTREE_CLOSE_CHOICE_TTL_MS } from '../src/constants.js';
import { create } from '../src/worktreeCreate.js';
import { handleCloseAgent, retireWorktreesLeftBy } from '../src/worktreeLeave.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { gitIn, gitOk, makeRepo, removeTempRepos, writeFile } from './fixtures/gitRepos.js';
import { clearTestHome } from './helpers/removeTempDir.js';

/** The card's ×: a Worktree agent with uncommitted files is asked about
 *  before it is stopped, and the answer is applied when it has exited. */

afterEach(() => {
  vi.restoreAllMocks();
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

async function launched(store: AgentStateStore, id = 1, sessionId = 's-1') {
  const repo = makeRepo();
  const result = await create({ path: repo }, { pickName: () => 'calm-heron', sessionId });
  if (!result.ok) throw new Error(result.reason);
  const { worktree } = result;
  store.set(
    id,
    createAgentState({
      id,
      sessionId,
      isExternal: false,
      projectDir: '/p',
      jsonlFile: `/p/${sessionId}.jsonl`,
      worktree: { name: worktree.name, path: worktree.path, branch: worktree.branch },
    }),
  );
  return { repo, worktree };
}

/** Press × (with an answer, or none): what the server sent, and whether it closed. */
async function pressClose(store: AgentStateStore, msg: Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  const closed: number[] = [];
  await handleCloseAgent(
    store,
    { type: 'closeAgent', ...msg },
    (m) => sent.push(m),
    (id) => closed.push(id),
  );
  return { sent, closed };
}

/** The agent's process exits: out of the store, then the leave rules. */
async function exits(store: AgentStateStore, id: number) {
  const agent = store.get(id)!;
  store.delete(id);
  await retireWorktreesLeftBy(store, agent);
}

const stateOf = (worktreePath: string) =>
  readRegistry().find((e) => e.path === worktreePath)?.state;

describe('closing a Worktree agent from its card', () => {
  it('nothing uncommitted: it closes at once, nothing asked', async () => {
    const store = new AgentStateStore();
    const { worktree } = await launched(store);
    expect(await pressClose(store, { id: 1 })).toEqual({ sent: [], closed: [1] });
    await exits(store, 1);
    expect(fs.existsSync(worktree.path)).toBe(false);
  });

  it('uncommitted files: asks first and leaves the agent running', async () => {
    const store = new AgentStateStore();
    const { repo, worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    const { sent, closed } = await pressClose(store, { id: 1 });
    expect(closed).toEqual([]);
    expect(sent).toEqual([
      {
        type: 'agentCloseQuestion',
        id: 1,
        directoryPath: repo,
        name: 'calm-heron',
        branch: worktree.branch,
        uncommittedFiles: 1,
      },
    ]);
    expect(stateOf(worktree.path)).toBe('active');
  });

  it('save: closes it, and the exit commits the files and parks the branch, never asking again', async () => {
    const store = new AgentStateStore();
    const { repo, worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    expect(await pressClose(store, { id: 1, worktreeChoice: 'save' })).toEqual({
      sent: [],
      closed: [1],
    });
    await exits(store, 1);
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(stateOf(worktree.path)).toBe('parked');
    expect(gitIn(repo, 'show', `${worktree.branch}:notes.txt`)).toBe('hello');
    expect(gitIn(repo, 'log', '-1', '--format=%B', worktree.branch)).toContain(
      'Pixel-Agents-Saved: true',
    );
  });

  it('keep: the folder stays as it is', async () => {
    const store = new AgentStateStore();
    const { worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    await pressClose(store, { id: 1, worktreeChoice: 'keep' });
    await exits(store, 1);
    expect(stateOf(worktree.path)).toBe('kept');
    expect(fs.readFileSync(path.join(worktree.path, 'notes.txt'), 'utf8')).toBe('hello\n');
  });

  it('discard: the confirmed files go with the folder and the branch', async () => {
    const store = new AgentStateStore();
    const { repo, worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    await pressClose(store, { id: 1, worktreeChoice: 'discard', confirmedFiles: 1 });
    await exits(store, 1);
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(gitOk(repo, 'rev-parse', '--verify', worktree.branch)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('a discard of fewer files than there are now is asked again, the agent left running', async () => {
    const store = new AgentStateStore();
    const { worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');
    writeFile(worktree.path, 'more.txt', 'more\n');

    const { sent, closed } = await pressClose(store, {
      id: 1,
      worktreeChoice: 'discard',
      confirmedFiles: 1,
    });
    expect(closed).toEqual([]);
    expect(sent).toMatchObject([{ type: 'agentCloseQuestion', uncommittedFiles: 2 }]);
  });

  it('files that appear while it shuts down: a discard falls back to asking after the leave', async () => {
    const store = new AgentStateStore();
    const { worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    await pressClose(store, { id: 1, worktreeChoice: 'discard', confirmedFiles: 1 });
    writeFile(worktree.path, 'late.txt', 'written on the way out\n');
    await exits(store, 1);
    expect(stateOf(worktree.path)).toBe('needsDecision');
    expect(fs.existsSync(path.join(worktree.path, 'late.txt'))).toBe(true);
  });

  it('files cleaned up while it shuts down: the plain leave rules, the answer moot', async () => {
    const store = new AgentStateStore();
    const { worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    await pressClose(store, { id: 1, worktreeChoice: 'keep' });
    fs.rmSync(path.join(worktree.path, 'notes.txt'));
    await exits(store, 1);
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('another agent stays in the Worktree: nothing to ask, it just closes', async () => {
    const store = new AgentStateStore();
    const { worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');
    store.set(
      2,
      createAgentState({
        id: 2,
        sessionId: 's-2',
        isExternal: false,
        projectDir: '/p',
        jsonlFile: '/p/s-2.jsonl',
        worktree: { name: worktree.name, path: worktree.path, branch: worktree.branch },
      }),
    );
    expect(await pressClose(store, { id: 1 })).toEqual({ sent: [], closed: [1] });
  });

  it('an answer that waits too long for its exit is dropped: the leave asks again', async () => {
    const store = new AgentStateStore();
    const { worktree } = await launched(store);
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    const now = Date.now();
    await pressClose(store, { id: 1, worktreeChoice: 'discard', confirmedFiles: 1 });
    vi.spyOn(Date, 'now').mockReturnValue(now + WORKTREE_CLOSE_CHOICE_TTL_MS + 60_000);
    await exits(store, 1);
    expect(stateOf(worktree.path)).toBe('needsDecision');
    expect(fs.existsSync(path.join(worktree.path, 'notes.txt'))).toBe(true);
  });
});
