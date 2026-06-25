import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { JSONL_POLL_INTERVAL_MS } from '../../server/src/constants.js';
import {
  ensureProjectScan,
  readNewLines,
  reassignAgentToFile,
  startFileWatching,
} from '../../server/src/fileWatcher.js';
import { loadLayout } from '../../server/src/layoutPersistence.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from '../../server/src/providers/hook/claude/constants.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import { cancelPermissionTimer, cancelWaitingTimer } from '../../server/src/timerManager.js';
import type { AgentSource, AgentState, PersistedAgent } from '../../server/src/types.js';
import { COPILOT_CLI_TERMINAL_NAME_PREFIX } from './constants.js';

export function getProjectDirPath(cwd?: string): string {
  // Fall back to home directory when no workspace folder is open (common on Linux/macOS
  // when VS Code is launched without a folder). The provider's getSessionDirs already
  // implements the Windows case-insensitive fallback for drive-letter casing.
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const dirs = claudeProvider.getSessionDirs?.(workspacePath) ?? [];
  if (dirs.length === 0) {
    throw new Error('claudeProvider.getSessionDirs returned no directories');
  }
  const projectDir = dirs[0];
  console.log(`[Pixel Agents] Terminal: Project dir: ${workspacePath} → ${projectDir}`);
  return projectDir;
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: AgentStateStore,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  persistAgents: () => void,
  folderPath?: string,
  bypassPermissions?: boolean,
  suppressShow?: boolean,
  agentType?: AgentSource,
): Promise<void> {
  const source: AgentSource = agentType === 'copilot-cli' ? 'copilot-cli' : 'claude-code';
  const isCopilotCli = source === 'copilot-cli';
  const namePrefix = isCopilotCli ? COPILOT_CLI_TERMINAL_NAME_PREFIX : CLAUDE_TERMINAL_NAME_PREFIX;

  const folders = vscode.workspace.workspaceFolders;
  // Use home directory as fallback cwd when no workspace is open (common on Linux/macOS).
  // This ensures the terminal starts in a predictable location that matches the project
  // dir hash Claude Code will use for JSONL transcript files.
  const cwd = folderPath || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `${namePrefix} #${idx}`,
    cwd,
  });
  // When suppressShow is set (auto-spawn + autoShowPanel), keep the panel view
  // on Pixel Agents instead of switching to Terminal. Claude Code still runs
  // via sendText below; user can click the character to focus the terminal via
  // the existing focusAgent message handler.
  if (!suppressShow) {
    terminal.show();
  }

  if (isCopilotCli) {
    // Copilot CLI agents run the `copilot` command and have no JSONL transcript,
    // so we create a character but don't set up file watching or activity tracking.
    terminal.sendText('copilot');
    const id = nextAgentIdRef.current++;
    const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
    const agent: AgentState = {
      id,
      source: 'copilot-cli',
      sessionId: crypto.randomUUID(),
      terminalRef: terminal,
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
      inputTokens: 0,
      outputTokens: 0,
      folderName,
    };
    agents.set(id, agent);
    activeAgentIdRef.current = id;
    persistAgents();
    console.log(`[Pixel Agents] Copilot CLI Agent ${id}: created for terminal ${terminal.name}`);
    return;
  }

  const sessionId = crypto.randomUUID();
  const launch = claudeProvider.buildLaunchCommand?.(sessionId, cwd, { bypassPermissions });
  if (!launch) {
    throw new Error('claudeProvider.buildLaunchCommand is not implemented');
  }
  terminal.sendText([launch.command, ...launch.args].join(' '));

  const projectDir = getProjectDirPath(cwd);

  // Pre-register expected JSONL file so project scan won't treat it as a /clear file
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  knownJsonlFiles.add(expectedFile);

  // Create agent immediately (before JSONL file exists)
  const id = nextAgentIdRef.current++;
  const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
  const agent: AgentState = {
    id,
    source: 'claude-code',
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
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
    folderName,
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  console.log(`[Pixel Agents] Terminal: Agent ${id} - created for terminal ${terminal.name}`);

  ensureProjectScan(
    projectDir,
    knownJsonlFiles,
    projectScanTimerRef,
    activeAgentIdRef,
    nextAgentIdRef,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    persistAgents,
  );

  // Poll for the specific JSONL file to appear
  const createdAt = Date.now();
  let pollCount = 0;
  console.log(`[Pixel Agents] Terminal: Agent ${id} - waiting for JSONL at ${agent.jsonlFile}`);
  const pollTimer = setInterval(() => {
    pollCount++;
    try {
      if (fs.existsSync(agent.jsonlFile)) {
        console.log(
          `[Pixel Agents] Terminal: Agent ${id} - found JSONL file ${path.basename(agent.jsonlFile)} (after ${pollCount}s)`,
        );
        clearInterval(pollTimer);
        jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
        );
        readNewLines(id, agents, waitingTimers, permissionTimers);
      } else if (pollCount === 10) {
        // After 10s of polling, warn with path details to help diagnose path encoding mismatches
        const dirExists = fs.existsSync(projectDir);
        let dirContents = '';
        if (dirExists) {
          try {
            const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
            dirContents =
              files.length > 0
                ? `Dir has ${files.length} JSONL file(s): ${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''}`
                : 'Dir exists but has no JSONL files';
          } catch {
            dirContents = 'Dir exists but unreadable';
          }
        } else {
          dirContents = 'Dir does not exist';
        }
        console.warn(
          `[Pixel Agents] Terminal: Agent ${id} - JSONL file not found after 10s. ` +
            `Expected: ${agent.jsonlFile}. ${dirContents}`,
        );
      } else if (pollCount > 10) {
        // Possible /resume: terminal started a different session than expected.
        // Check every tick for a file modified after the agent was created.
        try {
          const trackedFiles = new Set([...agents.values()].map((a) => path.resolve(a.jsonlFile)));
          const candidates = fs
            .readdirSync(projectDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => {
              const full = path.join(projectDir, f);
              return { file: full, mtime: fs.statSync(full).mtimeMs };
            })
            .filter((c) => !trackedFiles.has(path.resolve(c.file)) && c.mtime > createdAt)
            .sort((a, b) => b.mtime - a.mtime); // newest first

          if (candidates.length > 0) {
            console.log(
              `[Pixel Agents] Terminal: Agent ${id} - /resume detected, reassigning to ${path.basename(candidates[0].file)}`,
            );
            clearInterval(pollTimer);
            jsonlPollTimers.delete(id);
            reassignAgentToFile(
              id,
              candidates[0].file,
              agents,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              persistAgents,
            );
          }
        } catch {
          /* ignore scan errors */
        }
      }
    } catch {
      /* file may not exist yet */
    }
  }, JSONL_POLL_INTERVAL_MS);
  jsonlPollTimers.set(id, pollTimer);
}

