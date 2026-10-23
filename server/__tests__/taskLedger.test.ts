import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../core/src/messages.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  MANAGER_DIR_NAME,
  REMOTE_AGENT_TTL_MS,
  TASK_ORPHAN_GRACE_MS,
  TASKS_DIR_NAME,
  TASKS_SAVE_DEBOUNCE_MS,
} from '../src/constants.js';
import { ProgressTracker } from '../src/progress/progressTracker.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { TaskLedger } from '../src/tasks/taskLedger.js';
import { setAgentTitle } from '../src/transcriptTitle.js';
import type { AgentState } from '../src/types.js';

/**
 * The Manager's task log (docs/office/DESIGN.md, phase M): a task is a
 * session's title period, its stats attributed from the ProgressTracker's own
 * counting. Every ledger gets a temp data dir and an injected clock; nothing
 * touches the real ~/.pixel-agents.
 */

const MIN = 60_000;
/** 10:00 local time on 2026-10-17. */
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const TODAY = '2026-10-17';
const TOMORROW = '2026-10-18';
const PR_URL = 'https://github.com/acme/web/pull/42';
const MAC = { id: 'mac-1', label: 'Mac', kind: 'computer' as const };

type Message = Record<string, unknown>;

describe('TaskLedger', () => {
  let dataDir: string;
  let store: AgentStateStore;
  let clock: number;
  let tracker: ProgressTracker;
  let ledger: TaskLedger;
  let messages: Message[];

  function newLedger(): TaskLedger {
    return new TaskLedger(store, tracker, { dataDir, now: () => clock });
  }

  /** A fresh process over the same data dir: new store, tracker and ledger. */
  function restart(): void {
    ledger.dispose();
    tracker.dispose();
    store = new AgentStateStore();
    tracker = new ProgressTracker(store, { dailyDir: null, now: () => clock });
    ledger = newLedger();
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
  }

  function addAgent(id: number, extra: Partial<AgentState> = {}): AgentState {
    const agent = createAgentState({
      id,
      sessionId: `session-${id}`,
      isExternal: true,
      projectDir: '/home/me/.claude/projects/-work-hobbyfi-blog',
      jsonlFile: `/home/me/.claude/projects/-work-hobbyfi-blog/session-${id}.jsonl`,
      directoryName: 'hobbyfi-blog',
      ...extra,
    });
    store.set(id, agent);
    return agent;
  }

  const status = (id: number, s: 'active' | 'waiting') =>
    store.broadcast({ type: 'agentStatus', id, status: s });
  const title = (id: number, t: string) => setAgentTitle(id, store.get(id)!, store, t);
  const bash = (command: string, id = 1) => tracker.onToolStart(id, 'Bash', { command });
  const edit = (file: string, id = 1) => tracker.onToolStart(id, 'Edit', { file_path: file });
  const end = (command: string, response?: unknown, id = 1) =>
    tracker.onToolEnd(id, 'Bash', { command }, { response, failed: false });

  const tasks = (): Task[] => ledger.snapshot().tasks;
  const titled = (t: string): Task | undefined => tasks().find((task) => task.title === t);
  const updates = () => messages.filter((m) => m.type === 'taskUpdated');
  const dayFile = (date = TODAY) => path.join(dataDir, TASKS_DIR_NAME, `${date}.json`);
  const readDay = (date = TODAY) =>
    JSON.parse(fs.readFileSync(dayFile(date), 'utf-8')) as { date: string; tasks: Task[] };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tasks-'));
    store = new AgentStateStore();
    clock = T0;
    tracker = new ProgressTracker(store, { dailyDir: null, now: () => clock });
    ledger = newLedger();
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
  });

  afterEach(() => {
    ledger.dispose();
    tracker.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('task lifecycle', () => {
    it('opens no task for an agent that has done nothing', () => {
      addAgent(1, { title: 'Idle session' });
      status(1, 'waiting');
      expect(tasks()).toEqual([]);
    });

    it('opens "Untitled · <repo>" on first activity, then renames it when the title arrives', () => {
      addAgent(1);
      status(1, 'active');
      expect(tasks()).toEqual([
        {
          id: expect.any(String),
          title: 'Untitled · hobbyfi-blog',
          repo: 'hobbyfi-blog',
          machine: 'local',
          sessionId: 'session-1',
          startedAt: T0,
          status: 'in_progress',
          prs: [],
          pushes: 0,
          filesEdited: 0,
          commands: 0,
          activeMs: 0,
        },
      ]);
      const { id } = tasks()[0];

      clock += MIN;
      title(1, 'Draft review by email');
      // Renamed, not replaced: same id, same start.
      expect(tasks()).toEqual([
        expect.objectContaining({ id, title: 'Draft review by email', startedAt: T0 }),
      ]);
      expect(updates().at(-1)).toEqual({ type: 'taskUpdated', task: tasks()[0] });
    });

    it('takes the title the agent already has when its task opens', () => {
      addAgent(1, { title: 'Fix the login bug' });
      bash('npm test');
      expect(tasks()).toEqual([
        expect.objectContaining({ title: 'Fix the login bug', status: 'in_progress', commands: 1 }),
      ]);
    });

    it('closes the task as done when the title changes, and opens a new one', () => {
      addAgent(1, { title: 'Plan the API' });
      status(1, 'active');
      clock += 5 * MIN;
      title(1, 'Build the API');

      const [first, second] = tasks();
      expect(first).toMatchObject({ title: 'Plan the API', status: 'done', endedAt: T0 + 5 * MIN });
      expect(second).toMatchObject({
        title: 'Build the API',
        status: 'in_progress',
        startedAt: T0 + 5 * MIN,
        sessionId: 'session-1',
      });
      expect(second).not.toHaveProperty('endedAt');
      expect(second.id).not.toBe(first.id);
    });

    it('keeps the task through a repeated title', () => {
      addAgent(1, { title: 'Same' });
      status(1, 'active');
      store.broadcast({ type: 'agentTitle', id: 1, title: 'Same' });
      store.broadcast({ type: 'agentTitle', id: 1, title: 'Same' });
      expect(tasks()).toHaveLength(1);
    });

    it('follows active and waiting', () => {
      addAgent(1);
      status(1, 'active');
      expect(tasks()[0].status).toBe('in_progress');
      status(1, 'waiting');
      expect(tasks()[0].status).toBe('waiting');
      status(1, 'active');
      expect(tasks()[0].status).toBe('in_progress');
      expect(tasks()).toHaveLength(1);
    });

    it('carries the status into the task a title change opens', () => {
      addAgent(1, { title: 'One' });
      status(1, 'active');
      status(1, 'waiting');
      title(1, 'Two');
      expect(titled('Two')).toMatchObject({ status: 'waiting' });
    });

    it('closes the task as done when the session ends', () => {
      addAgent(1);
      status(1, 'active');
      clock += 3 * MIN;
      store.delete(1);
      expect(tasks()).toEqual([expect.objectContaining({ status: 'done', endedAt: T0 + 3 * MIN })]);
    });

    it('closes the task when the session changes under the agent (/clear) and starts untitled', () => {
      const agent = addAgent(1, { title: 'Before clear' });
      status(1, 'active');
      clock += MIN;
      agent.sessionId = 'session-1b';
      status(1, 'active');
      expect(tasks()).toEqual([
        expect.objectContaining({ title: 'Before clear', status: 'done', sessionId: 'session-1' }),
        expect.objectContaining({
          title: 'Untitled · hobbyfi-blog',
          status: 'in_progress',
          sessionId: 'session-1b',
        }),
      ]);
      title(1, 'After clear');
      expect(tasks()[1]).toMatchObject({ title: 'After clear', sessionId: 'session-1b' });
    });

    it('keeps the title when the session id is corrected before any work (adoption)', () => {
      // Adopted agents are named after their transcript file, then take the
      // hook's session id.
      const agent = addAgent(1, { title: 'Adopted mid-task', sessionId: 'file-name' });
      agent.sessionId = 'hook-session';
      status(1, 'active');
      expect(tasks()).toEqual([
        expect.objectContaining({ title: 'Adopted mid-task', sessionId: 'hook-session' }),
      ]);
    });

    it('gives a background agent its own task', () => {
      addAgent(3, { background: true, title: 'Nightly triage' });
      status(3, 'active');
      expect(titled('Nightly triage')).toMatchObject({ status: 'in_progress' });
    });
  });

  describe('remote sessions', () => {
    it('is one task per session, named for its machine', () => {
      addAgent(5, { remoteSource: MAC, hooksOnly: true, jsonlFile: '', directoryName: 'web' });
      status(5, 'active');
      // Remote agents have no transcript here; a stray title changes nothing.
      store.broadcast({ type: 'agentTitle', id: 5, title: 'Ignored' });
      status(5, 'waiting');
      expect(tasks()).toEqual([
        expect.objectContaining({
          title: '💻 Mac · web',
          repo: 'web',
          machine: 'Mac',
          sessionId: 'session-5',
          status: 'waiting',
        }),
      ]);
    });

    it('closes on expiry and reopens the same task when the session comes back', () => {
      addAgent(5, { remoteSource: MAC, hooksOnly: true, jsonlFile: '', directoryName: 'web' });
      status(5, 'active');
      const { id } = tasks()[0];
      clock += MIN;
      store.delete(5);
      expect(tasks()[0]).toMatchObject({ status: 'done', endedAt: T0 + MIN });

      clock += MIN;
      addAgent(6, {
        sessionId: 'session-5',
        remoteSource: MAC,
        hooksOnly: true,
        jsonlFile: '',
        directoryName: 'web',
      });
      status(6, 'active');
      expect(tasks()).toEqual([expect.objectContaining({ id, status: 'in_progress' })]);
      expect(tasks()[0]).not.toHaveProperty('endedAt');
    });
  });

  describe('attribution', () => {
    it("counts commands, files, pushes, PRs and active time toward the agent's live task", () => {
      addAgent(1, { title: 'Ship the strip' });
      status(1, 'active');
      bash('npm test');
      edit('/work/a.ts');
      edit('/work/a.ts');
      edit('/work/b.ts');
      end('git push');
      clock += 10 * MIN;
      end('gh pr create --title "Add the strip"', `Created\n${PR_URL}\n`);
      status(1, 'waiting');

      expect(titled('Ship the strip')).toMatchObject({
        commands: 1,
        filesEdited: 2,
        pushes: 1,
        prs: [{ title: 'Add the strip', repo: 'acme/web', url: PR_URL, at: T0 + 10 * MIN }],
        activeMs: 10 * MIN,
      });

      // A new title period starts from zero; a file is counted again per task.
      title(1, 'Polish the strip');
      status(1, 'active');
      bash('ls');
      edit('/work/a.ts');
      expect(titled('Polish the strip')).toMatchObject({
        commands: 1,
        filesEdited: 1,
        pushes: 0,
        prs: [],
      });
      expect(titled('Ship the strip')).toMatchObject({ commands: 1, filesEdited: 2 });
    });

    it('opens the task on the first counted tool, before the active status lands', () => {
      addAgent(1);
      bash('npm test');
      expect(tasks()).toEqual([
        expect.objectContaining({ status: 'in_progress', commands: 1, startedAt: T0 }),
      ]);
    });

    it("counts a teammate's or sub-agent's work toward its lead's task, never its own", () => {
      addAgent(1, { title: 'Lead task', isTeamLead: true, teamName: 't' });
      addAgent(2, { leadAgentId: 1, teamName: 't', agentName: 'reviewer', title: 'Review' });
      status(1, 'active');
      status(2, 'active');
      bash('npm test', 2);
      edit('/work/c.ts', 2);
      status(2, 'waiting');
      expect(tasks()).toEqual([
        expect.objectContaining({ title: 'Lead task', commands: 1, filesEdited: 1 }),
      ]);
      // The teammate's status is not the lead's.
      expect(tasks()[0].status).toBe('in_progress');
    });

    it('leaves the daily totals exactly as the tracker counted them', () => {
      addAgent(1);
      bash('a');
      bash('b');
      const stats = tracker.snapshot().at(-1);
      expect(stats).toMatchObject({ type: 'dailyStats', commandsRun: 2 });
      expect(tasks()[0].commands).toBe(2);
    });
  });

  describe('exclusions', () => {
    it("never logs the Manager's own runs (cwd = <dataDir>/manager)", () => {
      const managerDir = path.join(dataDir, MANAGER_DIR_NAME);
      // Hooks-only: projectDir is the cwd itself.
      addAgent(1, { projectDir: managerDir, jsonlFile: '', hooksOnly: true });
      // Transcript-backed: projectDir is Claude's encoded dir for that cwd.
      addAgent(2, {
        projectDir: path.join(
          '/home/me/.claude/projects',
          normalizeProjectPath(managerDir).toUpperCase(),
        ),
      });
      status(1, 'active');
      bash('ls', 1);
      status(2, 'active');
      bash('ls', 2);
      expect(tasks()).toEqual([]);
      expect(updates()).toEqual([]);
    });
  });

  describe('broadcasts', () => {
    it('sends taskUpdated in the wire shape on every change, and nothing for no change', () => {
      addAgent(1);
      status(1, 'active');
      edit('/work/a.ts');
      const count = updates().length;
      edit('/work/a.ts');
      status(1, 'active');
      expect(updates()).toHaveLength(count);
      const last = updates().at(-1)!.task as Record<string, unknown>;
      expect(Object.keys(last).sort()).toEqual(
        [
          'activeMs',
          'commands',
          'filesEdited',
          'id',
          'machine',
          'prs',
          'pushes',
          'repo',
          'sessionId',
          'startedAt',
          'status',
          'title',
        ].sort(),
      );
    });
  });

  describe('persistence', () => {
    it('writes today to <dataDir>/tasks/<date>.json, debounced and atomically', () => {
      vi.useFakeTimers();
      addAgent(1, { title: 'Persist me' });
      status(1, 'active');
      expect(fs.existsSync(dayFile())).toBe(false);
      vi.advanceTimersByTime(TASKS_SAVE_DEBOUNCE_MS);
      expect(readDay()).toMatchObject({
        version: 1,
        date: TODAY,
        tasks: [expect.objectContaining({ title: 'Persist me', status: 'in_progress' })],
      });
      expect(fs.readdirSync(path.join(dataDir, TASKS_DIR_NAME))).toEqual([`${TODAY}.json`]);
    });

    it('does not keep postponing the write while the agent stays busy', () => {
      vi.useFakeTimers();
      addAgent(1);
      for (let i = 0; i < 5; i++) {
        bash(`step ${i}`);
        vi.advanceTimersByTime(TASKS_SAVE_DEBOUNCE_MS / 2);
      }
      expect(fs.existsSync(dayFile())).toBe(true);
    });

    it('writes nothing with no data dir', () => {
      ledger.dispose();
      ledger = new TaskLedger(store, tracker, { dataDir: null, now: () => clock });
      addAgent(1);
      bash('ls');
      ledger.flush();
      expect(fs.readdirSync(dataDir)).toEqual([]);
      expect(tasks()).toHaveLength(1);
    });

    it('picks the open task back up after a restart, stats and file identities included', () => {
      addAgent(1, { title: 'Survive restart' });
      status(1, 'active');
      bash('one');
      edit('/work/a.ts');
      const { id } = tasks()[0];

      clock += MIN;
      restart();
      // Before any agent is back, the day still lists it.
      expect(tasks()).toEqual([expect.objectContaining({ id, status: 'in_progress' })]);

      addAgent(1, { title: 'Survive restart' });
      bash('two');
      edit('/work/a.ts');
      edit('/work/b.ts');
      expect(tasks()).toEqual([
        expect.objectContaining({ id, commands: 2, filesEdited: 2, startedAt: T0 }),
      ]);
    });

    it('renames a restored untitled task, or splits it when the title moved on', () => {
      addAgent(1);
      addAgent(2, { title: 'Old title' });
      status(1, 'active');
      status(2, 'active');
      restart();

      addAgent(1, { title: 'Now titled' });
      addAgent(2, { title: 'New title' });
      const list = tasks();
      expect(list).toHaveLength(3);
      expect(list[0]).toMatchObject({ title: 'Now titled', status: 'in_progress' });
      expect(list[1]).toMatchObject({ title: 'Old title', status: 'done', endedAt: clock });
      expect(list[2]).toMatchObject({ title: 'New title', status: 'in_progress' });
    });

    it('closes open tasks whose session never came back once the grace has passed', () => {
      vi.useFakeTimers();
      addAgent(1, { title: 'Comes back' });
      addAgent(2, { title: 'Gone for good' });
      status(1, 'active');
      status(2, 'active');
      restart();
      addAgent(1, { title: 'Comes back' });

      clock += TASK_ORPHAN_GRACE_MS;
      vi.advanceTimersByTime(TASK_ORPHAN_GRACE_MS);
      expect(titled('Gone for good')).toMatchObject({ status: 'done', endedAt: clock });
      expect(titled('Comes back')).toMatchObject({ status: 'in_progress' });
    });

    it('starts the day fresh over a corrupt file, and writes a valid one', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ledger.dispose();
      fs.mkdirSync(path.join(dataDir, TASKS_DIR_NAME), { recursive: true });
      fs.writeFileSync(dayFile(), '{ not json');
      ledger = newLedger();
      expect(tasks()).toEqual([]);
      expect(warn).toHaveBeenCalled();

      addAgent(1, { title: 'After corruption' });
      status(1, 'active');
      ledger.flush();
      expect(readDay().tasks).toEqual([expect.objectContaining({ title: 'After corruption' })]);
    });

    it('drops malformed entries from a day file', () => {
      ledger.dispose();
      fs.mkdirSync(path.join(dataDir, TASKS_DIR_NAME), { recursive: true });
      fs.writeFileSync(
        dayFile(),
        JSON.stringify({
          version: 1,
          date: TODAY,
          tasks: [
            { id: 'x' },
            null,
            {
              id: 'good',
              title: 'Kept',
              repo: 'r',
              machine: 'local',
              sessionId: 's',
              startedAt: T0,
              status: 'done',
              endedAt: T0 + MIN,
              prs: [{ title: 'p', repo: 'r', url: PR_URL, at: T0 }, { bad: true }],
              pushes: 2,
              filesEdited: 1,
              commands: -4,
              activeMs: 'lots',
            },
          ],
        }),
      );
      ledger = newLedger();
      expect(tasks()).toEqual([
        {
          id: 'good',
          title: 'Kept',
          repo: 'r',
          machine: 'local',
          sessionId: 's',
          startedAt: T0,
          endedAt: T0 + MIN,
          status: 'done',
          prs: [{ title: 'p', repo: 'r', url: PR_URL, at: T0 }],
          pushes: 2,
          filesEdited: 1,
          commands: 0,
          activeMs: 0,
        },
      ]);
    });

    it("reads another day's file on request; a missing or malformed date is empty", () => {
      addAgent(1, { title: 'Yesterday work' });
      status(1, 'active');
      ledger.flush();
      fs.renameSync(dayFile(), dayFile('2026-10-16'));

      expect(ledger.tasksFor('2026-10-16')).toEqual([
        expect.objectContaining({ title: 'Yesterday work' }),
      ]);
      expect(ledger.tasksFor('2026-10-16')[0]).not.toHaveProperty('fileKeys');
      expect(ledger.tasksFor('2026-01-01')).toEqual([]);
      expect(ledger.tasksFor('../secrets')).toEqual([]);
      expect(ledger.tasksFor('2026-13-45')).toEqual([]);
      expect(ledger.tasksFor(TODAY)).toEqual(tasks());
    });
  });

  describe('midnight', () => {
    it('carries open tasks into the new day with the same id, counting from zero', () => {
      addAgent(1, { title: 'Finished today' });
      addAgent(2, { title: 'Still going' });
      addAgent(3, { title: 'Needs Ansh' });
      status(1, 'active');
      status(2, 'active');
      status(3, 'active');
      bash('x', 2);
      bash('y', 2);
      status(3, 'waiting');
      store.delete(1);
      const before = Object.fromEntries(tasks().map((t) => [t.title, t]));

      clock = new Date(2026, 9, 18, 0, 10, 0).getTime();
      bash('after midnight', 2);

      const snapshot = ledger.snapshot();
      expect(snapshot.date).toBe(TOMORROW);
      expect(snapshot.tasks).toEqual([
        expect.objectContaining({
          id: before['Still going'].id,
          title: 'Still going',
          startedAt: T0,
          status: 'in_progress',
          commands: 1,
        }),
        expect.objectContaining({
          id: before['Needs Ansh'].id,
          status: 'waiting',
          commands: 0,
          activeMs: 0,
        }),
      ]);
      // The new day was announced as a whole.
      expect(messages).toContainEqual(
        expect.objectContaining({ type: 'tasksSnapshot', date: TOMORROW }),
      );

      // Yesterday's file holds the day as it ended: the open ones still open.
      const yesterday = readDay(TODAY);
      expect(yesterday.tasks.map((t) => [t.title, t.status, t.commands])).toEqual([
        ['Finished today', 'done', 0],
        ['Still going', 'in_progress', 2],
        ['Needs Ansh', 'waiting', 0],
      ]);

      // A carried task closes in the new day like any other.
      store.delete(3);
      ledger.flush();
      expect(readDay(TOMORROW).tasks.map((t) => [t.title, t.status])).toEqual([
        ['Still going', 'in_progress'],
        ['Needs Ansh', 'done'],
      ]);
    });

    it("carries yesterday's open tasks over a restart that spans midnight", () => {
      addAgent(1, { title: 'Late night' });
      addAgent(2, { title: 'Wrapped up' });
      status(1, 'active');
      status(2, 'active');
      store.delete(2);
      const { id } = titled('Late night')!;

      clock = new Date(2026, 9, 18, 9, 0, 0).getTime();
      restart();
      expect(ledger.snapshot()).toEqual({
        type: 'tasksSnapshot',
        date: TOMORROW,
        tasks: [expect.objectContaining({ id, status: 'in_progress', commands: 0 })],
      });

      addAgent(1, { title: 'Late night' });
      bash('morning');
      expect(tasks()).toEqual([expect.objectContaining({ id, commands: 1, startedAt: T0 })]);
    });

    it('rolls over on a snapshot alone, with no activity', () => {
      addAgent(1, { title: 'Overnight' });
      status(1, 'active');
      clock = new Date(2026, 9, 18, 8, 0, 0).getTime();
      expect(ledger.snapshot()).toEqual({
        type: 'tasksSnapshot',
        date: TOMORROW,
        tasks: [expect.objectContaining({ title: 'Overnight', startedAt: T0 })],
      });
    });
  });
});

