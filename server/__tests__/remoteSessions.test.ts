import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { REMOTE_AGENT_TTL_MS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { remoteSourceOf } from '../src/remoteSource.js';
import type { AgentState } from '../src/types.js';

/**
 * Remote sessions arrive through remote/relay: session ids are namespaced by
 * source, transcript paths are stripped, and `pixel_source` says where the
 * session runs. The transcript lives on another machine, so these agents are
 * hooks-only and must be admitted without Watch All Sessions.
 */

const LAPTOP = { id: 'laptop', label: 'Laptop', kind: 'computer' } as const;
const CLOUD = { id: 'cloud', label: 'Cloud', kind: 'cloud' } as const;

describe('remoteSourceOf', () => {
  it('reads a well-formed pixel_source', () => {
    expect(remoteSourceOf({ pixel_source: LAPTOP })).toEqual(LAPTOP);
  });

  it('rejects missing or malformed sources', () => {
    expect(remoteSourceOf({})).toBeUndefined();
    expect(remoteSourceOf({ pixel_source: 'laptop' })).toBeUndefined();
    expect(remoteSourceOf({ pixel_source: { ...LAPTOP, kind: 'phone' } })).toBeUndefined();
    expect(remoteSourceOf({ pixel_source: { ...LAPTOP, label: '' } })).toBeUndefined();
    expect(remoteSourceOf({ pixel_source: { ...LAPTOP, id: 3 } })).toBeUndefined();
  });
});

describe('AgentRuntime -- remote sessions', () => {
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    messages = [];
    store.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  afterEach(() => runtime.dispose());

  function fire(event: Record<string, unknown>, source: typeof LAPTOP | typeof CLOUD = LAPTOP) {
    runtime.handleHookEvent('claude', {
      cwd: '/home/user/hobbyfi-web',
      ...event,
      pixel_source: source,
    });
  }

  function onlyAgent(): AgentState {
    expect(store.size).toBe(1);
    return [...store.values()][0];
  }

  it('adopts a remote session on SessionStart + confirmation with Watch All off', () => {
    fire({ hook_event_name: 'SessionStart', session_id: 'laptop:s1', source: 'startup' });
    expect(store.size).toBe(0);
    fire({ hook_event_name: 'Stop', session_id: 'laptop:s1' });

    const agent = onlyAgent();
    expect(agent.sessionId).toBe('laptop:s1');
    expect(agent.hooksOnly).toBe(true);
    expect(agent.jsonlFile).toBe('');
    expect(agent.remoteSource).toEqual(LAPTOP);
    expect(agent.directoryName).toBe('hobbyfi-web');
  });

  it('adopts an already-running remote session from any event (e.g. after a restart)', () => {
    fire(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'cloud:s2',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'toolu_1',
      },
      CLOUD,
    );

    const agent = onlyAgent();
    expect(agent.remoteSource).toEqual(CLOUD);
    // The triggering event is processed once the agent exists.
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', id: agent.id, toolId: 'toolu_1' }),
    );
  });

  it('does not adopt an unknown remote session from SessionEnd', () => {
    fire({ hook_event_name: 'SessionEnd', session_id: 'laptop:gone', reason: 'exit' });
    expect(store.size).toBe(0);
  });

  it('still drops unknown local sessions with Watch All off', () => {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'local-1',
      cwd: '/somewhere/untracked',
      tool_name: 'Read',
      tool_input: {},
    });
    expect(store.size).toBe(0);
  });

  it('announces the source in agentCreated', () => {
    const added: AgentState[] = [];
    store.on('agentAdded', (_id, agent) => added.push(agent));
    fire({ hook_event_name: 'Stop', session_id: 'laptop:s3' });
    expect(added).toHaveLength(1);
    expect(added[0].remoteSource).toEqual(LAPTOP);
  });

  it('uses tool_use_id so parallel tools finish independently', () => {
    fire({
      hook_event_name: 'PreToolUse',
      session_id: 'laptop:p',
      tool_name: 'Read',
      tool_input: { file_path: 'a.ts' },
      tool_use_id: 'toolu_a',
    });
    fire({
      hook_event_name: 'PreToolUse',
      session_id: 'laptop:p',
      tool_name: 'Read',
      tool_input: { file_path: 'b.ts' },
      tool_use_id: 'toolu_b',
    });
    fire({
      hook_event_name: 'PostToolUse',
      session_id: 'laptop:p',
      tool_name: 'Read',
      tool_use_id: 'toolu_a',
    });
    fire({
      hook_event_name: 'PostToolUse',
      session_id: 'laptop:p',
      tool_name: 'Read',
      tool_use_id: 'toolu_b',
    });

    const done = messages.filter((m) => m.type === 'agentToolDone').map((m) => m.toolId);
    expect(done).toEqual(['toolu_a', 'toolu_b']);
  });

  it('creates a Subtask for an Agent tool and clears it on its PostToolUse', () => {
    fire({
      hook_event_name: 'PreToolUse',
      session_id: 'laptop:sub',
      tool_name: 'Agent',
      tool_input: { description: 'Review the diff', prompt: '...' },
      tool_use_id: 'toolu_agent',
    });
    const agent = onlyAgent();
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: 'agentToolStart',
        id: agent.id,
        toolId: 'toolu_agent',
        toolName: 'Agent',
        status: expect.stringMatching(/^Subtask: Review the diff/),
      }),
    );

    fire({
      hook_event_name: 'PostToolUse',
      session_id: 'laptop:sub',
      tool_name: 'Agent',
      tool_use_id: 'toolu_agent',
    });
    expect(messages).toContainEqual({
      type: 'subagentClear',
      id: agent.id,
      parentToolId: 'toolu_agent',
    });
    expect(agent.activeToolNames.has('toolu_agent')).toBe(false);
  });

  it('keeps lastDataAt fresh on every remote event', () => {
    fire({ hook_event_name: 'Stop', session_id: 'laptop:fresh' });
    const agent = onlyAgent();
    agent.lastDataAt = 0;
    fire({ hook_event_name: 'Stop', session_id: 'laptop:fresh' });
    expect(agent.lastDataAt).toBeGreaterThan(0);
  });

  it('does not reassign /clear across sources sharing a cwd', () => {
    fire({ hook_event_name: 'Stop', session_id: 'cloud:a' }, CLOUD);
    const cloudAgent = onlyAgent();
    fire({ hook_event_name: 'SessionEnd', session_id: 'cloud:a', reason: 'clear' }, CLOUD);
    expect(cloudAgent.pendingClear).toBe(true);

    fire({ hook_event_name: 'SessionStart', session_id: 'laptop:b', source: 'clear' }, LAPTOP);
    expect(cloudAgent.sessionId).toBe('cloud:a');
  });

  it('reassigns /clear within the same source', () => {
    fire({ hook_event_name: 'Stop', session_id: 'cloud:a' }, CLOUD);
    const agent = onlyAgent();
    fire({ hook_event_name: 'SessionEnd', session_id: 'cloud:a', reason: 'clear' }, CLOUD);
    fire({ hook_event_name: 'SessionStart', session_id: 'cloud:c', source: 'clear' }, CLOUD);
    expect(agent.sessionId).toBe('cloud:c');
  });

  it('expires remote agents that have been silent past the TTL', () => {
    fire({ hook_event_name: 'Stop', session_id: 'laptop:old' });
    fire({ hook_event_name: 'Stop', session_id: 'cloud:new' }, CLOUD);
    const [oldAgent, newAgent] = [...store.values()];
    const now = Date.now();
    oldAgent.lastDataAt = now - REMOTE_AGENT_TTL_MS - 1;
    newAgent.lastDataAt = now;

    runtime.expireRemoteAgents(now);

    expect([...store.values()].map((a) => a.sessionId)).toEqual(['cloud:new']);
  });
});
