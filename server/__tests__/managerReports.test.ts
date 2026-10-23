import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from '../../core/src/messages.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { type AlertFetch, PhoneAlerts } from '../src/alerts.js';
import {
  MANAGER_CLAUDE_MAX_BUFFER,
  MANAGER_CLAUDE_TIMEOUT_MS,
  MANAGER_DIR_NAME,
  MANAGER_REPORT_CHECK_INTERVAL_MS,
  REPORTS_DIR_NAME,
} from '../src/constants.js';
import { ProgressTracker } from '../src/progress/progressTracker.js';
import {
  buildReportData,
  buildReportPrompt,
  type ClaudeRun,
  formatMinutes,
  gatherWorkReport,
  ManagerReports,
  managerReportsEnabled,
  repoFacts,
  splitReport,
  type TaskWithNotes,
  templateDetails,
  templateOverview,
  withRepoFacts,
} from '../src/tasks/managerReports.js';
import type { PublishedReport } from '../src/tasks/notionConnector.js';
import { TaskLedger } from '../src/tasks/taskLedger.js';
import type { AgentState } from '../src/types.js';

/**
 * The Manager's daily report (docs/office/DESIGN.md, phase M): at 19:00 local
 * (or on "Write report now") the day's task log goes to `claude -p` as compact
 * JSON; on any failure a deterministic template is written instead. The claude
 * runner, ntfy fetch, clock and data dir are all injected: nothing runs claude,
 * nothing leaves the machine, nothing touches the real ~/.pixel-agents.
 */

const MIN = 60_000;
const DAY = '2026-10-17';
const at = (h: number, m = 0, d = 17) => new Date(2026, 9, d, h, m, 0).getTime();
const PR_URL = 'https://github.com/acme/web/pull/42';
const TOPIC = 'pixel-agents-Xy12_ab';
const AI_OVERVIEW = 'Hi Ansh!\n\n## Overview\n- **hobbyfi-blog** — Shipped the strip';
const AI_DETAILS =
  '## hobbyfi-blog\n\n- **The strip** — Done · 42 min\n  - It now shows on the home page';
const AI_MARKDOWN = `${AI_OVERVIEW}\n===DETAILS===\n${AI_DETAILS}`;

function task(overrides: Partial<TaskWithNotes>): TaskWithNotes {
  return {
    id: overrides.title ?? 'id',
    title: 'Task',
    repo: 'hobbyfi-blog',
    machine: 'local',
    sessionId: 'session-secret-uuid',
    startedAt: at(9),
    status: 'done',
    prs: [],
    pushes: 0,
    filesEdited: 0,
    commands: 0,
    activeMs: 0,
    ...overrides,
  };
}

const SAMPLE: Task[] = [
  task({
    title: 'Ship the strip',
    status: 'done',
    activeMs: 42 * MIN,
    pushes: 2,
    filesEdited: 5,
    commands: 12,
    prs: [{ title: 'Add the strip', repo: 'acme/web', url: PR_URL, at: at(11) }],
  }),
  task({ title: 'Refactor auth', status: 'in_progress', activeMs: 75 * MIN, commands: 30 }),
  task({ title: 'Pick a font', status: 'waiting', activeMs: 3 * MIN }),
  task({ title: '💻 Mac · web', repo: 'web', machine: 'Mac', status: 'done', activeMs: 10 * MIN }),
];

