import * as path from 'path';

import type { AgentEvent, HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { SESSION_END_GRACE_MS } from './constants.js';
import type { SessionRouter } from './sessionRouter.js';
import { getInlineTeammates, hasInlineTeammates, hasPromotedBackgroundAgent } from './teamUtils.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { notifyBackgroundAgentCompleted } from './transcriptParser.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/** Raw hook event received from a provider's relay via the HTTP server. */
export type HookEvent = Record<string, unknown>;

/**
 * Dispatches normalized AgentEvents to agents based on session_id.
 * Session routing (session→agent mapping, pending sessions, event buffering)
 * is delegated to an injected SessionRouter instance.
 *
 * When an event is successfully delivered, sets `agent.hookDelivered = true` which
 * suppresses heuristic timers (permission 7s, text-idle 5s) for that agent.
 */
/** Callback for session lifecycle events detected via hooks. */
interface SessionLifecycleCallbacks {
  /** Called when an external session is detected (unknown session_id in SessionStart).
   *  transcriptPath is undefined for providers without transcripts (OpenCode, Copilot). */
  onExternalSessionDetected?: (
    sessionId: string,
    transcriptPath: string | undefined,
    cwd: string,
  ) => void;
  /** Called when /clear is detected via hooks (SessionEnd reason=clear + SessionStart source=clear). */
  onSessionClear?: (
    agentId: number,
    newSessionId: string,
    newTranscriptPath: string | undefined,
  ) => void;
  /** Called when a session is resumed (--resume). Clears dismissals so the file can be re-adopted. */
  onSessionResume?: (transcriptPath: string) => void;
  /** Called when a session ends (exit/logout). */
  onSessionEnd?: (agentId: number, reason: string) => void;
  /** Called when an Agent Teams teammate is detected via SubagentStart hook.
   *  Triggers scanning of the session's subagents/ directory for the teammate's JSONL. */
  onTeammateDetected?: (parentAgentId: number, sessionId: string, agentType: string) => void;
  /** Called when a teammate should be removed (e.g. no longer in team config members).
   *  Removes the teammate agent from the office. */
  onTeammateRemoved?: (teammateAgentId: number) => void;
}

export class HookEventHandler {
  private lifecycleCallbacks: SessionLifecycleCallbacks = {};

  /** Highest HookProvider.protocolVersion this handler understands. */
  private static readonly SUPPORTED_PROTOCOL_VERSION = 1;

  constructor(
    private agents: AgentStateStore,
    private waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    private permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
    private provider: HookProvider,
    private sessionRouter: SessionRouter,
    private watchAllSessionsRef?: { current: boolean },
  ) {
    if (provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
      console.warn(
        `[Pixel Agents] HookProvider "${provider.id}" reports protocolVersion=${provider.protocolVersion}, ` +
          `but handler understands ${HookEventHandler.SUPPORTED_PROTOCOL_VERSION}. ` +
          `Events from this provider will be dropped.`,
      );
    }
  }

  /** Merged set of tool names that spawn subagents (teammates + within-turn subagents
   *  when a team provider is attached, or the base HookProvider set otherwise). */
  private getSubagentToolSet(): ReadonlySet<string> {
    if (this.provider.team) {
      return new Set<string>([
        ...this.provider.team.teammateSpawnTools,
        ...this.provider.team.withinTurnSubagentTools,
      ]);
    }
    return this.provider.subagentToolNames;
  }

  /** Check if a session is tracked (in workspace project dir, or Watch All Sessions ON). */
  private isTrackedSession(transcriptPath?: string, cwd?: string): boolean {
    if (this.watchAllSessionsRef?.current) return true;
    const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
    if (!projectDir) return false;
    return [...this.agents.values()].some(
      (a) => path.resolve(a.projectDir).toLowerCase() === path.resolve(projectDir).toLowerCase(),
    );
  }

  /** Set callbacks for session lifecycle events (SessionStart/SessionEnd). */
  setLifecycleCallbacks(callbacks: SessionLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  /** Register an agent for hook event routing. Flushes any buffered events for this session. */
  registerAgent(sessionId: string, agentId: number): void {
    const flushed = this.sessionRouter.register(sessionId, agentId);
    if (debug && flushed.length > 0)
      console.log(
        `[Pixel Agents] Hook: flushing ${flushed.length} buffered event(s) for session ${sessionId.slice(0, 8)}...`,
      );
    for (const { providerId, event } of flushed) {
      this.handleEvent(providerId, event as HookEvent);
    }
  }

  /** Remove an agent's session mapping (called on agent removal/terminal close). */
  unregisterAgent(sessionId: string): void {
    this.sessionRouter.unregister(sessionId);
  }

  /**
   * Process an incoming hook event. Looks up the agent by session_id,
   * falls back to auto-discovery scan, or buffers if agent not yet registered.
   * @param providerId - Provider that sent the event ('claude', 'codex', etc.)
   * @param event - The hook event payload from the CLI tool
   */
  handleEvent(_providerId: string, event: HookEvent): void {
    if (this.provider.protocolVersion !== HookEventHandler.SUPPORTED_PROTOCOL_VERSION) {
      return; // version mismatch already logged in constructor
    }
    // ── Provider normalization boundary ───────────────────────────────────────
    // All raw Claude-specific fields (tool_name, tool_input, agent_type, teammate_name,
    // task_subject, notification_type,
    // reason, source) are extracted by provider.normalizeHookEvent. Downstream dispatch
    // uses the normalized AgentEvent.kind. Raw `event.*` reads are still allowed in a few
    // places for provider-specific metadata that AgentEvent doesn't capture (transcript_path,
    // cwd for external-session adoption; event-specific teammate identity for routing).
    const normalized = this.provider.normalizeHookEvent(event);
    if (!normalized) return; // unknown / uninteresting event -- silently drop
    const normEvent = normalized.event;
    const sessionId = normalized.sessionId;
    const eventName =
      typeof event.hook_event_name === 'string'
        ? event.hook_event_name
        : typeof event.event === 'string'
          ? event.event
          : normEvent.kind;
    // CI / e2e diagnostic: see agentStateStore.ts debugLogBroadcast comment.
    if (process.env['PIXEL_AGENTS_DEBUG_LOG']) {
      try {
        const fs = require('fs') as typeof import('fs');
        const sid = sessionId.slice(0, 8);
        const extras =
          normEvent.kind === 'toolStart'
            ? ` toolName=${(normEvent as { toolName?: string }).toolName}`
            : '';
        fs.appendFileSync(
          process.env['PIXEL_AGENTS_DEBUG_LOG']!,
          `${new Date().toISOString()} HOOK kind=${normEvent.kind} sid=${sid} src=${(normEvent as { source?: string }).source ?? ''}${extras}\n`,
        );
      } catch {
        /* never crash on diagnostic failure */
      }
    }

    // --- SessionStart: handle /clear for known agents, ignore unknown sessions ---
    // External session detection via SessionStart is deferred to Phase C.
    // For now, only use SessionStart for:
    //   1. Confirming known agents (set hookDelivered)
    //   2. /clear reassignment (source=clear + pendingClear agent)
    if (normEvent.kind === 'sessionStart') {
      const sid = sessionId.slice(0, 8);
      const source = normEvent.source ?? 'unknown';
      const transcriptPath = normEvent.transcriptPath;
      const cwd = normEvent.cwd;
      const tracked = this.isTrackedSession(transcriptPath, cwd);
      // The relay sends this on actual model/tool activity, not on opening an
      // empty CLI session. Adopt immediately, including text-only turns.
      if (this.provider.id === 'openclaw') {
        let id = this.sessionRouter.resolve(sessionId);
        if (id !== undefined && !this.agents.has(id)) {
          this.sessionRouter.unregister(sessionId);
          id = undefined;
        }
        if (id === undefined) {
          const existing = [...this.agents.values()].find(
            (a) => a.providerId === 'openclaw' && a.sessionId === sessionId,
          );
          if (existing) {
            this.registerAgent(sessionId, existing.id);
          } else if (cwd) {
            this.lifecycleCallbacks.onExternalSessionDetected?.(sessionId, undefined, cwd);
          }
          id = this.sessionRouter.resolve(sessionId);
        }
        const agent = id === undefined ? undefined : this.agents.get(id);
        if (agent) {
          if (typeof event.display_name === 'string') {
            const name = event.display_name
              .replace(/[\u0000-\u001f\u007f]/g, '')
              .trim()
              .slice(0, 120);
            if (name && name !== agent.agentName) {
              agent.agentName = name;
              this.agents.broadcast({ type: 'agentTeamInfo', id: agent.id, agentName: name });
              this.agents.persist();
            }
          }
          cancelWaitingTimer(agent.id, this.waitingTimers);
          agent.hookDelivered = true;
          agent.isWaiting = false;
          agent.permissionSent = false;
          agent.lastDataAt = Date.now();
          this.agents.broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
        }
        return;
      }
      if (debug && tracked)
        console.log(`[Pixel Agents] Hook: SessionStart(source=${source}, session=${sid}...)`);

      // Check registered mapping
      const existingAgentId = this.sessionRouter.resolve(sessionId);
      if (existingAgentId !== undefined) {
        const agent = this.agents.get(existingAgentId);
        if (agent) {
          agent.hookDelivered = true;
        }
        if (debug)
          console.log(
            `[Pixel Agents] Hook: Agent ${existingAgentId} - SessionStart(source=${source}) known`,
          );
        return;
      }
      // Check auto-discovery (agent exists but not yet registered for hooks)
      for (const [id, agent] of this.agents) {
        const sameProvider = agent.providerId
          ? agent.providerId === this.provider.id
          : this.provider.id === 'claude';
        if (sameProvider && agent.sessionId === sessionId) {
          this.registerAgent(agent.sessionId, id);
          agent.hookDelivered = true;
          if (debug)
            console.log(
              `[Pixel Agents] Hook: Agent ${id} - SessionStart(source=${source}) auto-discovered`,
            );
          return;
        }
      }
      // /clear or /resume: reassign existing agent to new session
      if (normEvent.source === 'clear' || normEvent.source === 'resume') {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (projectDir) {
          for (const [id, agent] of this.agents) {
            // Both /clear and /resume send SessionEnd first (sets pendingClear),
            // then SessionStart. Match the agent that has pendingClear in same project dir.
            // Normalize paths for cross-platform comparison (separators + case-insensitive
            // for Windows where drive letter casing differs: c:\ vs C:\).
            const isMatch =
              agent.pendingClear &&
              path.resolve(agent.projectDir).toLowerCase() ===
                path.resolve(projectDir).toLowerCase();
            if (isMatch) {
              agent.pendingClear = false;
              console.log(
                `[Pixel Agents] Hook: Agent ${id} - /${normEvent.source} detected, reassigning to ${sessionId}`,
              );
              this.sessionRouter.unregister(agent.sessionId);
              this.registerAgent(sessionId, id);
              this.lifecycleCallbacks.onSessionClear?.(id, sessionId, transcriptPath);
              return;
            }
          }
        }
      }
      // Unknown session -- store as pending, create only when a confirmation event
      // arrives (Stop, Notification, PermissionRequest). This filters transient sessions
      // from Claude Code Extension which fire SessionStart + SessionEnd without any activity.
      if (transcriptPath || cwd) {
        // For --resume, clear dismissals so the file can be re-adopted
        if (normEvent.source === 'resume' && transcriptPath) {
          this.lifecycleCallbacks.onSessionResume?.(transcriptPath);
        }
        if (debug && tracked)
          console.log(
            `[Pixel Agents] Hook: SessionStart(source=${source}) -> pending external session ${sid}..., awaiting confirmation`,
          );
        this.sessionRouter.storePending(sessionId, {
          sessionId,
          transcriptPath,
          cwd: cwd ?? '',
        });
      } else {
        if (debug && tracked)
          console.log(
            `[Pixel Agents] Hook: SessionStart -> unknown session ${sid}..., no transcript_path`,
          );
      }
      return;
    }

    // --- All other events: standard agent lookup ---
    // If SessionEnd arrives for a pending external session, discard it (transient session)
    if (normEvent.kind === 'sessionEnd' && this.sessionRouter.hasPending(sessionId)) {
      this.sessionRouter.discardPending(sessionId);
      if (debug)
        console.log(
          `[Pixel Agents] Hook: SessionEnd discarded pending external session ${sessionId.slice(0, 8)}...`,
        );
      return;
    }

    // If a confirmation event arrives for a pending external session, create the agent first
    const pending = this.sessionRouter.confirmPending(sessionId);
    if (pending) {
      if (debug)
        console.log(
          `[Pixel Agents] Hook: ${eventName} confirmed external session ${sessionId.slice(0, 8)}..., notifying host`,
        );
      this.lifecycleCallbacks.onExternalSessionDetected?.(
        pending.sessionId,
        pending.transcriptPath,
        pending.cwd,
      );
      // Re-process this event now that the agent exists
      this.handleEvent(_providerId, event);
      return;
    }

    let agentId = this.sessionRouter.resolve(sessionId);
    if (agentId === undefined) {
      for (const [id, agent] of this.agents) {
        const sameProvider = agent.providerId
          ? agent.providerId === this.provider.id
          : this.provider.id === 'claude';
        if (sameProvider && agent.sessionId === sessionId) {
          this.registerAgent(agent.sessionId, id);
          agentId = id;
          break;
        }
      }
    }
    if (agentId === undefined) {
      // Buffer if: pending external session, already buffering for this session,
      // OR agents exist that haven't been registered yet (internal agent race:
      // hook event arrives before registerAgent is called after launchNewTerminal).
      // Silently drop events for sessions we have no record of
      // (e.g. other projects with Watch All OFF).
      const isPending = this.sessionRouter.hasPending(sessionId);
      const hasBuffered = this.sessionRouter.hasBuffered(sessionId);
      const hasUnregisteredAgents = [...this.agents.values()].some(
        (a) =>
          (a.providerId ?? 'claude') === this.provider.id &&
          a.sessionId &&
          !this.sessionRouter.hasSession(a.sessionId),
      );
      if (isPending || hasBuffered || hasUnregisteredAgents) {
        if (debug)
          console.log(
            `[Pixel Agents] Hook: ${eventName} - unknown session ${sessionId.slice(0, 8)}..., buffering`,
          );
        this.sessionRouter.bufferEvent(_providerId, { ...event, session_id: sessionId });
      }
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.hookDelivered = true;
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - ${eventName} (session=${sessionId.slice(0, 8)}...)`,
      );

    // Dispatch on normalized AgentEvent.kind, not raw hook event names.
    // The TeammateIdle / TaskCompleted hooks normalize to `subagentTurnEnd` -- both
    // retain their raw payload for the team-routing handler's identity extraction.
    switch (normEvent.kind) {
      case 'sessionEnd':
        return this.handleSessionEnd(normEvent, agent, agentId);
      case 'toolStart':
        return this.handlePreToolUse(normEvent, agent, agentId);
      case 'toolEnd':
        // Both PostToolUse and PostToolUseFailure normalize to toolEnd. Distinguishing
        // them inside handlers would require extra info; the existing behavior was
        // identical for both (agentToolDone + clear currentHookToolId), so one branch suffices.
        return this.handlePostToolUse(normEvent, agent, agentId);
      case 'subagentStart':
        return this.handleSubagentStart(normEvent, event, sessionId, agent, agentId);
      case 'subagentEnd':
        return this.handleSubagentStop(normEvent, agent, agentId);
      case 'permissionRequest':
        // Handles BOTH the PermissionRequest hook AND the Notification(permission_prompt)
        // hook -- normalizeHookEvent collapses them into one event kind.
        return this.handlePermissionRequest(agent, agentId);
      case 'turnEnd':
        // Handles Stop AND Notification(idle_prompt) -- both normalize to turnEnd.
        // awaitingInput discriminates them: idle_prompt sets it (-> "Waiting for
        // input"), Stop leaves it absent (-> "Done").
        return this.handleStop(agent, agentId, normEvent.awaitingInput === true);
      case 'subagentTurnEnd':
        // Handles TeammateIdle AND TaskCompleted -- both normalize here. The normalized
        // `reason` field discriminates; the team-provider's extractTeammateNameFromEvent(raw)
        // still routes to the specific teammate. (TaskCreated normalizes to null in the provider.)
        if (!this.provider.team) return;
        if (normEvent.reason === 'completed') {
          return this.handleTaskCompleted(event, agentId);
        }
        return this.handleTeammateIdle(event, agent, agentId);
      case 'progress':
        // Not yet consumed by the office visualization. Silently drop.
        return;
    }
  }

  /**
   * Handle SessionEnd: /clear marks pendingClear (SessionStart follows),
   * exit/logout marks agent waiting or triggers cleanup.
   */
  private handleSessionEnd(
    normEvent: Extract<AgentEvent, { kind: 'sessionEnd' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const reason = normEvent.reason;
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason ?? 'unknown'})`,
      );

    // /clear and /resume send SessionEnd then SessionStart. Wait briefly for the follow-up.
    // All other reasons (exit, logout, prompt_input_exit) are final -- despawn immediately.
    const expectsFollowUp = reason === 'clear' || reason === 'resume';

    if (expectsFollowUp) {
      agent.pendingClear = true;
      this.markAgentWaiting(agent, agentId);
      if (debug)
        console.log(
          `[Pixel Agents] Hook: Agent ${agentId} - SessionEnd(reason=${reason}), awaiting possible SessionStart`,
        );
      // Safety net: if SessionStart never arrives, clean up the zombie agent
      setTimeout(() => {
        if (agent.pendingClear) {
          agent.pendingClear = false;
          this.lifecycleCallbacks.onSessionEnd?.(agentId, reason);
        }
      }, SESSION_END_GRACE_MS);
    } else {
      // Immediate cleanup for exit/logout. onSessionEnd → removeTeammates in the
      // ViewProvider cleans up all teammates of this lead at once.
      this.markAgentWaiting(agent, agentId);
      this.lifecycleCallbacks.onSessionEnd?.(agentId, reason ?? 'unknown');
    }
  }

  /**
   * Handle PreToolUse: instantly mark agent as active (cancel waiting state).
   * JSONL still handles detailed tool tracking (toolId, status text, webview messages).
   * This just ensures the character starts animating without waiting for the 500ms JSONL poll.
   */
  private handlePreToolUse(
    normEvent: Extract<AgentEvent, { kind: 'toolStart' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const toolName = normEvent.toolName;
    const toolInput = (normEvent.input as Record<string, unknown> | undefined) ?? {};
    const status = this.provider.formatToolStatus(toolName, toolInput);
    const hookToolId = normEvent.toolId || `hook-${Date.now()}`;

    // Track for PostToolUse/SubagentStart correlation (always, even if suppressed below).
    // currentHookIsTeammateSpawn is the authoritative teammate-vs-subagent discriminator.
    // It is NOT cleared in PostToolUse to survive the PostToolUse-before-SubagentStart race.
    agent.currentHookToolId = hookToolId;
    agent.currentHookToolName = toolName;
    agent.currentHookIsTeammateSpawn =
      this.provider.team?.isTeammateSpawnCall(toolName, toolInput) ?? false;

    // When a lead has inline teammates, hook tool events are ambiguous (could be
    // from the lead or any teammate -- they share session_id). Suppress hook-originated
    // tool display on the lead. Both lead and teammate tools display via JSONL polling.
    if (hasInlineTeammates(agentId, this.agents)) return;

    // Cancel waiting, mark active
    cancelWaitingTimer(agentId, this.waitingTimers);
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.hadToolsInTurn = true;

    if (agent.hooksOnly) {
      agent.activeToolIds.add(hookToolId);
      agent.activeToolStatuses.set(hookToolId, status);
      agent.activeToolNames.set(hookToolId, toolName);
    }

    // Send tool start + active state to webview (instant, no 500ms JSONL delay).
    // Skip for Task/Agent tools — their sub-agent characters need the stable JSONL
    // tool ID (not the transient hook ID) so that SubagentStop/tool_result cleanup
    // can find and remove them. JSONL handles agentToolStart (with runInBackground)
    // for these tools.
    if (toolName !== 'Task' && toolName !== 'Agent') {
      this.agents.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId: hookToolId,
        status,
        toolName,
      });
    }
    this.agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'active',
    });
  }

  /**
   * Handle PostToolUse: no action needed. JSONL handles tool_result processing.
   * Stop hook handles the idle transition. This is here for completeness and
   * to serve as a confirmation event for pending external sessions.
   */
  private handlePostToolUse(
    normEvent: Extract<AgentEvent, { kind: 'toolEnd' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    const toolId = normEvent.toolId === 'current' ? agent.currentHookToolId : normEvent.toolId;
    if (toolId) {
      // Suppress tool display when lead has inline teammates (see handlePreToolUse)
      if (!hasInlineTeammates(agentId, this.agents)) {
        this.agents.broadcast({
          type: 'agentToolDone',
          id: agentId,
          toolId,
        });
      }
      if (agent.hooksOnly) {
        agent.activeToolIds.delete(toolId);
        agent.activeToolStatuses.delete(toolId);
        agent.activeToolNames.delete(toolId);
        if (agent.activeToolIds.size === 0) {
          // Return from reading/tool animation to normal working/typing while
          // the model continues generating, without ending the turn.
          this.agents.broadcast({ type: 'agentToolsClear', id: agentId });
        }
      }
      agent.currentHookToolId = undefined;
      agent.currentHookToolName = undefined;
    }
  }

  // NOTE: PostToolUseFailure used to have its own handler. The behavior was identical
  // to PostToolUse (emit agentToolDone, clear currentHookToolId). Both now normalize to
  // the 'toolEnd' AgentEvent kind and share handlePostToolUse.

  /**
   * Handle SubagentStart: notify webview that a sub-agent is spawning.
   *
   * For Agent Teams teammates (Agent tool with run_in_background), triggers
   * teammate discovery via lifecycle callback -- teammates become independent
   * agents with their own JSONL file watching.
   *
   * For old-style Task/Agent subagents (inline, no run_in_background), creates
   * the child character immediately via hooks without waiting for JSONL polling.
   */
  private handleSubagentStart(
    normEvent: Extract<AgentEvent, { kind: 'subagentStart' }>,
    event: HookEvent,
    sessionId: string,
    agent: AgentState,
    agentId: number,
  ): void {
    const agentType =
      this.provider.team?.extractTeammateNameFromEvent(event) ?? normEvent.toolName ?? 'unknown';

    // Decide path: teammate spawn vs basic within-turn subagent.
    // Two conditions must BOTH hold for the teammate path:
    //   1. currentHookIsTeammateSpawn === true -- this specific tool call has the
    //      teammate-spawn flag (e.g. Agent with run_in_background=true)
    //   2. agent.teamName set -- JSONL has confirmed this agent is a team lead.
    //      Without this guard, external sessions firing run_in_background=true
    //      for parallel basic subagents would be mis-routed to teammate discovery.
    // Mirrors the same gate used by the periodic scanAllTeammateFiles fallback.
    if (this.provider.team && agent.currentHookIsTeammateSpawn === true && agent.teamName) {
      if (debug)
        console.log(
          `[Pixel Agents] Hook: Agent ${agentId} - SubagentStart: teammate "${agentType}" detected, triggering discovery`,
        );
      this.lifecycleCallbacks.onTeammateDetected?.(agentId, sessionId, agentType);
      return;
    }

    if (!this.provider.team) {
      const parentToolId =
        normEvent.parentToolId === 'current' ? agent.currentHookToolId : normEvent.parentToolId;
      if (!parentToolId) return;
      const subToolId = normEvent.toolId;
      const status = this.provider.formatToolStatus(normEvent.toolName, normEvent.input);
      let subTools = agent.activeSubagentToolIds.get(parentToolId);
      if (!subTools) {
        subTools = new Set();
        agent.activeSubagentToolIds.set(parentToolId, subTools);
      }
      subTools.add(subToolId);
      let subNames = agent.activeSubagentToolNames.get(parentToolId);
      if (!subNames) {
        subNames = new Map();
        agent.activeSubagentToolNames.set(parentToolId, subNames);
      }
      subNames.set(subToolId, normEvent.toolName);
      this.agents.broadcast({
        type: 'subagentToolStart',
        id: agentId,
        parentToolId,
        toolId: subToolId,
        status,
      });
      return;
    }

    // Basic within-turn subagent path: find parent tool ID from activeToolNames.
    // Use only the real JSONL-populated id -- no synthetic fallback here, or we'd
    // double-track parents once JSONL catches up.
    const parentTools = this.getSubagentToolSet();
    let parentToolId: string | undefined;
    for (const [toolId, toolName] of agent.activeToolNames) {
      if (parentTools.has(toolName)) {
        parentToolId = toolId;
        break;
      }
    }
    if (!parentToolId) return; // JSONL will handle it via agent_progress tool_use

    // Create child sub-agent character immediately (same as old behavior).
    const subToolId = `hook-sub-${agentType}-${Date.now()}`;
    const status = `Subtask: ${agentType}`;

    // Track sub-agent
    let subTools = agent.activeSubagentToolIds.get(parentToolId);
    if (!subTools) {
      subTools = new Set();
      agent.activeSubagentToolIds.set(parentToolId, subTools);
    }
    subTools.add(subToolId);

    let subNames = agent.activeSubagentToolNames.get(parentToolId);
    if (!subNames) {
      subNames = new Map();
      agent.activeSubagentToolNames.set(parentToolId, subNames);
    }
    subNames.set(subToolId, agentType);

    this.agents.broadcast({
      type: 'subagentToolStart',
      id: agentId,
      parentToolId,
      toolId: subToolId,
      status,
    });
  }

  /**
   * Handle SubagentStop: notify webview that a sub-agent finished.
   *
   * For Agent Teams teammates: marks all teammate agents as waiting (they're
   * independent agents, not sub-agent characters to destroy).
   *
   * For old-style Task subagents: removes the child character from the office.
   */
  private handleSubagentStop(
    normEvent: Extract<AgentEvent, { kind: 'subagentEnd' }>,
    agent: AgentState,
    agentId: number,
  ): void {
    if (!this.provider.team) {
      const parentToolId =
        normEvent.parentToolId === 'current' ? agent.currentHookToolId : normEvent.parentToolId;
      if (!parentToolId) return;
      agent.activeSubagentToolIds.delete(parentToolId);
      agent.activeSubagentToolNames.delete(parentToolId);
      this.agents.broadcast({ type: 'subagentClear', id: agentId, parentToolId });
      return;
    }
    // Check if this agent has inline teammates (independent agents with leadAgentId).
    // Just mark them waiting -- SubagentStop fires per-task-iteration; teammates may
    // sit idle for minutes between lead requests before being re-invoked.
    // Actual removal is driven by:
    //   - Periodic team config polling (scanTeamConfigsForRemovals) -- teammate
    //     removed when no longer in team config members list
    //   - SessionEnd on lead (removeTeammates in ViewProvider)
    const inlineTeammates = getInlineTeammates(agentId, this.agents);
    if (inlineTeammates.length > 0) {
      if (debug)
        console.log(
          `[Pixel Agents] Hook: Agent ${agentId} - SubagentStop: marking inline teammates as waiting`,
        );
      for (const [id, a] of inlineTeammates) {
        this.markAgentWaiting(a, id);
      }
      return;
    }

    // Old-style within-turn subagents: find a parent tool that actually has tracked
    // sub-agents. The `activeSubagentToolIds.has(toolId)` gate below prevents us
    // from picking a subagent-spawning parent that already had its sub-agents
    // cleared in the same turn.
    const subagentParentTools = this.getSubagentToolSet();
    let parentToolId: string | undefined;
    for (const [toolId, toolName] of agent.activeToolNames) {
      if (subagentParentTools.has(toolName) && agent.activeSubagentToolIds.has(toolId)) {
        parentToolId = toolId;
        break;
      }
    }
    if (!parentToolId) return; // JSONL will handle it via agent_progress tool_result

    agent.activeSubagentToolIds.delete(parentToolId);
    agent.activeSubagentToolNames.delete(parentToolId);
    this.agents.broadcast({
      type: 'subagentClear',
      id: agentId,
      parentToolId,
    });
  }

  /** Handle PermissionRequest: cancel heuristic timer, show permission bubble on agent + sub-agents. */
  private handlePermissionRequest(agent: AgentState, agentId: number): void {
    // When lead has inline teammates, route permission to the teammates instead.
    // The hook fires on the lead's session_id but the permission is for a teammate.
    const inlineTeammates = getInlineTeammates(agentId, this.agents);
    if (inlineTeammates.length > 0) {
      for (const [id, a] of inlineTeammates) {
        cancelPermissionTimer(id, this.permissionTimers);
        a.permissionSent = true;
        this.agents.broadcast({ type: 'agentToolPermission', id });
      }
      return;
    }

    cancelPermissionTimer(agentId, this.permissionTimers);
    agent.permissionSent = true;
    this.agents.broadcast({
      type: 'agentToolPermission',
      id: agentId,
    });
    // Also notify any sub-agents with active tools
    for (const parentToolId of agent.activeSubagentToolNames.keys()) {
      this.agents.broadcast({
        type: 'subagentToolPermission',
        id: agentId,
        parentToolId,
      });
    }
  }

  /** Handle Stop: Claude finished responding, mark agent as waiting. */
  private handleStop(agent: AgentState, agentId: number, awaitingInput = false): void {
    this.markAgentWaiting(agent, agentId, awaitingInput);
  }

  /**
   * Handle TeammateIdle: teammate signaled it's idle and available for work.
   * Routes to the specific teammate if identifiable by teammate_name, otherwise
   * marks all inline teammates of this lead as waiting.
   * Fallback: if the agent has no inline teammates, mark the agent itself.
   */
  private handleTeammateIdle(event: HookEvent, agent: AgentState, agentId: number): void {
    const teammateName = this.provider.team?.extractTeammateNameFromEvent(event);
    const inlineTeammates = getInlineTeammates(agentId, this.agents);

    if (inlineTeammates.length === 0) {
      // No inline teammates — treat as a completed turn for this agent.
      this.markAgentWaiting(agent, agentId);
      return;
    }

    // Match by agentName if provider extracted a name from the event
    if (teammateName) {
      const match = inlineTeammates.find(([, a]) => a.agentName === teammateName);
      if (match) {
        const [id, a] = match;
        if (debug)
          console.log(
            `[Pixel Agents] Hook: TeammateIdle "${teammateName}" -> teammate Agent ${id}`,
          );
        this.markAgentWaiting(a, id);
        return;
      }
    }

    // Fallback: mark all inline teammates as waiting
    if (debug)
      console.log(
        `[Pixel Agents] Hook: TeammateIdle (no teammate_name match) -> marking ${inlineTeammates.length} teammate(s) done`,
      );
    for (const [id, a] of inlineTeammates) {
      this.markAgentWaiting(a, id);
    }
  }

  /**
   * Handle TaskCompleted: a teammate marked its task done.
   * Routes to the specific teammate when identifiable, marking it waiting instantly.
   */
  private handleTaskCompleted(event: HookEvent, agentId: number): void {
    const taskSubject =
      typeof event.task_subject === 'string'
        ? event.task_subject
        : typeof event.subject === 'string'
          ? event.subject
          : '';
    const teammateName = this.provider.team?.extractTeammateNameFromEvent(event);
    if (debug)
      console.log(
        `[Pixel Agents] Hook: Agent ${agentId} - TaskCompleted: ${taskSubject}${teammateName ? ` (teammate_name=${teammateName})` : ''}`,
      );

    const inlineTeammates = getInlineTeammates(agentId, this.agents);
    if (inlineTeammates.length === 0) return;

    // Match by agentName if available, otherwise mark all inline teammates waiting
    if (teammateName) {
      const match = inlineTeammates.find(([, a]) => a.agentName === teammateName);
      if (match) {
        const [id, a] = match;
        this.markAgentWaiting(a, id);
        return;
      }
    }
    for (const [id, a] of inlineTeammates) {
      this.markAgentWaiting(a, id);
    }
  }

  /**
   * Transition agent to waiting state. Clears foreground tools (preserves background
   * agents), cancels timers, and notifies the webview. Same logic as the turn_duration
   * handler in transcriptParser.ts.
   */
  private markAgentWaiting(agent: AgentState, agentId: number, awaitingInput = false): void {
    cancelWaitingTimer(agentId, this.waitingTimers);
    cancelPermissionTimer(agentId, this.permissionTimers);

    // Clear foreground tools, preserve background agents (same logic as turn_duration handler).
    // ALWAYS send agentToolsClear at turn end -- even when activeToolIds is empty by now
    // (because tool_results already processed and removed them). Without this, stale
    // sub-agent characters and permission bubbles from the turn would never clear.
    const parentTools = this.getSubagentToolSet();
    for (const toolId of [...agent.activeToolIds]) {
      if (agent.backgroundAgentToolIds.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      const toolName = agent.activeToolNames.get(toolId);
      agent.activeToolNames.delete(toolId);
      if (toolName && parentTools.has(toolName)) {
        agent.activeSubagentToolIds.delete(toolId);
        agent.activeSubagentToolNames.delete(toolId);
        // A foreground spawn dropped at Stop without a tool_result: stop its
        // shadow watch too, or it lingers until sessionEnd.
        notifyBackgroundAgentCompleted(agentId, toolId);
      }
    }
    this.agents.broadcast({ type: 'agentToolsClear', id: agentId });
    // Re-send background agent tools to restore them after the clear.
    // toolName + runInBackground are REQUIRED: without them the webview can't
    // recognize the re-sent tool as a subagent spawn and never recreates the
    // Subtask sub-character (extractToolName("Subtask: ...") is not a tool).
    // Skip tools whose background agent was promoted to its own character.
    for (const toolId of agent.backgroundAgentToolIds) {
      if (hasPromotedBackgroundAgent(agentId, toolId, this.agents)) continue;
      const status = agent.activeToolStatuses.get(toolId);
      if (status) {
        this.agents.broadcast({
          type: 'agentToolStart',
          id: agentId,
          toolId,
          status,
          toolName: agent.activeToolNames.get(toolId),
          runInBackground: true,
          isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
        });
      }
    }

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    agent.currentHookToolId = undefined;
    this.agents.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
      awaitingInput,
    });
  }

  /** Clean up timers and maps. Called when the extension disposes. */
  dispose(): void {
    this.sessionRouter.dispose();
  }
}
