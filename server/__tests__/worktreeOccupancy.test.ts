import * as fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';

import type { PersistedAgent } from '../../core/src/schemas.js';
import { restoredAgentInit } from '../src/agentPersistence.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { realPathKey } from '../src/pathKey.js';
import { create } from '../src/worktreeCreate.js';
import { retireWorktreesLeftBy } from '../src/worktreeLeave.js';
import {
  carrySession,
  heldPaths,
  holdsWorktree,
  occupantOf,
  savedOccupant,
  worktreeInUse,
} from '../src/worktreeOccupancy.js';
import { readRegistry, recordSession } from '../src/worktreeRegistry.js';
import { makeRepo, removeTempRepos } from './fixtures/gitRepos.js';
import { clearTestHome } from './helpers/removeTempDir.js';

/** Who still runs in a Worktree: by where an agent runs, or by its session. */

afterEach(() => {
  removeTempRepos();
  clearTestHome('.pixel-agents');
});

async function made(sessionId: string) {
  const result = await create({ path: makeRepo() }, { pickName: () => 'held', sessionId });
  if (!result.ok) throw new Error(result.reason);
  return readRegistry()[0];
}

function agent(
  id: number,
  sessionId: string,
  worktree?: { name: string; path: string; branch: string },
) {
  return createAgentState({
    id,
    sessionId,
    isExternal: false,
    projectDir: '/p',
    jsonlFile: `/p/${sessionId}.jsonl`,
    worktree,
  });
}

describe('holding a Worktree', () => {
  it('an agent running there, or whose session was run there, holds it; another does not', async () => {
    const entry = await made('s-1');
    expect(holdsWorktree({ sessionId: 's-1' }, entry)).toBe(true);
    expect(holdsWorktree({ sessionId: 's-2', worktree: { path: entry.path } }, entry)).toBe(true);
    expect(holdsWorktree({ sessionId: 's-2' }, entry)).toBe(false);
    expect(holdsWorktree({ sessionId: '' }, { path: entry.path, sessionIds: [''] })).toBe(false);
  });

  it('a /clear carries the hold to the new session', async () => {
    const entry = await made('s-1');
    carrySession('s-1', 's-2');
    expect(holdsWorktree({ sessionId: 's-2' }, readRegistry()[0])).toBe(true);
    expect(heldPaths([{ sessionId: 's-2' }])).toContain(realPathKey(entry.path));
  });

  it('an agent that moved out still holds it, and leaving retires it', async () => {
    const entry = await made('s-1');
    const store = new AgentStateStore();
    // Moved itself into some other folder: no marker of ours any more.
    store.set(1, agent(1, 's-1'));
    expect(worktreeInUse(store, entry)).toBe(true);

    const left = store.get(1)!;
    store.delete(1);
    await retireWorktreesLeftBy(store, left);
    expect(fs.existsSync(entry.path)).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('the agent running there is its occupant, not one whose session only passed through', async () => {
    const entry = await made('s-1');
    recordSession(entry, 's-visitor');
    const store = new AgentStateStore();
    // The visitor cd'd in and out of it, and came first in the store.
    store.set(1, agent(1, 's-visitor'));
    store.set(2, agent(2, 's-1', { name: entry.name, path: entry.path, branch: entry.branch }));
    expect(occupantOf(store, readRegistry()[0])).toBe(2);
    // With the agent running there gone, the visitor still holds it.
    store.delete(2);
    expect(occupantOf(store, readRegistry()[0])).toBe(1);
  });

  it('a save from before homeWorktree went loads, ignoring it', async () => {
    const entry = await made('s-1');
    const legacy = {
      id: 1,
      sessionId: 's-1',
      terminalName: 'Claude Code #1',
      jsonlFile: '/p/s-1.jsonl',
      projectDir: '/p',
      homeWorktree: { name: 'held', path: entry.path, branch: entry.branch },
    } as PersistedAgent;
    const init = restoredAgentInit(legacy);
    expect(init).not.toHaveProperty('homeWorktree');
    expect(init.worktree).toBeUndefined();
    // Still held, through its session.
    expect(heldPaths([savedOccupant(legacy)])).toContain(realPathKey(entry.path));
  });
});
