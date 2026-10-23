import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  agentLinkMessage,
  bridgeSessionIdOf,
  bridgeSessionUrl,
  claudeSessionIdOf,
  quoteShellPath,
  readTranscriptSeed,
  resumeCommand,
} from '../src/inbox/agentLinks.js';
import { InboxTracker } from '../src/inbox/inboxTracker.js';
import {
  isModelResponse,
  limitReasonOf,
  parseResetTime,
  usageLimitFromNotification,
  usageLimitFromRecord,
  usageLimitFromStopFailure,
} from '../src/inbox/usageLimit.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/**
 * The "Needs you" inbox's server half (docs/office/DESIGN.md, phase G):
 * Open-in-Claude links and the usage-limit tracker. Clocks are injected and
 * transcripts live in temp dirs; nothing touches the real ~/.claude.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 14:00 local time on 2026-10-18. */
const T0 = new Date(2026, 9, 18, 14, 0, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(2026, 9, 18 + dayOffset, h, m, 0, 0).getTime();

const BRIDGE = 'cse_012DpjLEXUt9weNGa7AWUKXp';
const BRIDGE_URL = 'https://claude.ai/code/session_012DpjLEXUt9weNGa7AWUKXp';
const SESSION = '672c9a0b-c7f4-4ccb-811b-ce46e72bd607';

type Message = Record<string, unknown>;

/** The usage-limit record shape Claude Code writes (from a real transcript). */
function limitRecord(
  resetsAtSec?: number,
  text = "You've hit your session limit · resets 6:30pm (Asia/Kolkata)",
) {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiError: 'usage_limit_reached',
    apiErrorStatus: 429,
    ...(resetsAtSec !== undefined
      ? {
          quotaLimits: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' },
          apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: resetsAtSec } },
        }
      : {}),
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  };
}

const bridgeRecord = (id = BRIDGE) => ({
  type: 'bridge-session',
  sessionId: SESSION,
  bridgeSessionId: id,
  lastSequenceNum: 0,
});

const modelRecord = () => ({
  type: 'assistant',
  message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Done.' }] },
});

describe('Open in Claude links', () => {
  it('turns a bridge id into its claude.ai/code session URL', () => {
    expect(bridgeSessionUrl(BRIDGE)).toBe(BRIDGE_URL);
  });

  it('refuses anything that is not a plain bridge id', () => {
    for (const bad of [
      undefined,
      '',
      'session_012',
      'cse_',
      'cse_../evil',
      'cse_a b',
      'xcse_012',
    ]) {
      expect(bridgeSessionUrl(bad)).toBeUndefined();
    }
  });

  it('reads the bridge id off a bridge-session record only', () => {
    expect(bridgeSessionIdOf(bridgeRecord())).toBe(BRIDGE);
    expect(bridgeSessionIdOf({ type: 'user', bridgeSessionId: BRIDGE })).toBeUndefined();
    expect(bridgeSessionIdOf(bridgeRecord('cse_../x'))).toBeUndefined();
    expect(bridgeSessionIdOf(null)).toBeUndefined();
  });

  it('builds the resume command with a quoted cwd', () => {
    expect(resumeCommand(SESSION, 'D:\\Projects\\pixel agents')).toBe(
      `cd "D:\\Projects\\pixel agents" && claude --resume ${SESSION}`,
    );
    expect(resumeCommand(SESSION, '/home/ansh/hobbyfi-web')).toBe(
      `cd "/home/ansh/hobbyfi-web" && claude --resume ${SESSION}`,
    );
    expect(resumeCommand(SESSION)).toBe(`claude --resume ${SESSION}`);
  });

  it('falls back to POSIX single quotes for paths double quotes would expand', () => {
    expect(quoteShellPath('/tmp/$HOME/x')).toBe(`'/tmp/$HOME/x'`);
    expect(quoteShellPath('/tmp/it\'s "here"')).toBe(`'/tmp/it'\\''s "here"'`);
    expect(quoteShellPath('/tmp/`whoami`')).toBe("'/tmp/`whoami`'");
  });

  it('quotes a session id that is not a plain token', () => {
    expect(resumeCommand('a b;rm -rf /')).toBe(`claude --resume "a b;rm -rf /"`);
  });

  it('strips the relay prefix from a remote session id and omits the cd', () => {
    const remote = {
      sessionId: `mac:${SESSION}`,
      remoteSource: { id: 'mac', label: 'Mac', kind: 'computer' as const },
    };
    expect(claudeSessionIdOf(remote)).toBe(SESSION);
    expect(agentLinkMessage(7, remote, { cwd: '/Users/ansh/web' })).toEqual({
      type: 'agentLink',
      id: 7,
      resumeCommand: `claude --resume ${SESSION}`,
    });
    expect(claudeSessionIdOf({ sessionId: SESSION, remoteSource: undefined })).toBe(SESSION);
  });

  it('includes the URL only when the session has a bridge', () => {
    const local = { sessionId: SESSION, remoteSource: undefined };
    expect(agentLinkMessage(1, local, { bridgeSessionId: BRIDGE, cwd: 'D:\\web' })).toEqual({
      type: 'agentLink',
      id: 1,
      url: BRIDGE_URL,
      resumeCommand: `cd "D:\\web" && claude --resume ${SESSION}`,
    });
  });
});

