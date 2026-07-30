import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  scanForBackgroundAgentFiles,
  setHookProvider as setFileWatcherHookProvider,
  setSubagentWatch,
  setTeamProvider,
} from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import { SubagentWatch } from '../src/subagentWatch.js';
import {
  processTranscriptLine,
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
} from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

const LEAD_SESSION = 'lead-session-1';
const SPAWN_TOOL_ID = 'toolu_01LMvN98KN4sn1fmvftm7vhk';
const SUB_TOOL_ID = 'toolu_sub_01';

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
    contextTokens: 0,
    maxContextTokens: 200_000,
  } as AgentState;
}

/** Records shaped like the background-agent flow (Claude 2.1.x, teams OFF):
 *  unflagged Agent tool_use, "Async agent launched" result, queue-operation
 *  completion. */
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

function namedAgentSpawnRecord(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: SPAWN_TOOL_ID,
          name: 'Agent',
          input: {
            description: 'ghost writer probe',
            name: 'ghost-writer',
            subagent_type: 'general-purpose',
          },
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

/** Lines for the SPAWN's OWN transcript (watched by the shadow store). */
function subToolUseLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: SUB_TOOL_ID, name: 'Read', input: { file_path: '/tmp/x.ts' } },
      ],
    },
  });
}

function subToolResultLine(): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: SUB_TOOL_ID, content: 'ok' }] },
  });
}

function subTurnDurationLine(): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration' });
}

