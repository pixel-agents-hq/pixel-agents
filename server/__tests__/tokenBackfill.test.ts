import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { ProgressTracker } from '../src/progress/progressTracker.js';
import { TOKENS_BACKFILL_SUFFIX, TOKENS_BACKFILL_TODAY_TTL_MS } from '../src/signals/constants.js';
import { SignalsHub } from '../src/signals/signalsHub.js';
import { type ScannedDays, scanTranscript, TokenBackfill } from '../src/signals/tokenBackfill.js';
import { fromCounted } from '../src/signals/tokenMeter.js';

/**
 * The token backfill (docs/office/DESIGN.md, phase G): per-repo usage read
 * back from the transcripts for days the meter missed -- deduped by response,
 * attributed by cwd, cached per closed day, today's folded into the meter.
 * Every transcript lives in a temp "projects" dir; nothing touches ~/.claude.
 */

const HOUR = 3_600_000;
/** 15:00 local time on 2026-10-18. */
const T0 = new Date(2026, 9, 18, 15, 0, 0).getTime();
const TODAY = '2026-10-18';
const YESTERDAY = '2026-10-17';
const OPUS = 'claude-opus-5-5';

interface Line {
  id: string;
  at: number;
  cwd?: string;
  input: number;
  output?: number;
  model?: string;
}

function assistantLine({ id, at, cwd, input, output = 0, model = OPUS }: Line): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    ...(cwd !== undefined ? { cwd } : {}),
    message: {
      id,
      model,
      usage: { input_tokens: input, output_tokens: output },
      content: [{ type: 'text', text: 'hi' }],
    },
  });
}

function userLine(at: number, cwd: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(at).toISOString(),
    cwd,
    message: { role: 'user', content: 'go' },
  });
}

function write(file: string, lines: string[], mtime?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime !== undefined) fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

const summarize = (messages: ReadonlyMap<string, unknown> | undefined) =>
  [...(messages ?? new Map()).entries()]
    .map(([id, c]) => {
      const e = fromCounted(c as Parameters<typeof fromCounted>[0]);
      return [id, e.repo, e.tokens.input, e.tokens.output] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));