describe('transcript seeding', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-inbox-seed-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (records: unknown[], prefix = '') => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(file, prefix + records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };

  it('finds the newest bridge id, the start cwd and a trailing API error', () => {
    const file = write([
      { type: 'user', cwd: 'D:\\Projects\\web', message: { content: 'hi' } },
      bridgeRecord('cse_old1'),
      modelRecord(),
      bridgeRecord(BRIDGE),
      limitRecord(1_800_000_000),
    ]);
    const seed = readTranscriptSeed(file);
    expect(seed.bridgeSessionId).toBe(BRIDGE);
    expect(seed.cwd).toBe('D:\\Projects\\web');
    expect(seed.lastApiError).toMatchObject({ isApiErrorMessage: true });
  });

  it('reports no API error when a real response came after it', () => {
    const file = write([limitRecord(1_800_000_000), modelRecord()]);
    expect(readTranscriptSeed(file).lastApiError).toBeUndefined();
  });

  it('falls back to the head for a bridge id the tail does not have', () => {
    const filler = Array.from({ length: 3000 }, (_, i) => ({
      type: 'user',
      n: i,
      pad: 'x'.repeat(100),
    }));
    const file = write([{ type: 'user', cwd: '/w' }, bridgeRecord(BRIDGE), ...filler]);
    expect(readTranscriptSeed(file).bridgeSessionId).toBe(BRIDGE);
  });

  it('is empty for a missing file', () => {
    expect(readTranscriptSeed(path.join(dir, 'nope.jsonl'))).toEqual({});
  });
});

