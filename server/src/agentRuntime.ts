/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import { LIMIT_BREAK_REASONS } from '../../core/src/constants.js';
import type { HookProvider } from '../../core/src/provider.js';
import { createAgentState } from './agentState.js';
import type { AgentStateStore } from './agentStateStore.js';
import { PhoneAlerts, type PhoneAlertsOptions } from './alerts.js';
import type { AnshSources } from './ansh/anshBrain.js';
import { AnshBrain } from './ansh/anshBrain.js';
import { REMOTE_AGENT_TTL_MS, REMOTE_EXPIRY_CHECK_INTERVAL_MS } from './constants.js';
import { DismissalTracker } from './dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  reassignAgentToFile,
  restoredDirectoryName,
  scanForBackgroundAgentFiles,
  scanForTeammateFiles,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setSubagentWatch,
  setTeammateRegisterCallback,
  setTeammateRemovalCallback,
  setTeamProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import { FunServices, getFunServices, setFunServices } from './fun/funServices.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import {
  getInboxTracker,
  InboxTracker,
  type InboxTrackerOptions,
  setInboxTracker,
} from './inbox/inboxTracker.js';
import {
  getLocalSessionWatcher,
  LocalSessionWatcher,
  type LocalSessionWatcherOptions,
  setLocalSessionWatcher,
} from './localSessions.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
import {
  localDateKey,
  ProgressTracker,
  type ProgressTrackerOptions,
} from './progress/progressTracker.js';
import { SessionRouter } from './sessionRouter.js';
import { getSignalsHub, setSignalsHub } from './signals/registry.js';
import { SignalsHub, type SignalsHubOptions } from './signals/signalsHub.js';
import { SubagentWatch } from './subagentWatch.js';
import {
  buildReportData,
  ManagerReports,
  type ManagerReportsOptions,
} from './tasks/managerReports.js';
import {
  defaultManagerDataDir,
  getTaskLedger,
  setTaskLedger,
  TaskLedger,
} from './tasks/taskLedger.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import {
  getProgressTracker,
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
  setProgressTracker,
  setTeamSwitchCallback,
} from './transcriptParser.js';
import { readLatestAiTitle } from './transcriptTitle.js';
import type { AgentState } from './types.js';
import type { UsageMeterOptions } from './usage/usageMeter.js';
import { getUsageMeter, setUsageMeter, UsageMeter } from './usage/usageMeter.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