describe('TokenBackfill', () => {
  let projects: string;
  let cacheDir: string;
  let clock: number;

  const backfill = () => new TokenBackfill({ projectsDir: projects, cacheDir, now: () => clock });

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-backfill-'));
    projects = path.join(root, 'projects');
    cacheDir = path.join(root, 'tokens');
    clock = T0;
    fs.mkdirSync(projects, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(projects), { recursive: true, force: true });
  });

  it('reads sessions and their subagents, once per response, attributed by cwd and bucketed by local day', async () => {
    const web = path.join(projects, '-w-web');
    write(path.join(web, 's1.jsonl'), [
      userLine(T0 - 20 * HOUR, '/w/web'),
      // Yesterday evening, one response streamed as two records (the second knows more output).
      assistantLine({ id: 'y1', at: T0 - 20 * HOUR, cwd: '/w/web', input: 100, output: 5 }),
      assistantLine({ id: 'y1', at: T0 - 20 * HOUR, cwd: '/w/web', input: 100, output: 50 }),
      // Today: a record without a cwd takes the file's.
      assistantLine({ id: 't1', at: T0 - HOUR, input: 10 }),
      'not json at all {',
      JSON.stringify({ type: 'summary', summary: 'no usage here' }),
    ]);
    write(path.join(web, 's1', 'subagents', 'agent-a.jsonl'), [
      assistantLine({ id: 'sub1', at: T0 - HOUR / 2, cwd: '/w/web', input: 7 }),
    ]);
    write(path.join(projects, '-w-api', 's2.jsonl'), [
      assistantLine({ id: 'a1', at: T0 - 22 * HOUR, cwd: '/w/api', input: 3 }),
      // Two days ago: not asked for.
      assistantLine({ id: 'old', at: T0 - 50 * HOUR, cwd: '/w/api', input: 999 }),
    ]);
    // Not a transcript.
    write(path.join(projects, '-w-api', 'notes.txt'), ['{"usage": 1}']);

    const found = await backfill().usageFor([YESTERDAY, TODAY]);
    expect(summarize(found.get(YESTERDAY))).toEqual([
      ['a1', 'api', 3, 0],
      ['y1', 'web', 100, 50],
    ]);
    expect(summarize(found.get(TODAY))).toEqual([
      ['sub1', 'web', 7, 0],
      ['t1', 'web', 10, 0],
    ]);
  });

  it('skips a file last written before the first day asked for', async () => {
    write(
      path.join(projects, '-w-old', 's.jsonl'),
      [assistantLine({ id: 'late', at: T0 - 20 * HOUR, cwd: '/w/old', input: 5 })],
      // Its clock says it was last written three days ago: nothing of yesterday can be in it.
      T0 - 72 * HOUR,
    );
    write(path.join(projects, '-w-new', 's.jsonl'), [
      assistantLine({ id: 'fresh', at: T0 - 20 * HOUR, cwd: '/w/new', input: 6 }),
    ]);
    const found = await backfill().usageFor([YESTERDAY]);
    expect(summarize(found.get(YESTERDAY))).toEqual([['fresh', 'new', 6, 0]]);
  });

  it('caches a closed day and never scans it again; today is rescanned past the TTL', async () => {
    const file = path.join(projects, '-w-web', 's.jsonl');
    write(file, [
      assistantLine({ id: 'y1', at: T0 - 20 * HOUR, cwd: '/w/web', input: 1 }),
      assistantLine({ id: 't1', at: T0 - HOUR, cwd: '/w/web', input: 2 }),
    ]);
    const first = backfill();
    await first.usageFor([YESTERDAY, TODAY]);
    const cache = path.join(cacheDir, `${YESTERDAY}.${TOKENS_BACKFILL_SUFFIX}`);
    expect(fs.existsSync(cache)).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, `${TODAY}.${TOKENS_BACKFILL_SUFFIX}`))).toBe(false);

    // More of both days turns up in the transcript.
    fs.appendFileSync(
      file,
      `${assistantLine({ id: 'y2', at: T0 - 19 * HOUR, cwd: '/w/web', input: 10 })}\n` +
        `${assistantLine({ id: 't2', at: T0 - HOUR / 2, cwd: '/w/web', input: 20 })}\n`,
    );
    // Within the TTL today's last scan still stands.
    const soon = await first.usageFor([YESTERDAY, TODAY]);
    expect(summarize(soon.get(TODAY))).toEqual([['t1', 'web', 2, 0]]);
    clock += TOKENS_BACKFILL_TODAY_TTL_MS;
    const later = await first.usageFor([YESTERDAY, TODAY]);
    expect(summarize(later.get(TODAY))).toEqual([
      ['t1', 'web', 2, 0],
      ['t2', 'web', 20, 0],
    ]);
    // Yesterday is closed: the cache answers, in this process and the next.
    expect(summarize(later.get(YESTERDAY))).toEqual([['y1', 'web', 1, 0]]);
    expect(summarize((await backfill().usageFor([YESTERDAY])).get(YESTERDAY))).toEqual([
      ['y1', 'web', 1, 0],
    ]);
  });

  it('answers empty for a day with nothing, a day to come, and a missing projects dir', async () => {
    fs.rmSync(projects, { recursive: true, force: true });
    const found = await backfill().usageFor([YESTERDAY, TODAY, '2026-10-19']);
    expect(found.size).toBe(0);
  });

  it('runs one scan at a time: a second ask waits for the first', async () => {
    write(path.join(projects, '-w-web', 's.jsonl'), [
      assistantLine({ id: 't1', at: T0 - HOUR, cwd: '/w/web', input: 2 }),
    ]);
    const b = backfill();
    const [a, c] = await Promise.all([b.usageFor([TODAY]), b.usageFor([TODAY])]);
    expect(summarize(a.get(TODAY))).toEqual([['t1', 'web', 2, 0]]);
    expect(summarize(c.get(TODAY))).toEqual([['t1', 'web', 2, 0]]);
  });
});