describe('reset-time parsing', () => {
  it('reads a clock time later today', () => {
    expect(parseResetTime("You've hit your session limit · resets 6:30pm (Asia/Kolkata)", T0)).toBe(
      at(18, 30),
    );
    expect(parseResetTime('Limit reached, resets at 6:30 PM', T0)).toBe(at(18, 30));
    expect(parseResetTime('usage limit · reset at 18:30', T0)).toBe(at(18, 30));
    expect(parseResetTime('resets 3pm', T0)).toBe(at(15));
  });

  it('takes a clock time already past as tomorrow', () => {
    expect(parseResetTime('resets 6:30pm', at(19))).toBe(at(18, 30, 1));
    expect(parseResetTime('resets 3am', T0)).toBe(at(3, 0, 1));
    expect(parseResetTime('resets 12am', T0)).toBe(at(0, 0, 1));
    expect(parseResetTime('resets 2:00pm', T0)).toBe(at(14, 0, 1));
  });

  it('reads relative resets', () => {
    expect(parseResetTime('resets in 2 hours', T0)).toBe(T0 + 2 * HOUR);
    expect(parseResetTime('resets in 1h 12m', T0)).toBe(T0 + HOUR + 12 * MIN);
    expect(parseResetTime('Limit resets in 45 minutes.', T0)).toBe(T0 + 45 * MIN);
    expect(parseResetTime('resets in 2 hrs and 5 mins', T0)).toBe(T0 + 2 * HOUR + 5 * MIN);
  });

  it('reads a month and day (next year once past)', () => {
    expect(parseResetTime('Weekly limit reached · resets Oct 20, 9am', T0)).toBe(at(9, 0, 2));
    expect(parseResetTime('resets on Oct 20 at 9:00 AM', T0)).toBe(at(9, 0, 2));
    // Oct 10 has passed: next year's is more than 8 days out, so it is not believed.
    expect(parseResetTime('resets Oct 10, 9am', T0)).toBeUndefined();
  });

  it('reads the old epoch suffix', () => {
    expect(parseResetTime('Claude AI usage limit reached|1792343200', T0)).toBe(1_792_343_200_000);
  });

  it('ignores text without a usable time', () => {
    expect(parseResetTime('rate limited', T0)).toBeUndefined();
    expect(parseResetTime('resets 2', T0)).toBeUndefined();
    expect(parseResetTime('resets 13pm', T0)).toBeUndefined();
    expect(parseResetTime('resets 25:00', T0)).toBeUndefined();
    expect(parseResetTime('', T0)).toBeUndefined();
  });

  it('classifies the limit', () => {
    expect(limitReasonOf('x', 'five_hour')).toBe('session');
    expect(limitReasonOf('x', 'seven_day_opus')).toBe('weekly');
    expect(limitReasonOf("You've hit your session limit")).toBe('session');
    expect(limitReasonOf('Weekly limit reached')).toBe('weekly');
    expect(limitReasonOf('Claude usage limit reached')).toBe('usage');
    expect(limitReasonOf('429 rate_limit_error')).toBe('rate');
  });
});

describe('usage-limit detection', () => {
  const resetSec = Math.floor(at(18, 30) / 1000);

  it('reads the structured reset off a transcript API-error record', () => {
    expect(usageLimitFromRecord(limitRecord(resetSec), T0)).toEqual({
      reason: 'session',
      resetsAt: resetSec * 1000,
    });
  });

  it('parses the text when the record has no structured reset', () => {
    expect(usageLimitFromRecord(limitRecord(), T0)).toEqual({
      reason: 'session',
      resetsAt: at(18, 30),
    });
  });

  it('ignores other API errors and ordinary text that mentions a limit', () => {
    expect(
      usageLimitFromRecord(
        {
          type: 'assistant',
          isApiErrorMessage: true,
          error: 'server_error',
          apiErrorStatus: 500,
          message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500' }] },
        },
        T0,
      ),
    ).toBeUndefined();
    expect(
      usageLimitFromRecord(
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'usage limit reached' }] },
        },
        T0,
      ),
    ).toBeUndefined();
    expect(
      usageLimitFromRecord({ type: 'user', isApiErrorMessage: true, error: 'rate_limit' }, T0),
    ).toBeUndefined();
  });

  it('tells a real response from a synthetic one', () => {
    expect(isModelResponse(modelRecord())).toBe(true);
    expect(isModelResponse(limitRecord())).toBe(false);
    expect(isModelResponse({ type: 'assistant', message: { model: '<synthetic>' } })).toBe(false);
    expect(isModelResponse({ type: 'user' })).toBe(false);
  });

  it('reads a StopFailure payload', () => {
    expect(
      usageLimitFromStopFailure(
        {
          error: 'rate_limit',
          last_assistant_message: "You've hit your session limit · resets 6:30pm",
        },
        T0,
      ),
    ).toEqual({ reason: 'session', resetsAt: at(18, 30) });
    expect(usageLimitFromStopFailure({ error: 'rate_limit' }, T0)).toEqual({ reason: 'rate' });
    expect(
      usageLimitFromStopFailure(
        { error: 'unknown', error_details: 'Claude usage limit reached' },
        T0,
      ),
    ).toEqual({ reason: 'usage' });
    expect(
      usageLimitFromStopFailure(
        { error: { type: 'rate_limit', message: 'resets in 2 hours' } },
        T0,
      ),
    ).toEqual({ reason: 'rate', resetsAt: T0 + 2 * HOUR });
    expect(usageLimitFromStopFailure({ error: 'server_error' }, T0)).toBeUndefined();
    expect(usageLimitFromStopFailure({ error: 'authentication_failed' }, T0)).toBeUndefined();
  });

  it('reads a usage-limit Notification', () => {
    expect(
      usageLimitFromNotification('Claude usage limit reached. Your limit will reset at 6pm.', T0),
    ).toEqual({ reason: 'usage', resetsAt: at(18) });
    expect(
      usageLimitFromNotification('Claude needs your permission to use Bash', T0),
    ).toBeUndefined();
    expect(usageLimitFromNotification(undefined, T0)).toBeUndefined();
  });
});

