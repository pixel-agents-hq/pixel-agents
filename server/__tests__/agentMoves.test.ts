import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { toPersistedAgent } from '../src/agentPersistence.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { readNewLines, scanExternalDir, startFileWatching } from '../src/fileWatcher.js';
import { realPathKey } from '../src/pathKey.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';
import { setAttributionDirectories } from '../src/worktreeAttribution.js';
import { create } from '../src/worktreeCreate.js';
import {
  resumeRetiringForTests,
  retireWorktreesLeftBy,
  sweepWorktrees,
} from '../src/worktreeLeave.js';
import { heldPaths, savedOccupant, worktreeInUse } from '../src/worktreeOccupancy.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { gitIn, makeRepo, removeTempRepos } from './fixtures/gitRepos.js';
import { clearTestHome, removeTempDir } from './helpers/removeTempDir.js';

/**
 * Following an agent that moves into or out of a worktree mid-session
 * (Claude Code's EnterWorktree / ExitWorktree). The hook payloads and
 * transcripts are recorded from a real Claude Code 2.1.310 session
 * (fixtures/enter-worktree/README.md), with their placeholder paths pointed
 * at a real temporary repo and the isolated $HOME.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'enter-worktree');

interface Recording {
  repo: string;
  sessionId: string;
  hooks: Array<Record<string, unknown>>;
  records: string[];
  /** The repo's own project dir, and a worktree's. */
  projectDir: string;
  worktreeProjectDir: (name: string) => string;
}

/** A recording with its placeholders resolved against `repo`. */
function recording(kind: 'interactive' | 'print-mode', repo: string): Recording {
  const resolve = (text: string) =>
    text
      .split('-REPO_PARENT-repo')
      .join(normalizeProjectPath(repo))
      .split('/REPO_PARENT/repo')
      .join(repo)
      .split('/HOME')
      .join(os.homedir());
  const lines = (file: string) =>
    resolve(fs.readFileSync(path.join(FIXTURES, file), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim());
  const hooks = lines(`${kind}.hooks.jsonl`).map((l) => JSON.parse(l) as Record<string, unknown>);
  const projects = path.join(os.homedir(), '.claude', 'projects');
  return {
    repo,
    sessionId: hooks[0].session_id as string,
    hooks,
    records: lines(`${kind}.transcript.jsonl`),
    projectDir: path.join(projects, normalizeProjectPath(repo)),
    worktreeProjectDir: (name) =>
      path.join(projects, normalizeProjectPath(path.join(repo, '.claude', 'worktrees', name))),
  };
}

/** The worktree EnterWorktree makes: Claude's own (`worktree-<name>`), not in our registry. */
function claudeWorktree(repo: string, name: string): string {
  const folder = path.join(repo, '.claude', 'worktrees', name);
  gitIn(repo, 'worktree', 'add', '--quiet', '-b', `worktree-${name}`, folder);
  return folder;
}

/** The index of the first record of `type` (from `from` on). */
function indexOf(records: string[], type: string, from = 0): number {
  const i = records.findIndex((r, n) => n >= from && JSON.parse(r).type === type);
  if (i < 0) throw new Error(`no ${type} record`);
  return i;
}

function hookIndex(hooks: Recording['hooks'], event: string, tool?: string, from = 0): number {
  const i = hooks.findIndex(
    (h, n) => n >= from && h.hook_event_name === event && (!tool || h.tool_name === tool),
  );
  if (i < 0) throw new Error(`no ${event} ${tool ?? ''} hook`);
  return i;
}

function append(file: string, records: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => `${r}\n`).join(''));
}

function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

