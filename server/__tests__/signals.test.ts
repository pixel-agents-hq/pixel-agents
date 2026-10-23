import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  LOOP_CHECK_INTERVAL_MS,
  LOOP_STALL_ACTIVE_MS,
  TIMELINE_MAX_ENTRIES,
} from '../src/signals/constants.js';
import { repeatKey } from '../src/signals/loopDetector.js';
import { isFailedToolEnd, troubleLevel } from '../src/signals/trouble.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/**
 * Useful signals (docs/office/DESIGN.md, phase D): trouble, the loop detector and
 * the tap-for-timeline, driven end to end through a runtime -- hook events, the
 * transcript, the connect-time resend and the client message handler. Token
 * files and the notice board are off (no StateAdapter), so nothing touches the
 * real ~/.pixel-agents or `gh`.
 */

const MIN = 60_000;
const T0 = new Date(2026, 9, 18, 10, 0, 0).getTime();

type Message = Record<string, unknown>;

describe('isFailedToolEnd', () => {
  it('fails PostToolUseFailure, whatever the tool', () => {
    expect(isFailedToolEnd('PostToolUseFailure', 'Read', undefined)).toBe(true);
  });

  it('reads a shell response for a non-zero exit or an interrupt', () => {
    expect(isFailedToolEnd('PostToolUse', 'Bash', { stdout: '', interrupted: true })).toBe(true);
    expect(isFailedToolEnd('PostToolUse', 'Bash', { stdout: '', exitCode: 2 })).toBe(true);
    expect(isFailedToolEnd('PostToolUse', 'PowerShell', 'Exit code 1\nboom')).toBe(true);
    expect(isFailedToolEnd('PostToolUse', 'Bash', { stdout: 'ok', interrupted: false })).toBe(
      false,
    );
    expect(isFailedToolEnd('PostToolUse', 'Bash', { exitCode: 0 })).toBe(false);
    expect(isFailedToolEnd('PostToolUse', 'Bash', 'Exit code 0')).toBe(false);
  });

  it('never reads another tool output as a shell exit', () => {
    expect(isFailedToolEnd('PostToolUse', 'Read', 'Exit code 1')).toBe(false);
    expect(isFailedToolEnd('PostToolUse', 'Grep', { interrupted: true })).toBe(false);
  });

  it('maps failures in a row to levels', () => {
    expect([0, 1, 2, 3, 7].map(troubleLevel)).toEqual(['none', 'fire', 'fire', 'alarm', 'alarm']);
  });
});

