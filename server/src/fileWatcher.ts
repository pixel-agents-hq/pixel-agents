/**
 * Session Detection: Dual-Mode Architecture
 *
 * HOOKS MODE (preferred): Claude Code Hooks API delivers instant, reliable events
 * for session lifecycle (SessionStart, SessionEnd, Stop, PermissionRequest, etc.).
 * When hooks work, heuristic scanners and timers are suppressed. The hookDelivered
 * flag per agent and hooksEnabledRef globally control the switch.
 *
 * HEURISTIC MODE (fallback): For environments without hooks (other providers,
 * hooks disabled, older Claude versions). Uses:
 * - Per-agent 500ms JSONL polling for tool activity and /clear detection
 * - 1s main scanner for terminal adoption
 * - 3s external scanner for external session detection
 * - 30s stale check for orphaned external agents
 * - Multiple dismissal systems to prevent re-adoption races
 *
 * JSONL POLLING (always active): readNewLines + processTranscriptLine run in both
 * modes. They provide tool content (status text, animations) that hooks don't carry.
 * Only their timer logic (permission 7s, text-idle 5s) is suppressed by hookDelivered.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import type { HookProvider } from '../../core/src/provider.js';
import type { TeamProvider } from '../../core/src/teamProvider.js';
import type { ITerminalAdapter } from '../../core/src/terminalAdapter.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CLEAR_IDLE_THRESHOLD_MS,
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
  GLOBAL_SCAN_ACTIVE_MIN_SIZE,
  PROJECT_SCAN_INTERVAL_MS,
} from './constants.js';
import type { DismissalTracker } from './dismissalTracker.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Dismissal tracker instance. Set once at startup via setDismissalTracker().
 *  Replaces the former module-global dismissedJsonlFiles, clearDismissedFiles,
 *  seededMtimes, and pendingClearFiles Maps/Sets. */
let dismissalTracker: DismissalTracker | null = null;

/** Register the DismissalTracker instance. Called from PixelAgentsViewProvider at startup. */
export function setDismissalTracker(tracker: DismissalTracker): void {
  dismissalTracker = tracker;
}

/** Get the active DismissalTracker (for PixelAgentsViewProvider direct access). */
export function getDismissalTracker(): DismissalTracker | null {
  return dismissalTracker;
}

/** Terminal adapter for matching terminals to agents. Set once at startup. */
let terminalAdapter: ITerminalAdapter | null = null;

/** Register the terminal adapter (VS Code terminals, standalone = null). */
export function setTerminalAdapter(adapter: ITerminalAdapter): void {
  terminalAdapter = adapter;
}

/** Agent removal callback. Injected by PixelAgentsViewProvider to avoid a
 *  server/src/ → src/ back-import on agentManager.ts. The ViewProvider closure
 *  captures the store and timer Maps, so only the agent ID is needed. */
let agentRemovalCallback: ((id: number) => void) | null = null;

/** Register the agent removal callback. Called by PixelAgentsViewProvider. */
export function setAgentRemovalCallback(cb: typeof agentRemovalCallback): void {
  agentRemovalCallback = cb;
}

/** Dependencies for per-agent /clear detection in readNewLines polling.
 *  Set once by ensureProjectScan; used by startFileWatching's poll loop. */
let clearDetectionDeps: {
  projectDir: string;
  knownJsonlFiles: Set<string>;
  activeAgentIdRef: { current: number | null };
  fileWatchers: Map<number, fs.FSWatcher>;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  persistAgents: () => void;
} | null = null;

