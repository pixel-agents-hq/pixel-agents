import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

function makeAgent(): AgentState {
  return {
    id: 1,
    sessionId: 'codex-session',
    isExternal: false,
    projectDir: '',
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
    providerId: 'codex',
    inputTokens: 0,
    outputTokens: 0,
  };
}

describe('codexProvider', () => {
  it('exposes Codex provider metadata', () => {
    expect(codexProvider.kind).toBe('hook');
    expect(codexProvider.id).toBe('codex');
    expect(codexProvider.displayName).toBe('Codex');
    expect(codexProvider.protocolVersion).toBe(1);
    expect(codexProvider.subagentToolNames.size).toBe(0);
  });

  it('parses Codex function_call records as toolStart events', () => {
    const event = codexProvider.parseTranscriptLine?.(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_1',
          arguments: JSON.stringify({ command: 'npm test' }),
        },
      }),
    );

    expect(event?.kind).toBe('toolStart');
    if (event?.kind === 'toolStart') {
      expect(event.toolId).toBe('call_1');
      expect(event.toolName).toBe('shell_command');
      expect(event.input).toEqual({ command: 'npm test' });
    }
  });

  it('parses Codex function_call_output records as toolEnd events', () => {
    expect(
      codexProvider.parseTranscriptLine?.(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call_1', output: '{}' },
        }),
      ),
    ).toEqual({ kind: 'toolEnd', toolId: 'call_1' });
  });

  it('parses Codex custom_tool_call records as toolStart events', () => {
    const event = codexProvider.parseTranscriptLine?.(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call_patch',
          name: 'apply_patch',
          input: { operation: 'update' },
        },
      }),
    );

    expect(event?.kind).toBe('toolStart');
    if (event?.kind === 'toolStart') {
      expect(event.toolId).toBe('call_patch');
      expect(event.toolName).toBe('apply_patch');
      expect(event.input).toEqual({ operation: 'update' });
    }
  });

  it('drives AgentStateStore broadcasts through the normalized parser path', () => {
    setHookProvider(codexProvider);
    const store = new AgentStateStore();
    const agent = makeAgent();
    const broadcasts: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => broadcasts.push(message));
    store.set(1, agent);

    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_1',
          arguments: JSON.stringify({ command: 'npm test' }),
        },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.activeToolIds.has('call_1')).toBe(true);
    expect(agent.activeToolNames.get('call_1')).toBe('shell_command');
    expect(broadcasts).toContainEqual({ type: 'agentStatus', id: 1, status: 'active' });
    expect(broadcasts).toContainEqual({
      type: 'agentToolStart',
      id: 1,
      toolId: 'call_1',
      status: 'Running: npm test',
      toolName: 'shell_command',
      permissionActive: false,
      runInBackground: undefined,
    });

    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_1', output: '{}' },
      }),
      store,
      new Map(),
      new Map(),
    );

    expect(agent.activeToolIds.has('call_1')).toBe(false);
  });
});