function memoryAdapter(initial: PersistedAgent[] = []): StateAdapter {
  let current = initial;
  return {
    loadAgents: () => current,
    saveAgents: (agents) => {
      current = agents;
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    loadCardOrder: () => [],
    saveCardOrder: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: () => {},
  };
}

let store: AgentStateStore;
let runtime: AgentRuntime;
let sent: Array<Record<string, unknown>>;

beforeEach(() => {
  store = new AgentStateStore();
  store.setAdapter(memoryAdapter());
  runtime = new AgentRuntime(store, claudeProvider);
  sent = [];
  store.on('broadcast', (m: Record<string, unknown>) => sent.push(m));
});

afterEach(() => {
  runtime.dispose();
  setAttributionDirectories(() => []);
  resumeRetiringForTests();
  removeTempRepos();
  clearTestHome('.claude', '.pixel-agents');
});

function moves(): Array<Record<string, unknown>> {
  return sent.filter((m) => m.type === 'agentWorktreeChanged');
}

/** An agent of the Directory at `repo`, watching `jsonlFile` from its end. */
function agentReading(
  rec: Recording,
  jsonlFile: string,
  init: Partial<AgentState> = {},
): AgentState {
  const id = store.nextAgentId.current++;
  const agent = createAgentState({
    id,
    sessionId: rec.sessionId,
    isExternal: true,
    jsonlFile,
    projectDir: path.dirname(jsonlFile),
    directoryName: 'Repo',
    ...init,
  });
  try {
    agent.fileOffset = fs.statSync(jsonlFile).size;
  } catch {
    agent.fileOffset = 0;
  }
  store.set(id, agent);
  runtime.registerAgent(agent.sessionId, id);
  startFileWatching(
    id,
    jsonlFile,
    store,
    runtime.fileWatchers,
    runtime.pollingTimers,
    runtime.waitingTimers,
    runtime.permissionTimers,
  );
  return agent;
}

describe('the Claude provider reads where a session runs', () => {
  it('every hook names the folder and transcript; the transcript records the move', () => {
    const rec = recording('print-mode', '/code/repo');
    const enter = rec.hooks[hookIndex(rec.hooks, 'PostToolUse', 'EnterWorktree')];
    expect(claudeProvider.normalizeHookEvent(enter)?.where).toEqual({
      cwd: '/code/repo/.claude/worktrees/probe',
      transcriptPath: enter.transcript_path,
    });

    const records = rec.records.map((r) => JSON.parse(r) as unknown);
    const found = records
      .map((r) => claudeProvider.sessionMoveFromRecord?.(r))
      .filter((m) => m !== null);
    expect(found).toEqual([
      { cwd: '/code/repo/.claude/worktrees/probe' },
      { cwd: '/code/repo/.claude/worktrees/probe', branch: 'worktree-probe' },
      { cwd: '/code/repo/.claude/worktrees/probe' },
      { cwd: '/code/repo/.claude/worktrees/probe', branch: 'worktree-probe' },
      // ExitWorktree: back in the repo (worktree-state null names nothing).
      { cwd: '/code/repo' },
      { cwd: '/code/repo' },
    ]);
  });
});

describe('with hooks: a session that stays put', () => {
  it('a launched agent knows its folder: its hooks are no move, and nothing is looked up', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const rec = recording('interactive', repo);
    const file = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    append(file, []);
    // Launched into the Directory: it starts knowing where it runs.
    const agent = agentReading(rec, file, { isExternal: false, cwd: repo });
    const lookups = vi.spyOn(claudeProvider, 'getSessionDirs');
    try {
      for (const hook of rec.hooks.slice(0, hookIndex(rec.hooks, 'PostToolUse', 'EnterWorktree'))) {
        runtime.handleHookEvent('claude', hook);
      }
      expect(lookups).not.toHaveBeenCalled();
    } finally {
      lookups.mockRestore();
    }
    expect(agent.jsonlFile).toBe(file);
    expect(agent.worktree).toBeUndefined();
    expect(moves()).toEqual([]);
  });
});