export function startFileWatching(
  agentId: number,
  _filePath: string,
  agents: AgentStateStore,
  _fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  // Single polling approach: reliable on all platforms (macOS, Linux, WSL2, Windows).
  // Previously used triple-redundant fs.watch + fs.watchFile + setInterval, but
  // fs.watch is unreliable on macOS/WSL2 and the redundancy created 3 timers per
  // agent doing synchronous I/O. The manual poll at 500ms is fast enough for a
  // pixel art visualization and works everywhere.
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      return;
    }
    const agent = agents.get(agentId)!;
    const prevOffset = agent.fileOffset;
    readNewLines(agentId, agents, waitingTimers, permissionTimers);

    // HEURISTIC FALLBACK: Per-agent /clear detection (skipped when hooks handle sessions).
    // When hooks are active, SessionEnd+SessionStart handle /clear reliably.
    if (
      !agent.hookDelivered &&
      clearDetectionDeps &&
      agent.fileOffset === prevOffset &&
      agent.terminalRef &&
      !agent.isExternal &&
      ![...agents.values()].some((a) => a.isExternal) &&
      agent.linesProcessed > 0 &&
      clearDetectionDeps.activeAgentIdRef.current === agentId &&
      Date.now() - agent.lastDataAt > CLEAR_IDLE_THRESHOLD_MS
    ) {
      const deps = clearDetectionDeps;
      try {
        const dirFiles = fs
          .readdirSync(deps.projectDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(deps.projectDir, f));
        // Find the first untracked, non-dismissed file NOT already in knownJsonlFiles.
        // knownJsonlFiles blocks seeded files (startup) and adopted files.
        // dismissedJsonlFiles blocks old files from previous /clears.
        // The main scanner does NOT add non-adopted files to knownJsonlFiles,
        // so /clear files remain findable here.
        for (const file of dirFiles) {
          if (deps.knownJsonlFiles.has(file)) continue;
          if (dismissalTracker!.isDismissed(file)) continue;
          let tracked = false;
          for (const a of agents.values()) {
            if (a.jsonlFile === file) {
              tracked = true;
              break;
            }
          }
          if (tracked) continue;
          // Content-based /clear detection: only claim files with the /clear command
          // record. Dropped "last-prompt" check because it also appears in --resume
          // sessions. "/clear</command-name>" is specific to /clear (~1.5KB in file).
          try {
            const buf = Buffer.alloc(8192);
            const fd = fs.openSync(file, 'r');
            const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
            fs.closeSync(fd);
            if (!buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) continue;
          } catch {
            continue;
          }
          // Found a /clear file (has last-prompt) → claim it
          deps.knownJsonlFiles.add(file);
          console.log(
            `[Pixel Agents] Watcher: Agent ${agentId} - /clear detected, reassigning to ${path.basename(file)}`,
          );
          reassignAgentToFile(
            agentId,
            file,
            agents,
            deps.fileWatchers,
            deps.pollingTimers,
            deps.waitingTimers,
            deps.permissionTimers,
            deps.persistAgents,
          );
          break; // Only claim one file per poll
        }
      } catch {
        /* ignore dir read errors */
      }
    }
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export function readNewLines(
  agentId: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    // Cap single read at 64KB to prevent blocking on massive JSONL dumps.
    // Remaining data will be picked up on the next poll cycle.
    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      // New data arriving — cancel timers (data flowing means agent is still active).
      // When hooks are active, don't clear permission state here — the hook gave us a
      // definitive signal that permission is needed. Only a new user prompt or tool_result
      // (processed in transcriptParser) should clear it.
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent && !agent.hookDelivered && !agent.leadAgentId) {
        agent.permissionSent = false;
        agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers);
    }
  } catch (e) {
    // ENOENT is expected for hook-detected agents where the JSONL file hasn't been created yet
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.log(`[Pixel Agents] Watcher: Agent ${agentId} - read error: ${e}`);
  }
}

// Track all project directories to scan (supports multi-root workspaces)
const trackedProjectDirs = new Set<string>();

/** Check if a project dir is tracked by the workspace scanner. */
export function isTrackedProjectDir(dir: string): boolean {
  if (trackedProjectDirs.has(dir)) return true;
  // Case-insensitive fallback for Windows (drive letter casing: c:\ vs C:\)
  const resolved = path.resolve(dir).toLowerCase();
  for (const tracked of trackedProjectDirs) {
    if (path.resolve(tracked).toLowerCase() === resolved) return true;
  }
  return false;
}

