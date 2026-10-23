import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  DAILY_STATS_SAVE_DEBOUNCE_MS,
  PROGRESS_CYCLE_GAP_MS,
  REMOTE_AGENT_TTL_MS,
} from '../src/constants.js';
import { type ProgressEvent, ProgressTracker } from '../src/progress/progressTracker.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/**
 * The stage track and the done-today totals (docs/progress/DESIGN.md). Every
 * tracker gets a temp daily dir and an injected clock; nothing touches the real
 * ~/.pixel-agents.
 */

const MIN = 60_000;
/** 10:00 local time on 2026-10-17. */
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const TODAY = '2026-10-17';
const PR_URL = 'https://github.com/acme/web/pull/42';

type Message = Record<string, unknown>;

function addAgent(store: AgentStateStore, id: number, extra: Partial<AgentState> = {}): AgentState {
  const agent = createAgentState({
    id,
    sessionId: `session-${id}`,
    projectDir: '/work',
    jsonlFile: '',
    isExternal: true,
    directoryName: 'hobbyfi-web',
    ...extra,
  });
  store.set(id, agent);
  return agent;
}

function readDaily(dir: string, date = TODAY): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), 'utf-8'));
}

describe('ProgressTracker', () => {
  let dir: string;
  let store: AgentStateStore;
  let clock: number;
  let tracker: ProgressTracker;
  let messages: Message[];

  function newTracker(): ProgressTracker {
    return new ProgressTracker(store, { dailyDir: dir, now: () => clock });
  }

  const ofType = (type: string) => messages.filter((m) => m.type === type);
  const lastOf = (type: string) => ofType(type).at(-1);
  const stats = () => lastOf('dailyStats');
  const progressOf = (id: number) =>
    messages.filter((m) => m.type === 'agentProgress' && m.id === id).at(-1);

  const start = (toolName: string, input: Record<string, unknown> = {}, id = 1) =>
    tracker.onToolStart(id, toolName, input);
  const bash = (command: string, id = 1) => start('Bash', { command }, id);
  const end = (
    command: string,
    result: { response?: unknown; prUrl?: string; failed?: boolean } = {},
    id = 1,
  ) => tracker.onToolEnd(id, 'Bash', { command }, { failed: false, ...result });
  const status = (id: number, s: 'active' | 'waiting') =>
    store.broadcast({ type: 'agentStatus', id, status: s });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-progress-'));
    store = new AgentStateStore();
    clock = T0;
    tracker = newTracker();
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
    addAgent(store, 1);
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('stage track', () => {
    it('follows the latest classified tool and lists phases first reached, in order', () => {
      start('Read');
      expect(progressOf(1)).toEqual({
        type: 'agentProgress',
        id: 1,
        phase: 'explore',
        reached: ['explore'],
      });
      start('Edit', { file_path: '/work/a.ts' });
      expect(progressOf(1)).toMatchObject({ phase: 'build', reached: ['explore', 'build'] });
      start('Grep');
      expect(progressOf(1)).toMatchObject({ phase: 'explore', reached: ['explore', 'build'] });
      bash('npx vitest run');
      expect(progressOf(1)).toMatchObject({ phase: 'test', reached: ['explore', 'build', 'test'] });
      bash('git commit -m "fix"');
      expect(progressOf(1)).toMatchObject({
        phase: 'ship',
        reached: ['explore', 'build', 'test', 'ship'],
      });
    });

    it('leaves the phase alone for unclassified tools and repeats nothing unchanged', () => {
      start('Read');
      start('Read');
      start('TodoWrite');
      bash('ls -la');
      expect(ofType('agentProgress')).toHaveLength(1);
      expect(progressOf(1)).toMatchObject({ phase: 'explore', reached: ['explore'] });
    });

    it('starts a new cycle with the first non-ship tool after shipping', () => {
      start('Read');
      start('Edit', { file_path: '/work/a.ts' });
      bash('git commit -m x');
      // Commit, push, PR in a row are one shipping step.
      bash('git push -u origin feat');
      bash('gh pr create --fill');
      expect(progressOf(1)).toMatchObject({ phase: 'ship', reached: ['explore', 'build', 'ship'] });
      start('Read');
      expect(progressOf(1)).toMatchObject({ phase: 'explore', reached: ['explore'] });
    });

    it(`starts a new cycle after ${PROGRESS_CYCLE_GAP_MS / MIN} quiet minutes`, () => {
      start('Read');
      clock += 29 * MIN;
      start('Edit', { file_path: '/work/a.ts' });
      expect(progressOf(1)).toMatchObject({ reached: ['explore', 'build'] });
      // Unclassified tools don't keep a cycle alive.
      clock += 20 * MIN;
      start('TodoWrite');
      clock += 10 * MIN;
      bash('npm test');
      expect(progressOf(1)).toMatchObject({ phase: 'test', reached: ['test'] });
    });

    it('keeps each agent on its own track', () => {
      addAgent(store, 2);
      start('Read', {}, 1);
      bash('npm run build', 2);
      expect(progressOf(1)).toMatchObject({ phase: 'explore', reached: ['explore'] });
      expect(progressOf(2)).toMatchObject({ phase: 'test', reached: ['test'] });
    });

    it('ignores agents the store does not know', () => {
      start('Read', {}, 99);
      bash('npm test', 99);
      expect(messages).toEqual([]);
    });

    it('forgets a removed agent', () => {
      start('Read');
      store.delete(1);
      addAgent(store, 1);
      expect(tracker.snapshot()[0]).toEqual({ type: 'agentProgress', id: 1, reached: [] });
    });
  });

  describe('waiting and active time', () => {
    it('sets waitingSince when the agent becomes waiting and clears it when active', () => {
      start('Read');
      clock += MIN;
      status(1, 'waiting');
      expect(progressOf(1)).toEqual({
        type: 'agentProgress',
        id: 1,
        phase: 'explore',
        reached: ['explore'],
        waitingSince: T0 + MIN,
      });
      // A second `waiting` (Stop, then the idle notification) keeps the first time.
      clock += MIN;
      status(1, 'waiting');
      expect(progressOf(1)).toMatchObject({ waitingSince: T0 + MIN });
      clock += MIN;
      status(1, 'active');
      expect(progressOf(1)).toEqual({
        type: 'agentProgress',
        id: 1,
        phase: 'explore',
        reached: ['explore'],
      });
    });

    it('does not answer its own broadcasts or other message types', () => {
      store.broadcast({ type: 'agentToolStart', id: 1, toolId: 't', status: 'Reading' });
      store.broadcast({ type: 'agentStatus', id: 99, status: 'waiting' });
      expect(ofType('agentProgress')).toEqual([]);
      expect(ofType('dailyStats')).toEqual([]);
    });

    it('sums each span from active to the next waiting into activeMs', () => {
      status(1, 'active');
      clock += 4 * MIN;
      // Every tool re-announces active; the span runs from the first.
      status(1, 'active');
      clock += 6 * MIN;
      status(1, 'waiting');
      expect(stats()).toMatchObject({ activeMs: 10 * MIN });
      clock += 30 * MIN;
      status(1, 'waiting');
      expect(stats()).toMatchObject({ activeMs: 10 * MIN });
      status(1, 'active');
      clock += 5 * MIN;
      status(1, 'waiting');
      expect(stats()).toMatchObject({ activeMs: 15 * MIN });
    });

    it('adds up concurrent agents and drops the span of an agent removed mid-turn', () => {
      addAgent(store, 2);
      addAgent(store, 3);
      status(1, 'active');
      status(2, 'active');
      status(3, 'active');
      clock += 10 * MIN;
      store.delete(3);
      status(1, 'waiting');
      status(2, 'waiting');
      expect(stats()).toMatchObject({ activeMs: 20 * MIN });
    });
  });

  describe('daily totals', () => {
    it('counts every shell tool start as a command', () => {
      bash('ls');
      bash('npm test');
      start('PowerShell', { command: 'Get-ChildItem' });
      start('Read');
      expect(stats()).toMatchObject({ type: 'dailyStats', date: TODAY, commandsRun: 3 });
    });

    it('counts each edited file once', () => {
      start('Edit', { file_path: '/work/a.ts' });
      start('Write', { file_path: '/work/b.ts' });
      start('MultiEdit', { file_path: '/work/a.ts', edits: [] });
      start('NotebookEdit', { notebook_path: '/work/n.ipynb' });
      start('Edit', { file_path: '/work/b.ts' });
      expect(stats()).toMatchObject({ filesEdited: 3 });
      // The repeats changed nothing, so they broadcast nothing.
      expect(ofType('dailyStats')).toHaveLength(3);
    });

    it("keys a remote session's files by its source", () => {
      const source = (id: string) => ({ id, label: id, kind: 'cloud' as const });
      addAgent(store, 2, { remoteSource: source('cloud-a') });
      addAgent(store, 3, { remoteSource: source('cloud-b') });
      start('Edit', { file_path: '/home/user/web/a.ts' }, 2);
      start('Edit', { file_path: '/home/user/web/a.ts' }, 3);
      start('Edit', { file_path: '/home/user/web/a.ts' }, 2);
      expect(stats()).toMatchObject({ filesEdited: 2 });
    });

    it('counts successful pushes per repo, not failed ones', () => {
      addAgent(store, 2, { directoryName: 'pixel-agents' });
      addAgent(store, 3, { directoryName: undefined });
      end('git push');
      end('git commit -m x && git push -u origin x');
      end('git push', {}, 2);
      end('git push', {}, 3);
      end('git push', { failed: true });
      end('git push --dry-run');
      end('git status');
      expect(stats()).toMatchObject({
        pushes: [
          { repo: 'hobbyfi-web', count: 2 },
          { repo: 'pixel-agents', count: 1 },
          { repo: 'unknown', count: 1 },
        ],
      });
    });

    it('records a PR with the title from the command and the url from the response', () => {
      clock += MIN;
      end('git push -u origin x && gh pr create --title "Add the strip" --body "b"', {
        response: { stdout: `Creating pull request\n${PR_URL}\n`, stderr: '' },
      });
      expect(stats()).toMatchObject({
        prs: [{ title: 'Add the strip', repo: 'acme/web', url: PR_URL, at: T0 + MIN }],
        pushes: [{ repo: 'hobbyfi-web', count: 1 }],
      });
    });

    it("takes a remote session's PR url from the relay's pr_url", () => {
      end('gh pr create -t "Remote one"', { prUrl: 'https://github.com/acme/api/pull/7' });
      expect(stats()).toMatchObject({
        prs: [{ title: 'Remote one', repo: 'acme/api', url: 'https://github.com/acme/api/pull/7' }],
      });
    });

    it('falls back to PR and the directory when nothing names them', () => {
      end('gh pr create --fill', { response: 'Warning: 2 uncommitted changes' });
      expect(stats()).toMatchObject({ prs: [{ title: 'PR', repo: 'hobbyfi-web' }] });
      expect((stats()!.prs as Message[])[0]).not.toHaveProperty('url');
    });

    it('ignores a PR url it already has, and PRs that failed or never opened', () => {
      end('gh pr create --fill', { response: PR_URL });
      const broadcasts = ofType('dailyStats').length;
      end('gh pr create --title "again"', { response: PR_URL });
      tracker.onPrLink(1, { url: PR_URL });
      end('gh pr create --fill', { response: 'https://github.com/acme/web/pull/43', failed: true });
      end('gh pr create --web', { response: 'Opening github.com/acme/web/pull/new/x' });
      expect(stats()!.prs).toHaveLength(1);
      expect(ofType('dailyStats')).toHaveLength(broadcasts);
    });

    it('records pr-link PRs, with the repo from the url or the record', () => {
      tracker.onPrLink(1, { url: PR_URL });
      tracker.onPrLink(1, { url: 'https://ghe.example.com/x/y/pull/1', repo: 'x/y' });
      tracker.onPrLink(1, { url: 'not a url' });
      expect(stats()).toMatchObject({
        prs: [
          { title: 'PR', repo: 'acme/web', url: PR_URL },
          { title: 'PR', repo: 'x/y', url: 'https://ghe.example.com/x/y/pull/1' },
        ],
      });
    });
  });

  describe('persistence', () => {
    it('writes at most every few seconds, then again after more changes', () => {
      vi.useFakeTimers();
      bash('npm test');
      bash('npm test');
      expect(fs.existsSync(path.join(dir, `${TODAY}.json`))).toBe(false);
      vi.advanceTimersByTime(DAILY_STATS_SAVE_DEBOUNCE_MS);
      expect(readDaily(dir)).toMatchObject({ version: 1, date: TODAY, commandsRun: 2 });
      bash('npm test');
      vi.advanceTimersByTime(DAILY_STATS_SAVE_DEBOUNCE_MS);
      expect(readDaily(dir)).toMatchObject({ commandsRun: 3 });
      expect(fs.readdirSync(dir)).toEqual([`${TODAY}.json`]);
    });

    it('round-trips through a new tracker without double counting', () => {
      bash('npm test');
      start('Edit', { file_path: '/work/a.ts' });
      start('Edit', { file_path: '/work/b.ts' });
      end('git push');
      end('gh pr create --title "One"', { response: PR_URL });
      status(1, 'active');
      clock += 3 * MIN;
      status(1, 'waiting');
      tracker.dispose();
      // The paths themselves never reach the file.
      expect(fs.readFileSync(path.join(dir, `${TODAY}.json`), 'utf-8')).not.toContain('a.ts');

      tracker = newTracker();
      const expected = {
        type: 'dailyStats',
        date: TODAY,
        prs: [{ title: 'One', repo: 'acme/web', url: PR_URL, at: T0 }],
        pushes: [{ repo: 'hobbyfi-web', count: 1 }],
        filesEdited: 2,
        commandsRun: 1,
        activeMs: 3 * MIN,
      };
      expect(tracker.snapshot().at(-1)).toEqual(expected);

      start('Edit', { file_path: '/work/a.ts' });
      end('gh pr create --title "One"', { response: PR_URL });
      expect(tracker.snapshot().at(-1)).toEqual(expected);
    });

    it('starts fresh from a missing or corrupt file and keeps the good parts of a damaged one', () => {
      expect(tracker.snapshot().at(-1)).toMatchObject({ commandsRun: 0, prs: [] });
      tracker.dispose();

      fs.writeFileSync(path.join(dir, `${TODAY}.json`), '{ not json');
      tracker = newTracker();
      expect(tracker.snapshot().at(-1)).toMatchObject({ commandsRun: 0 });
      tracker.dispose();

      fs.writeFileSync(
        path.join(dir, `${TODAY}.json`),
        JSON.stringify({
          prs: [{ title: 'ok', repo: 'a/b', at: 1 }, { title: 3 }, null],
          pushes: [
            { repo: 'r', count: 2 },
            { repo: 'bad', count: -1 },
          ],
          files: ['k1', 7],
          commandsRun: 'many',
          activeMs: 5,
        }),
      );
      tracker = newTracker();
      expect(tracker.snapshot().at(-1)).toEqual({
        type: 'dailyStats',
        date: TODAY,
        prs: [{ title: 'ok', repo: 'a/b', at: 1 }],
        pushes: [{ repo: 'r', count: 2 }],
        filesEdited: 1,
        commandsRun: 0,
        activeMs: 5,
      });
    });

    it('closes the day at midnight and starts a fresh one', () => {
      clock = new Date(2026, 9, 17, 23, 50).getTime();
      status(1, 'active');
      bash('npm test');
      start('Edit', { file_path: '/work/a.ts' });
      clock = new Date(2026, 9, 18, 0, 10).getTime();
      start('Read');
      expect(stats()).toMatchObject({
        date: '2026-10-18',
        commandsRun: 0,
        filesEdited: 0,
        activeMs: 0,
      });
      expect(readDaily(dir, TODAY)).toMatchObject({ date: TODAY, commandsRun: 1 });
      // A span that crossed midnight counts from midnight.
      status(1, 'waiting');
      expect(stats()).toMatchObject({ date: '2026-10-18', activeMs: 10 * MIN });
      start('Edit', { file_path: '/work/a.ts' });
      expect(stats()).toMatchObject({ filesEdited: 1 });
      tracker.dispose();
      expect(readDaily(dir, '2026-10-18')).toMatchObject({ commandsRun: 0, activeMs: 10 * MIN });
      expect(readDaily(dir, TODAY)).toMatchObject({ commandsRun: 1, activeMs: 0 });
    });

    it('keeps totals in memory with dailyDir null', () => {
      tracker.dispose();
      tracker = new ProgressTracker(store, { dailyDir: null, now: () => clock });
      bash('npm test');
      tracker.dispose();
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });

  describe('observers', () => {
    // What the tracker counted, as it counted it: the Manager's task log
    // (tasks/taskLedger.ts) attributes these to the agent's live task.
    let events: ProgressEvent[];
    let unobserve: () => void;

    beforeEach(() => {
      events = [];
      unobserve = tracker.observe((e) => events.push(e));
    });

    it('reports each counted command, edited file, push and PR with its agent', () => {
      addAgent(store, 2, { directoryName: 'pixel-agents' });
      bash('npm test');
      start('Read');
      start('Edit', { file_path: '/work/a.ts' });
      start('Edit', { file_path: '/work/a.ts' }, 2);
      end('git push', {}, 2);
      clock += MIN;
      end('gh pr create --title "Ship it"', { response: PR_URL });

      expect(events).toEqual([
        { kind: 'command', agentId: 1, at: T0 },
        { kind: 'fileEdited', agentId: 1, at: T0, fileKey: expect.any(String) },
        { kind: 'fileEdited', agentId: 2, at: T0, fileKey: expect.any(String) },
        { kind: 'push', agentId: 2, at: T0, repo: 'pixel-agents' },
        {
          kind: 'pr',
          agentId: 1,
          at: T0 + MIN,
          pr: { title: 'Ship it', repo: 'acme/web', url: PR_URL, at: T0 + MIN },
        },
      ]);
      // The same file edited by two agents is the same file: one key.
      expect(events[1]).toMatchObject({ fileKey: (events[2] as { fileKey: string }).fileKey });
    });

    it('reports a file edit every time, even one already counted today', () => {
      start('Edit', { file_path: '/work/a.ts' });
      start('Edit', { file_path: '/work/a.ts' });
      expect(events.filter((e) => e.kind === 'fileEdited')).toHaveLength(2);
      expect(stats()).toMatchObject({ filesEdited: 1 });
    });

    it('reports nothing the totals did not count', () => {
      end('git push', { failed: true });
      end('gh pr create --fill', { response: PR_URL });
      end('gh pr create --fill', { response: PR_URL });
      tracker.onPrLink(1, { url: PR_URL });
      expect(events.map((e) => e.kind)).toEqual(['pr']);
    });

    it('reports each closed active span, clipped at midnight like the totals', () => {
      status(1, 'active');
      clock += 7 * MIN;
      status(1, 'waiting');
      expect(events).toEqual([{ kind: 'activeTime', agentId: 1, at: T0 + 7 * MIN, ms: 7 * MIN }]);

      events = [];
      clock = new Date(2026, 9, 17, 23, 50, 0).getTime();
      status(1, 'active');
      clock = new Date(2026, 9, 18, 0, 5, 0).getTime();
      status(1, 'waiting');
      expect(events).toEqual([{ kind: 'activeTime', agentId: 1, at: clock, ms: 5 * MIN }]);
    });

    it('stops reporting once unsubscribed, and survives an observer that throws', () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      tracker.observe(() => {
        throw new Error('observer bug');
      });
      bash('ls');
      expect(stats()).toMatchObject({ commandsRun: 1 });
      expect(events).toHaveLength(1);
      unobserve();
      bash('ls');
      expect(events).toHaveLength(1);
      expect(stats()).toMatchObject({ commandsRun: 2 });
      logged.mockRestore();
    });
  });

  describe('snapshot', () => {
    it('sends every agent, with or without progress, then today', () => {
      addAgent(store, 2);
      start('Read');
      status(1, 'waiting');
      bash('npm test', 2);
      const snapshot = tracker.snapshot();
      expect(snapshot).toEqual([
        { type: 'agentProgress', id: 1, phase: 'explore', reached: ['explore'], waitingSince: T0 },
        { type: 'agentProgress', id: 2, phase: 'test', reached: ['test'] },
        expect.objectContaining({ type: 'dailyStats', date: TODAY, commandsRun: 1 }),
      ]);
    });
  });
});

describe('ProgressTracker wiring', () => {
  let dir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let clock: number;
  let messages: Message[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-progress-rt-'));
    store = new AgentStateStore();
    clock = T0;
    runtime = new AgentRuntime(store, claudeProvider, {
      progress: { dailyDir: dir, now: () => clock },
    });
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ofType = (type: string) => messages.filter((m) => m.type === type);
  const stats = () => ofType('dailyStats').at(-1);

  function hook(event: Record<string, unknown>, sessionId = 'session-1') {
    runtime.handleHookEvent('claude', { session_id: sessionId, ...event });
  }

  function hookedAgent(id = 1): AgentState {
    const agent = addAgent(store, id);
    runtime.registerAgent(agent.sessionId, id);
    return agent;
  }

  /** One assistant record with a single tool_use, as the transcript parser reads it. */
  function toolUseLine(name: string, input: Record<string, unknown>, id = 'toolu_1'): string {
    return JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
  }

  function parse(agentId: number, line: string, agents = store) {
    processTranscriptLine(agentId, line, agents, runtime.waitingTimers, runtime.permissionTimers);
  }

  it('turns hook events into agentProgress and dailyStats broadcasts', () => {
    hookedAgent();
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a' } });
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/a' } });
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(ofType('agentProgress').at(-1)).toEqual({
      type: 'agentProgress',
      id: 1,
      phase: 'test',
      reached: ['explore', 'test'],
    });
    expect(stats()).toMatchObject({ commandsRun: 1 });

    const command = 'git push -u origin x && gh pr create --title "Ship it"';
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { stdout: PR_URL, stderr: '', interrupted: false },
    });
    expect(stats()).toMatchObject({
      commandsRun: 2,
      pushes: [{ repo: 'hobbyfi-web', count: 1 }],
      prs: [{ title: 'Ship it', repo: 'acme/web', url: PR_URL }],
    });

    clock += 5 * MIN;
    hook({ hook_event_name: 'Stop' });
    expect(ofType('agentProgress').at(-1)).toMatchObject({
      phase: 'ship',
      waitingSince: T0 + 5 * MIN,
    });
    expect(stats()).toMatchObject({ activeMs: 5 * MIN });
  });

  it('does not count a push whose tool failed', () => {
    hookedAgent();
    const command = 'git push';
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    hook({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command },
      error: 'rejected',
    });
    expect(stats()).toMatchObject({ commandsRun: 1, pushes: [] });
  });

  it('counts remote PRs from the relay field', () => {
    const source = { id: 'laptop', label: 'Laptop', kind: 'computer' } as const;
    const command = 'gh pr create --fill';
    const remote = (event: Record<string, unknown>) =>
      hook({ cwd: '/home/me/api', pixel_source: source, ...event }, 'laptop:s1');
    remote({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    remote({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      pr_url: 'https://github.com/me/api/pull/3',
    });
    expect(stats()).toMatchObject({
      prs: [{ title: 'PR', repo: 'me/api', url: 'https://github.com/me/api/pull/3' }],
    });
  });

  it("counts a transcript's tools only for agents whose hooks do not report them", () => {
    const heuristic = addAgent(store, 1);
    parse(1, toolUseLine('Bash', { command: 'npm test' }));
    expect(stats()).toMatchObject({ commandsRun: 1 });
    expect(ofType('agentProgress').at(-1)).toMatchObject({ id: 1, phase: 'test' });

    // Once hooks flow, the same agent's transcript is display only.
    heuristic.hookDelivered = true;
    const before = messages.length;
    parse(1, toolUseLine('Bash', { command: 'git push' }, 'toolu_2'));
    parse(1, toolUseLine('Edit', { file_path: '/work/a.ts' }, 'toolu_3'));
    expect(messages.slice(before).filter((m) => m.type === 'dailyStats')).toEqual([]);
    expect(messages.slice(before).filter((m) => m.type === 'agentProgress')).toEqual([]);
  });

  it('does not count a hooked agent twice through hooks and its transcript', () => {
    hookedAgent();
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    parse(1, toolUseLine('Bash', { command: 'npm test' }));
    expect(stats()).toMatchObject({ commandsRun: 1 });
  });

  it("does not count a teammate's transcript when its tools fire on the hooked lead's session", () => {
    hookedAgent(1);
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    // In-process teammate: shares the lead's session, so its hooks are the lead's.
    addAgent(store, 2, { sessionId: 'session-1', leadAgentId: 1, agentName: 'researcher' });
    parse(2, toolUseLine('Bash', { command: 'npm test' }));
    // A teammate with its own session and no hooks yet is counted from its transcript.
    addAgent(store, 3, { sessionId: 'session-3', leadAgentId: 1, agentName: 'writer' });
    parse(3, toolUseLine('Bash', { command: 'npm test' }));
    expect(stats()).toMatchObject({ commandsRun: 2 });
  });

  it('ignores transcripts parsed into another store (the shadow sub-agent store)', () => {
    const shadow = new AgentStateStore();
    addAgent(shadow, 1);
    addAgent(store, 1);
    parse(1, toolUseLine('Bash', { command: 'npm test' }), shadow);
    expect(ofType('dailyStats')).toEqual([]);
  });

  it('records pr-link records for agents without hooks only', () => {
    const agent = addAgent(store, 1);
    const prLink = (url: string) =>
      JSON.stringify({ type: 'pr-link', prUrl: url, prNumber: 1, prRepository: 'acme/web' });
    parse(1, prLink(PR_URL));
    agent.hookDelivered = true;
    parse(1, prLink('https://github.com/acme/web/pull/43'));
    expect(stats()).toMatchObject({ prs: [{ title: 'PR', repo: 'acme/web', url: PR_URL }] });
  });

  it('sends every agent and today to a connecting client with the activity resend', () => {
    hookedAgent(1);
    addAgent(store, 2);
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const sent: Message[] = [];
    resendAgentActivity((m) => sent.push(m), store);
    expect(sent.filter((m) => m.type === 'agentProgress')).toEqual([
      { type: 'agentProgress', id: 1, phase: 'test', reached: ['test'] },
      { type: 'agentProgress', id: 2, reached: [] },
    ]);
    expect(sent.filter((m) => m.type === 'dailyStats')).toMatchObject([
      { type: 'dailyStats', date: TODAY, commandsRun: 1 },
    ]);

    // Another runtime's store gets none of this one's progress.
    const other = new AgentStateStore();
    const otherSent: Message[] = [];
    resendAgentActivity((m) => otherSent.push(m), other);
    expect(otherSent).toEqual([]);
  });

  it('flushes the daily totals when the runtime is disposed', () => {
    hookedAgent();
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    runtime.dispose();
    expect(readDaily(dir)).toMatchObject({ commandsRun: 1 });
  });

  it('expires remote agents without counting their open span', () => {
    const source = { id: 'laptop', label: 'Laptop', kind: 'computer' } as const;
    hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: {},
        cwd: '/home/me/api',
        pixel_source: source,
      },
      'laptop:s9',
    );
    const [id] = [...store.keys()];
    runtime.expireRemoteAgents(Date.now() + REMOTE_AGENT_TTL_MS + 1);
    expect(store.has(id)).toBe(false);
    expect(runtime.progress.snapshot()).toEqual([
      expect.objectContaining({ type: 'dailyStats', activeMs: 0 }),
    ]);
  });
});