describe('with hooks: a new cwd follows the agent', () => {
  it('interactive EnterWorktree: the moved transcript is followed from where it was, marker set', async () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const folder = claudeWorktree(repo, 'probe2');
    const rec = recording('interactive', repo);
    const oldFile = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    const newFile = path.join(rec.worktreeProjectDir('probe2'), `${rec.sessionId}.jsonl`);

    // Up to and including the EnterWorktree tool_use, read live.
    const enterAt = indexOf(rec.records, 'relocated');
    append(oldFile, []);
    const agent = agentReading(rec, oldFile);
    const id = agent.id;
    append(oldFile, rec.records.slice(0, enterAt));
    for (const hook of rec.hooks.slice(0, hookIndex(rec.hooks, 'PostToolUse', 'EnterWorktree'))) {
      runtime.handleHookEvent('claude', hook);
    }
    await vi.waitFor(() => expect(agent.contextTokens).toBeGreaterThan(0));
    const context = agent.contextTokens;

    // The CLI writes the move records, then moves the whole file.
    append(oldFile, rec.records.slice(enterAt, enterAt + 2));
    await vi.waitFor(() => expect(agent.fileOffset).toBe(fs.statSync(oldFile).size));
    const offset = agent.fileOffset;
    moveFile(oldFile, newFile);
    runtime.handleHookEvent(
      'claude',
      rec.hooks[hookIndex(rec.hooks, 'PostToolUse', 'EnterWorktree')],
    );

    expect(store.size).toBe(1);
    expect(store.get(id)).toBe(agent);
    expect(agent.sessionId).toBe(rec.sessionId);
    expect(agent.jsonlFile).toBe(newFile);
    expect(agent.projectDir).toBe(path.dirname(newFile));
    expect(agent.worktree).toEqual({ name: 'probe2', path: folder, branch: 'worktree-probe2' });
    expect(moves()).toEqual([
      { type: 'agentWorktreeChanged', id, worktree: { name: 'probe2', branch: 'worktree-probe2' } },
    ]);
    // Same bytes: read on from where it was, nothing replayed, gauge kept.
    expect(agent.fileOffset).toBe(offset);
    expect(agent.contextTokens).toBe(context);
    expect(readRegistry()).toEqual([]);

    // The session goes on in its new home, and the agent's tools with it.
    const before = agent.linesProcessed;
    append(newFile, rec.records.slice(enterAt + 2));
    for (const hook of rec.hooks.slice(
      hookIndex(rec.hooks, 'PostToolUse', 'EnterWorktree') + 1,
      -1,
    )) {
      runtime.handleHookEvent('claude', hook);
    }
    await vi.waitFor(() =>
      expect(agent.linesProcessed).toBe(before + rec.records.length - enterAt - 2),
    );
    expect(
      sent.some((m) => m.type === 'agentToolStart' && String(m.status).startsWith('Writing')),
    ).toBe(true);
    expect(agent.contextTokens).toBeGreaterThan(0);
    // Its records repeat the move: nothing changes again.
    expect(moves()).toHaveLength(1);
    expect(store.size).toBe(1);

    // A reload restores it at its new location, with its marker.
    const saved = toPersistedAgent(agent)!;
    expect(saved.jsonlFile).toBe(newFile);
    expect(saved.worktree).toEqual({ name: 'probe2', path: folder, branch: 'worktree-probe2' });
  });

  it('print mode: the file stays (the named one never exists), so it is kept; exiting clears the marker', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    claudeWorktree(repo, 'probe');
    const rec = recording('print-mode', repo);
    const file = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    append(file, rec.records);
    const agent = agentReading(rec, file);

    for (const hook of rec.hooks.slice(0, hookIndex(rec.hooks, 'PreToolUse', 'ExitWorktree') + 1)) {
      runtime.handleHookEvent('claude', hook);
    }
    expect(agent.worktree?.branch).toBe('worktree-probe');
    expect(agent.jsonlFile).toBe(file);
    expect(
      fs.existsSync(path.join(rec.worktreeProjectDir('probe'), `${rec.sessionId}.jsonl`)),
    ).toBe(false);

    for (const hook of rec.hooks.slice(hookIndex(rec.hooks, 'PostToolUse', 'ExitWorktree'), -1)) {
      runtime.handleHookEvent('claude', hook);
    }
    expect(agent.worktree).toBeUndefined();
    expect(agent.jsonlFile).toBe(file);
    expect(agent.sessionId).toBe(rec.sessionId);
    expect(moves().map((m) => m.worktree)).toEqual([
      { name: 'probe', branch: 'worktree-probe' },
      undefined,
    ]);
    expect(moves().every((m) => m.id === agent.id)).toBe(true);
  });

  it('interactive ExitWorktree: the file moved back is followed, the marker cleared', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const folder = claudeWorktree(repo, 'probe2');
    const rec = recording('interactive', repo);
    const inWorktree = path.join(rec.worktreeProjectDir('probe2'), `${rec.sessionId}.jsonl`);
    const back = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    append(inWorktree, rec.records);
    const agent = agentReading(rec, inWorktree, {
      worktree: { name: 'probe2', path: folder, branch: 'worktree-probe2' },
    });
    const offset = agent.fileOffset;

    moveFile(inWorktree, back);
    runtime.handleHookEvent('claude', {
      ...rec.hooks[hookIndex(rec.hooks, 'Stop')],
      cwd: repo,
      transcript_path: back,
    });

    expect(agent.jsonlFile).toBe(back);
    expect(agent.fileOffset).toBe(offset);
    expect(agent.worktree).toBeUndefined();
    expect(moves()).toEqual([{ type: 'agentWorktreeChanged', id: agent.id }]);
  });

  it('the hook can beat the rename: the agent looks again until the file is there', async () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    claudeWorktree(repo, 'probe2');
    const rec = recording('interactive', repo);
    const oldFile = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    const newFile = path.join(rec.worktreeProjectDir('probe2'), `${rec.sessionId}.jsonl`);
    append(oldFile, rec.records.slice(0, 17));
    const agent = agentReading(rec, oldFile);

    runtime.handleHookEvent(
      'claude',
      rec.hooks[hookIndex(rec.hooks, 'PostToolUse', 'EnterWorktree')],
    );
    expect(agent.worktree?.name).toBe('probe2');
    expect(agent.jsonlFile).toBe(oldFile);

    moveFile(oldFile, newFile);
    await vi.waitFor(() => expect(agent.jsonlFile).toBe(newFile), { timeout: 3000 });
    expect(store.size).toBe(1);
  });

  it('a move elsewhere is followed with no marker', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-elsewhere-')));
    const rec = recording('interactive', repo);
    const oldFile = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    const newFile = path.join(
      os.homedir(),
      '.claude',
      'projects',
      normalizeProjectPath(elsewhere),
      `${rec.sessionId}.jsonl`,
    );
    append(oldFile, rec.records.slice(0, 5));
    const agent = agentReading(rec, oldFile, {
      worktree: { name: 'old', path: path.join(repo, '.claude', 'worktrees', 'old'), branch: 'b' },
    });
    moveFile(oldFile, newFile);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: rec.sessionId,
      cwd: elsewhere,
      transcript_path: newFile,
    });
    expect(agent.jsonlFile).toBe(newFile);
    expect(agent.worktree).toBeUndefined();
    expect(agent.directoryName).toBe('Repo');
    removeTempDir(elsewhere);
  });
});