/**
 * Seed a project directory's known files and register it for periodic scanning.
 * Can be called multiple times with different directories — all will be scanned
 * by the single shared interval timer.
 */
export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  _onAgentCreated?: (agent: AgentState) => void,
  hooksEnabledRef?: { current: boolean },
): void {
  // Set deps for per-agent /clear detection (only on first call)
  if (!clearDetectionDeps) {
    clearDetectionDeps = {
      projectDir,
      knownJsonlFiles,
      activeAgentIdRef,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    };
  }

  // Always seed this directory's files (supports multi-root workspaces).
  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      // Seed all files and track mtime. External scanner detects --resume
      // by comparing current mtime to seeded mtime (changed = new writes).
      knownJsonlFiles.add(f);
      try {
        const stat = fs.statSync(f);
        dismissalTracker!.seedMtime(f, stat.mtimeMs);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  // Register for periodic scanning
  trackedProjectDirs.add(projectDir);

  // Start the shared timer only once
  if (projectScanTimerRef.current) return;
  projectScanTimerRef.current = setInterval(() => {
    // Teammate scanning runs in BOTH modes (hooks + heuristic).
    // In hooks mode, SubagentStart triggers immediate scanning, but the periodic
    // fallback catches teammates that hooks missed (e.g. hook arrived before JSONL).
    scanAllTeammateFiles(
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );

    // Check team config files to detect dismissed teammates (authoritative source
    // of truth for team membership). Removes teammates no longer in members list.
    const toRemove = scanTeamConfigsForRemovals(agents);
    for (const id of toRemove) {
      teammateRemovalCallback?.(id);
    }

    // When hooks are active, SessionStart handles new file detection.
    if (hooksEnabledRef?.current) return;

    for (const dir of trackedProjectDirs) {
      scanForNewJsonlFiles(
        dir,
        knownJsonlFiles,
        activeAgentIdRef,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

export function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  for (const file of files) {
    if (knownJsonlFiles.has(file)) continue;

    // Main scanner does NOT do /clear detection. /clear is handled per-agent
    // in startFileWatching's poll loop (500ms, requires CURRENT terminal focus).
    // Only add to knownJsonlFiles when the file is CLAIMED (terminal adopted).
    // Non-adopted files stay OUT of knownJsonlFiles so the per-agent /clear
    // check can find them when the idle check passes (up to 5s later).

    // Try to adopt the focused terminal (only if it's a Claude-named terminal).
    // Cast to vscode.Terminal because the adapter returns the real object at runtime;
    // the TerminalHandle type is the minimal interface for the adapter contract.
    const activeTerminal = terminalAdapter?.activeTerminal() as vscode.Terminal | undefined;
    if (
      activeTerminal &&
      hookProvider?.terminalNamePrefix &&
      activeTerminal.name.startsWith(hookProvider.terminalNamePrefix)
    ) {
      let owned = false;
      for (const agent of agents.values()) {
        if (agent.terminalRef === activeTerminal) {
          owned = true;
          break;
        }
      }
      if (!owned) {
        knownJsonlFiles.add(file); // Claimed by terminal adoption
        adoptTerminalForFile(
          activeTerminal,
          file,
          projectDir,
          nextAgentIdRef,
          agents,
          activeAgentIdRef,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          persistAgents,
        );
      } else {
        // Active terminal is owned -- scan for untracked Claude-named terminals.
        // Only adopt terminals with TERMINAL_NAME_PREFIX to avoid grabbing
        // pre-existing shells ("zsh", "bash") for /clear files.
        for (const terminal of (terminalAdapter?.allTerminals() ?? []) as vscode.Terminal[]) {
          if (
            !hookProvider?.terminalNamePrefix ||
            !terminal.name.startsWith(hookProvider.terminalNamePrefix)
          )
            continue;
          let owned = false;
          for (const agent of agents.values()) {
            if (agent.terminalRef === terminal) {
              owned = true;
              break;
            }
          }
          if (!owned) {
            knownJsonlFiles.add(file); // Claimed by terminal adoption
            adoptTerminalForFile(
              terminal,
              file,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              persistAgents,
              onAgentCreated,
            );
            break;
          }
        }
      }
    }
  }

  // Clean up orphaned agents whose terminals have been closed (skip external agents)
  for (const [id, agent] of agents) {
    if (agent.isExternal) continue;
    if (agent.terminalRef && agent.terminalRef.exitStatus !== undefined) {
      console.log(`[Pixel Agents] Watcher: Agent ${id} - terminal closed, cleaning up orphan`);
      agentRemovalCallback?.(id);
    }
  }
}

function adoptTerminalForFile(
  terminal: vscode.Terminal,
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const id = nextAgentIdRef.current++;
  const sessionId = path.basename(jsonlFile, '.jsonl');
  // Skip to end of file -- adopted terminals show live activity only, not replay history
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    fileOffset = stat.size;
  } catch {
    /* start from beginning if stat fails */
  }
  const agent: AgentState = {
    id,
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    jsonlFile,
    fileOffset,
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
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  onAgentCreated?.(agent);

  console.log(
    `[Pixel Agents] Watcher: Agent ${id} - adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`,
  );

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

// ── Lead + Teammates support (provider-driven) ──

/** Known teammate JSONL files (prevents re-adoption). */
const knownTeammateFiles = new Set<string>();

/** Callback to remove a teammate agent when detected as dismissed via team config. */
let teammateRemovalCallback: ((teammateAgentId: number) => void) | null = null;

/** Team provider: supplies all CLI-specific paths, parsers, and tool names.
 *  Set once at startup via setTeamProvider(). Module functions assume it's set
 *  by the time they're called. */
let teamProvider: TeamProvider | null = null;

/** Hook provider: supplies non-team capabilities fileWatcher needs (all-session
 *  roots for global discovery, launch command, etc.). Set once at startup. */
let hookProvider: HookProvider | null = null;

/** Register the callback used to remove teammates detected as dismissed via team config polling. */
export function setTeammateRemovalCallback(cb: (teammateAgentId: number) => void): void {
  teammateRemovalCallback = cb;
}

/** Register the TeamProvider that describes the active CLI's Lead+Teammates pattern. */
export function setTeamProvider(provider: TeamProvider): void {
  teamProvider = provider;
}

/** Register the active HookProvider for non-team capabilities (session roots, etc.). */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

/**
 * Scan the provider's teammate transcripts for a given lead session.
 * Each teammate gets its own independent agent (positive ID) with file watching.
 *
 * Called from two paths:
 * 1. Hooks-triggered (immediate): onTeammateDetected callback from SubagentStart
 * 2. Periodic fallback: ensureProjectScan timer (heuristic mode)
 */
export function scanForTeammateFiles(
  projectDir: string,
  sessionId: string,
  parentAgentId: number,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (!teamProvider) return;
  const teammates = teamProvider.discoverTeammates(projectDir, sessionId);

  const parentAgent = agents.get(parentAgentId);

  for (const { jsonlPath: file, teammateName } of teammates) {
    if (knownTeammateFiles.has(file)) continue;

    // Also check if any existing agent already tracks this file
    let alreadyTracked = false;
    for (const a of agents.values()) {
      if (a.jsonlFile === file) {
        alreadyTracked = true;
        break;
      }
    }
    if (alreadyTracked) continue;

    knownTeammateFiles.add(file);

    // Deduplicate by teammate name per parent: if we already have a live agent
    // with the same name for this parent, reassign it to the new JSONL file
    // (Claude may restart a teammate, creating a new .jsonl for the same role).
    let existingTeammate: AgentState | undefined;
    for (const a of agents.values()) {
      if (a.leadAgentId === parentAgentId && a.agentName === teammateName) {
        existingTeammate = a;
        break;
      }
    }
    if (existingTeammate) {
      if (debug)
        console.log(
          `[Pixel Agents] Teammate "${teammateName}" already exists (Agent ${existingTeammate.id}), reassigning to ${path.basename(file)}`,
        );
      // Reassign to new JSONL file -- stop old polling, start new
      const oldTimer = pollingTimers.get(existingTeammate.id);
      if (oldTimer) clearInterval(oldTimer);
      pollingTimers.delete(existingTeammate.id);
      existingTeammate.jsonlFile = file;
      existingTeammate.fileOffset = 0;
      existingTeammate.lineBuffer = '';
      existingTeammate.lastDataAt = Date.now();
      existingTeammate.linesProcessed = 0;
      existingTeammate.isWaiting = false;
      startFileWatching(
        existingTeammate.id,
        file,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
      );
      readNewLines(existingTeammate.id, agents, waitingTimers, permissionTimers);
      continue;
    }

    const id = nextAgentIdRef.current++;
    // Read from start -- teammate JSONL is usually small and we want full tool history
    const agent: AgentState = {
      id,
      sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir,
      jsonlFile: file,
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
      // Keep hookDelivered false: teammates need JSONL-based tool tracking
      // (agentToolStart messages). Permission events are routed from the lead's
      // hooks via handlePermissionRequest forwarding.
      hookDelivered: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      inputTokens: 0,
      outputTokens: 0,
      // Agent Teams fields
      agentName: teammateName,
      leadAgentId: parentAgentId,
      teamName: parentAgent?.teamName,
    };

    agents.set(id, agent);
    persistAgents();

    console.log(
      `[Pixel Agents] Teammate detected: "${teammateName}" (Agent ${id}) for parent Agent ${parentAgentId} (${path.basename(file)})`,
    );

    onAgentCreated?.(agent);

    startFileWatching(
      id,
      file,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
    );
    readNewLines(id, agents, waitingTimers, permissionTimers);
  }
}

/**
 * Scan team config files (via the active TeamProvider) to detect teammate
 * dismissals. A teammate is considered dismissed if:
 *   - The team config no longer lists them in members, OR
 *   - The team config file is missing/unreadable (team dissolved)
 *
 * This is the authoritative source of truth for Agent Teams membership.
 * Returns the IDs of teammates that should be removed.
 */
export function scanTeamConfigsForRemovals(agents: AgentStateStore): number[] {
  const toRemove: number[] = [];
  if (!teamProvider) return toRemove;
  // Group teammates by their teamName for efficient config lookups
  const teammatesByTeam = new Map<string, Array<{ id: number; agent: AgentState }>>();
  for (const [id, agent] of agents) {
    if (agent.leadAgentId === undefined || agent.teamUsesTmux || !agent.teamName) continue;
    let list = teammatesByTeam.get(agent.teamName);
    if (!list) {
      list = [];
      teammatesByTeam.set(agent.teamName, list);
    }
    list.push({ id, agent });
  }

  for (const [teamName, members] of teammatesByTeam) {
    // Provider owns both the read and parse -- returns null on any failure (team dissolved)
    const memberNames = teamProvider.getTeamMembers(teamName);

    for (const { id, agent } of members) {
      if (memberNames === null) {
        toRemove.push(id);
      } else if (agent.agentName && !memberNames.has(agent.agentName)) {
        toRemove.push(id);
      }
    }
  }

  return toRemove;
}

/**
 * Scan all tracked project dirs for teammate JSONL files.
 * Called periodically as a fallback when hooks are disabled.
 */
export function scanAllTeammateFiles(
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  // For each known lead agent, ask the provider to scan for teammate transcripts.
  // CRITICAL: only scan agents that JSONL has confirmed as team leads (teamName set).
  // Without this gate we'd pick up basic subagents' JSONL files (which some CLIs also
  // write to the same teammate directory) and create spurious teammate characters for
  // them when the Agent Teams feature is OFF.
  for (const [agentId, agent] of agents) {
    // Only scan for lead agents (not teammates themselves)
    if (agent.leadAgentId !== undefined) continue;
    if (!agent.sessionId || !agent.projectDir) continue;
    // Gate: basic-mode agents never get teamName set. Real team leads do, via JSONL.
    if (!agent.teamName) continue;

    scanForTeammateFiles(
      agent.projectDir,
      agent.sessionId,
      agentId,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      onAgentCreated,
    );
  }
}

// ── External session support (VS Code extension panel, etc.) ──

/**
 * Adopt an external session detected via hooks (SessionStart for unknown session_id).
 * Thinner wrapper than filesystem-based adoptExternalSession: hooks provide
 * transcript_path and cwd directly, no scanning needed.
 */
export function adoptExternalSessionFromHook(
  sessionId: string,
  transcriptPath: string | undefined,
  cwd: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (transcriptPath) {
    // File-based provider (Claude, Codex): adopt with JSONL file watching
    // Guard: don't adopt if file is already tracked by an agent
    for (const agent of agents.values()) {
      if (agent.jsonlFile === transcriptPath) return;
    }
    // Don't check knownJsonlFiles here -- hooks confirmed this is a real session,
    // and seeded files at startup are in knownJsonlFiles but may become active later.
    if (dismissalTracker!.isDismissed(transcriptPath)) return;
    if (dismissalTracker!.isPermanentlyDismissed(transcriptPath)) return;

    knownJsonlFiles.add(transcriptPath);
    const projectDir = path.dirname(transcriptPath);
    const folderName = folderNameFromProjectDir(path.basename(projectDir));

    adoptExternalSession(
      transcriptPath,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      folderName,
    );

    const adoptedAgent = [...agents.values()].find((a) => a.jsonlFile === transcriptPath);
    if (adoptedAgent && debug) {
      console.log(
        `[Pixel Agents] Hook: Agent ${adoptedAgent.id} - detected external session ${path.basename(transcriptPath)}${adoptedAgent.folderName ? ` (${adoptedAgent.folderName})` : ''}`,
      );
    }
    if (adoptedAgent) {
      adoptedAgent.sessionId = sessionId;
      adoptedAgent.hookDelivered = true;
      onAgentCreated?.(adoptedAgent);
    }
  } else {
    // Hooks-only provider (OpenCode, Copilot): no transcript file, all state from hooks
    const id = nextAgentIdRef.current++;
    const folderName = cwd ? path.basename(cwd) : undefined;
    const agent: AgentState = {
      id,
      sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: cwd,
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
      hookDelivered: true,
      hooksOnly: true,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName,
      inputTokens: 0,
      outputTokens: 0,
    };
    agents.set(id, agent);
    persistAgents();
    if (debug) {
      console.log(
        `[Pixel Agents] Hook: Agent ${id} - detected hooks-only external session${folderName ? ` (${folderName})` : ''}`,
      );
    }
    onAgentCreated?.(agent);
  }
}

function adoptExternalSession(
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  folderName?: string,
): void {
  const id = nextAgentIdRef.current++;
  // Skip to end of file -- only show live activity going forward, not replay history
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    fileOffset = stat.size;
  } catch {
    /* start from beginning if stat fails */
  }
  const agent: AgentState = {
    id,
    sessionId: path.basename(jsonlFile, '.jsonl'),
    terminalRef: undefined,
    isExternal: true,
    projectDir,
    jsonlFile,
    fileOffset,
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
    folderName,
    inputTokens: 0,
    outputTokens: 0,
  };

  agents.set(id, agent);
  persistAgents();

  // Log is emitted by the caller (adoptExternalSessionFromHook or scanExternalDir)
  // to use the correct prefix (Hook: vs Watcher:).

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

/**
 * Periodically scans for external sessions (VS Code extension panel, etc.)
 * that produce JSONL files without an associated terminal.
 */
export function startExternalSessionScanning(
  _projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  _jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,

  persistAgents: () => void,
  watchAllSessionsRef?: { current: boolean },
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    // When hooks are active, SessionStart handles workspace session detection.
    // Only skip workspace scanning; global scanning (Watch All) still needed
    // because hooks can't detect already-running sessions from other projects.
    if (!hooksEnabledRef?.current) {
      // Scan all tracked project dirs (heuristic fallback)
      for (const dir of trackedProjectDirs) {
        scanExternalDir(
          dir,
          knownJsonlFiles,
          nextAgentIdRef,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          persistAgents,
        );
      }
    }
    // If "Watch All Sessions" is ON, also scan all global project dirs
    if (watchAllSessionsRef?.current) {
      scanGlobalProjectDirs(
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, EXTERNAL_SCAN_INTERVAL_MS);
}

/** Scan a single project dir for external sessions. */
export function scanExternalDir(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  const now = Date.now();

  // If an internal agent in this projectDir is still waiting for its JSONL file
  // (file doesn't exist), skip all adoptions. The agent may have done /resume,
  // and agentManager will detect and reassign it. Prevents the scanner from
  // stealing the file as a new external agent.
  const hasOrphanedInternal = [...agents.values()].some((a) => {
    if (a.isExternal || a.projectDir !== projectDir) return false;
    try {
      fs.statSync(a.jsonlFile);
      return false;
    } catch {
      return true;
    }
  });
  if (hasOrphanedInternal) return;

  for (const file of files) {
    // --resume detection: seeded files whose mtime changed have new data.
    // Adopt directly, bypassing content check (old /clear files have
    // /clear content but should still be adoptable when resumed).
    // File stays in knownJsonlFiles (safe from per-agent /clear stealing).
    const seededMtime = dismissalTracker!.getSeededMtime(file);
    if (seededMtime !== undefined) {
      // Seeded files are pre-existing at extension startup. If mtime changed,
      // it could be --resume or internal agent activity. Don't adopt or reassign
      // here (too ambiguous, causes cascading stealing). Just remove from tracking
      // so the file can be handled through normal adoption if appropriate.
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > seededMtime) {
          dismissalTracker!.clearSeededMtime(file);
          knownJsonlFiles.delete(file);
        }
      } catch {
        /* ignore */
      }
      continue;
    }

    // Skip files already known (seeded or adopted).
    if (knownJsonlFiles.has(file)) continue;

    // Skip files permanently dismissed by /clear (never re-adopted)
    if (dismissalTracker!.isPermanentlyDismissed(file)) continue;

    // Skip files recently dismissed by the user (closed via X).
    // isDismissed() handles the 3-minute cooldown and auto-expires old entries.
    if (dismissalTracker!.isDismissed(file)) continue;

    // Check if already tracked by an agent (normalize paths for comparison).
    // This prevents the external scanner from adopting /clear files (already
    // reassigned to a terminal agent) while allowing untracked files through.
    const normalizedFile = path.resolve(file);
    let tracked = false;
    for (const agent of agents.values()) {
      if (path.resolve(agent.jsonlFile) === normalizedFile) {
        tracked = true;
        break;
      }
    }
    if (tracked) continue;

    // Only adopt recently-active files (modified within threshold).
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS) continue;
    } catch {
      continue;
    }

    // Content check with two-tick delay for /clear files:
    // First tick: skip /clear files (give per-agent 3s to claim for internal /clear).
    // Second tick: per-agent didn't claim → adopt as new external agent.
    try {
      const buf = Buffer.alloc(8192);
      const fd = fs.openSync(file, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      if (buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) {
        if (!dismissalTracker!.hasPendingClear(file)) {
          dismissalTracker!.registerPendingClear(file);
          continue; // First tick: skip, give per-agent a chance
        }
        dismissalTracker!.clearPendingClear(file);
        // Second tick: per-agent didn't claim → fall through to adopt
      }
    } catch {
      continue;
    }

    knownJsonlFiles.add(file);
    console.log(`[Pixel Agents] Watcher: detected external session ${path.basename(file)}`);
    adoptExternalSession(
      file,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );
  }
}

/** Derive a readable folder name from the Claude project dir hash. */
function folderNameFromProjectDir(dirName: string): string {
  const parts = dirName.replace(/^-+/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

/** Scan every session root the active provider exposes for active sessions
 *  (global discovery — powers the "Watch All Sessions" toggle). */
function scanGlobalProjectDirs(
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const roots = hookProvider?.getAllSessionRoots?.() ?? [];
  if (roots.length === 0) return;

  const projectDirs: string[] = [];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) projectDirs.push(path.join(root, entry.name));
      }
    } catch {
      // root missing / unreadable -> skip
    }
  }

  const now = Date.now();
  for (const dirPath of projectDirs) {
    // Skip directories already tracked by workspace scanning
    if (trackedProjectDirs.has(dirPath)) continue;

    let files: string[];
    try {
      files = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dirPath, f));
    } catch {
      continue;
    }

    for (const file of files) {
      if (knownJsonlFiles.has(file)) continue;
      let tracked = false;
      for (const agent of agents.values()) {
        if (agent.jsonlFile === file) {
          tracked = true;
          break;
        }
      }
      if (tracked) continue;
      // Activity filter: >3KB AND modified within 10 minutes
      try {
        const stat = fs.statSync(file);
        if (stat.size < GLOBAL_SCAN_ACTIVE_MIN_SIZE) continue;
        if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;
      } catch {
        continue;
      }

      const folderName = folderNameFromProjectDir(path.basename(dirPath));
      knownJsonlFiles.add(file);
      console.log(
        `[Pixel Agents] Watcher: detected global session ${path.basename(file)} (${folderName})`,
      );
      adoptExternalSession(
        file,
        dirPath,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
        folderName,
      );
    }
  }
}