export function removeAgent(
  agentId: number,
  store: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
): void {
  const agent = store.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  jsonlPollTimers.delete(agentId);

  // Stop file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Remove from store (fires agentRemoved event) and persist
  store.delete(agentId);
  store.persist();
}

export function persistAgents(agents: AgentStateStore, adapter: StateAdapter): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    persisted.push({
      id: agent.id,
      sessionId: agent.sessionId,
      terminalName: agent.terminalRef?.name ?? '',
      isExternal: agent.isExternal || undefined,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
      teamName: agent.teamName,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
      teamUsesTmux: agent.teamUsesTmux,
    });
  }
  adapter.saveAgents(persisted);
}

export function restoreAgents(
  adapter: StateAdapter,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  store: AgentStateStore,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
): void {
  const persisted = adapter.loadAgents();
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  let restoredProjectDir: string | null = null;

  // IDs of agents we ACTUALLY restored in this call (newly added to the store).
  // The cleanup pass below targets only these; pre-existing agents (e.g., a
  // freshly launched one whose webview just remounted and re-fired
  // webviewReady) must not be culled by this restore-time grace period, since
  // their JSONL may still be on its way (heuristic /resume path waits ~11s).
  const justRestoredTerminalIds: number[] = [];

  for (const p of persisted) {
    // Skip agents already in the map — prevents duplicate file watchers on re-entry
    // (webviewReady fires on every panel focus, re-calling restoreAgents each time)
    if (store.has(p.id)) {
      knownJsonlFiles.add(p.jsonlFile);
      continue;
    }

    let terminal: vscode.Terminal | undefined;
    const isExternal = p.isExternal ?? false;
    const source = p.source ?? 'claude-code';

    // Copilot CLI agents have no JSONL tracking and are re-launched manually — skip restoring them.
    if (source === 'copilot' || source === 'copilot-cli') continue;

    if (isExternal) {
      // External agents — restore if JSONL file still exists on disk
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
    } else {
      // Terminal agents — find matching terminal by name
      terminal = liveTerminals.find((t) => t.name === p.terminalName);
      if (!terminal) continue;
    }

    const agent: AgentState = {
      id: p.id,
      source,
      sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
      terminalRef: terminal,
      isExternal,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
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
      folderName: p.folderName,
      hookDelivered: false,
      inputTokens: 0,
      outputTokens: 0,
      teamName: p.teamName,
      agentName: p.agentName,
      isTeamLead: p.isTeamLead,
      leadAgentId: p.leadAgentId,
      teamUsesTmux: p.teamUsesTmux,
    };

    store.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    if (isExternal) {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored external → ${path.basename(p.jsonlFile)}`,
      );
    } else {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored → terminal "${p.terminalName}"`,
      );
      justRestoredTerminalIds.push(p.id);
    }

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Claude Code #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    // Start file watching if JSONL exists, skipping to end of file
    try {
      if (fs.existsSync(p.jsonlFile)) {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          store,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.jsonlFile)) {
              console.log(`[Pixel Agents] Terminal: Agent ${p.id} - found JSONL file`);
              clearInterval(pollTimer);
              jsonlPollTimers.delete(p.id);
              const stat = fs.statSync(agent.jsonlFile);
              agent.fileOffset = stat.size;
              startFileWatching(
                p.id,
                agent.jsonlFile,
                store,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // After a short delay, remove terminal agents that we JUST restored from
  // workspaceState and which never received data. These are dead terminals
  // restored by VS Code (e.g., after a window reload) where Claude is no
  // longer running. Only target the IDs the loop above actually added — never
  // pre-existing agents from launchNewTerminal in the same session whose
  // expected JSONL may still be on its way (heuristic /resume waits ~11s).
  if (justRestoredTerminalIds.length > 0) {
    setTimeout(() => {
      for (const id of justRestoredTerminalIds) {
        const agent = store.get(id);
        if (agent && !agent.isExternal && agent.linesProcessed === 0) {
          console.log(
            `[Pixel Agents] Terminal: Agent ${id} - removing restored agent, no data received`,
          );
          agent.terminalRef?.dispose();
          removeAgent(
            id,
            store,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            jsonlPollTimers,
          );
        }
      }
    }, 10_000); // 10 seconds grace period
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  store.persist();

  // Start project scan for /clear detection
  if (restoredProjectDir) {
    ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimerRef,
      activeAgentIdRef,
      nextAgentIdRef,
      store,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => store.persist(),
    );
  }
}

export function sendExistingAgents(
  agents: AgentStateStore,
  adapter: StateAdapter,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = adapter.loadSeats();

  // Include folderName and isExternal per agent
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  console.log(
    `[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
    externalAgents,
  });
  // Note: sendCurrentAgentStatuses is called separately AFTER layoutLoaded
  // so that agentStatus/agentToolStart messages arrive after characters are created.
}

export function sendCurrentAgentStatuses(
  agents: AgentStateStore,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    // Re-send active tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      const toolName = agent.activeToolNames.get(toolId) ?? '';
      webview.postMessage({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
        toolName,
      });
    }
    // Re-send waiting status
    if (agent.isWaiting) {
      webview.postMessage({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
      });
    }
    // Re-send team metadata
    if (agent.teamName) {
      webview.postMessage({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
      });
    }
    // Re-send token usage
    if (agent.inputTokens > 0 || agent.outputTokens > 0) {
      webview.postMessage({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }
  }
}

export function sendLayout(
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = loadLayout(defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}