describe('without hooks', () => {
  it('the scanner finds the session under another tracked project dir and follows it', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const folder = claudeWorktree(repo, 'probe2');
    const rec = recording('interactive', repo);
    const oldFile = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    const newFile = path.join(rec.worktreeProjectDir('probe2'), `${rec.sessionId}.jsonl`);
    append(oldFile, rec.records.slice(0, indexOf(rec.records, 'relocated')));
    const agent = agentReading(rec, oldFile);
    const offset = agent.fileOffset;

    // The move records land and the file moves before the agent's poll reads them.
    append(oldFile, rec.records.slice(indexOf(rec.records, 'relocated')));
    moveFile(oldFile, newFile);
    scanExternalDir(
      path.dirname(newFile),
      runtime.knownJsonlFiles,
      store.nextAgentId,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      () => store.persist(),
    );

    expect(store.size).toBe(1);
    expect(agent.jsonlFile).toBe(newFile);
    expect(agent.fileOffset).toBe(offset);
    expect(agent.worktree).toEqual({ name: 'probe2', path: folder, branch: 'worktree-probe2' });

    // The rest is read from the new home: the move records agree, no flicker.
    readNewLines(agent.id, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(agent.worktree?.name).toBe('probe2');
    expect(moves()).toHaveLength(1);
  });

  it('the same session id in another project dir, while the agent’s own file is still there, is not hidden', () => {
    // Nothing moved (e.g. the session continued from another folder while
    // its old file stays): the conservative rule adopts it as before.
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    claudeWorktree(repo, 'probe2');
    const rec = recording('interactive', repo);
    const oldFile = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    const otherFile = path.join(rec.worktreeProjectDir('probe2'), `${rec.sessionId}.jsonl`);
    append(oldFile, rec.records.slice(0, 5));
    const agent = agentReading(rec, oldFile);
    append(otherFile, rec.records.slice(0, 5));

    scanExternalDir(
      path.dirname(otherFile),
      runtime.knownJsonlFiles,
      store.nextAgentId,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      () => store.persist(),
    );

    expect(agent.jsonlFile).toBe(oldFile);
    expect([...store.values()].map((a) => a.jsonlFile)).toContain(otherFile);
  });

  it('the transcript’s own move records set and clear the marker (print mode: the file stays)', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    claudeWorktree(repo, 'probe');
    const rec = recording('print-mode', repo);
    const file = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    append(file, []);
    const agent = agentReading(rec, file);
    append(
      file,
      rec.records.slice(0, indexOf(rec.records, 'user', indexOf(rec.records, 'worktree-state'))),
    );
    readNewLines(agent.id, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(agent.worktree?.branch).toBe('worktree-probe');

    append(file, rec.records.slice(agent.linesProcessed));
    readNewLines(agent.id, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(agent.worktree).toBeUndefined();
    expect(agent.jsonlFile).toBe(file);
    expect(moves().map((m) => (m.worktree as { branch?: string } | undefined)?.branch)).toEqual([
      'worktree-probe',
      undefined,
    ]);
  });

  it('with hooks flowing, the records leave the move to the hooks', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    claudeWorktree(repo, 'probe');
    const rec = recording('print-mode', repo);
    const file = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    append(file, []);
    const agent = agentReading(rec, file, { hookDelivered: true });
    append(file, rec.records.slice(0, indexOf(rec.records, 'worktree-state') + 1));
    readNewLines(agent.id, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(agent.worktree).toBeUndefined();
    expect(moves()).toEqual([]);
  });
});

describe('ownership: Claude’s worktree is shown, never managed', () => {
  it('our Directory agent moves into Claude’s worktree and leaves: nothing is retired', async () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const folder = claudeWorktree(repo, 'probe2');
    const rec = recording('interactive', repo);
    const file = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    append(file, rec.records.slice(0, 5));
    const agent = agentReading(rec, file, { isExternal: false });
    runtime.relocateAgent(agent.id, { cwd: folder });
    expect(agent.worktree?.path).toBe(folder);

    runtime.closeAgent(agent.id);
    await retireWorktreesLeftBy(store, agent);
    expect(fs.existsSync(path.join(folder, 'README.md'))).toBe(true);
    expect(gitIn(repo, 'branch', '--list', 'worktree-probe2')).toContain('worktree-probe2');
    expect(readRegistry()).toEqual([]);
  });

  it('our Worktree’s agent moves out: it still holds it (no sweep takes it), retired when it leaves', async () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const rec = recording('interactive', repo);
    // A launch into a Worktree records the session it is made for.
    const made = await create({ path: repo }, { pickName: () => 'ours', sessionId: rec.sessionId });
    if (!made.ok) throw new Error(made.reason);
    const ours = { name: 'ours', path: made.worktree.path, branch: made.worktree.branch };
    const claudes = claudeWorktree(repo, 'probe2');
    const file = path.join(
      os.homedir(),
      '.claude',
      'projects',
      normalizeProjectPath(ours.path),
      `${rec.sessionId}.jsonl`,
    );
    append(file, rec.records.slice(0, 5));
    const agent = agentReading(rec, file, { isExternal: false, worktree: ours });

    runtime.relocateAgent(agent.id, { cwd: claudes });
    expect(agent.worktree?.path).toBe(claudes);
    expect(worktreeInUse(store, readRegistry()[0])).toBe(true);
    await sweepWorktrees(store, { savedAgentsHold: (saved) => saved.isExternal === true });
    expect(fs.existsSync(ours.path)).toBe(true);
    expect(readRegistry()[0].state).toBe('active');
    // ...and across a reload: the saved agent still holds it.
    expect(heldPaths([savedOccupant(toPersistedAgent(agent)!)])).toContain(realPathKey(ours.path));

    // Back home: one marker.
    runtime.relocateAgent(agent.id, { cwd: ours.path });
    expect(agent.worktree).toEqual(ours);
    runtime.relocateAgent(agent.id, { cwd: claudes });

    // It leaves: ours goes by the leave rules (clean: removed), Claude's stays.
    runtime.closeAgent(agent.id);
    await retireWorktreesLeftBy(store, agent);
    expect(fs.existsSync(ours.path)).toBe(false);
    expect(readRegistry()).toEqual([]);
    expect(fs.existsSync(path.join(claudes, 'README.md'))).toBe(true);
  });
});