describe('background spawns (teams OFF) classified by sidecar name', () => {
  let tmpRoot: string;
  let agents: AgentStateStore;
  let watch: SubagentWatch;
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
      watch.removeBySpawn(leadId, toolUseId);
    });
  }

  function seedSidecar(opts?: { name?: string; transcriptLines?: string[] }): string {
    const subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const jsonlPath = path.join(subagentsDir, 'agent-a4cb86c99458dbe55.jsonl');
    const lines = opts?.transcriptLines ?? [];
    fs.writeFileSync(jsonlPath, lines.length > 0 ? lines.join('\n') + '\n' : '');
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-a4cb86c99458dbe55.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Say hello',
        toolUseId: SPAWN_TOOL_ID,
        spawnDepth: 1,
        ...(opts?.name ? { name: opts.name } : {}),
      }),
    );
    return jsonlPath;
  }

  function spawnAndLaunch(): void {
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-bg-'));
    setHookProvider(claudeProvider);
    setFileWatcherHookProvider(claudeProvider);
    setTeamProvider(claudeTeamProvider);
    agents = new AgentStateStore();
    watch = new SubagentWatch(agents);
    setSubagentWatch(watch);
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
    watch.dispose();
    setSubagentWatch(null);
    for (const t of pollingTimers.values()) clearInterval(t);
    pollingTimers.clear();
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Unnamed spawn = Sub-agent (shadow-watched) ──────────────────────

  it('flags a NAMED spawn as isTeammateSpawn so the webview never creates a Subtask ghost', () => {
    processTranscriptLine(1, namedAgentSpawnRecord(), agents, waitingTimers, permissionTimers);

    const start = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(start).toBeDefined();
    expect(start!.isTeammateSpawn).toBe(true);

    // The async re-broadcast and the turn-end re-send must carry the flag too
    // (a turn can end before the teammate character is discovered).
    processTranscriptLine(1, asyncLaunchResultRecord(), agents, waitingTimers, permissionTimers);
    messages.length = 0;
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    for (const m of messages) {
      if (m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID) {
        expect(m.isTeammateSpawn).toBe(true);
      }
    }
  });

  it('does not flag an unnamed spawn as isTeammateSpawn', () => {
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    const start = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(start).toBeDefined();
    expect(start!.isTeammateSpawn).toBeUndefined();
  });

  it('re-broadcasts the spawn tool flagged runInBackground when the async result lands', () => {
    // The tool_use input OMITS run_in_background on current harnesses, so the
    // original agentToolStart went out unflagged. Without the flagged
    // re-broadcast, the webview removes the Subtask at the first turn-end
    // clear and recreates it at a new tile (the teleport bug).
    seedSidecar();
    spawnAndLaunch();

    const flagged = messages.find(
      (m) =>
        m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID && m.runInBackground === true,
    );
    expect(flagged).toBeDefined();
    expect(flagged!.toolName).toBe('Agent');
  });

  it('watches an unnamed spawn in the shadow store instead of creating a character', () => {
    const jsonlPath = seedSidecar();
    spawnAndLaunch();

    expect(lead.backgroundAgentToolIds.has(SPAWN_TOOL_ID)).toBe(true);
    // No main-store child, so no agentCreated fires and nothing is persisted.
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
    // The transient Subtask sub-character must LIVE: no ghost-kill.
    expect(
      messages.some((m) => m.type === 'subagentClear' && m.parentToolId === SPAWN_TOOL_ID),
    ).toBe(false);
    expect(watch.isWatching(jsonlPath)).toBe(true);
  });

  it('translates the watched transcript into subagent* messages keyed to the spawn tool', () => {
    vi.useFakeTimers();
    seedSidecar({ transcriptLines: [subToolUseLine(), subToolResultLine()] });
    spawnAndLaunch();

    const start = messages.find((m) => m.type === 'subagentToolStart');
    expect(start).toBeDefined();
    expect(start!.id).toBe(1);
    expect(start!.parentToolId).toBe(SPAWN_TOOL_ID);
    expect(start!.toolId).toBe(SUB_TOOL_ID);
    expect(start!.status).toContain('x.ts');

    // Per-tool dones are DEFERRED to the sub's turn end: emitting them as they
    // happened made the sub-character flap between typing and idle on every
    // tool boundary.
    vi.advanceTimersByTime(400);
    expect(messages.some((m) => m.type === 'subagentToolDone')).toBe(false);

    // Nothing leaks through untranslated: the shadow agent's own lifecycle
    // messages must not reach the webview with a shadow id.
    expect(messages.some((m) => (m.id as number) >= 1_000_000)).toBe(false);
  });

  it('marks sub tools done when the watched transcript ends its turn cleanly', () => {
    // tool_result BEFORE turn_duration: nothing left to clear at turn end, so
    // the done batch must ride the agentStatus:waiting broadcast instead.
    seedSidecar({
      transcriptLines: [subToolUseLine(), subToolResultLine(), subTurnDurationLine()],
    });
    spawnAndLaunch();

    const done = messages.find((m) => m.type === 'subagentToolDone' && m.toolId === SUB_TOOL_ID);
    expect(done).toBeDefined();
    expect(done!.id).toBe(1);
    expect(done!.parentToolId).toBe(SPAWN_TOOL_ID);
  });

  it('synthesizes subagentToolDone for live tools when the watched transcript hits turn end', () => {
    seedSidecar({ transcriptLines: [subToolUseLine(), subTurnDurationLine()] });
    spawnAndLaunch();

    // No tool_result arrived; turn_duration (-> agentToolsClear on the shadow
    // agent) must still resolve the started tool so the sub-character idles.
    const done = messages.find((m) => m.type === 'subagentToolDone' && m.toolId === SUB_TOOL_ID);
    expect(done).toBeDefined();
    expect(done!.id).toBe(1);
    expect(done!.parentToolId).toBe(SPAWN_TOOL_ID);
  });

  it('re-sends a watched spawn tool with toolName + runInBackground at turn end', () => {
    // The Subtask sub-character is the spawn's only representation and MUST be
    // recreatable after the turn-end agentToolsClear.
    seedSidecar();
    spawnAndLaunch();
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

  it('re-sends a watched spawn tool when a new user prompt clears activity (heuristic path)', () => {
    // clearAgentActivity used to re-send background tools WITHOUT toolName/
    // runInBackground -- the webview then failed to recreate the Subtask and
    // the sub-character despawned on the next user prompt.
    seedSidecar();
    spawnAndLaunch();
    messages.length = 0;
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'user', message: { content: 'now do something else' } }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    const resent = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(resent).toBeDefined();
    expect(resent!.toolName).toBe('Agent');
    expect(resent!.runInBackground).toBe(true);
  });

  it('stops the shadow watch when the completion queue-operation lands', () => {
    const jsonlPath = seedSidecar();
    spawnAndLaunch();
    expect(watch.isWatching(jsonlPath)).toBe(true);

    processTranscriptLine(1, queueOpCompletionRecord(), agents, waitingTimers, permissionTimers);

    expect(completed).toEqual([{ leadId: 1, toolUseId: SPAWN_TOOL_ID }]);
    expect(watch.isWatching(jsonlPath)).toBe(false);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
  });

  it('does not double-watch on a re-scan', () => {
    seedSidecar();
    spawnAndLaunch();
    expect(watch.store.size).toBe(1);

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

    expect(watch.store.size).toBe(1);
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
  });

  // ── Foreground spawns (open Agent tool, no async result) ───────────

  function foregroundResultRecord(): string {
    return JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: SPAWN_TOOL_ID, content: 'Here is my report.' },
        ],
      },
    });
  }

  it('watches a foreground spawn sidecar while its tool is open, even when named', () => {
    // Foreground spawns are within-turn work whatever the sidecar says: they
    // are watched for live activity, never seated as teammates.
    const jsonlPath = seedSidecar({ name: 'ghost-writer' });
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    // No async launch result: the tool is a live FOREGROUND spawn.
    scanForBackgroundAgentFiles(
      1,
      agents,
      { current: 300 },
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => {},
      undefined,
    );

    expect(watch.isWatching(jsonlPath)).toBe(true);
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
  });

  it('stops the foreground watch when the spawn tool completes', () => {
    const jsonlPath = seedSidecar();
    processTranscriptLine(1, agentSpawnRecord(), agents, waitingTimers, permissionTimers);
    scanForBackgroundAgentFiles(
      1,
      agents,
      { current: 300 },
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => {},
      undefined,
    );
    expect(watch.isWatching(jsonlPath)).toBe(true);

    processTranscriptLine(1, foregroundResultRecord(), agents, waitingTimers, permissionTimers);

    expect(watch.isWatching(jsonlPath)).toBe(false);
    expect(
      messages.some((m) => m.type === 'subagentClear' && m.parentToolId === SPAWN_TOOL_ID),
    ).toBe(true);
  });

  // ── Named spawn = Teammate ──────────────────────────────────────────

  it('creates a teammate named from the sidecar name and badges the lead', () => {
    const jsonlPath = seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();

    const teammate = [...agents.values()].find((a) => a.leadAgentId === 1);
    expect(teammate).toBeDefined();
    // The sidecar `name` wins over description/agentType.
    expect(teammate!.agentName).toBe('ghost-writer');
    expect(teammate!.spawnToolUseId).toBe(SPAWN_TOOL_ID);
    expect(teammate!.jsonlFile).toBe(jsonlPath);
    // Derived team: NO teamName (config polling must stay away), but the
    // spawner becomes a Lead.
    expect(teammate!.teamName).toBeUndefined();
    expect(lead.isTeamLead).toBe(true);
    expect(
      messages.some((m) => m.type === 'agentTeamInfo' && m.id === 1 && m.isTeamLead === true),
    ).toBe(true);
    // The transient Subtask sub-character is superseded by the real character.
    expect(
      messages.some((m) => m.type === 'subagentClear' && m.parentToolId === SPAWN_TOOL_ID),
    ).toBe(true);
    expect(watch.isWatching(jsonlPath)).toBe(false);
  });

  it('does not create a second teammate when the sidecar path is spelled differently', () => {
    // Windows only: the same transcript reaches the runtime spelled two ways
    // (hooks carry Claude's `process.cwd()` casing, scanners build from
    // Uri.fsPath's lowercased drive letter). An exact-string already-tracked
    // check missed and adopted the same background agent twice.
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const jsonlPath = seedSidecar({ name: 'ghost-writer' });
      spawnAndLaunch();
      const teammates = [...agents.values()].filter((a) => a.leadAgentId === 1);
      expect(teammates).toHaveLength(1);

      // Re-scan with the agent's path stored under the other spelling.
      teammates[0].jsonlFile = jsonlPath.toUpperCase();
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

  it('does not re-send the spawn tool at turn end for a named teammate (no ghost Subtask)', () => {
    seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();
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

  it('does not re-send the spawn tool on a new user prompt once a teammate exists', () => {
    seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();
    messages.length = 0;
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'user', message: { content: 'now do something else' } }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(messages.some((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID)).toBe(
      false,
    );
  });

  it('removes the teammate when the completion queue-operation lands', () => {
    seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(true);

    processTranscriptLine(1, queueOpCompletionRecord(), agents, waitingTimers, permissionTimers);

    expect(completed).toEqual([{ leadId: 1, toolUseId: SPAWN_TOOL_ID }]);
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
  });

  // ── Shared gate ─────────────────────────────────────────────────────

  it('adopts nothing when the sidecar toolUseId matches no live background spawn', () => {
    // Stale sidecar from an earlier session: same shape, dead toolUseId.
    const subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'agent-old.jsonl'), '');
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-old.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_dead', name: 'stale' }),
    );
    spawnAndLaunch();
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
    expect(watch.isWatching(path.join(subagentsDir, 'agent-old.jsonl'))).toBe(false);
  });
});