describe('TaskLedger through AgentRuntime', () => {
  let dataDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let clock: number;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tasks-rt-'));
    store = new AgentStateStore();
    clock = T0;
    runtime = new AgentRuntime(store, claudeProvider, {
      progress: { dailyDir: null, now: () => clock },
      manager: { dataDir, now: () => clock },
    });
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function hookedAgent(id: number, extra: Partial<AgentState> = {}): AgentState {
    const agent = createAgentState({
      id,
      sessionId: `session-${id}`,
      isExternal: true,
      projectDir: '/work',
      jsonlFile: '',
      hooksOnly: true,
      hookDelivered: true,
      directoryName: 'hobbyfi-blog',
      ...extra,
    });
    store.set(id, agent);
    runtime.registerAgent(agent.sessionId, id);
    return agent;
  }

  const hook = (event: Record<string, unknown>, sessionId = 'session-1') =>
    runtime.handleHookEvent('claude', { session_id: sessionId, ...event });

  it('opens, counts and parks a task from hook events', () => {
    hookedAgent(1, { title: 'Hooked task' });
    hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'toolu_1',
    });
    hook({ hook_event_name: 'Stop' });
    expect(runtime.tasks.snapshot().tasks).toEqual([
      expect.objectContaining({ title: 'Hooked task', commands: 1, status: 'waiting' }),
    ]);
  });

  it("is replayed to a connecting client as today's tasksSnapshot", () => {
    hookedAgent(1, { title: 'Replay me' });
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    const sent: Message[] = [];
    resendAgentActivity((m) => sent.push(m), store);
    expect(sent).toContainEqual({
      type: 'tasksSnapshot',
      date: TODAY,
      tasks: [expect.objectContaining({ title: 'Replay me' })],
    });
  });

  it('closes a remote task when the remote session expires', () => {
    hookedAgent(1, { remoteSource: MAC, lastDataAt: T0 });
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    runtime.expireRemoteAgents(T0 + REMOTE_AGENT_TTL_MS + 1);
    expect(runtime.tasks.snapshot().tasks).toEqual([
      expect.objectContaining({ title: '💻 Mac · hobbyfi-blog', status: 'done' }),
    ]);
  });

  it('leaves open tasks open on shutdown: stopping the server ends no session', () => {
    hookedAgent(1, { title: 'Across restarts' });
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    runtime.dispose();
    const file = JSON.parse(
      fs.readFileSync(path.join(dataDir, TASKS_DIR_NAME, `${TODAY}.json`), 'utf-8'),
    ) as { tasks: Task[] };
    expect(file.tasks).toEqual([
      expect.objectContaining({ title: 'Across restarts', status: 'in_progress' }),
    ]);
  });

  it('keeps the task log in memory when the surface asks for no manager', () => {
    const memStore = new AgentStateStore();
    const memRuntime = new AgentRuntime(memStore, claudeProvider, {
      progress: { dailyDir: null, now: () => clock },
    });
    try {
      memStore.set(
        9,
        createAgentState({
          id: 9,
          sessionId: 's9',
          isExternal: true,
          projectDir: '/w',
          jsonlFile: '',
        }),
      );
      memStore.broadcast({ type: 'agentStatus', id: 9, status: 'active' });
      expect(memRuntime.tasks.snapshot().tasks).toHaveLength(1);
      memRuntime.tasks.flush();
    } finally {
      memRuntime.dispose();
    }
    // Nothing landed in this suite's data dir, nor anywhere else we chose.
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });
});