describe('repeatKey', () => {
  it('ignores key order, whitespace and descriptions', () => {
    const a = repeatKey('Bash', { command: 'npm  test', description: 'run tests' });
    const b = repeatKey('Bash', { description: 'again', command: ' npm test ' });
    expect(a).toBe(b);
    expect(a).not.toBe(repeatKey('Bash', { command: 'npm run build' }));
    expect(a).not.toBe(repeatKey('PowerShell', { command: 'npm test' }));
  });

  it('has nothing to compare for an empty input (a relayed remote call)', () => {
    expect(repeatKey('Bash', { command: '' })).toBeNull();
    expect(repeatKey('EnterPlanMode', {})).toBeNull();
  });

  it('is a short hash, never the input', () => {
    const key = repeatKey('Bash', { command: 'echo secret-token' });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('SignalsHub wiring', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let clock: number;
  let messages: Message[];

  beforeEach(() => {
    store = new AgentStateStore();
    clock = T0;
    runtime = new AgentRuntime(store, claudeProvider, {
      progress: { dailyDir: null, now: () => clock },
      signals: { tokensDir: null, noticeBoard: null, now: () => clock },
    });
    messages = [];
    store.on('broadcast', (m) => messages.push(m));
  });

  afterEach(() => {
    runtime.dispose();
  });

  const ofType = (type: string, id?: number) =>
    messages.filter((m) => m.type === type && (id === undefined || m.id === id));

  function addAgent(id: number, extra: Partial<AgentState> = {}): AgentState {
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

  function hookedAgent(id = 1, extra: Partial<AgentState> = {}): AgentState {
    const agent = addAgent(id, extra);
    runtime.registerAgent(agent.sessionId, id);
    return agent;
  }

  function hook(event: Record<string, unknown>, sessionId = 'session-1') {
    runtime.handleHookEvent('claude', { session_id: sessionId, ...event });
  }

  let toolSeq = 0;
  /** PreToolUse then PostToolUse (or PostToolUseFailure) for one tool. */
  function tool(
    name: string,
    input: Record<string, unknown>,
    end: { failed?: boolean; response?: unknown } = {},
  ) {
    const tool_use_id = `toolu_${++toolSeq}`;
    hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id });
    hook({
      hook_event_name: end.failed ? 'PostToolUseFailure' : 'PostToolUse',
      tool_name: name,
      tool_input: input,
      tool_use_id,
      ...(end.failed ? { error: 'Exit code 1' } : { tool_response: end.response ?? '' }),
    });
  }

  function timeline(id = 1, privileged = false): Message | undefined {
    const sent: Message[] = [];
    handleClientMessage({ type: 'requestTimeline', id }, (m) => sent.push(m), {
      store,
      runtime,
      cache: null,
      privileged,
    });
    return sent.find((m) => m.type === 'agentTimeline');
  }

  describe('trouble', () => {
    it('lights a fire on the first failure, the alarm on the third, and clears on success', () => {
      hookedAgent();
      tool('Bash', { command: 'npm test' }, { failed: true });
      expect(ofType('agentTrouble').at(-1)).toEqual({
        type: 'agentTrouble',
        id: 1,
        level: 'fire',
        failures: 1,
      });
      tool('Read', { file_path: '/missing' }, { failed: true });
      tool('Bash', { command: 'npm test' }, { response: { stdout: '', interrupted: true } });
      expect(ofType('agentTrouble').at(-1)).toMatchObject({ level: 'alarm', failures: 3 });

      tool('Bash', { command: 'npm test' }, { response: { stdout: 'ok', interrupted: false } });
      expect(ofType('agentTrouble').at(-1)).toEqual({
        type: 'agentTrouble',
        id: 1,
        level: 'none',
        failures: 0,
      });
      // A further success says nothing new.
      const before = ofType('agentTrouble').length;
      tool('Read', { file_path: '/a' });
      expect(ofType('agentTrouble')).toHaveLength(before);
    });

    it('reads tool results from the transcript for an agent without hooks', () => {
      addAgent(2);
      const parse = (record: unknown) =>
        processTranscriptLine(
          2,
          JSON.stringify(record),
          store,
          runtime.waitingTimers,
          runtime.permissionTimers,
        );
      parse({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }],
        },
      });
      parse({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
      });
      expect(ofType('agentTrouble', 2).at(-1)).toMatchObject({ level: 'fire', failures: 1 });
      parse({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
      });
      expect(ofType('agentTrouble', 2).at(-1)).toMatchObject({ level: 'none' });
    });

    it('is resent to a client that connects, and forgotten with the agent', () => {
      hookedAgent();
      tool('Bash', { command: 'npm test' }, { failed: true });
      const sent: Message[] = [];
      resendAgentActivity((m) => sent.push(m), store);
      expect(sent.filter((m) => m.type === 'agentTrouble')).toEqual([
        { type: 'agentTrouble', id: 1, level: 'fire', failures: 1 },
      ]);
      runtime.removeAgent(1);
      const after: Message[] = [];
      resendAgentActivity((m) => after.push(m), store);
      expect(after.filter((m) => m.type === 'agentTrouble')).toEqual([]);
    });
  });

  describe('loop detector', () => {
    it('flags the same tool and input four times within 10 minutes', () => {
      hookedAgent();
      for (let i = 0; i < 3; i++) {
        tool('Bash', { command: 'npm test' });
        clock += MIN;
      }
      expect(ofType('agentLoop')).toEqual([]);
      tool('Bash', { command: 'npm  test', description: 'again' });
      expect(ofType('agentLoop').at(-1)).toEqual({
        type: 'agentLoop',
        id: 1,
        looping: true,
        reason: 'repeat',
      });
    });

    it('does not count repeats spread past the window', () => {
      hookedAgent();
      for (let i = 0; i < 4; i++) {
        tool('Read', { file_path: '/a.ts' });
        clock += 4 * MIN;
      }
      expect(ofType('agentLoop')).toEqual([]);
    });

    it('clears on a new file edited or a phase change', () => {
      hookedAgent();
      for (let i = 0; i < 4; i++) tool('Bash', { command: 'npm test' });
      expect(ofType('agentLoop').at(-1)).toMatchObject({ looping: true });
      tool('Edit', { file_path: '/src/a.ts', old_string: 'a', new_string: 'b' });
      expect(ofType('agentLoop').at(-1)).toEqual({ type: 'agentLoop', id: 1, looping: false });

      // Edit-test cycles change phase every step: never a loop.
      for (let i = 0; i < 6; i++) {
        tool('Edit', { file_path: '/src/a.ts', old_string: `${i}`, new_string: `${i + 1}` });
        tool('Bash', { command: 'npm test' });
      }
      expect(ofType('agentLoop').at(-1)).toMatchObject({ looping: false });
    });

    it('flags 15 minutes of active work with no new file and no phase change', () => {
      hookedAgent();
      tool('Read', { file_path: '/a.ts' });
      clock += LOOP_STALL_ACTIVE_MS - MIN;
      tool('Grep', { pattern: 'x' });
      expect(ofType('agentLoop')).toEqual([]);
      clock += 2 * MIN;
      tool('Glob', { pattern: '*.ts' });
      expect(ofType('agentLoop').at(-1)).toMatchObject({ looping: true, reason: 'stall' });
    });

    it("doesn't count time spent waiting on the user", () => {
      hookedAgent();
      tool('Read', { file_path: '/a.ts' });
      hook({ hook_event_name: 'Stop' });
      clock += 60 * MIN;
      tool('Read', { file_path: '/b.ts' });
      expect(ofType('agentLoop')).toEqual([]);
    });

    it('stall check runs on its timer too', () => {
      vi.useFakeTimers();
      try {
        hookedAgent();
        runtime.startStaleCheck();
        tool('Read', { file_path: '/a.ts' });
        clock += LOOP_STALL_ACTIVE_MS + MIN;
        vi.advanceTimersByTime(LOOP_CHECK_INTERVAL_MS);
        expect(ofType('agentLoop').at(-1)).toMatchObject({ looping: true, reason: 'stall' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips the repeat count for relayed remote sessions (inputs arrive emptied)', () => {
      hookedAgent(1, { remoteSource: { id: 'laptop', label: 'Laptop', kind: 'computer' } });
      for (let i = 0; i < 5; i++) tool('Bash', { command: 'npm test' });
      expect(ofType('agentLoop')).toEqual([]);
    });
  });

  describe('timeline', () => {
    it('answers requestTimeline with activity labels, status changes, PRs, pushes and active time', () => {
      hookedAgent();
      tool('Read', { file_path: '/home/me/secret/plan.md' });
      clock += 2 * MIN;
      tool('Bash', { command: 'npm test' }, { failed: true });
      const command = 'git push -u origin x && gh pr create --title "Ship it"';
      tool('Bash', { command }, { response: { stdout: 'https://github.com/acme/web/pull/42' } });
      clock += 3 * MIN;
      hook({ hook_event_name: 'Stop' });

      const reply = timeline();
      expect(reply).toMatchObject({
        type: 'agentTimeline',
        id: 1,
        pushes: 1,
        prs: [{ title: 'Ship it', repo: 'acme/web', url: 'https://github.com/acme/web/pull/42' }],
        activeMs: 5 * MIN,
      });
      const entries = reply!.entries as Array<Record<string, unknown>>;
      expect(entries.map((e) => [e.kind, e.text, e.failed ?? false])).toEqual([
        ['status', 'Started working', false],
        ['tool', 'Reading plan.md', false],
        ['tool', 'Running: npm test', true],
        ['tool', claudeProvider.formatToolStatus('Bash', { command }), false],
        ['ship', 'Shipping', false],
        ['push', 'Pushed hobbyfi-web', false],
        ['pr', 'Opened PR: Ship it', false],
        ['status', 'Turn ended', false],
      ]);
      // Never a raw input: the full path stays out.
      expect(JSON.stringify(reply)).not.toContain('/home/me/secret');
    });

    it('keeps only the last 20 actions', () => {
      hookedAgent();
      for (let i = 0; i < 30; i++) tool('Read', { file_path: `/f${i}.ts` });
      const entries = timeline()!.entries as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(TIMELINE_MAX_ENTRIES);
      expect(entries.at(-1)).toMatchObject({ text: 'Reading f29.ts' });
    });

    it('is open to a read-only client, and only to the asker', () => {
      hookedAgent();
      tool('Read', { file_path: '/a.ts' });
      const broadcastsBefore = messages.length;
      expect(timeline(1, false)).toMatchObject({ type: 'agentTimeline', id: 1 });
      expect(messages.length).toBe(broadcastsBefore);
    });

    it('sends nothing for an unknown agent', () => {
      expect(timeline(99, true)).toBeUndefined();
    });
  });

  it('still refuses other messages from a read-only client', () => {
    const sent: Message[] = [];
    handleClientMessage({ type: 'saveLayout', layout: {} }, (m) => sent.push(m), {
      store,
      runtime,
      cache: null,
      privileged: false,
    });
    expect(sent.some((m) => m.type === 'agentTimeline')).toBe(false);
  });
});
