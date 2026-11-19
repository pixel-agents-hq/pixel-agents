import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { Directory } from '../../core/src/messages.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { resendAgentActivity } from '../../server/src/agentActivityResend.js';
import { existingAgentNicknames, existingAgentWorktrees } from '../../server/src/agentMessages.js';
import {
  isPersistedSpawnChild,
  restoredAgentInit,
  toPersistedAgent,
} from '../../server/src/agentPersistence.js';
import { createAgentState } from '../../server/src/agentState.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { JSONL_POLL_INTERVAL_MS } from '../../server/src/constants.js';
import { clearContextUsage } from '../../server/src/contextUsage.js';
import {
  ensureProjectScan,
  readNewLines,
  reassignAgentToFile,
  startFileWatching,
} from '../../server/src/fileWatcher.js';
import { loadLayout } from '../../server/src/layoutPersistence.js';
import type { AgentMcpAccess } from '../../server/src/mcp/officeMcp.js';
import { assignPaletteIfNeeded } from '../../server/src/paletteAssigner.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from '../../server/src/providers/hook/claude/constants.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import { sessionMarkersUnset } from '../../server/src/terminal/terminalEnv.js';
import { cancelPermissionTimer, cancelWaitingTimer } from '../../server/src/timerManager.js';
import type { AgentState } from '../../server/src/types.js';
import { visitSnapshot } from '../../server/src/visits.js';
import { retireWorktreesLeftBy } from '../../server/src/worktreeLeave.js';
import { savedOccupant, type WorktreeOccupant } from '../../server/src/worktreeOccupancy.js';

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