describe('Claude provider: StopFailure + limit notifications', () => {
  it('installs StopFailure', () => {
    expect(CLAUDE_HOOK_EVENTS).toContain('StopFailure');
  });

  it('normalizes a usage-limit StopFailure to a paused turn end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    try {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'StopFailure',
          session_id: SESSION,
          error: 'rate_limit',
          last_assistant_message: "You've hit your session limit · resets 6:30pm",
        }),
      ).toEqual({
        sessionId: SESSION,
        event: { kind: 'turnEnd', usageLimit: { reason: 'session', resetsAt: at(18, 30) } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes any other StopFailure to a plain turn end', () => {
    expect(
      claudeProvider.normalizeHookEvent({
        hook_event_name: 'StopFailure',
        session_id: SESSION,
        error: 'server_error',
      }),
    ).toEqual({ sessionId: SESSION, event: { kind: 'turnEnd' } });
  });

  it('turns a usage-limit Notification into a paused turn end, and ignores other ones', () => {
    const limited = claudeProvider.normalizeHookEvent({
      hook_event_name: 'Notification',
      session_id: SESSION,
      message: 'Claude usage limit reached',
    });
    expect(limited).toEqual({
      sessionId: SESSION,
      event: { kind: 'turnEnd', awaitingInput: true, usageLimit: { reason: 'usage' } },
    });
    expect(
      claudeProvider.normalizeHookEvent({
        hook_event_name: 'Notification',
        session_id: SESSION,
        message: 'Claude is waiting for your input',
      }),
    ).toBeNull();
  });
});

