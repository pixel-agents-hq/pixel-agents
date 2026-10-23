import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Task, TimeReport } from '../../core/src/messages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { TASKS_DIR_NAME, TIME_REPORT_MAX_DAYS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { TOKENS_DIR_NAME } from '../src/signals/constants.js';
import { TokenMeter, type UsageEntry } from '../src/signals/tokenMeter.js';
import {
  buildTimeReport,
  datesBetween,
  timeReportRange,
  type TimeReportSources,
} from '../src/tasks/timeReport.js';
import { processTranscriptLine } from '../src/transcriptParser.js';

/**
 * Time per repo (docs/office/DESIGN.md, phase G): the task log and the token
 * meter summed per repo per day over a date range, the token meter's repo
 * attribution (and the files it wrote before it had one), and the request's
 * validation. Every file lives in a temp dir; nothing touches ~/.pixel-agents.
 */

const MIN = 60_000;
/** 10:00 local time on 2026-10-17. */
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const TODAY = '2026-10-17';
const YESTERDAY = '2026-10-16';
const OPUS = 'claude-opus-5-5';
const isoAt = (t: number) => new Date(t).toISOString();

function task(repo: string, over: Partial<Task> = {}): Task {
  return {
    id: `${repo}-${Math.random()}`,
    title: `Work on ${repo}`,
    repo,
    machine: 'local',
    sessionId: 's',
    startedAt: T0,
    status: 'done',
    prs: [],
    pushes: 0,
    filesEdited: 0,
    commands: 0,
    activeMs: 0,
    ...over,
  };
}

function usage(repo: string | undefined, input: number, output = 0, model = OPUS): UsageEntry {
  return {
    ...(repo !== undefined ? { repo } : {}),
    model,
    tokens: { input, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  };
}

function sourcesOf(
  tasks: Record<string, Task[]>,
  tokens: Record<string, UsageEntry[]>,
): TimeReportSources {
  return { tasksFor: (d) => tasks[d] ?? [], usageFor: (d) => tokens[d] ?? [] };
}

function assistant(
  id: string,
  usage: Record<string, unknown>,
  at = T0,
  model = OPUS,
): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: isoAt(at),
    message: { id, model, usage, content: [{ type: 'text', text: 'hi' }] },
  };
}