describe('background spawn persistence & derived team lifecycle', () => {
  function fakeAdapter(initial: unknown[] = []): StateAdapter & { saved: unknown[][] } {
    const saved: unknown[][] = [];
    return {
      saved,
      loadAgents: () => initial as never,
      saveAgents: (agents) => {
        saved.push(agents as unknown[]);
      },
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, defaultValue: T) => defaultValue,
      setSetting: () => {},
    };
  }

  it('persists the lead backgroundAgentToolIds and never the spawned children', () => {
    const store = new AgentStateStore();
    const adapter = fakeAdapter();
    store.setAdapter(adapter);

    const lead = createLeadAgent('/tmp/proj');
    lead.backgroundAgentToolIds.add(SPAWN_TOOL_ID);
    store.set(1, lead);

    const child = createLeadAgent('/tmp/proj');
    child.id = 2;
    child.agentName = 'ghost-writer';
    child.leadAgentId = 1;
    child.spawnToolUseId = SPAWN_TOOL_ID;
    store.set(2, child);

    store.persist();

    const persisted = adapter.saved.at(-1) as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(1);
    expect(persisted[0].backgroundAgentToolIds).toEqual([SPAWN_TOOL_ID]);
  });

  it('drops the LEAD badge when the last teammate leaves', () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      const lead = createLeadAgent('/tmp/proj');
      lead.isTeamLead = true;
      store.set(1, lead);
      const teammate = createLeadAgent('/tmp/proj');
      teammate.id = 2;
      teammate.agentName = 'ghost-writer';
      teammate.leadAgentId = 1;
      teammate.spawnToolUseId = SPAWN_TOOL_ID;
      store.set(2, teammate);
      const broadcasts: Array<Record<string, unknown>> = [];
      store.on('broadcast', (m) => broadcasts.push(m as Record<string, unknown>));

      runtime.removeTeammate(2, 'test');

      expect(store.has(2)).toBe(false);
      expect(store.get(1)!.isTeamLead).toBeUndefined();
      const demote = broadcasts.find((m) => m.type === 'agentTeamInfo' && m.id === 1);
      expect(demote).toBeDefined();
      expect(demote!.isTeamLead).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it('keeps the LEAD badge while other teammates remain', () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      const lead = createLeadAgent('/tmp/proj');
      lead.isTeamLead = true;
      store.set(1, lead);
      for (const [id, name] of [
        [2, 'ghost-writer'],
        [3, 'researcher'],
      ] as const) {
        const teammate = createLeadAgent('/tmp/proj');
        teammate.id = id;
        teammate.agentName = name;
        teammate.leadAgentId = 1;
        teammate.spawnToolUseId = `${SPAWN_TOOL_ID}-${id}`;
        store.set(id, teammate);
      }

      runtime.removeTeammate(2, 'test');

      expect(store.get(1)!.isTeamLead).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it('restores the lead set and skips stale child entries (leadAgentId, no teamName)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-bg-restore-'));
    const leadJsonl = path.join(tmpRoot, `${LEAD_SESSION}.jsonl`);
    const childJsonl = path.join(tmpRoot, 'child.jsonl');
    fs.writeFileSync(leadJsonl, '');
    fs.writeFileSync(childJsonl, '');

    const adapter = fakeAdapter([
      {
        id: 1,
        sessionId: LEAD_SESSION,
        terminalName: '',
        isExternal: true,
        jsonlFile: leadJsonl,
        projectDir: tmpRoot,
        backgroundAgentToolIds: [SPAWN_TOOL_ID],
      },
      {
        // Stale background child written by an older build: derived state,
        // must not resurrect as an immortal character.
        id: 2,
        sessionId: LEAD_SESSION,
        terminalName: '',
        isExternal: true,
        jsonlFile: childJsonl,
        projectDir: tmpRoot,
        agentName: 'Say hello',
        leadAgentId: 1,
      },
    ]);

    const store = new AgentStateStore();
    store.setAdapter(adapter);
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      runtime.restoreExternalAgents();

      expect(store.has(1)).toBe(true);
      expect(store.has(2)).toBe(false);
      expect(store.get(1)!.backgroundAgentToolIds.has(SPAWN_TOOL_ID)).toBe(true);
    } finally {
      runtime.dispose();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
