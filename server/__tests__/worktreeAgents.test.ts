import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { owningSession, worktreeLook } from '../src/worktreeAgents.js';
import { clearTestHome, removeTempDir } from './helpers/removeTempDir.js';

/** Whose character a Worktree's row wears. */

const tmp: string[] = [];
afterEach(() => {
  for (const dir of tmp.splice(0)) removeTempDir(dir);
  clearTestHome('.pixel-agents');
});

function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-agents-'));
  tmp.push(dir);
  return dir;
}

function agent(id: number, sessionId: string, palette: number, worktreePath?: string) {
  const a = createAgentState({
    id,
    sessionId,
    isExternal: false,
    projectDir: '/p',
    jsonlFile: `/p/${sessionId}.jsonl`,
    worktree: worktreePath ? { name: 'w', path: worktreePath, branch: 'w' } : undefined,
  });
  a.palette = palette;
  a.repeat = 0;
  return a;
}

describe('owningSession', () => {
  it('keeps the recorded agent while it runs there or nothing does', () => {
    expect(owningSession('a', ['b', 'a'])).toBe('a');
    expect(owningSession('a', [])).toBe('a');
  });
  it('passes to the first agent running there once the recorded one has gone', () => {
    expect(owningSession('a', ['b', 'c'])).toBe('b');
    expect(owningSession(undefined, ['b'])).toBe('b');
    expect(owningSession(undefined, [])).toBeUndefined();
  });
});

describe('worktreeLook', () => {
  it('wears the agent it was made for, through a visitor and after both leave', () => {
    const wt = folder();
    const store = new AgentStateStore();
    store.set(2, agent(2, 'helly', 7, wt));
    expect(worktreeLook(store, { path: wt })).toEqual({ palette: 7, repeat: 0 });

    // A visitor that cd'd in, listed first, doesn't take it.
    store.set(1, agent(1, 'mark', 10, wt));
    expect(worktreeLook(store, { path: wt })?.palette).toBe(7);

    // Both leave it; Helly's conversation is resumed elsewhere: still hers.
    store.delete(2);
    store.set(1, agent(1, 'mark', 10));
    store.set(3, agent(3, 'helly', 7));
    expect(worktreeLook(store, { path: wt })?.palette).toBe(7);
  });

  it('passes to another agent once its own has gone and that one runs there', () => {
    const wt = folder();
    const store = new AgentStateStore();
    store.set(1, agent(1, 'a', 3, wt));
    expect(worktreeLook(store, { path: wt })?.palette).toBe(3);
    store.delete(1);
    store.set(2, agent(2, 'b', 5, wt));
    expect(worktreeLook(store, { path: wt })?.palette).toBe(5);
    // And stays with it after it leaves.
    store.set(2, agent(2, 'b', 5));
    expect(worktreeLook(store, { path: wt })?.palette).toBe(5);
  });

  it("with no agent ever seen there, wears its newest conversation's live agent", () => {
    const wt = folder();
    const store = new AgentStateStore();
    store.set(4, agent(4, 'latest', 9));
    expect(worktreeLook(store, { path: wt }, 'latest')?.palette).toBe(9);
    expect(worktreeLook(store, { path: wt })).toBeUndefined();
  });
});