describe('after a reload', () => {
  it('a moved agent is restored at its new location, with its marker', () => {
    const repo = makeRepo();
    setAttributionDirectories(() => [{ name: 'Repo', path: repo }]);
    const folder = claudeWorktree(repo, 'probe2');
    const rec = recording('interactive', repo);
    const oldFile = path.join(rec.projectDir, `${rec.sessionId}.jsonl`);
    const newFile = path.join(rec.worktreeProjectDir('probe2'), `${rec.sessionId}.jsonl`);
    append(oldFile, rec.records);
    const agent = agentReading(rec, oldFile);
    moveFile(oldFile, newFile);
    runtime.handleHookEvent(
      'claude',
      rec.hooks[hookIndex(rec.hooks, 'PostToolUse', 'EnterWorktree')],
    );
    const saved = store.getAdapter()!.loadAgents();
    runtime.dispose();

    const next = new AgentStateStore();
    next.setAdapter(memoryAdapter(JSON.parse(JSON.stringify(saved)) as PersistedAgent[]));
    const nextRuntime = new AgentRuntime(next, claudeProvider);
    try {
      const out: Array<Record<string, unknown>> = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => out.push(m), {
        store: next,
        runtime: nextRuntime,
        cache: null,
        privileged: true,
      });
      const restored = next.get(agent.id)!;
      expect(restored.jsonlFile).toBe(newFile);
      expect(restored.sessionId).toBe(rec.sessionId);
      expect(restored.worktree).toEqual({
        name: 'probe2',
        path: folder,
        branch: 'worktree-probe2',
      });
      expect(out.find((m) => m.type === 'existingAgents')?.worktrees).toEqual({
        [agent.id]: { name: 'probe2', branch: 'worktree-probe2' },
      });
    } finally {
      nextRuntime.dispose();
    }
  });
});
