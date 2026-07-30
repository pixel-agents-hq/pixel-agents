/**
 * SubagentWatch: transcript watching for UNNAMED background spawns (sub-agents).
 *
 * Under the domain model a name is the sole classifier: a named background
 * spawn becomes a Teammate character, an unnamed one stays a Sub-agent — the
 * transient "Subtask" character near its parent. But the unnamed spawn still
 * has its own transcript (under <projectDir>/<leadSessionId>/subagents/), and
 * newer harnesses write no agent_progress records on the lead, so the only way
 * to show live activity is to watch that transcript directly.
 *
 * The watch runs in a SHADOW AgentStateStore: a second store whose agents are
 * never persisted, never announced (its agentAdded event is bridged nowhere),
 * and never rendered as characters. The transcript parser drives it exactly
 * like a real agent; this class subscribes to the shadow store's broadcasts
 * and re-emits them on the MAIN store as the existing subagent* messages,
 * keyed to (lead id, spawn tool_use id) — the same key the webview already
 * uses for the Subtask sub-character. No protocol change.
 */

import type * as fs from 'fs';

import { AgentStateStore } from './agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from './constants.js';
import { readNewLines, startFileWatching } from './fileWatcher.js';
import { pathsMatch } from './pathKey.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState } from './types.js';

/** Shadow ids start far above any real agent id. The transcript parser's
 *  module-level callbacks (background detected/completed, team switch) fire
 *  with shadow ids too; the offset guarantees they miss the main store and
 *  no-op instead of touching an unrelated real agent. */
const SHADOW_ID_BASE = 1_000_000;

/** A sub-agent transcript adoption request (sidecar-backed, unnamed). */
export interface SubagentWatchEntry {
  jsonlPath: string;
  toolUseId: string;
}

export class SubagentWatch {
  /** Shadow store: parsed like real agents, broadcast-translated, never shown. */
  readonly store = new AgentStateStore();
  private readonly fileWatchers = new Map<number, fs.FSWatcher>();
  private readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Shadow id → the (lead, spawn tool) the webview keys the sub-character on.
   *  Kept here (not read off AgentState) so transcript-parser mutations of the
   *  shadow agent's team fields can never break the translation. */
  private readonly subKeys = new Map<number, { leadId: number; spawnToolUseId: string }>();
  /** Shadow id → tool ids started but not yet done (for toolsClear synthesis). */
  private readonly liveToolIds = new Map<number, Set<string>>();

  constructor(private readonly mainStore: AgentStateStore) {
    this.store.nextAgentId.current = SHADOW_ID_BASE;
    this.store.on('broadcast', (message) => this.translate(message));
  }

  /** Is this transcript already watched? Consulted by scanner dedupe loops. */
  isWatching(jsonlPath: string): boolean {
    for (const a of this.store.values()) {
      if (pathsMatch(a.jsonlFile, jsonlPath)) return true;
    }
    return false;
  }

  /** Start watching an unnamed background spawn's transcript for the given lead. */
  watch(lead: AgentState, leadId: number, entry: SubagentWatchEntry): void {
    const id = this.store.nextAgentId.current++;
    const agent: AgentState = {
      id,
      // Shares the lead's session like the transcript it mirrors. Never
      // registered with the session router.
      sessionId: lead.sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: lead.projectDir,
      jsonlFile: entry.jsonlPath,
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
      hookDelivered: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      leadAgentId: leadId,
      spawnToolUseId: entry.toolUseId,
    };

    this.subKeys.set(id, { leadId, spawnToolUseId: entry.toolUseId });
    this.store.set(id, agent);

    console.log(
      `[Pixel Agents] Watching background sub-agent transcript for lead Agent ${leadId} (${entry.toolUseId})`,
    );

    startFileWatching(
      id,
      entry.jsonlPath,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
    );
    readNewLines(id, this.store, this.waitingTimers, this.permissionTimers);
  }

  /** Stop the watch matching a completed spawn (queue-operation on the lead). */
  removeBySpawn(leadId: number, toolUseId: string): void {
    for (const [id, key] of this.subKeys) {
      if (key.leadId === leadId && key.spawnToolUseId === toolUseId) {
        this.remove(id);
        return;
      }
    }
  }

  /** Stop all watches belonging to a lead (lead's session ended). */
  removeByLead(leadId: number): void {
    for (const [id, key] of [...this.subKeys]) {
      if (key.leadId === leadId) {
        this.remove(id);
      }
    }
  }

  dispose(): void {
    for (const id of [...this.subKeys.keys()]) {
      this.remove(id);
    }
  }

  private remove(id: number): void {
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) clearInterval(pt);
    this.pollingTimers.delete(id);
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);
    this.subKeys.delete(id);
    this.liveToolIds.delete(id);
    this.store.delete(id);
  }

  /** Re-emit shadow-store activity on the main store as subagent* messages.
   *  Everything not listed here (agentTokenUsage, agentTeamInfo, the shadow's
   *  own nested subagent* messages) is deliberately dropped: the sub-character
   *  has no context gauge, no team badge, and no sub-sub-characters.
   *
   *  Per-tool dones are DEFERRED to the sub's turn end: emitting them as they
   *  happen made the sub-character flap between typing and idle on every
   *  tool boundary. Instead, started tools accumulate and a single batch of
   *  subagentToolDone fires when the shadow agent's turn ends — via
   *  agentToolsClear (activity cleared) or agentStatus:waiting (clean
   *  turn_duration broadcasts no clear) — so the sub types through its turn
   *  and idles between turns. */
  private translate(message: Record<string, unknown>): void {
    const shadowId = message.id as number;
    const key = this.subKeys.get(shadowId);
    if (!key) return;
    const { leadId, spawnToolUseId } = key;

    switch (message.type) {
      case 'agentToolStart': {
        const toolId = message.toolId as string;
        let live = this.liveToolIds.get(shadowId);
        if (!live) {
          live = new Set();
          this.liveToolIds.set(shadowId, live);
        }
        live.add(toolId);
        this.mainStore.broadcast({
          type: 'subagentToolStart',
          id: leadId,
          parentToolId: spawnToolUseId,
          toolId,
          status: message.status,
        });
        break;
      }
      case 'agentToolsClear': {
        this.finishSubTurn(shadowId, leadId, spawnToolUseId);
        break;
      }
      case 'agentStatus': {
        if (message.status === 'waiting') {
          this.finishSubTurn(shadowId, leadId, spawnToolUseId);
        }
        break;
      }
      case 'agentToolPermission': {
        this.mainStore.broadcast({
          type: 'subagentToolPermission',
          id: leadId,
          parentToolId: spawnToolUseId,
        });
        break;
      }
      default:
        break;
    }
  }

  /** The shadow agent's turn ended: mark every started tool done in one batch
   *  so the sub-character idles between its turns. */
  private finishSubTurn(shadowId: number, leadId: number, spawnToolUseId: string): void {
    const live = this.liveToolIds.get(shadowId);
    if (!live || live.size === 0) return;
    for (const toolId of live) {
      this.mainStore.broadcast({
        type: 'subagentToolDone',
        id: leadId,
        parentToolId: spawnToolUseId,
        toolId,
      });
    }
    live.clear();
  }
}
