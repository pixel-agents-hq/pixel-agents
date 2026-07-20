import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (mirrors hookEventHandler.test.ts). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'lead-session',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  } as AgentState;
}

function agentToolUseRecord(toolId: string, name: string, input: Record<string, unknown>) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function toolResultRecord(toolId: string, text: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }],
    },
  });
}

describe('transcriptParser: teammate spawn results (new-harness implicit teams)', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => {
      messages.push(msg as Record<string, unknown>);
    });
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it('marks the agent as team lead when an Agent spawn result carries agent_id@team', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', {
        name: 'wa-research',
        subagent_type: 'general-purpose',
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.activeToolNames.get('toolu_1')).toBe('Agent');

    processTranscriptLine(
      1,
      toolResultRecord(
        'toolu_1',
        'Spawned successfully. (internal metadata)\nagent_id: wa-research@session-abc12345\nname: wa-research',
      ),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.teamName).toBe('session-abc12345');
    expect(agent.isTeamLead).toBe(true);
    const teamInfo = messages.find((m) => m.type === 'agentTeamInfo');
    expect(teamInfo).toMatchObject({ id: 1, teamName: 'session-abc12345', isTeamLead: true });
  });

  it('completes the spawn tool normally (no lingering background tool or Subtask)', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'wa-research' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: wa-research@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    // The teammate character replaces the transient Subtask one: the spawn tool
    // must be cleared, not parked in backgroundAgentToolIds forever (the new
    // harness never writes the queue-operation completion record).
    expect(agent.backgroundAgentToolIds.size).toBe(0);
    expect(agent.activeToolIds.has('toolu_1')).toBe(false);
    expect(messages.some((m) => m.type === 'subagentClear' && m.parentToolId === 'toolu_1')).toBe(
      true,
    );
  });

  it('does not overwrite team identity already established from record tags', () => {
    agent.teamName = 'explicit-team';
    agent.agentName = undefined;
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'helper' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: helper@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('explicit-team');
  });

  it('still parks old-style async agent launches as background tools', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { run_in_background: true }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Async agent launched successfully.'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.backgroundAgentToolIds.has('toolu_1')).toBe(true);
    expect(agent.activeToolIds.has('toolu_1')).toBe(true);
    expect(agent.teamName).toBeUndefined();
  });

  it('ignores results of non-spawn tools that happen to mention agent_id', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Read', { file_path: '/tmp/x' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'agent_id: someone@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBeUndefined();
    expect(agent.isTeamLead).toBeUndefined();
  });
});