describe('SignalsHub with the backfill', () => {
  let root: string;
  let clock: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-backfill-hub-'));
    clock = T0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("folds today's scan into the meter, so dailyTokens counts it once, and merges a closed day with the meter's file", async () => {
    const projects = path.join(root, 'projects');
    const tokensDir = path.join(root, 'tokens');
    write(path.join(projects, '-w-web', 's.jsonl'), [
      assistantLine({ id: 't1', at: T0 - HOUR, cwd: '/w/web', input: 1_000_000 }),
      assistantLine({ id: 't2', at: T0 - HOUR, cwd: '/w/web', input: 500_000 }),
      assistantLine({ id: 'y1', at: T0 - 20 * HOUR, cwd: '/w/web', input: 10 }),
    ]);
    // The meter saw part of yesterday itself (one response the scan has too, one it has not).
    fs.mkdirSync(tokensDir, { recursive: true });
    fs.writeFileSync(
      path.join(tokensDir, `${YESTERDAY}.json`),
      JSON.stringify({
        version: 2,
        date: YESTERDAY,
        messages: { y1: [OPUS, 10, 0, 0, 0, 0, 0, 'web'], y9: [OPUS, 5, 0, 0, 0, 0, 0, 'api'] },
      }),
    );

    const store = new AgentStateStore();
    const progress = new ProgressTracker(store, { dailyDir: null, now: () => clock });
    const hub = new SignalsHub(store, progress, {
      tokensDir,
      projectsDir: projects,
      noticeBoard: null,
      now: () => clock,
    });
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    try {
      const usage = await hub.timeReportUsage([YESTERDAY, TODAY]);
      const byInput = (list: (typeof usage)[string]) =>
        list.map((e) => [e.repo, e.tokens.input] as const).sort((a, b) => a[1] - b[1]);
      expect(byInput(usage[TODAY])).toEqual([
        ['web', 500_000],
        ['web', 1_000_000],
      ]);
      expect(byInput(usage[YESTERDAY])).toEqual([
        ['api', 5],
        ['web', 10],
      ]);
      // The TODAY strip: one dailyTokens for the whole scan, with its total.
      const daily = broadcasts.filter((m) => m.type === 'dailyTokens');
      expect(daily).toHaveLength(1);
      expect(daily[0]).toMatchObject({ date: TODAY, input: 1_500_000, estimatedUsd: 6 });
      // Asked again within the TTL: nothing new, nothing re-sent.
      await hub.timeReportUsage([TODAY]);
      expect(broadcasts.filter((m) => m.type === 'dailyTokens')).toHaveLength(1);
    } finally {
      hub.dispose();
      progress.dispose();
    }
  });

  it('scans today once on start(), and reads no transcripts for an in-memory meter', async () => {
    const projects = path.join(root, 'projects');
    write(path.join(projects, '-w-web', 's.jsonl'), [
      assistantLine({ id: 't1', at: T0 - HOUR, cwd: '/w/web', input: 42 }),
    ]);
    const store = new AgentStateStore();
    const progress = new ProgressTracker(store, { dailyDir: null, now: () => clock });
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => broadcasts.push(m));

    const hub = new SignalsHub(store, progress, {
      tokensDir: path.join(root, 'tokens'),
      projectsDir: projects,
      noticeBoard: null,
      now: () => clock,
    });
    hub.start();
    for (let i = 0; i < 200 && !broadcasts.some((m) => m.type === 'dailyTokens'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(broadcasts.find((m) => m.type === 'dailyTokens')).toMatchObject({ input: 42 });
    hub.dispose();

    broadcasts.length = 0;
    const quiet = new SignalsHub(store, progress, {
      tokensDir: null,
      noticeBoard: null,
      now: () => clock,
    });
    quiet.start();
    expect(await quiet.timeReportUsage([TODAY])).toEqual({});
    expect(broadcasts.filter((m) => m.type === 'dailyTokens')).toHaveLength(0);
    quiet.dispose();
    progress.dispose();
  });
});

describe('scanTranscript resuming (today, read once)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-backfill-resume-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const wanted = new Set([TODAY]);
  const line = (id: string, input: number) =>
    assistantLine({ id, at: T0, cwd: '/w/pixel-agents', input });

  it('stops before a half-written last line and reads it whole next time', async () => {
    const file = path.join(dir, 's.jsonl');
    const whole = line('m1', 10);
    const next = line('m2', 20);
    fs.writeFileSync(file, `${whole}\n${next.slice(0, 25)}`);
    const found: ScannedDays = new Map();

    const mark = await scanTranscript(file, wanted, found);
    expect(mark.offset).toBe(Buffer.byteLength(whole) + 1);
    expect(summarize(found.get(TODAY))).toEqual([['m1', 'pixel-agents', 10, 0]]);

    fs.writeFileSync(file, `${whole}\n${next}\n`);
    const after = await scanTranscript(file, wanted, found, mark);
    expect(after.offset).toBe(fs.statSync(file).size);
    expect(summarize(found.get(TODAY))).toEqual([
      ['m1', 'pixel-agents', 10, 0],
      ['m2', 'pixel-agents', 20, 0],
    ]);
  });

  it('keeps the file repo for appended records without a cwd', async () => {
    const file = path.join(dir, 's.jsonl');
    write(file, [assistantLine({ id: 'm8', at: T0, cwd: '/w/clam.ai', input: 1 })]);
    const found: ScannedDays = new Map();
    const mark = await scanTranscript(file, wanted, found);
    fs.appendFileSync(file, `${assistantLine({ id: 'm9', at: T0, input: 5 })}\n`);
    await scanTranscript(file, wanted, found, mark);
    expect(summarize(found.get(TODAY))).toEqual([
      ['m8', 'clam.ai', 1, 0],
      ['m9', 'clam.ai', 5, 0],
    ]);
  });

  it("a resumed today's scan matches a fresh full read", async () => {
    const file = path.join(projects(dir), 'p', 's.jsonl');
    write(file, [line('a', 1), line('b', 2)]);
    let clock = T0;
    const backfill = new TokenBackfill({
      projectsDir: projects(dir),
      cacheDir: null,
      now: () => clock,
    });
    await backfill.usageFor([TODAY]);

    // More of the session lands, including a bigger figure for a known response.
    fs.appendFileSync(file, `${line('c', 3)}\n${line('b', 7)}\n`);
    clock += TOKENS_BACKFILL_TODAY_TTL_MS + 1;
    const resumed = summarize((await backfill.usageFor([TODAY])).get(TODAY));

    const fresh = new TokenBackfill({
      projectsDir: projects(dir),
      cacheDir: null,
      now: () => clock,
    });
    expect(resumed).toEqual(summarize((await fresh.usageFor([TODAY])).get(TODAY)));
    expect(resumed).toEqual([
      ['a', 'pixel-agents', 1, 0],
      ['b', 'pixel-agents', 7, 0],
      ['c', 'pixel-agents', 3, 0],
    ]);
  });
});

function projects(dir: string): string {
  return path.join(dir, 'projects');
}