/**
 * Periodically removes stale external agents whose JSONL files
 * haven't been modified recently.
 */
export function startStaleExternalAgentCheck(
  agents: AgentStateStore,
  knownJsonlFiles: Set<string>,
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    // When hooks are active, SessionEnd handles agent cleanup.
    if (hooksEnabledRef?.current) return;
    const toRemove: number[] = [];

    for (const [id, agent] of agents) {
      if (!agent.isExternal) continue;

      // Only despawn if the JSONL file has been deleted from disk.
      // Inactive external agents stay alive so they can resume when
      // the session continues (e.g., claude --resume).
      try {
        fs.statSync(agent.jsonlFile);
        // File still exists — keep the agent alive regardless of mtime
      } catch {
        // File deleted — remove agent
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const agent = agents.get(id);
      if (agent) {
        // Remove from knownJsonlFiles so the file can be re-adopted if it becomes active again
        knownJsonlFiles.delete(agent.jsonlFile);
      }
      console.log(`[Pixel Agents] Watcher: Agent ${id} - removing stale external agent`);
      agentRemovalCallback?.(id);
    }
  }, EXTERNAL_STALE_CHECK_INTERVAL_MS);
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop old file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, agents, permissionTimers);

  // Permanently dismiss old file so scanners never re-adopt it as external
  dismissalTracker!.permanentlyDismiss(agent.jsonlFile);

  // Swap to new file (update sessionId for hook registration).
  // Keep hookDelivered — if hooks worked before /clear, they'll work after.
  agent.sessionId = path.basename(newFilePath, '.jsonl');
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  // Start watching new file
  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers);
}