describe('InboxTracker', () => {
  let store: AgentStateStore;
  let tracker: InboxTracker;
  let clock: number;
  let messages: Message[];
  const seeds = new Map<string, ReturnType<typeof readTranscriptSeed>>();

  const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
  const ofType = (type: string) => messages.filter((m) => m.type === type);

  function addAgent(id: number, extra: Partial<AgentState> = {}): AgentState {
    const agent = createAgentState({
      id,
      sessionId: SESSION,
      projectDir: '/work',
      jsonlFile: `/t/${id}.jsonl`,
      isExternal: true,
      ...extra,
    });
    store.set(id, agent);
    return agent;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    store = new AgentStateStore();
    clock = T0;
    messages = [];
    seeds.clear();
    tracker = new InboxTracker(store, {
      now: () => clock,
      readSeed: (file) => seeds.get(file) ?? {},
      fallbackPauseMs: HOUR,
    });
    store.on('broadcast', (m) => messages.push(m));
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('sends a new agent its link once, seeded from the transcript', async () => {
    seeds.set('/t/1.jsonl', { bridgeSessionId: BRIDGE, cwd: 'D:\\web' });
    addAgent(1);
    await flush();
    expect(ofType('agentLink')).toEqual([
      {
        type: 'agentLink',
        id: 1,
        url: BRIDGE_URL,
        resumeCommand: `cd "D:\\web" && claude --resume ${SESSION}`,
      },
    ]);
    tracker.onTranscriptRecord(1, { type: 'user', message: { content: 'go' } });
    tracker.onTranscriptRecord(1, bridgeRecord(BRIDGE));
    expect(ofType('agentLink')).toHaveLength(1);
  });

  it('follows a new bridge id from the live transcript', async () => {
    addAgent(1);
    await flush();
    expect(ofType('agentLink').at(-1)).not.toHaveProperty('url');
    tracker.onTranscriptRecord(1, bridgeRecord(BRIDGE));
    expect(ofType('agentLink').at(-1)).toMatchObject({ url: BRIDGE_URL });
  });

  it('re-seeds when the agent moves to a new transcript (/clear)', async () => {
    seeds.set('/t/1.jsonl', { bridgeSessionId: BRIDGE });
    const agent = addAgent(1);
    await flush();
    agent.jsonlFile = '/t/new.jsonl';
    agent.sessionId = 'new-session';
    tracker.onTranscriptRecord(1, { type: 'user' });
    expect(ofType('agentLink').at(-1)).toEqual({
      type: 'agentLink',
      id: 1,
      resumeCommand: 'claude --resume new-session',
    });
  });

  it('gives a remote agent the bare resume command', async () => {
    addAgent(2, {
      sessionId: `mac:${SESSION}`,
      jsonlFile: '',
      hooksOnly: true,
      projectDir: '/Users/ansh/web',
      remoteSource: { id: 'mac', label: 'Mac', kind: 'computer' },
    });
    await flush();
    expect(ofType('agentLink')).toEqual([
      { type: 'agentLink', id: 2, resumeCommand: `claude --resume ${SESSION}` },
    ]);
  });

  it('pauses on a transcript usage-limit record and clears on tool activity', async () => {
    addAgent(1);
    await flush();
    tracker.onTranscriptRecord(1, limitRecord(Math.floor(at(18, 30) / 1000)));
    expect(ofType('agentLimit')).toEqual([
      { type: 'agentLimit', id: 1, paused: true, reason: 'session', resetsAt: at(18, 30) },
    ]);
    expect(tracker.isPaused(1)).toBe(true);
    store.broadcast({ type: 'agentToolStart', id: 1, toolId: 't1', status: 'Reading' });
    expect(ofType('agentLimit').at(-1)).toEqual({ type: 'agentLimit', id: 1, paused: false });
    expect(tracker.isPaused(1)).toBe(false);
  });

  it('clears at the reset time', async () => {
    addAgent(1);
    await flush();
    tracker.onUsageLimit(1, { reason: 'session', resetsAt: T0 + 30 * MIN });
    vi.advanceTimersByTime(30 * MIN - 1);
    expect(tracker.isPaused(1)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isPaused(1)).toBe(false);
    expect(ofType('agentLimit').at(-1)).toEqual({ type: 'agentLimit', id: 1, paused: false });
  });

  it('clears on a real model response, and after the fallback with no reset time', async () => {
    addAgent(1);
    await flush();
    tracker.onUsageLimit(1, { reason: 'rate' });
    tracker.onTranscriptRecord(1, modelRecord());
    expect(tracker.isPaused(1)).toBe(false);
    tracker.onUsageLimit(1, { reason: 'rate' });
    vi.advanceTimersByTime(HOUR);
    expect(tracker.isPaused(1)).toBe(false);
  });

  it('keeps a known reset time when a later report has none, and does not repeat itself', async () => {
    addAgent(1);
    await flush();
    tracker.onUsageLimit(1, { reason: 'session', resetsAt: at(18, 30) });
    tracker.onUsageLimit(1, { reason: 'session' });
    expect(ofType('agentLimit')).toHaveLength(1);
    tracker.onUsageLimit(1, { reason: 'weekly' });
    expect(ofType('agentLimit').at(-1)).toEqual({
      type: 'agentLimit',
      id: 1,
      paused: true,
      reason: 'weekly',
      resetsAt: at(18, 30),
    });
  });

  it('ignores a limit that has already reset', async () => {
    addAgent(1);
    await flush();
    tracker.onTranscriptRecord(1, limitRecord(Math.floor((T0 - HOUR) / 1000), 'session limit'));
    expect(ofType('agentLimit')).toEqual([]);
  });

  it('believes a seeded limit only with a future reset time', async () => {
    seeds.set('/t/1.jsonl', { lastApiError: limitRecord(Math.floor(at(18, 30) / 1000)) });
    seeds.set('/t/2.jsonl', { lastApiError: limitRecord(undefined, 'rate limited') });
    addAgent(1);
    addAgent(2);
    await flush();
    expect(tracker.isPaused(1)).toBe(true);
    expect(tracker.isPaused(2)).toBe(false);
  });

  it('snapshots every link and every pause for a connecting client', async () => {
    seeds.set('/t/1.jsonl', { bridgeSessionId: BRIDGE });
    addAgent(1);
    addAgent(2);
    await flush();
    tracker.onUsageLimit(2, { reason: 'session', resetsAt: at(18, 30) });
    expect(tracker.snapshot()).toEqual([
      { type: 'agentLink', id: 1, url: BRIDGE_URL, resumeCommand: `claude --resume ${SESSION}` },
      { type: 'agentLink', id: 2, resumeCommand: `claude --resume ${SESSION}` },
      { type: 'agentLimit', id: 2, paused: true, reason: 'session', resetsAt: at(18, 30) },
    ]);
  });

  it('forgets a removed agent', async () => {
    addAgent(1);
    await flush();
    tracker.onUsageLimit(1, { reason: 'session', resetsAt: at(18, 30) });
    store.delete(1);
    expect(tracker.isPaused(1)).toBe(false);
    expect(tracker.snapshot()).toEqual([]);
  });

  it('never sends the limit text', async () => {
    addAgent(1);
    await flush();
    tracker.onTranscriptRecord(1, limitRecord(Math.floor(at(18, 30) / 1000)));
    expect(JSON.stringify(messages)).not.toContain('hit your');
  });
});

describe('inbox wiring', () => {
  let dir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let messages: Message[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-inbox-rt-'));
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, { progress: { dailyDir: null } });
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ofType = (type: string) => messages.filter((m) => m.type === type);

  function hookedAgent(id = 1): AgentState {
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(
      file,
      [{ type: 'user', cwd: dir }, bridgeRecord(BRIDGE)].map((r) => JSON.stringify(r)).join('\n') +
        '\n',
    );
    const agent = createAgentState({
      id,
      sessionId: SESSION,
      projectDir: dir,
      jsonlFile: file,
      isExternal: true,
    });
    store.set(id, agent);
    runtime.registerAgent(SESSION, id);
    return agent;
  }

  it('pauses on a usage-limit StopFailure hook and still ends the turn', () => {
    hookedAgent();
    runtime.handleHookEvent('claude', {
      hook_event_name: 'StopFailure',
      session_id: SESSION,
      error: 'rate_limit',
      last_assistant_message: "You've hit your session limit · resets 6:30pm",
    });
    expect(ofType('agentLimit')).toEqual([
      { type: 'agentLimit', id: 1, paused: true, reason: 'session', resetsAt: at(18, 30) },
    ]);
    expect(ofType('agentStatus').at(-1)).toMatchObject({ id: 1, status: 'waiting' });
    // A new tool means it is working again.
    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: SESSION,
      tool_name: 'Read',
      tool_input: { file_path: '/a' },
    });
    expect(ofType('agentLimit').at(-1)).toEqual({ type: 'agentLimit', id: 1, paused: false });
  });

  it('pauses from a parsed transcript line', () => {
    hookedAgent();
    processTranscriptLine(
      1,
      JSON.stringify(limitRecord(Math.floor(at(18, 30) / 1000))),
      store,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    expect(runtime.inbox.isPaused(1)).toBe(true);
  });

  it('replays links and pauses to a connecting client', async () => {
    hookedAgent();
    await Promise.resolve();
    runtime.inbox.onUsageLimit(1, { reason: 'weekly', resetsAt: at(18, 30) });
    const sent: Message[] = [];
    resendAgentActivity((m) => sent.push(m), store);
    expect(sent.filter((m) => m.type === 'agentLink')).toEqual([
      {
        type: 'agentLink',
        id: 1,
        url: BRIDGE_URL,
        resumeCommand: `cd "${dir}" && claude --resume ${SESSION}`,
      },
    ]);
    expect(sent.filter((m) => m.type === 'agentLimit')).toEqual([
      { type: 'agentLimit', id: 1, paused: true, reason: 'weekly', resetsAt: at(18, 30) },
    ]);
  });
});