/** A task day file as the ledger writes it. */
function writeTaskDay(dataDir: string, date: string, tasks: Task[]): void {
  const dir = path.join(dataDir, TASKS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${date}.json`),
    JSON.stringify({ version: 1, date, tasks: tasks.map((t) => ({ ...t, fileKeys: [] })) }),
  );
}

/** A token day file: version 1 (no repo) or 2 (repo after the figures). */
function writeTokenDay(
  dataDir: string,
  date: string,
  messages: Record<string, Array<string | number>>,
  version: 1 | 2,
): void {
  const dir = path.join(dataDir, TOKENS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ version, date, messages }));
}

describe('timeReportRange', () => {
  it('accepts real dates in order, up to the cap', () => {
    expect(timeReportRange('2026-10-12', '2026-10-18')).toEqual({
      from: '2026-10-12',
      to: '2026-10-18',
    });
    expect(timeReportRange(TODAY, TODAY)).toEqual({ from: TODAY, to: TODAY });
    // 31 days: a whole month.
    expect(timeReportRange('2026-10-01', '2026-10-31')).toBeDefined();
    expect(TIME_REPORT_MAX_DAYS).toBe(31);
  });

  it('rejects bad dates, a backwards range and a span over the cap', () => {
    for (const bad of ['../../x', '2026-1-01', '2026-02-30', 20261017, undefined, null]) {
      expect(timeReportRange(bad, TODAY)).toBeUndefined();
      expect(timeReportRange(TODAY, bad)).toBeUndefined();
    }
    expect(timeReportRange('2026-10-18', '2026-10-17')).toBeUndefined();
    // 32 days.
    expect(timeReportRange('2026-10-01', '2026-11-01')).toBeUndefined();
  });

  it('lists every date of a range, across a month end', () => {
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(datesBetween(TODAY, TODAY)).toEqual([TODAY]);
  });
});

describe('buildTimeReport', () => {
  const range = { from: YESTERDAY, to: TODAY };

  it('sums tasks and attributed tokens per repo per day, in date then repo order', () => {
    const pr = { title: 'Fix', repo: 'web', at: T0 };
    const report = buildTimeReport(
      range,
      sourcesOf(
        {
          [YESTERDAY]: [task('web', { activeMs: 30 * MIN })],
          [TODAY]: [
            task('web', { activeMs: 60 * MIN, prs: [pr], pushes: 2 }),
            task('web', { activeMs: 15 * MIN, pushes: 1 }),
            task('api', { activeMs: 5 * MIN }),
          ],
        },
        {
          [TODAY]: [usage('web', 1_000_000, 1_000_000), usage('web', 500_000), usage('api', 100)],
        },
      ),
    );
    expect(report).toMatchObject({ type: 'timeReport', from: YESTERDAY, to: TODAY });
    expect(report.rows).toEqual([
      // Yesterday's token file had nothing for web: no figures, not zero.
      { date: YESTERDAY, repo: 'web', activeMs: 30 * MIN, tasks: 1, prs: 0, pushes: 0 },
      {
        date: TODAY,
        repo: 'api',
        activeMs: 5 * MIN,
        tasks: 1,
        prs: 0,
        pushes: 0,
        input: 100,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedUsd: 0.0004,
      },
      {
        date: TODAY,
        repo: 'web',
        activeMs: 75 * MIN,
        tasks: 2,
        prs: 1,
        pushes: 3,
        input: 1_500_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        // Opus 5.5: $4/M in, $20/M out.
        estimatedUsd: 6 + 20,
      },
    ]);
    expect(report.unattributed).toEqual([]);
  });

  it('gives a repo with tokens but no task a row of its own, and skips days with nothing', () => {
    const report = buildTimeReport(
      { from: '2026-10-14', to: TODAY },
      sourcesOf({ [TODAY]: [task('web')] }, { [YESTERDAY]: [usage('manager', 10)] }),
    );
    expect(report.rows.map((r) => [r.date, r.repo, r.tasks, r.input])).toEqual([
      [YESTERDAY, 'manager', 0, 10],
      [TODAY, 'web', 1, undefined],
    ]);
  });

  it('sums tokens without a repo per day as unattributed', () => {
    const report = buildTimeReport(
      range,
      sourcesOf(
        { [YESTERDAY]: [task('web')] },
        { [YESTERDAY]: [usage(undefined, 1_000_000), usage(undefined, 0, 1_000_000)] },
      ),
    );
    expect(report.rows).toEqual([
      { date: YESTERDAY, repo: 'web', activeMs: 0, tasks: 1, prs: 0, pushes: 0 },
    ]);
    expect(report.unattributed).toEqual([
      {
        date: YESTERDAY,
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedUsd: 24,
      },
    ]);
  });

  it('marks an estimate partial when a model has no price, and gives none when nothing has', () => {
    const report = buildTimeReport(
      { from: TODAY, to: TODAY },
      sourcesOf(
        {},
        {
          [TODAY]: [
            usage('web', 1_000_000),
            usage('web', 50, 0, 'claude-mystery-1'),
            usage('api', 50, 0, 'claude-mystery-1'),
          ],
        },
      ),
    );
    expect(report.rows).toEqual([
      {
        date: TODAY,
        repo: 'api',
        activeMs: 0,
        tasks: 0,
        prs: 0,
        pushes: 0,
        input: 50,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        date: TODAY,
        repo: 'web',
        activeMs: 0,
        tasks: 0,
        prs: 0,
        pushes: 0,
        input: 1_000_050,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedUsd: 4,
        partialEstimate: true,
      },
    ]);
  });
});

describe('TokenMeter repo attribution', () => {
  let dir: string;
  let clock: number;

  const meter = () => new TokenMeter({ dir, now: () => clock, onChange: () => {} });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-time-tokens-'));
    clock = T0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps each response’s repo, persists it, and reads it back for the report', () => {
    const first = meter();
    first.record(assistant('msg_web', { input_tokens: 10 }), 'web');
    first.record(assistant('msg_none', { input_tokens: 5 }));
    // The same response again, now with its repo known: attributed, not doubled.
    expect(first.record(assistant('msg_none', { input_tokens: 5 }), 'api')).toBe(true);
    expect(first.record(assistant('msg_none', { input_tokens: 5 }), 'api')).toBe(false);
    first.dispose();

    const stored = JSON.parse(fs.readFileSync(path.join(dir, `${TODAY}.json`), 'utf-8'));
    expect(stored.version).toBe(2);
    expect(stored.messages.msg_web).toEqual([OPUS, 10, 0, 0, 0, 0, 0, 'web']);

    const second = meter();
    expect(second.usageFor(TODAY)).toEqual([
      { repo: 'web', model: OPUS, tokens: expect.objectContaining({ input: 10 }) },
      { repo: 'api', model: OPUS, tokens: expect.objectContaining({ input: 5 }) },
    ]);
    // Another day comes from its file; a day with none is empty.
    expect(second.usageFor(YESTERDAY)).toEqual([]);
    second.dispose();
  });

  it('reads a version 1 file (no repos) as unattributed usage, totals intact', () => {
    fs.writeFileSync(
      path.join(dir, `${YESTERDAY}.json`),
      JSON.stringify({
        version: 1,
        date: YESTERDAY,
        messages: { msg_old: [OPUS, 10, 20, 30, 40, 50, 1] },
      }),
    );
    const m = meter();
    expect(m.usageFor(YESTERDAY)).toEqual([
      {
        model: OPUS,
        tokens: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite5m: 40,
          cacheWrite1h: 50,
          fast: true,
        },
      },
    ]);
    expect(m.usageFor(YESTERDAY)[0]).not.toHaveProperty('repo');
    // Reading today's version 1 file keeps the day's totals too.
    fs.renameSync(path.join(dir, `${YESTERDAY}.json`), path.join(dir, `${TODAY}.json`));
    const today = meter();
    expect(today.message()).toMatchObject({ input: 10, output: 20, cacheRead: 30, cacheWrite: 90 });
    today.dispose();
    m.dispose();
  });

  it('an in-memory meter answers only for today', () => {
    const m = new TokenMeter({ dir: null, now: () => clock, onChange: () => {} });
    m.record(assistant('msg_1', { input_tokens: 1 }), 'web');
    expect(m.usageFor(TODAY)).toHaveLength(1);
    expect(m.usageFor(YESTERDAY)).toEqual([]);
    m.dispose();
  });
});

/**
 * End to end through the message handler: the standalone runtime over a temp
 * data dir, with the task log, token files and transcripts it would have on
 * disk, answers a read-only client's requestTimeReport and nothing else. The
 * reply follows the transcript scan, so the tests wait for it.
 */
describe('clientMessageHandler: requestTimeReport', () => {
  let dataDir: string;
  let projectsDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-time-report-'));
    projectsDir = path.join(dataDir, 'projects');
    fs.mkdirSync(projectsDir);
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, {
      progress: { dailyDir: null, now: () => T0 },
      manager: { dataDir, now: () => T0, env: {} },
      signals: {
        tokensDir: path.join(dataDir, TOKENS_DIR_NAME),
        projectsDir,
        noticeBoard: null,
        now: () => T0,
      },
    });
    sent = [];
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const dispatch = (msg: Record<string, unknown>, privileged = false) =>
    handleClientMessage(msg, (m) => sent.push(m), { store, runtime, cache: null, privileged });

  /** The reply to the request just dispatched. */
  async function reply(): Promise<TimeReport> {
    const want = sent.length + 1;
    for (let i = 0; i < 200 && sent.length < want; i++) await settle();
    expect(sent).toHaveLength(want);
    return sent[want - 1] as unknown as TimeReport;
  }

  it('answers a read-only client from the day files, the transcripts and today’s live log', async () => {
    writeTaskDay(dataDir, YESTERDAY, [
      task('web', { activeMs: 90 * MIN, pushes: 1 }),
      task('api', { activeMs: 10 * MIN }),
    ]);
    writeTokenDay(dataDir, '2026-10-15', { old: [OPUS, 1_000_000, 0, 0, 0, 0, 0] }, 1);
    writeTokenDay(dataDir, YESTERDAY, { m1: [OPUS, 1_000_000, 0, 0, 0, 0, 0, 'web'] }, 2);

    // Today: an agent in `web` works (a live task) and its transcript reports usage.
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's1',
        projectDir: '/w/web',
        jsonlFile: '',
        isExternal: true,
        directoryName: 'web',
        title: 'Ship it',
      }),
    );
    store.broadcast({ type: 'agentStatus', id: 1, status: 'active' });
    processTranscriptLine(
      1,
      JSON.stringify(assistant('msg_live', { input_tokens: 2_000_000, output_tokens: 1 })),
      store,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    // A transcript the board never watched: a `docs` session earlier today, and
    // the same live response of web's (counted once).
    fs.mkdirSync(path.join(projectsDir, '-w-docs'));
    fs.writeFileSync(
      path.join(projectsDir, '-w-docs', 's9.jsonl'),
      [
        JSON.stringify({
          ...assistant('msg_docs', { input_tokens: 500_000 }, T0 - 60 * MIN),
          cwd: '/w/docs',
        }),
        JSON.stringify({
          ...assistant('msg_live', { input_tokens: 2_000_000, output_tokens: 1 }),
          cwd: '/w/web',
        }),
      ].join('\n'),
    );

    dispatch({ type: 'requestTimeReport', from: '2026-10-15', to: TODAY });
    const report = await reply();
    expect(report.type).toBe('timeReport');
    expect(report.rows).toEqual([
      {
        date: YESTERDAY,
        repo: 'api',
        activeMs: 10 * MIN,
        tasks: 1,
        prs: 0,
        pushes: 0,
      },
      {
        date: YESTERDAY,
        repo: 'web',
        activeMs: 90 * MIN,
        tasks: 1,
        prs: 0,
        pushes: 1,
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedUsd: 4,
      },
      {
        date: TODAY,
        repo: 'docs',
        activeMs: 0,
        tasks: 0,
        prs: 0,
        pushes: 0,
        input: 500_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedUsd: 2,
      },
      {
        date: TODAY,
        repo: 'web',
        activeMs: 0,
        tasks: 1,
        prs: 0,
        pushes: 0,
        input: 2_000_000,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedUsd: 8,
      },
    ]);
    // The version 1 day: tokens, but no repo to put them on.
    expect(report.unattributed).toEqual([
      {
        date: '2026-10-15',
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        estimatedUsd: 4,
      },
    ]);
  });

  it('credits a sub-agent’s transcript to its lead’s repo', async () => {
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's1',
        projectDir: '/w/web',
        jsonlFile: '',
        isExternal: true,
        directoryName: 'web',
      }),
    );
    store.set(
      2,
      createAgentState({
        id: 2,
        sessionId: 's1',
        projectDir: '/w/web',
        jsonlFile: '',
        isExternal: true,
        leadAgentId: 1,
      }),
    );
    processTranscriptLine(
      2,
      JSON.stringify(assistant('msg_sub', { input_tokens: 7 })),
      store,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    dispatch({ type: 'requestTimeReport', from: TODAY, to: TODAY });
    expect((await reply()).rows).toEqual([
      expect.objectContaining({ date: TODAY, repo: 'web', tasks: 0, input: 7 }),
    ]);
  });

  it('drops a bad or over-long range unanswered', async () => {
    dispatch({ type: 'requestTimeReport', from: '2026-10-18', to: TODAY });
    dispatch({ type: 'requestTimeReport', from: '2026-09-01', to: TODAY });
    dispatch({ type: 'requestTimeReport', from: '../../x', to: TODAY });
    dispatch({ type: 'requestTimeReport', from: TODAY });
    dispatch({ type: 'requestTimeReport' });
    await settle();
    expect(sent).toEqual([]);
  });

  it('answers with an empty report without a runtime', async () => {
    runtime.dispose(); // its hub is the registered one: gone, nothing answers for tokens
    handleClientMessage(
      { type: 'requestTimeReport', from: YESTERDAY, to: TODAY },
      (m) => sent.push(m),
      { store, cache: null, privileged: false },
    );
    expect(await reply()).toEqual({
      type: 'timeReport',
      from: YESTERDAY,
      to: TODAY,
      rows: [],
      unattributed: [],
    });
  });
});

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
