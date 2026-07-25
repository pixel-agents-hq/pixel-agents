import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { scanForBackgroundAgentFiles, setTeamProvider } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import {
  processTranscriptLine,
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
} from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

const LEAD_SESSION = 'lead-session-1';
const SPAWN_TOOL_ID = 'toolu_01LMvN98KN4sn1fmvftm7vhk';

function createLeadAgent(projectDir: string): AgentState {
  return {
    id: 1,
    sessionId: LEAD_SESSION,
    terminalRef: undefined,
    isExternal: false,
    projectDir,
    jsonlFile: path.join(projectDir, `${LEAD_SESSION}.jsonl`),
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
  } as AgentState;
}

/** Records shaped like the anonymous background-agent flow (Claude 2.1.x,
 *  teams OFF): unflagged Agent tool_use, "Async agent launched" result,
 *  queue-operation completion. */
function agentSpawnRecord(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: SPAWN_TOOL_ID,
          name: 'Agent',
          input: { description: 'Say hello', subagent_type: 'general-purpose' },
        },
      ],
    },
  });
}

function asyncLaunchResultRecord(): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: SPAWN_TOOL_ID,
          content: [
            {
              type: 'text',
              text: 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a4cb86c99458dbe55 (internal)',
            },
          ],
        },
      ],
    },
  });
}

function queueOpCompletionRecord(): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification> <task-id>a4cb86c99458dbe55</task-id> <tool-use-id>${SPAWN_TOOL_ID}</tool-use-id> <output>done</output>`,
  });
}

describe('anonymous background agents (teams OFF) promoted to named characters', () => {
  let tmpRoot: string;
  let agents: AgentStateStore;
  let lead: AgentState;
  let messages: Array<Record<string, unknown>>;
  let completed: Array<{ leadId: number; toolUseId: string }>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  const fileWatchers = new Map<number, fs.FSWatcher>();

  /** Mirrors the agentRuntime wiring for the two transcriptParser callbacks. */
  function wireCallbacks() {
    setBackgroundAgentDetectedCallback((leadId) => {
      scanForBackgroundAgentFiles(
        leadId,
        agents,
        { current: 100 },
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        () => {},
        undefined,
      );
    });
    setBackgroundAgentCompletedCallback((leadId, toolUseId) => {
      completed.push({ leadId, toolUseId });
      for (const [id, a] of agents) {
        if (a.leadAgentId === leadId && a.spawnToolUseId === toolUseId) {
          agents.delete(id);
          break;
        }
      }
    });
  }

  function seedSidecar(): string {
    const subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const jsonlPath = path.join(subagentsDir, 'agent-a4cb86c99458dbe55.jsonl');
    fs.writeFileSync(jsonlPath, '');
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-a4cb86c99458dbe55.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Say hello',
        toolUseId: SPAWN_TOOL_ID,
        spawnDepth: 1,
      }),
    );
    return jsonlPath;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-bg-'));
    setHookProvider(claudeProvider);
    setTeamProvider(claudeTeamProvider);
    agents = new AgentStateStore();
    lead = createLeadAgent(tmpRoot);
    agents.set(1, lead);
    messages = [];
    completed = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    wireCallbacks();
  });

  afterEach(() => {
    setBackgroundAgentDetectedCallback(() => {});
    setBackgroundAgentCompletedCallback(() => {});
    for (const t of pollingTimers.values()) clearInterval(t);
    pollingTimers.clear();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('promotes the spawn to a named character and clears the Subtask ghost', () => {
    const jsonlPath = seedSidecar();
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);

    expect(lead.backgroundAgentToolIds.has(SPAWN_TOOL_ID)).toBe(true);
    const promoted = [...agents.values()].find((a) => a.leadAgentId === 1);
    expect(promoted).toBeDefined();
    expect(promoted!.agentName).toBe('Say hello');
    expect(promoted!.spawnToolUseId).toBe(SPAWN_TOOL_ID);
    expect(promoted!.jsonlFile).toBe(jsonlPath);
    // The transient Subtask sub-character is superseded by the real one.
    expect(
      messages.some((m) => m.type === 'subagentClear' && m.parentToolId === SPAWN_TOOL_ID),
    ).toBe(true);
  });

  it('does not promote a second character when the sidecar path is spelled differently', () => {
    // Windows only: the same transcript reaches the runtime spelled two ways
    // (hooks carry Claude's `process.cwd()` casing, scanners build from
    // Uri.fsPath's lowercased drive letter). An exact-string already-tracked
    // check missed and promoted the same background agent twice.
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const jsonlPath = seedSidecar();
      processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
      processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);
      const promoted = [...agents.values()].filter((a) => a.leadAgentId === 1);
      expect(promoted).toHaveLength(1);

      // Re-scan with the agent's path stored under the other spelling.
      promoted[0].jsonlFile = jsonlPath.toUpperCase();
      scanForBackgroundAgentFiles(
        1,
        agents,
        { current: 200 },
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        () => {},
        undefined,
      );

      expect([...agents.values()].filter((a) => a.leadAgentId === 1)).toHaveLength(1);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not re-send the spawn tool at turn end once promoted (no ghost Subtask)', () => {
    seedSidecar();
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);
    // Add a foreground tool so the turn_duration cleanup branch runs.
    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    messages.length = 0;
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(messages.some((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID)).toBe(
      false,
    );
  });

  it('re-sends non-promoted background tools with toolName + runInBackground at turn end', () => {
    // No sidecar: promotion cannot happen; the Subtask sub-character is the only
    // representation and MUST be recreatable after agentToolsClear.
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);
    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    messages.length = 0;
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    const resent = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(resent).toBeDefined();
    expect(resent!.toolName).toBe('Agent');
    expect(resent!.runInBackground).toBe(true);
  });

  it('removes the promoted character when the completion queue-operation lands', () => {
    seedSidecar();
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(true);

    processTranscriptLine(1, queueOpCompletionRecord(), agents, waitingTimers, permissionTimers);

    expect(completed).toEqual([{ leadId: 1, toolUseId: SPAWN_TOOL_ID }]);
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
  });

  it('adopts nothing when the sidecar toolUseId matches no live background spawn', () => {
    // Stale sidecar from an earlier session: same shape, dead toolUseId.
    const subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'agent-old.jsonl'), '');
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-old.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_dead' }),
    );
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
  });
});
