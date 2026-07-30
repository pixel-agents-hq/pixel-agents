import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  processTranscriptLine,
  setHookProvider,
  setTeamSwitchCallback,
} from '../src/transcriptParser.js';
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
    contextTokens: 0,
    maxContextTokens: 200_000,
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
    return () => {
      vi.useRealTimers();
      setTeamSwitchCallback(() => {});
    };
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
    // Tag-derived identity (tmux/inline leads) is authoritative over spawn results.
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'assistant', teamName: 'explicit-team', message: { content: [] } }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('explicit-team');
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

  it('re-latches a resumed tag-less lead to the newest team and reports the switch', () => {
    const switches: Array<{ leadId: number; previousTeam: string }> = [];
    setTeamSwitchCallback((leadId, previousTeam) => switches.push({ leadId, previousTeam }));

    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: demo-15s@session-aaaa1111'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('session-aaaa1111');

    // Resume: a new CLI run of the same session mints a fresh implicit team.
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_2', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_2', 'Spawned successfully.\nagent_id: demo-15s@session-bbbb2222'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.teamName).toBe('session-bbbb2222');
    expect(agent.isTeamLead).toBe(true);
    expect(switches).toEqual([{ leadId: 1, previousTeam: 'session-aaaa1111' }]);
    const teamInfos = messages.filter((m) => m.type === 'agentTeamInfo');
    expect(teamInfos[teamInfos.length - 1]).toMatchObject({
      id: 1,
      teamName: 'session-bbbb2222',
      isTeamLead: true,
    });
  });

  it('does not re-latch a teammate that spawns its own named Agent', () => {
    // A teammate session runs through the same processTranscriptLine as its
    // lead. Claude 5 teammates can use the Agent tool, so the teammate's own
    // transcript carries a spawn tool_result naming a NESTED team. Without the
    // leadAgentId guard the teammate re-latches onto that nested team, sets
    // isTeamLead, and linkTeammates detaches it from its real lead.
    const switches: Array<{ leadId: number; previousTeam: string }> = [];
    setTeamSwitchCallback((leadId, previousTeam) => switches.push({ leadId, previousTeam }));

    const teammate = createTestAgent({
      id: 2,
      sessionId: 'teammate-session',
      jsonlFile: '/test/teammate.jsonl',
      // As adopted by fileWatcher: team + lead are pre-set, and
      // teamNameFromTags is NOT set (the tag branch short-circuits because
      // teamName already matches).
      teamName: 'session-aaaa1111',
      agentName: 'helper',
      leadAgentId: 1,
    });
    agents.set(2, teammate);

    processTranscriptLine(
      2,
      agentToolUseRecord('toolu_9', 'Agent', { name: 'nested-helper' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      2,
      toolResultRecord(
        'toolu_9',
        'Spawned successfully.\nagent_id: nested-helper@session-cccc3333',
      ),
      agents,
      waitingTimers,
      permissionTimers,
    );

    // Stays in its own team, stays a teammate, stays attached to its lead.
    expect(teammate.teamName).toBe('session-aaaa1111');
    expect(teammate.isTeamLead).toBeFalsy();
    expect(teammate.leadAgentId).toBe(1);
    expect(switches).toEqual([]);
  });

  it('does not badge an adopted teammate session as LEAD when its lead is not tracked', () => {
    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'user',
        teamName: 'session-abc12345',
        agentName: 'demo-15s',
        message: { content: 'hello' },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.agentName).toBe('demo-15s');
    expect(agent.teamName).toBe('session-abc12345');
    expect(agent.isTeamLead).toBeFalsy();
  });

  it('links an earlier-adopted teammate once the lead latches onto the team', () => {
    const teammate = createTestAgent({ id: 2, sessionId: 'tm-session' });
    agents.set(2, teammate);
    processTranscriptLine(
      2,
      JSON.stringify({
        type: 'user',
        teamName: 'session-abc12345',
        agentName: 'demo-15s',
        message: { content: 'hello' },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(teammate.leadAgentId).toBeUndefined();

    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: demo-15s@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.isTeamLead).toBe(true);
    expect(teammate.leadAgentId).toBe(1);
    expect(teammate.isTeamLead).toBe(false);
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
