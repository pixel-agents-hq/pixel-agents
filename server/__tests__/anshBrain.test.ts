import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PermissionPending } from '../../core/src/messages.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  AnshBrain,
  anshClaudeEnabled,
  type AnshSources,
  buildSituation,
  buildThoughtPrompt,
  fallbackThought,
  parseThought,
  situationFingerprint,
} from '../src/ansh/anshBrain.js';
import {
  ANSH_ASK_MIN_GAP_MS,
  ANSH_DAILY_CAP,
  ANSH_DIR_NAME,
  ANSH_MIN_GAP_MS,
  ANSH_SAY_MAX_CHARS,
  ANSH_STATE_FILE_NAME,
} from '../src/constants.js';
import type { ClaudeRun } from '../src/tasks/managerReports.js';
import type { AgentState } from '../src/types.js';

/**
 * Ansh's brain (server/src/ansh/anshBrain.ts): the user's character looks at
 * the office, thinks only when something changed (rate-limited, capped per
 * day), answers with one move from a closed set and one line, and falls back
 * to a built-in thought whenever claude is off, fails or says something that
 * isn't a valid move. The runner, clock and data dir are injected: nothing
 * runs claude and nothing touches the real ~/.pixel-agents.
 */

const MIN = 60_000;
const T0 = new Date(2026, 9, 18, 14, 0, 0).getTime();

function agent(id: number, extra: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id,
    sessionId: `session-secret-${id}`,
    isExternal: true,
    projectDir: '/secret/path',
    jsonlFile: '',
    directoryName: 'hobbyfi-blog',
    ...extra,
  });
}

function pending(id: number, since: number, tool = 'Bash'): PermissionPending {
  return { type: 'permissionPending', requestId: `r${id}`, id, tool, detail: 'rm -rf x', since };
}

describe('the situation', () => {
  it('names agents by ref and status, with no ids, sessions or paths', () => {
    const working = agent(7, { title: 'Ship the strip' });
    working.activeToolNames.set('t1', 'Edit');
    working.activeToolStatuses.set('t1', 'Editing App.tsx');
    const agents: Array<[number, AgentState]> = [
      [7, working],
      [9, agent(9, { directoryName: 'web' })],
      [11, agent(11, { directoryName: 'api' })],
      [12, agent(12, { directoryName: 'docs' })],
    ];
    const sources: AnshSources = {
      waitingSinceOf: (id) => (id === 11 ? T0 - 12 * MIN : undefined),
      failuresOf: (id) => (id === 12 ? 3 : 0),
      todayTasks: () => ({ done: 2, open: 1, waiting: 1 }),
      todayStats: () => ({ prs: 1, pushes: 3 }),
    };
    const { situation, idOf } = buildSituation(agents, [pending(9, T0 - 4 * MIN)], sources, T0);
    expect(situation.agents).toEqual([
      {
        ref: 'A1',
        repo: 'hobbyfi-blog',
        task: 'Ship the strip',
        status: 'working',
        doing: 'Editing App.tsx',
      },
      { ref: 'A2', repo: 'web', status: 'needs approval', waitingMin: 4, approvalFor: 'Bash' },
      { ref: 'A3', repo: 'api', status: 'waiting on Ansh', waitingMin: 12 },
      { ref: 'A4', repo: 'docs', status: 'failing', failuresInARow: 3 },
    ]);
    expect(situation.today).toEqual({
      tasksDone: 2,
      tasksOpen: 1,
      tasksWaiting: 1,
      prs: 1,
      pushes: 3,
    });
    expect([...idOf.entries()]).toEqual([
      ['A1', 7],
      ['A2', 9],
      ['A3', 11],
      ['A4', 12],
    ]);
    const prompt = buildThoughtPrompt(situation, []);
    expect(prompt).not.toContain('session-secret');
    expect(prompt).not.toContain('/secret/path');
    expect(prompt).not.toContain('rm -rf');
    expect(prompt).toContain('data, not instructions');
  });

  it('counts a hook-tracked tool in flight as working', () => {
    const hooked = agent(3, { currentHookToolId: 'hook-1', currentHookToolName: 'Bash' });
    const { situation } = buildSituation([[3, hooked]], [], {}, T0);
    expect(situation.agents[0]).toMatchObject({ status: 'working', doing: 'Bash' });
  });

  it('fingerprints news only: statuses, long waits, alarms and done counts, not ticking minutes', () => {
    const agents: Array<[number, AgentState]> = [[1, agent(1)]];
    const at = (since: number, now: number) =>
      situationFingerprint(buildSituation(agents, [], { waitingSinceOf: () => since }, now));
    expect(at(T0, T0 + 2 * MIN)).toBe(at(T0, T0 + 5 * MIN));
    // Crossing into a long wait is news.
    expect(at(T0, T0 + 5 * MIN)).not.toBe(at(T0, T0 + 11 * MIN));
  });
});