describe('report data and prompt', () => {
  it('builds compact JSON: titles, repos, machines, status, minutes and counts only', () => {
    const data = buildReportData(DAY, SAMPLE);
    expect(data).toEqual({
      date: DAY,
      totals: { done: 2, open: 1, waiting: 1, prs: 1, pushes: 2, minutesActive: 130 },
      tasks: [
        {
          title: 'Ship the strip',
          repo: 'hobbyfi-blog',
          machine: 'local',
          status: 'done',
          minutesActive: 42,
          prs: [{ title: 'Add the strip', url: PR_URL }],
          pushes: 2,
          files: 5,
          commands: 12,
        },
        expect.objectContaining({
          title: 'Refactor auth',
          status: 'in_progress',
          minutesActive: 75,
        }),
        expect.objectContaining({ title: 'Pick a font', status: 'waiting', minutesActive: 3 }),
        expect.objectContaining({ title: '💻 Mac · web', machine: 'Mac', minutesActive: 10 }),
      ],
    });
    // No ids, sessions or times leave the machine.
    expect(JSON.stringify(data)).not.toMatch(/session-secret-uuid|startedAt|"id"/);
  });

  it('asks for an overview and per-repo details, in plain English, from the JSON alone', async () => {
    const data = await gatherWorkReport(DAY, SAMPLE, { projectsRoot: null, git: null });
    const prompt = buildReportPrompt(data);
    for (const section of ['Overview', 'Waiting on you', 'PRs shipped', 'Tomorrow']) {
      expect(prompt).toContain(`## ${section}`);
    }
    expect(prompt).toContain('===DETAILS===');
    expect(prompt).toContain('Ansh');
    expect(prompt).toMatch(/plain, simple English/);
    expect(prompt).toMatch(/never invent/i);
    expect(prompt).toContain(JSON.stringify(data));
    // No ids or sessions leave the machine.
    expect(JSON.stringify(data)).not.toMatch(/session-secret-uuid|startedAt|"id"/);
  });

  it('splits the reply at the marker; no marker is all overview', () => {
    expect(splitReport(AI_MARKDOWN)).toEqual({ overview: AI_OVERVIEW, details: AI_DETAILS });
    expect(splitReport('  just a report \n')).toEqual({ overview: 'just a report' });
  });

  it('formats minutes', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(80)).toBe('1 h 20 min');
  });

  it('writes deterministic template parts from the same data', async () => {
    const data = await gatherWorkReport(DAY, SAMPLE, { projectsRoot: null, git: null });
    const overview = templateOverview(data);
    expect(templateOverview(data)).toBe(overview);
    expect(overview).toContain('Ansh');
    expect(overview).toMatch(/## Overview\n+- \*\*hobbyfi-blog\*\*/);
    expect(overview).toMatch(/## Waiting on you\n+- \*\*Pick a font\*\*/);
    expect(overview).toContain(`[Add the strip](${PR_URL})`);
    expect(overview).toMatch(/## Tomorrow\n+.*waiting on you/i);
    const details = templateDetails(data);
    expect(details).toContain('## hobbyfi-blog');
    expect(details).toContain('- **Ship the strip** — Done · 42 min');
    expect(details).toContain('- **Refactor auth** — In progress · 1 h 15 min');
    // A remote session's title only names its machine: it is called a session there.
    expect(details).toMatch(/## web\n\n- \*\*Session on Mac\*\*/);
  });

  it('says so when there is nothing', async () => {
    const data = await gatherWorkReport(DAY, [], { projectsRoot: null, git: null });
    expect(templateOverview(data)).toMatch(/## Overview\n+_Nothing ran/);
    expect(templateOverview(data)).toMatch(/## PRs shipped\n+_No PRs/);
    expect(templateDetails(data)).toMatch(/Nothing ran/);
  });

  it('keeps the totals the dashboard and MCP read', () => {
    expect(buildReportData(DAY, SAMPLE).totals).toMatchObject({ done: 2, open: 1, waiting: 1 });
  });
});

describe('withRepoFacts', () => {
  it("adds each repo's facts under its section, and a section for a repo the details left out", async () => {
    const data = await gatherWorkReport(DAY, SAMPLE, { projectsRoot: null, git: null });
    const out = withRepoFacts('Intro\n\n## hobbyfi-blog\n\n- **The strip** — Done', data);
    expect(out).toMatch(
      /^Intro\n\n## hobbyfi-blog\n\n- \*\*The strip\*\* — Done\n- \*\*The numbers\*\* — /,
    );
    expect(out).toContain(`- **PRs**\n  - [Add the strip](${PR_URL})`);
    expect(out).toMatch(
      /## web\n\n- \*\*The numbers\*\* — 10 min · 1 session · on Mac · 0 commits/,
    );
  });
});

describe('gatherWorkReport', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-projects-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const record = (type: string, hour: number, content: unknown, extra = {}) =>
    JSON.stringify({
      type,
      timestamp: new Date(at(hour)).toISOString(),
      cwd: '/work/hobbyfi-blog',
      message: { role: type, content },
      ...extra,
    });

  it("reads a local task's asks, outcomes and plan from its transcript, within its time", async () => {
    fs.mkdirSync(path.join(root, '-work-hobbyfi-blog'));
    fs.writeFileSync(
      path.join(root, '-work-hobbyfi-blog', 'sess-1.jsonl'),
      [
        record('user', 8, 'a prompt from before the task'),
        record('user', 9, 'Add a newsletter strip to the home page', { gitBranch: 'feat/strip' }),
        record('assistant', 9, [
          { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Build strip' }] } },
        ]),
        record('assistant', 10, [{ type: 'text', text: 'The strip is live on the home page.' }]),
        record('user', 10, [{ type: 'tool_result', content: 'ok' }]),
        record('user', 10, '<command-name>/clear</command-name>'),
        record('user', 11, 'sidechain', { isSidechain: true }),
      ].join('\n'),
    );
    const gitCalls: string[][] = [];
    const git = async (args: string[]) => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse') return '/work/hobbyfi-blog\n';
      if (args[0] === 'config') return 'ansh@example.com\n';
      return [
        '\x1eabc1234\trefs/heads/main\tAdd newsletter strip',
        '',
        '30\t2\tsrc/strip.ts',
        '4\t0\tsrc/home.ts',
        '\x1edef5678\trefs/heads/feat/strip\tFix strip spacing',
        '',
        '1\t1\tsrc/strip.ts',
        '-\t-\tlogo.png',
        '',
      ].join('\n');
    };
    const tasks: TaskWithNotes[] = [
      task({
        title: 'Newsletter strip',
        sessionId: 'sess-1',
        startedAt: at(9),
        activeMs: 30 * MIN,
      }),
    ];
    const data = await gatherWorkReport(DAY, tasks, { projectsRoot: root, git, now: () => at(20) });
    const [repo] = data.repos;
    expect(repo.repo).toBe('hobbyfi-blog');
    expect(repo.commits).toEqual(['Add newsletter strip', 'Fix strip spacing']);
    expect(repo.git).toEqual({
      branches: [
        { name: 'main', commits: [{ hash: 'abc1234', subject: 'Add newsletter strip' }] },
        { name: 'feat/strip', commits: [{ hash: 'def5678', subject: 'Fix strip spacing' }] },
      ],
      files: 3,
      insertions: 35,
      deletions: 3,
    });
    expect(repo.tasks[0].branch).toBe('feat/strip');
    // The facts block lists every commit by branch; the report run never sees it.
    const facts = repoFacts(repo).join('\n');
    expect(facts).toContain(
      '- **The numbers** — 30 min · 1 session · on this PC · 2 commits · +35 / −3 lines in 3 files',
    );
    expect(facts).toContain('- **Worked on** — `feat/strip`');
    expect(facts).toContain('  - `main` — 1 commit\n    - `abc1234` Add newsletter strip');
    expect(buildReportPrompt(data)).not.toContain('abc1234');
    expect(repo.tasks[0]).toMatchObject({
      asked: ['Add a newsletter strip to the home page'],
      outcomes: ['The strip is live on the home page.'],
      plan: ['Build strip'],
    });
    expect(gitCalls.find((a) => a[0] === 'log')).toContain('--author=ansh@example.com');
  });

  it("uses a remote task's live notes, and folds sessions with nothing recorded", async () => {
    const tasks: TaskWithNotes[] = [
      task({
        title: '💻 Mac · native-re',
        repo: 'native-re',
        machine: 'Mac',
        activeMs: 90 * MIN,
        notes: {
          asks: [],
          outcomes: ['Decoded the save format'],
          todos: [],
          commits: ['Add decoder'],
        },
      }),
      task({ title: '💻 Mac · native-re', repo: 'native-re', machine: 'Mac' }),
    ];
    const data = await gatherWorkReport(DAY, tasks, { projectsRoot: root, git: null });
    expect(data.repos).toHaveLength(1);
    expect(data.repos[0]).toMatchObject({ machines: ['Mac'], minutesActive: 90, briefSessions: 1 });
    expect(data.repos[0].tasks[0]).toMatchObject({
      outcomes: ['Decoded the save format'],
      commits: ['Add decoder'],
    });
  });
});

describe('managerReportsEnabled', () => {
  it('is on unless PIXEL_AGENTS_MANAGER turns it off', () => {
    expect(managerReportsEnabled({})).toBe(true);
    expect(managerReportsEnabled({ PIXEL_AGENTS_MANAGER: 'on' })).toBe(true);
    for (const off of ['off', 'OFF', ' 0 ', 'false', 'no']) {
      expect(managerReportsEnabled({ PIXEL_AGENTS_MANAGER: off })).toBe(false);
    }
  });
});

describe('ManagerReports', () => {
  let dataDir: string;
  let store: AgentStateStore;
  let clock: number;
  let tracker: ProgressTracker;
  let ledger: TaskLedger;
  let alerts: PhoneAlerts;
  let reports: ManagerReports;
  let runs: ClaudeRun[];
  let runner: (run: ClaudeRun) => Promise<string>;
  let sent: Array<{ url: string; body: string; headers: Record<string, string> }>;
  let messages: Array<Record<string, unknown>>;
  let env: NodeJS.ProcessEnv;
  let published: PublishedReport[];
  let publishUrl: string | undefined;

  const reportFile = (date = DAY) => path.join(dataDir, REPORTS_DIR_NAME, `${date}.json`);
  const readReport = (date = DAY) => JSON.parse(fs.readFileSync(reportFile(date), 'utf-8'));
  const alertsFile = () => path.join(dataDir, 'alerts.json');

  function newReports(platform: NodeJS.Platform = 'linux'): ManagerReports {
    return new ManagerReports(store, ledger, alerts, {
      dataDir,
      now: () => clock,
      env,
      platform,
      runClaude: (run) => {
        runs.push(run);
        return runner(run);
      },
      projectsRoot: null,
      git: null,
      publisher: {
        publish: async (report) => {
          published.push(report);
          return publishUrl;
        },
      },
    });
  }

  function addAgent(id: number, extra: Partial<AgentState> = {}): void {
    store.set(
      id,
      createAgentState({
        id,
        sessionId: `session-${id}`,
        isExternal: true,
        projectDir: '/work',
        jsonlFile: '',
        directoryName: 'hobbyfi-blog',
        ...extra,
      }),
    );
  }
  const status = (id: number, s: 'active' | 'waiting') =>
    store.broadcast({ type: 'agentStatus', id, status: s });

  /** Two done, one in progress, one waiting. */
  function seedDay(): void {
    for (const [id, title] of [
      [1, 'Ship the strip'],
      [2, 'Write the docs'],
      [3, 'Refactor auth'],
      [4, 'Pick a font'],
    ] as const) {
      addAgent(id, { title });
      status(id, 'active');
    }
    status(4, 'waiting');
    store.delete(1);
    store.delete(2);
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-reports-'));
    store = new AgentStateStore();
    clock = at(10);
    tracker = new ProgressTracker(store, { dailyDir: null, now: () => clock });
    ledger = new TaskLedger(store, tracker, { dataDir, now: () => clock });
    sent = [];
    const fetchImpl: AlertFetch = async (url, init) => {
      sent.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 200 };
    };
    alerts = new PhoneAlerts(store, tracker, {
      configFile: alertsFile(),
      fetch: fetchImpl,
      now: () => clock,
    });
    runs = [];
    runner = async () => `\n${AI_MARKDOWN}\n\n`;
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
    env = {};
    published = [];
    publishUrl = undefined;
    reports = newReports();
  });

  afterEach(() => {
    reports.dispose();
    alerts.dispose();
    ledger.dispose();
    tracker.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('writing a report', () => {
    it('runs claude -p with no tools and no session, in the manager dir, prompt on stdin', async () => {
      seedDay();
      await reports.writeNow();

      expect(runs).toHaveLength(1);
      const [run] = runs;
      expect(run.file).toBe('claude');
      expect(run.args).toEqual([
        '-p',
        '--tools',
        '',
        '--no-session-persistence',
        '--output-format',
        'text',
      ]);
      expect(run.args).not.toContain('--bare');
      expect(run.cwd).toBe(path.join(dataDir, MANAGER_DIR_NAME));
      expect(fs.statSync(run.cwd).isDirectory()).toBe(true);
      expect(run.timeout).toBe(MANAGER_CLAUDE_TIMEOUT_MS);
      expect(MANAGER_CLAUDE_TIMEOUT_MS).toBe(300_000);
      expect(run.maxBuffer).toBe(MANAGER_CLAUDE_MAX_BUFFER);
      expect(MANAGER_CLAUDE_MAX_BUFFER).toBe(1024 * 1024);
      expect(run.input).toBe(
        buildReportPrompt(
          await gatherWorkReport(DAY, ledger.tasksWithNotesFor(DAY), {
            projectsRoot: null,
            git: null,
          }),
        ),
      );
      expect(run.input).toContain('Refactor auth');
    });

    it('saves the AI report and announces it', async () => {
      seedDay();
      clock = at(15, 30);
      await reports.writeNow();
      const details = readReport().details as string;
      expect(details.startsWith(AI_DETAILS)).toBe(true);
      expect(details).toContain('- **The numbers** — 0 min · 4 sessions · on this PC · 0 commits');
      expect(readReport()).toEqual({
        date: DAY,
        markdown: AI_OVERVIEW,
        details,
        generatedAt: at(15, 30),
        aiWritten: true,
      });
      expect(messages).toContainEqual({ type: 'reportReady', date: DAY });
      expect(reports.reportMessage(DAY)).toEqual({
        type: 'report',
        date: DAY,
        exists: true,
        markdown: AI_OVERVIEW,
        details,
        generatedAt: at(15, 30),
        aiWritten: true,
      });
    });

    it('sends the report to the publisher and keeps the page link', async () => {
      seedDay();
      publishUrl = 'https://www.notion.so/Day-abc';
      await reports.writeNow();
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        date: DAY,
        title: 'Saturday, 17 October 2026',
        details: readReport().details,
      });
      expect(published[0].details).toContain(AI_DETAILS);
      expect(published[0].repos).toEqual(['hobbyfi-blog']);
      expect(readReport().notionUrl).toBe(publishUrl);
      expect(reports.reportMessage(DAY)).toMatchObject({ notionUrl: publishUrl });
      expect(messages.filter((m) => m.type === 'reportReady')).toHaveLength(2);
    });

    it('keeps the AI overview and writes template details when the marker is missing', async () => {
      runner = async () => 'Just an overview';
      await reports.writeNow();
      expect(readReport()).toMatchObject({ markdown: 'Just an overview', aiWritten: true });
      expect(readReport().details).toMatch(/Nothing ran/);
    });

    it('uses claude.exe on Windows, and PIXEL_AGENTS_CLAUDE_BIN over either', async () => {
      reports.dispose();
      reports = newReports('win32');
      await reports.writeNow();
      expect(runs.at(-1)!.file).toBe('claude.exe');

      reports.dispose();
      env = { PIXEL_AGENTS_CLAUDE_BIN: '/opt/claude/bin/claude' };
      reports = newReports('win32');
      await reports.writeNow();
      expect(runs.at(-1)!.file).toBe('/opt/claude/bin/claude');
    });

    it('writes the template report when claude fails', async () => {
      const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seedDay();
      runner = async () => {
        throw new Error('spawn claude ENOENT');
      };
      await reports.writeNow();
      const data = await gatherWorkReport(DAY, ledger.tasksWithNotesFor(DAY), {
        projectsRoot: null,
        git: null,
      });
      expect(readReport()).toMatchObject({
        markdown: templateOverview(data),
        details: withRepoFacts(templateDetails(data), data),
        aiWritten: false,
      });
      expect(messages).toContainEqual({ type: 'reportReady', date: DAY });
      expect(logged).toHaveBeenCalled();
    });

    it('writes the template report when claude answers with nothing', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      runner = async () => '   \n';
      await reports.writeNow();
      expect(readReport()).toMatchObject({ aiWritten: false });
      expect(readReport().markdown).toContain('## Overview');
    });

    it('answers requestReport with writing:true while it runs, one run at a time', async () => {
      let finish!: (text: string) => void;
      runner = () => new Promise<string>((resolve) => (finish = resolve));
      const first = reports.writeNow();
      const second = reports.writeNow();
      await Promise.resolve();
      expect(reports.reportMessage(DAY)).toEqual({
        type: 'report',
        date: DAY,
        exists: false,
        writing: true,
      });
      expect(runs).toHaveLength(1);

      finish(AI_MARKDOWN);
      await Promise.all([first, second]);
      expect(runs).toHaveLength(1);
      expect(reports.reportMessage(DAY)).toMatchObject({ exists: true, aiWritten: true });
      expect(reports.reportMessage(DAY)).not.toHaveProperty('writing');
    });

    it('says a day has no report, and shrugs off a corrupt one', () => {
      expect(reports.reportMessage('2026-10-01')).toEqual({
        type: 'report',
        date: '2026-10-01',
        exists: false,
      });
      fs.mkdirSync(path.join(dataDir, REPORTS_DIR_NAME), { recursive: true });
      fs.writeFileSync(reportFile('2026-10-02'), '{ nope');
      expect(reports.reportMessage('2026-10-02')).toMatchObject({ exists: false });
    });

    it('never runs claude with PIXEL_AGENTS_MANAGER=off: Write report now writes the template', async () => {
      reports.dispose();
      env = { PIXEL_AGENTS_MANAGER: 'off' };
      reports = newReports();
      seedDay();
      await reports.writeNow();
      expect(runs).toEqual([]);
      expect(readReport()).toMatchObject({ aiWritten: false });
    });
  });

  describe('the 19:00 run', () => {
    it('fires once at 19:00 local, not before, and pushes the counts to the phone', async () => {
      fs.writeFileSync(alertsFile(), JSON.stringify({ ntfyTopic: TOPIC }));
      seedDay();
      clock = at(18, 59);
      await reports.checkSchedule();
      expect(runs).toHaveLength(0);

      clock = at(19, 0);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);
      expect(readReport()).toMatchObject({ aiWritten: true });
      expect(sent).toEqual([
        {
          url: `https://ntfy.sh/${TOPIC}`,
          body: '📋 Daily report: 2 done, 1 open, 1 waiting',
          headers: expect.objectContaining({ Title: 'Daily report' }),
        },
      ]);

      clock = at(19, 1);
      await reports.checkSchedule();
      clock = at(23, 59);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);
    });

    it('fires once per day even across restarts, and again the next day', async () => {
      clock = at(19, 0);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);

      reports.dispose();
      reports = newReports();
      clock = at(19, 30);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);

      clock = at(19, 0, 18);
      await reports.checkSchedule();
      expect(runs).toHaveLength(2);
      expect(fs.existsSync(reportFile('2026-10-18'))).toBe(true);
    });

    it('catches up after a restart past 19:00 on the same day', async () => {
      clock = at(21, 15);
      await reports.checkSchedule();
      expect(runs).toHaveLength(1);
    });

    it('still fires at 19:00 after an earlier Write report now', async () => {
      clock = at(15, 0);
      await reports.writeNow();
      clock = at(19, 0);
      await reports.checkSchedule();
      expect(runs).toHaveLength(2);
    });

    it('pushes nothing without alerts.json, or for a manual report', async () => {
      clock = at(19, 0);
      await reports.checkSchedule();
      expect(sent).toEqual([]);

      fs.writeFileSync(alertsFile(), JSON.stringify({ ntfyTopic: TOPIC }));
      await reports.writeNow();
      expect(sent).toEqual([]);
    });

    it('checks on start and then every minute', async () => {
      vi.useFakeTimers();
      clock = at(18, 59);
      reports.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toHaveLength(0);
      clock = at(19, 0);
      await vi.advanceTimersByTimeAsync(MANAGER_REPORT_CHECK_INTERVAL_MS);
      expect(runs).toHaveLength(1);
      reports.dispose();
      clock = at(19, 0, 18);
      await vi.advanceTimersByTimeAsync(MANAGER_REPORT_CHECK_INTERVAL_MS * 2);
      expect(runs).toHaveLength(1);
    });

    it('is off with PIXEL_AGENTS_MANAGER=off', async () => {
      reports.dispose();
      env = { PIXEL_AGENTS_MANAGER: 'off' };
      reports = newReports();
      clock = at(19, 0);
      reports.start();
      await reports.checkSchedule();
      expect(runs).toEqual([]);
      expect(fs.existsSync(reportFile())).toBe(false);
    });
  });
});
