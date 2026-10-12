import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { hookProviderById } from '../src/providers/index.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (mirrors hookEventHandler.test.ts). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

describe('HookEventHandler multi-provider dispatch', () => {
  let agents: AgentStateStore;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let messages: Array<Record<string, unknown>>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    waitingTimers = new Map();
    permissionTimers = new Map();
    messages = [];
    agents.on('broadcast', (msg) => {
      messages.push(msg as Record<string, unknown>);
    });
    // Same resolver wiring as AgentRuntime: constructor provider is Claude,
    // per-event resolution goes through the registry.
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
      undefined,
      (id: string) => hookProviderById(id),
    );
    agents.set(1, createTestAgent({ id: 1 }));
    handler.registerAgent('ses-1', 1);
  });

  it('normalizes opencode events through the opencode provider', () => {
    handler.handleEvent('opencode', {
      hook_event_name: 'PreToolUse',
      session_id: 'ses-1',
      tool_name: 'read',
      tool_input: { path: '/a/b.ts' },
      call_id: 'call-1',
    });
    const start = messages.find((m) => m.type === 'agentToolStart');
    expect(start).toMatchObject({ id: 1, toolName: 'read', status: 'Reading b.ts' });
  });

  it('falls back to the constructor provider for unknown ids', () => {
    handler.handleEvent('nope', {
      hook_event_name: 'PermissionRequest',
      session_id: 'ses-1',
    });
    expect(messages.find((m) => m.type === 'agentToolPermission')).toBeTruthy();
  });

  it('routes opencode PermissionRequest to the permission bubble', () => {
    handler.handleEvent('opencode', {
      hook_event_name: 'PermissionRequest',
      session_id: 'ses-1',
    });
    const msg = messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(msg?.id).toBe(1);
  });

  it('creates and clears a basic sub-agent character from hook-parented events', () => {
    handler.handleEvent('opencode', {
      hook_event_name: 'PreToolUse',
      session_id: 'ses-1',
      tool_name: 'task',
      tool_input: { description: 'Explore auth' },
      call_id: 'call-7',
    });
    // task is a subagent-spawning tool: no transient overlay of its own.
    expect(messages.find((m) => m.type === 'agentToolStart')).toBeFalsy();

    handler.handleEvent('opencode', {
      hook_event_name: 'SubagentStart',
      session_id: 'ses-1',
      tool_name: 'explore',
      tool_input: { description: 'Explore auth' },
      call_id: 'call-7',
    });
    const start = messages.find((m) => m.type === 'subagentToolStart');
    expect(start).toMatchObject({
      id: 1,
      parentToolId: 'hook-call-7',
      toolId: 'hook-sub-explore-call-7',
      status: 'Subtask: explore',
    });

    handler.handleEvent('opencode', {
      hook_event_name: 'SubagentStop',
      session_id: 'ses-1',
      call_id: 'call-7',
    });
    const clear = messages.find((m) => m.type === 'subagentClear');
    expect(clear).toMatchObject({ id: 1, parentToolId: 'hook-call-7' });
  });

  it('purges hook-parented subagents on turn end', () => {
    handler.handleEvent('opencode', {
      hook_event_name: 'PreToolUse',
      session_id: 'ses-1',
      tool_name: 'task',
      tool_input: {},
      call_id: 'call-8',
    });
    handler.handleEvent('opencode', {
      hook_event_name: 'SubagentStart',
      session_id: 'ses-1',
      tool_name: 'explore',
      tool_input: {},
      call_id: 'call-8',
    });
    expect(messages.find((m) => m.type === 'subagentToolStart')).toBeTruthy();

    handler.handleEvent('opencode', { hook_event_name: 'Stop', session_id: 'ses-1' });
    const clear = messages.find((m) => m.type === 'subagentClear');
    expect(clear).toMatchObject({ id: 1, parentToolId: 'hook-call-8' });
    const statuses = messages.filter((m) => m.type === 'agentStatus');
    expect(statuses.at(-1)).toMatchObject({ id: 1, status: 'waiting' });
  });

  it('keeps Claude subagent routing on the JSONL path (no hook fallback)', () => {
    // A Claude SubagentStart with no JSONL parent and the 'current' sentinel
    // parent must not create a character: JSONL handles it via agent_progress.
    handler.handleEvent('claude', {
      hook_event_name: 'SubagentStart',
      session_id: 'ses-1',
      agent_type: 'explore',
    });
    expect(messages.find((m) => m.type === 'subagentToolStart')).toBeFalsy();
  });
});
