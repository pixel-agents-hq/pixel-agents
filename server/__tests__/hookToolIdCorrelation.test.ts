import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { TOOL_DONE_DELAY_MS } from '../src/constants.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/sess-1.jsonl',
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
    hookDelivered: true,
    contextTokens: 0,
    maxContextTokens: 200_000,
  } as AgentState;
}

const line = (record: unknown) => JSON.stringify(record);

describe('hook tool rows close from the transcript when PostToolUse never arrives', () => {
  let agents: AgentStateStore;
  let handler: HookEventHandler;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    vi.useFakeTimers();
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agents.set(1, createTestAgent());
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
    );
    handler.registerAgent('sess-1', 1);
    return () => vi.useRealTimers();
  });

  /** Simulate a tool whose PreToolUse fires, whose tool_use and tool_result
   *  land in the transcript, and whose PostToolUse never fires. */
  function runToolWithoutPostToolUse(hookPayload: Record<string, unknown>): string | undefined {
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'StructuredOutput',
      tool_input: {},
      ...hookPayload,
    });
    const start = messages.find((m) => m.type === 'agentToolStart');
    processTranscriptLine(
      1,
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'StructuredOutput', input: {} }],
        },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    vi.advanceTimersByTime(TOOL_DONE_DELAY_MS);
    return start?.toolId as string | undefined;
  }

  it('keys the hook row by tool_use_id, so the transcript result closes it', () => {
    const shownId = runToolWithoutPostToolUse({ tool_use_id: 'toolu_1' });
    expect(shownId).toBe('toolu_1');
    const done = messages.filter((m) => m.type === 'agentToolDone').map((m) => m.toolId);
    expect(done).toContain(shownId);
  });

  it('falls back to a synthetic id for CLIs that send no tool_use_id', () => {
    const shownId = runToolWithoutPostToolUse({});
    expect(shownId).toMatch(/^hook-/);
  });
});