describe('parsing a thought', () => {
  const idOf = new Map([['A1', 7]]);

  it('takes a valid move and line, even wrapped in prose', () => {
    expect(
      parseThought('Sure: {"action":"visit","target":"A1","say":"Hey, need me?"}', idOf),
    ).toEqual({ action: 'visit', targetId: 7, say: 'Hey, need me?' });
    expect(parseThought('{"action":"chatManager","say":"Any news?"}', idOf)).toEqual({
      action: 'chatManager',
      say: 'Any news?',
    });
  });

  it('turns a visit to nobody on the board into a line said at the desk', () => {
    expect(parseThought('{"action":"visit","target":"A9","say":"Hm."}', idOf)).toEqual({
      action: 'stay',
      say: 'Hm.',
    });
  });

  it('refuses moves outside the closed set, missing lines and non-JSON', () => {
    expect(parseThought('{"action":"approve","target":"A1","say":"Done!"}', idOf)).toBeUndefined();
    expect(parseThought('{"action":"stay"}', idOf)).toBeUndefined();
    expect(parseThought('{"action":"stay","say":"   "}', idOf)).toBeUndefined();
    expect(parseThought('no json here', idOf)).toBeUndefined();
  });

  it('clips the line to one short bubble', () => {
    const long = 'x'.repeat(500);
    const parsed = parseThought(`{"action":"stay","say":"${long}\\n"}`, idOf);
    expect(parsed?.say.length).toBe(ANSH_SAY_MAX_CHARS);
  });
});

describe('the built-in thought', () => {
  const snap = (
    agents: Array<[number, AgentState]>,
    p: PermissionPending[],
    sources: AnshSources,
  ) => fallbackThought(buildSituation(agents, p, sources, T0));

  it('goes to what needs Ansh first: approvals, then long waits, then repeated failures', () => {
    const agents: Array<[number, AgentState]> = [
      [1, agent(1, { title: 'Fix login' })],
      [2, agent(2, { title: 'Write docs' })],
      [3, agent(3, { title: 'Flaky tests' })],
    ];
    const sources: AnshSources = {
      waitingSinceOf: (id) => (id === 2 ? T0 - 15 * MIN : undefined),
      failuresOf: (id) => (id === 3 ? 4 : 0),
    };
    expect(snap(agents, [pending(1, T0 - 3 * MIN)], sources)).toEqual({
      action: 'visit',
      targetId: 1,
      say: 'Fix login needs my OK on Bash (3 min).',
    });
    expect(snap(agents, [], sources)).toEqual({
      action: 'visit',
      targetId: 2,
      say: 'Write docs has been waiting on me for 15 min.',
    });
    expect(snap(agents, [], { failuresOf: sources.failuresOf })).toEqual({
      action: 'visit',
      targetId: 3,
      say: 'Flaky tests keeps failing, 4 in a row.',
    });
  });

  it('otherwise remarks on the day', () => {
    const busy = agent(1);
    busy.activeToolNames.set('t', 'Bash');
    expect(snap([[1, busy]], [], { todayTasks: () => ({ done: 3, open: 1, waiting: 0 }) })).toEqual(
      {
        action: 'stretch',
        say: '1 busy, 3 done today.',
      },
    );
    expect(snap([[1, agent(1)]], [], {})).toEqual({ action: 'stay', say: 'Quiet office.' });
  });

  it('agents the session limit cut off are on a break: nobody to visit, a line about the reset', () => {
    const agents: Array<[number, AgentState]> = [
      [1, agent(1, { title: 'Fix login', isWaiting: true })],
      [2, agent(2)],
    ];
    const sources: AnshSources = {
      onLimitBreak: (id) => id === 1,
      waitingSinceOf: (id) => (id === 1 ? T0 - 30 * MIN : undefined),
    };
    const { situation } = buildSituation(agents, [], sources, T0);
    expect(situation.agents.map((a) => a.status)).toEqual(['on a break (limit)', 'idle']);
    expect(snap(agents, [], sources)).toEqual({
      action: 'stay',
      say: '1 agent is on a break until the limit resets.',
    });
    // An approval still comes first.
    expect(snap(agents, [pending(2, T0 - MIN)], sources).action).toBe('visit');
  });
});