export interface AgentRuntimeOptions {
  /** Daily-totals location and clock. Default: ~/.pixel-agents/daily when the
   *  store has a StateAdapter, in memory when it has none. */
  progress?: ProgressTrackerOptions;
  /** Session list, clock and home dir for the LocalSessionWatcher (tests).
   *  Default: `claude agents --json`, Date.now, os.homedir. */
  localSessions?: LocalSessionWatcherOptions;
  /** Config file, fetch and clock for the phone alerts (tests). Default:
   *  ~/.pixel-agents/alerts.json, global fetch, Date.now. */
  alerts?: PhoneAlertsOptions;
  /** The Manager's task log and daily reports (tasks/). Present: both live
   *  under `dataDir` (default ~/.pixel-agents) -- the standalone CLI passes {}.
   *  Absent: the task log is kept in memory and no report is written, which is
   *  what the VS Code adapter gets: two surfaces writing one day's task file
   *  would clobber each other's tasks. Clock, claude runner and env: tests. */
  manager?: Omit<ManagerReportsOptions, 'dataDir'> & { dataDir?: string };
  /** Token files, notice board runner and clock for the useful signals (tests).
   *  Default: ~/.pixel-agents/tokens and `gh` with a StateAdapter, in memory
   *  and no board without one. */
  signals?: SignalsHubOptions;
  /** Clock and transcript reader for the inbox tracker (tests). */
  inbox?: InboxTrackerOptions;
  /** The usage meter's saved-report file and clock. Default:
   *  ~/.pixel-agents/usage.json with a StateAdapter, in memory without one. */
  usage?: UsageMeterOptions;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state. PathSet (not Set) so a transcript adopted via hooks is still
  // recognized as known when a scanner rebuilds the path from the workspace folder
  // -- the two spellings differ by drive-letter case on Windows.
  readonly knownJsonlFiles = new PathSet();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private remoteExpiryTimer: ReturnType<typeof setInterval> | null = null;

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  /** Shadow-store watcher for unnamed background spawns (sub-agents). */
  readonly subagentWatch: SubagentWatch;
  /** Stage track per agent + done-today totals (see progress/progressTracker.ts). */
  readonly progress: ProgressTracker;
  /** Trouble, loops, timeline, tokens, notice board (see signals/signalsHub.ts). */
  readonly signals: SignalsHub;
  /** Keeps every open local session on the board and puts idle ones to sleep
   *  (see localSessions.ts). Polls only once started -- the standalone CLI does. */
  readonly localSessions: LocalSessionWatcher;
  /** ntfy phone alerts for agents left waiting on the user (see alerts.ts).
   *  Checks only once started -- the standalone CLI does. */
  readonly alerts: PhoneAlerts;
  /** The Manager's task log: one task per session title period (tasks/taskLedger.ts). */
  readonly tasks: TaskLedger;
  /** The Manager's daily report (tasks/managerReports.ts). Scheduled only once
   *  started -- the standalone CLI does. */
  readonly reports: ManagerReports;
  /** Ansh's brain: the user's character thinks about the office and comments
   *  (ansh/anshBrain.ts). Looks only once started -- the standalone CLI does. */
  readonly ansh: AnshBrain;
  /** What the office looks like beyond the store -- waits, failures, sleep,
   *  today's totals. Read by Ansh's brain and the office MCP server (mcp/). */
  readonly officeSources: AnshSources;
  /** Needs-you inbox: Open-in-Claude links + usage-limit pauses (inbox/). */
  readonly inbox: InboxTracker;
  /** Week wall totals + weather (see fun/funServices.ts). Weather polls only once started. */
  readonly fun: FunServices;
  /** The subscription's 5-hour / 7-day usage for the server room's meter (usage/). */
  readonly usage: UsageMeter;
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: HookProvider,
    options: AgentRuntimeOptions = {},
  ) {
    // Both surfaces set a StateAdapter before building the runtime. A bare store
    // (tests) persists nothing else either, so its daily totals stay in memory
    // rather than landing in whatever home directory the process has.
    const progressOptions = options.progress ?? (store.getAdapter() ? {} : { dailyDir: null });
    this.progress = new ProgressTracker(store, progressOptions);
    this.signals = new SignalsHub(
      store,
      this.progress,
      options.signals ?? (store.getAdapter() ? {} : { tokensDir: null, noticeBoard: null }),
    );
    setSignalsHub(this.signals);
    this.fun = new FunServices(store, {
      dailyDir: progressOptions.dailyDir,
      now: progressOptions.now,
    });
    setFunServices(this.fun);
    this.localSessions = new LocalSessionWatcher(
      store,
      {
        adopt: (sessionId, transcriptPath, cwd) =>
          this.adoptListedSession(sessionId, transcriptPath, cwd),
        remove: (id) => this.removeEndedSession(id),
      },
      options.localSessions,
    );
    setLocalSessionWatcher(this.localSessions);
    this.alerts = new PhoneAlerts(store, this.progress, options.alerts);
    const { manager } = options;
    const managerDataDir = manager ? (manager.dataDir ?? defaultManagerDataDir()) : null;
    this.tasks = new TaskLedger(store, this.progress, {
      dataDir: managerDataDir,
      now: manager?.now,
    });
    setTaskLedger(this.tasks);
    this.reports = new ManagerReports(store, this.tasks, this.alerts, {
      ...manager,
      dataDir: managerDataDir,
    });
    this.officeSources = {
      waitingSinceOf: (id) => this.progress.waitingSinceOf(id),
      failuresOf: (id) => {
        for (const m of this.signals.snapshot()) {
          if (m.type === 'agentTrouble' && m.id === id && typeof m.failures === 'number') {
            return m.failures;
          }
        }
        return 0;
      },
      isSleeping: (id) => this.localSessions.isSleeping(id),
      onLimitBreak: (id) => LIMIT_BREAK_REASONS.includes(this.inbox.limitReasonOf(id) ?? ''),
      todayTasks: () => {
        const date = localDateKey((manager?.now ?? Date.now)());
        const { done, open, waiting } = buildReportData(date, this.tasks.tasksFor(date)).totals;
        return { done, open, waiting };
      },
      todayStats: () => {
        for (const m of this.progress.snapshot()) {
          if (m.type === 'dailyStats') return { prs: m.prs.length, pushes: m.pushes.length };
        }
        return { prs: 0, pushes: 0 };
      },
    };
    this.ansh = new AnshBrain(store, this.officeSources, {
      ...manager,
      dataDir: managerDataDir,
    });
    this.inbox = new InboxTracker(store, options.inbox);
    setInboxTracker(this.inbox);
    this.usage = new UsageMeter(store, options.usage ?? (store.getAdapter() ? {} : { file: null }));
    setUsageMeter(this.usage);

    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    setProgressTracker(this.progress);
    this.subagentWatch = new SubagentWatch(store);
    setSubagentWatch(this.subagentWatch);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));
    // New-style teammates run their own sessions; registering routes their hook
    // events (PreToolUse, Stop, SessionEnd) directly to the teammate agent.
    setTeammateRegisterCallback((sessionId, agentId) => this.registerAgent(sessionId, agentId));
    // Background spawns (teams OFF): classify by sidecar name on spawn (named
    // -> teammate character, unnamed -> shadow-watched sub-agent), remove when
    // the completion queue-operation lands on the lead.
    setBackgroundAgentDetectedCallback((leadId) => {
      scanForBackgroundAgentFiles(
        leadId,
        this.store,
        this.store.nextAgentId,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        undefined,
      );
    });
    setBackgroundAgentCompletedCallback((leadId, toolUseId) => {
      for (const [id, agent] of this.store) {
        if (agent.leadAgentId === leadId && agent.spawnToolUseId === toolUseId) {
          this.removeTeammate(id, 'background-complete');
          break;
        }
      }
      // Unnamed spawns live in the shadow store; the webview sub-character is
      // cleared by the lead-side queue-op subagentClear, not by this call.
      this.subagentWatch.removeBySpawn(leadId, toolUseId);
    });
    // A resumed lead that spawns again belongs to a freshly minted implicit
    // team; its previous team's teammates are defunct. Promoted anonymous
    // background agents (leadAgentId but no teamName) are left untouched.
    setTeamSwitchCallback((leadId, previousTeamName) => {
      const stale = [...this.store].filter(
        ([, a]) => a.leadAgentId === leadId && a.teamName === previousTeamName,
      );
      for (const [id] of stale) {
        this.removeTeammate(id, 'team-switch');
      }
    });

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
      this.progress,
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd, remote) => {
        if (remote) {
          // Relayed from another machine: its relay key is the opt-in, so Watch All
          // Sessions doesn't apply, and its transcript isn't on this disk.
          adoptExternalSessionFromHook(
            sessionId,
            undefined,
            cwd,
            this.knownJsonlFiles,
            this.store.nextAgentId,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
            (agent) => this.registerAgent(agent.sessionId, agent.id),
            remote,
          );
          return;
        }
        const before = new Set(this.store.keys());
        this.adoptLocalSession(sessionId, transcriptPath, cwd, false);
        // A hook-adopted session the session list never shows is headless.
        for (const id of this.store.keys()) {
          if (!before.has(id)) this.localSessions.noteHookAdoption(id);
        }
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        // Covers real team leads AND leads of background teammates (which
        // have children but no teamName). No-op when childless.
        this.removeTeammates(agentId);
        // Unnamed background spawns die with their lead's session too.
        this.subagentWatch.removeByLead(agentId);
        if (agent.isExternal) {
          this.unregisterAgent(agent.sessionId);
          this.removeAgent(agentId);
        }
      },
    });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Local session adoption ──

  /**
   * Adopt a session running on this machine: as a teammate when its transcript
   * names a tracked lead's team, else as an external agent. A hook-detected
   * session needs its project tracked or Watch All Sessions on; one the
   * open-session list names (`anyProject`) is adopted wherever it runs -- having
   * every open session on the board is that list's purpose.
   */
  private adoptLocalSession(
    sessionId: string,
    transcriptPath: string | undefined,
    cwd: string,
    anyProject: boolean,
  ): void {
    const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
    // Teammate session of a tracked lead? Attach it as a teammate character
    // instead of adopting a generic external agent -- and regardless of the
    // Watch All Sessions setting: tracking the lead is the opt-in for its
    // team. (Newer harnesses run every spawned agent as an independent
    // top-level session that fires its own hooks.)
    if (transcriptPath) {
      const teamMeta = this.provider.team?.getTeamMetadataForSession(transcriptPath);
      if (teamMeta?.teamName && teamMeta.agentName) {
        for (const [leadId, lead] of this.store) {
          if (lead.teamName !== teamMeta.teamName || lead.leadAgentId !== undefined) continue;
          console.log(
            `[Pixel Agents] Hook: session ${sessionId.slice(0, 8)}... is teammate "${teamMeta.agentName}" of Agent ${leadId}, attaching`,
          );
          scanForTeammateFiles(
            lead.projectDir,
            lead.sessionId,
            leadId,
            this.store.nextAgentId,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
            undefined,
          );
          break;
        }
        // Done only if discovery actually adopted this transcript. Old-style
        // tmux teammates (non-UUID transcript names outside discovery's scan)
        // fall through to normal external adoption and self-identify from
        // their record tags.
        for (const a of this.store.values()) {
          if (pathsMatch(a.jsonlFile, transcriptPath)) return;
        }
      }
    }
    if (!anyProject && !isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) {
      console.log(
        `[Pixel Agents] Hook: external session ${sessionId.slice(0, 8)}... not adopted ` +
          `(project untracked, Watch All Sessions off)`,
      );
      return;
    }
    adoptExternalSessionFromHook(
      sessionId,
      transcriptPath,
      cwd,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      (agent) => this.registerAgent(agent.sessionId, agent.id),
    );
  }

  /** LocalSessionHost.adopt: the id of the agent adopting `transcriptPath`
   *  created, or undefined when it created none (dismissed, already tracked). */
  private adoptListedSession(
    sessionId: string,
    transcriptPath: string,
    cwd: string,
  ): number | undefined {
    const before = new Set(this.store.keys());
    this.adoptLocalSession(sessionId, transcriptPath, cwd, true);
    for (const [id, agent] of this.store) {
      if (!before.has(id) && pathsMatch(agent.jsonlFile, transcriptPath)) return id;
    }
    return undefined;
  }

  /** LocalSessionHost.remove: the session's process ended without a SessionEnd,
   *  so end it the way one would (see onSessionEnd) -- its teammates and
   *  sub-agents go with it, and its transcript is dismissed so no scanner
   *  re-adopts it. */
  private removeEndedSession(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;
    this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    this.removeTeammates(id);
    this.subagentWatch.removeByLead(id);
    this.unregisterAgent(agent.sessionId);
    this.removeAgent(id);
  }

  /** Start keeping every open local session on the board (standalone only). */
  startLocalSessionWatch(): void {
    this.localSessions.start();
  }

  stopLocalSessionWatch(): void {
    this.localSessions.stop();
  }

  /** Start the phone alerts (standalone only); off until alerts.json exists. */
  startPhoneAlerts(): void {
    this.alerts.start();
  }

  /** Start the Manager's 19:00 daily report (standalone only). */
  startManagerReports(): void {
    this.reports.start();
  }

  /** Start Ansh's brain (standalone only). */
  startAnshBrain(): void {
    this.ansh.start();
  }

  /** Start polling the weather for the office windows (standalone only; needs the network). */
  startWeather(): void {
    this.fun.weather.start();
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  /** Remove a single teammate agent. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    // Background teammates (spawnToolUseId set) share the LEAD's session id;
    // unregistering it would knock the lead itself out of the session router.
    if (!agent.spawnToolUseId) {
      this.unregisterAgent(agent.sessionId);
    }
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
    if (agent.leadAgentId !== undefined) {
      this.demoteLeadIfTeamEmpty(agent.leadAgentId);
    }
  }

  /** Drop the LEAD badge when the last teammate leaves. teamName is kept: it
   *  still routes discovery of late-arriving teammates of the same generation
   *  (and linkTeammates / the derived-team path re-badge on the next spawn). */
  private demoteLeadIfTeamEmpty(leadId: number): void {
    const lead = this.store.get(leadId);
    if (!lead || !lead.isTeamLead) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId) return;
    }
    lead.isTeamLead = undefined;
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: leadId,
      teamName: lead.teamName,
      agentName: lead.agentName,
      isTeamLead: undefined,
      leadAgentId: lead.leadAgentId,
    });
    this.store.persist();
  }

  /**
   * Close an agent the user (or its process) ended: its Teammates and watched
   * Sub-agents go with it, and its transcript is dismissed so no scanner
   * re-adopts it. Children first — once the Lead is gone, nothing can find
   * them (a later sessionEnd resolves no agent).
   */
  closeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;
    this.removeTeammates(id);
    this.subagentWatch.removeByLead(id);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    this.removeAgent(id);
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (!agent.spawnToolUseId) {
          this.unregisterAgent(agent.sessionId);
        }
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
    this.remoteExpiryTimer = setInterval(
      () => this.expireRemoteAgents(),
      REMOTE_EXPIRY_CHECK_INTERVAL_MS,
    );
    // Both surfaces start this check: the signals' timers (stall check, gh polls) ride along.
    this.signals.start();
  }

  /** Remove remote agents with no event for REMOTE_AGENT_TTL_MS. */
  expireRemoteAgents(now = Date.now()): void {
    for (const [id, agent] of [...this.store]) {
      if (!agent.remoteSource || now - agent.lastDataAt <= REMOTE_AGENT_TTL_MS) continue;
      console.log(
        `[Pixel Agents] Agent ${id} - remote session from ${agent.remoteSource.label} silent, removing`,
      );
      this.unregisterAgent(agent.sessionId);
      this.removeAgent(id);
    }
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      // Background-spawn children (a leadAgentId but no teamName) are derived
      // state: the 1s scan re-materializes them from sidecars while their spawn
      // is live. Restoring them directly would resurrect immortal characters
      // (also skips stale entries written by older builds that persisted them).
      if (p.leadAgentId !== undefined && !p.teamName) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent = createAgentState({
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
        // Live spawn ids survive the restart so the 1s scan can re-adopt the
        // spawns' transcripts and the completion queue-op still matches.
        backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
        // The transcript's own cwd outranks the persisted label, which older
        // builds guessed from the encoded project dir ("automation" for
        // hobbyfi-blog-automation); the next persist writes the corrected one.
        directoryName: restoredDirectoryName(p.jsonlFile) ?? p.directoryName ?? p.folderName,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
        palette: p.palette,
        hueShift: p.hueShift,
        // Read before the agent is announced, so agentCreated carries it.
        title: readLatestAiTitle(p.jsonlFile),
      });

      assignPaletteIfNeeded(agent, this.store);
      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    // First, so the removals below are not read as dismissals of open sessions.
    this.localSessions.dispose();
    if (getLocalSessionWatcher() === this.localSessions) setLocalSessionWatcher(null);
    // Also before the removals: shutting down ends no session, so it closes no task.
    this.reports.dispose();
    this.ansh.dispose();
    this.tasks.dispose();
    if (getTaskLedger() === this.tasks) setTaskLedger(null);
    this.alerts.dispose();
    this.hookEventHandler.dispose();
    this.subagentWatch.dispose();
    this.progress.dispose();
    if (getProgressTracker() === this.progress) setProgressTracker(null);
    this.signals.dispose();
    if (getSignalsHub() === this.signals) setSignalsHub(null);
    this.inbox.dispose();
    if (getInboxTracker() === this.inbox) setInboxTracker(null);
    this.fun.dispose();
    if (getFunServices() === this.fun) setFunServices(null);
    this.usage.dispose();
    if (getUsageMeter() === this.usage) setUsageMeter(null);

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
    if (this.remoteExpiryTimer) {
      clearInterval(this.remoteExpiryTimer);
      this.remoteExpiryTimer = null;
    }

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