/** A word of a command typed into the user's shell: as is when it holds
 *  only characters no shell treats specially (every word a launch has types
 *  exactly as before), else double-quoted, which keeps a space inside one
 *  word in sh, zsh, cmd and PowerShell alike (a `--mcp-config` path under a
 *  home folder with a space in it). It does not stop `$` expanding: none of
 *  our words holds one. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(word) ? word : `"${word}"`;
}

/** What a launch asks for, beyond the runtime it registers with. */
export interface LaunchTerminalOptions {
  /** The Directory launched into, as the launch request named it (resolved by
   *  the caller): the agent's name, its default characters and, through the
   *  name, its Area seating. Never derived here from the folder it runs in. */
  directory?: Directory;
  /** The folder the terminal runs in; absent = the Directory's path, else the
   *  first workspace folder, else home. It need not be the Directory's path. */
  cwd?: string;
  /** The host's persisted permission posture (never a per-launch choice). */
  bypassPermissions?: boolean;
  /** Keep the panel on Pixel Agents instead of showing the terminal. */
  suppressShow?: boolean;
  /** The character picked from the roster (a palette index); absent = the
   *  launch Directory's default characters, else a random pick. */
  palette?: number;
  /** The Worktree `cwd` is, when the launch made one: its agent wears the
   *  marker and branch (still named after `directory`), and the terminal
   *  closing applies the leave rules to it. */
  worktree?: AgentState['worktree'];
  /** The new session's id, when the caller already chose it (a Worktree
   *  records the session it was made for). Absent = a fresh UUID. */
  sessionId?: string;
  /** The Pixel Office MCP: with the user's consent, the agent is launched
   *  with `--mcp-config <its own file>` (a token minted for it alone). */
  mcp?: AgentMcpAccess;
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
  {
    directory,
    cwd: launchCwd,
    bypassPermissions,
    suppressShow,
    palette,
    worktree,
    sessionId: chosenSessionId,
    mcp,
  }: LaunchTerminalOptions = {},
): Promise<number> {
  const folders = vscode.workspace.workspaceFolders;
  // Use home directory as fallback cwd when no workspace is open (common on Linux/macOS).
  // This ensures the terminal starts in a predictable location that matches the project
  // dir hash Claude Code will use for JSONL transcript files.
  const cwd = launchCwd || directory?.path || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);
  const idx = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `${CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
    // A VS Code started from inside a CLI session lends that session's markers
    // to every terminal: unset them (null = unset), or the agent runs as a
    // child of that session (Claude Code then saves no transcript).
    env: sessionMarkersUnset(claudeProvider, process.env),
  });
  // When suppressShow is set (auto-spawn + autoShowPanel), keep the panel view
  // on Pixel Agents instead of switching to Terminal. Claude Code still runs
  // via sendText below; user can click the character to focus the terminal via
  // the existing focusAgent message handler.
  if (!suppressShow) {
    terminal.show();
  }

  const sessionId = chosenSessionId ?? crypto.randomUUID();
  // Before the token is minted: nothing between it and the agent joining the
  // store throws, so a token never outlives a launch that didn't happen.
  const projectDir = getProjectDirPath(cwd);
  // The id first: the Pixel Office MCP mints its token for this agent (the
  // file's path on the command line, never the token).
  const id = nextAgentIdRef.current++;
  const mcpConfig = mcp?.configFor(id);
  const launch = claudeProvider.buildLaunchCommand?.(sessionId, cwd, {
    bypassPermissions,
    mcpConfig,
  });
  if (!launch) {
    mcp?.revoke(id);
    throw new Error('claudeProvider.buildLaunchCommand is not implemented');
  }
  terminal.sendText([launch.command, ...launch.args].map(shellWord).join(' '));

  // Pre-register expected JSONL file so project scan won't treat it as a /clear file
  const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
  knownJsonlFiles.add(expectedFile);

  // Create agent immediately (before JSONL file exists)
  // The character's origin label, and the key areaMappings is looked up by.
  //
  // A launch the office aimed at a Directory (the caller resolved it from the
  // launch request) wears that Directory's name as the user wrote it, so
  // "Side Project" doesn't come out as "side-project" and the Areas assigned
  // to it in the modal match.
  //
  // Everything else keeps the old multi-root rule: the most specific containing
  // workspace folder (longest path wins for nested folders), and nothing at all
  // in a single-root window, where an origin label would say what the whole
  // office already says.
  const chosenDirectoryName = directory?.name;
  const owningFolder = (folders ?? [])
    .filter((f) => cwd === f.uri.fsPath || cwd.startsWith(f.uri.fsPath + path.sep))
    .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
  const directoryName =
    chosenDirectoryName ??
    (isMultiRoot ? (owningFolder?.name ?? (cwd ? path.basename(cwd) : undefined)) : undefined);
  const agent = createAgentState({
    id,
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    jsonlFile: expectedFile,
    directoryName,
    worktree,
    // Where its session runs: a hook naming this folder is no move.
    cwd,
  });

  // Only a launch the office aimed at a Directory wears its defaults.
  assignPaletteIfNeeded(agent, agents, { picked: palette, directory });
  agents.set(id, agent);
  // A fresh session starts with an empty context: a full gauge from the spawn on.
  clearContextUsage(id, agents);
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
  return id;
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

/**
 * Reference implementation of the AgentState → PersistedAgent projection: it shows
 * exactly which fields survive a reload. Kept as the worked example for adapters that
 * persist through a StateAdapter directly; AgentStateStore.persist() is what the
 * VS Code surface calls at runtime.
 *
 * @public
 */
export function persistAgents(agents: AgentStateStore, adapter: StateAdapter): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    const p = toPersistedAgent(agent);
    if (p) persisted.push(p);
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
  // The Worktrees of saved terminal agents whose terminal is gone: the leave
  // rules apply to them once the store holds everyone who did come back.
  const leftAgents: WorktreeOccupant[] = [];

  for (const p of persisted) {
    // Skip agents already in the map — prevents duplicate file watchers on re-entry
    // (webviewReady fires on every panel focus, re-calling restoreAgents each time)
    if (store.has(p.id)) {
      knownJsonlFiles.add(p.jsonlFile);
      continue;
    }

    if (isPersistedSpawnChild(p)) continue;

    let terminal: vscode.Terminal | undefined;
    const isExternal = p.isExternal ?? false;

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
      if (!terminal) {
        // Its terminal closed while no window watched it: the agent left.
        leftAgents.push(savedOccupant(p));
        continue;
      }
    }

    const agent = createAgentState({
      ...restoredAgentInit(p),
      terminalRef: terminal,
      isExternal,
    });

    assignPaletteIfNeeded(agent, store);
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
          // Claude is no longer running there: the agent has left its Worktree.
          void retireWorktreesLeftBy(store, agent);
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
  for (const left of leftAgents) void retireWorktreesLeftBy(store, left);

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

  // Include directoryName and isExternal per agent
  const directoryNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of agents) {
    if (agent.directoryName) {
      directoryNames[id] = agent.directoryName;
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
    directoryNames,
    externalAgents,
    worktrees: existingAgentWorktrees(agents),
    nicknames: existingAgentNicknames(agents),
  });
  // Note: sendCurrentAgentStatuses is called separately AFTER layoutLoaded
  // so that agentStatus/agentToolStart messages arrive after characters are created.
}

export function sendCurrentAgentStatuses(
  agents: AgentStateStore,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  resendAgentActivity((msg) => webview.postMessage(msg), agents);
  for (const msg of visitSnapshot(agents)) void webview.postMessage(msg);
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