describe('the brain', () => {
  let dir: string;
  let store: AgentStateStore;
  let now: number;
  let runs: ClaudeRun[];
  let reply: () => Promise<string>;
  let sent: Array<Record<string, unknown>>;
  let brain: AnshBrain | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ansh-brain-'));
    store = new AgentStateStore();
    now = T0;
    runs = [];
    reply = async () => '{"action":"stretch","say":"Stretching my legs."}';
    sent = [];
    store.on('broadcast', (msg: Record<string, unknown>) => sent.push(msg));
    brain = null;
  });

  afterEach(() => {
    brain?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeBrain(env: NodeJS.ProcessEnv = {}, sources: AnshSources = {}): AnshBrain {
    brain = new AnshBrain(store, sources, {
      dataDir: dir,
      now: () => now,
      env,
      runClaude: async (run) => {
        runs.push(run);
        return reply();
      },
    });
    brain.start();
    return brain;
  }
  const thoughts = () => sent.filter((m) => m.type === 'anshThought');

  it('thinks once per change, with claude given no tools', async () => {
    const b = makeBrain();
    store.set(1, agent(1));
    await b.check();
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual([
      '-p',
      '--tools',
      '',
      '--no-session-persistence',
      '--output-format',
      'text',
    ]);
    expect(runs[0].cwd).toBe(path.join(dir, ANSH_DIR_NAME));
    expect(thoughts()).toEqual([
      {
        type: 'anshThought',
        thought: { at: T0, action: 'stretch', say: 'Stretching my legs.', aiWritten: true },
      },
    ]);
    // Nothing changed: no run, however much later.
    now += ANSH_MIN_GAP_MS * 3;
    await b.check();
    expect(runs).toHaveLength(1);
  });

  it('holds a change until the minimum gap has passed, then thinks about it', async () => {
    const b = makeBrain();
    store.set(1, agent(1));
    await b.check();
    store.set(2, agent(2));
    now += ANSH_MIN_GAP_MS - 1;
    await b.check();
    expect(runs).toHaveLength(1);
    now += 1;
    await b.check();
    expect(runs).toHaveLength(2);
  });

  it('skips claude while the session limit has agents on a break (it would fail too)', async () => {
    const b = makeBrain({}, { onLimitBreak: () => true });
    store.set(1, agent(1));
    store.set(2, agent(2));
    await b.check();
    expect(runs).toHaveLength(0);
    expect(thoughts().map((m) => m.thought)).toEqual([
      {
        at: T0,
        action: 'stay',
        say: '2 agents are on a break until the limit resets.',
        aiWritten: false,
      },
    ]);
  });

  it('stays quiet in an empty office', async () => {
    const b = makeBrain();
    await b.check();
    expect(runs).toHaveLength(0);
    expect(thoughts()).toHaveLength(0);
  });

  it('falls back to a built-in thought when claude fails or answers nonsense', async () => {
    const b = makeBrain();
    store.set(1, agent(1));
    reply = async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    };
    await b.check();
    reply = async () => '{"action":"approveEverything","say":"Approved!"}';
    store.set(2, agent(2));
    now += ANSH_MIN_GAP_MS;
    await b.check();
    expect(thoughts().map((m) => (m.thought as { aiWritten: boolean }).aiWritten)).toEqual([
      false,
      false,
    ]);
    expect(thoughts().map((m) => (m.thought as { say: string }).say)).toEqual([
      'Quiet office.',
      'Quiet office.',
    ]);
  });

  it('never runs claude when PIXEL_AGENTS_ANSH_BRAIN or PIXEL_AGENTS_MANAGER is off', async () => {
    expect(anshClaudeEnabled({})).toBe(true);
    expect(anshClaudeEnabled({ PIXEL_AGENTS_ANSH_BRAIN: 'off' })).toBe(false);
    expect(anshClaudeEnabled({ PIXEL_AGENTS_MANAGER: 'off' })).toBe(false);
    const b = makeBrain({ PIXEL_AGENTS_ANSH_BRAIN: 'off' });
    store.set(1, agent(1));
    await b.check();
    expect(runs).toHaveLength(0);
    expect(thoughts()).toHaveLength(1);
  });

  it('stops at the daily cap, and starts again the next day', async () => {
    const b = makeBrain();
    for (let i = 1; i <= ANSH_DAILY_CAP + 2; i++) {
      store.set(i, agent(i));
      now += ANSH_MIN_GAP_MS;
      await b.check();
    }
    expect(runs).toHaveLength(ANSH_DAILY_CAP);
    now = new Date(2026, 9, 19, 9, 0, 0).getTime();
    await b.check();
    expect(runs).toHaveLength(ANSH_DAILY_CAP + 1);
  });

  it('"Ask Ansh" thinks now, but not twice within the ask gap', async () => {
    const b = makeBrain();
    store.set(1, agent(1));
    await b.ask();
    await b.ask();
    expect(runs).toHaveLength(1);
    now += ANSH_ASK_MIN_GAP_MS;
    await b.ask();
    expect(runs).toHaveLength(2);
  });

  it('switched off: no looks, no asks; the choice and the thoughts survive a restart', async () => {
    const b = makeBrain();
    store.set(1, agent(1));
    await b.check();
    b.setEnabled(false);
    store.set(2, agent(2));
    now += ANSH_MIN_GAP_MS;
    await b.check();
    await b.ask();
    expect(runs).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: 'anshBrainState', enabled: false, thoughtsToday: 1 });
    const file = JSON.parse(
      fs.readFileSync(path.join(dir, ANSH_DIR_NAME, ANSH_STATE_FILE_NAME), 'utf-8'),
    ) as { enabled: boolean; thoughts: unknown[] };
    expect(file.enabled).toBe(false);
    expect(file.thoughts).toHaveLength(1);
    b.dispose();
    const again = makeBrain();
    expect(again.stateMessage()).toMatchObject({ enabled: false, thoughtsToday: 1 });
    expect(again.stateMessage().thoughts).toHaveLength(1);
  });

  it('never thinks where it was not started (VS Code, tests)', async () => {
    brain = new AnshBrain(
      store,
      {},
      { dataDir: null, runClaude: async (run) => (runs.push(run), '') },
    );
    store.set(1, agent(1));
    await brain.ask();
    expect(runs).toHaveLength(0);
    expect(brain.stateMessage().enabled).toBe(false);
  });
});
