import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider } from '../../core/src/provider.js';
import { resendAgentActivity } from '../../server/src/agentActivityResend.js';
import { createAgentState } from '../../server/src/agentState.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { JSONL_POLL_INTERVAL_MS } from '../../server/src/constants.js';
import { directoryNameForLaunch } from '../../server/src/directories.js';
import {
  ensureProjectScan,
  readNewLines,
  reassignAgentToFile,
  startFileWatching,
} from '../../server/src/fileWatcher.js';
import { loadLayout } from '../../server/src/layoutPersistence.js';
import { assignPaletteIfNeeded } from '../../server/src/paletteAssigner.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from '../../server/src/providers/hook/claude/constants.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import { cancelPermissionTimer, cancelWaitingTimer } from '../../server/src/timerManager.js';
import type { PersistedAgent } from '../../server/src/types.js';
import { workspaceDirectories } from './hostDirectories.js';

export function getProjectDirPath(cwd?: string, provider: HookProvider = claudeProvider): string {
  // Fall back to home directory when no workspace folder is open (common on Linux/macOS
  // when VS Code is launched without a folder). The provider's getSessionDirs already
  // implements the Windows case-insensitive fallback for drive-letter casing.
  // ONLY for providers that have transcript directories — push-only providers
  // (Hermes: one SQLite store, no per-project JSONL) deliberately register no
  // getSessionDirs, and this function must never be reached for them.
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const dirs = provider.getSessionDirs?.(workspacePath) ?? [];
  if (dirs.length === 0) {
    throw new Error(`${provider.displayName} returned no session directories`);
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
  directoryPath?: string,
  bypassPermissions?: boolean,
  suppressShow?: boolean,
  provider: HookProvider = claudeProvider,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  // Use home directory as fallback cwd when no workspace is open (common on Linux/macOS).
  // This ensures the terminal starts in a predictable location that matches the project
  // dir hash Claude Code will use for JSONL transcript files.
  const cwd = directoryPath || folders?.[0]?.uri.fsPath || os.homedir();
  const isMultiRoot = !!(folders && folders.length > 1);

  // Build the launch command BEFORE creating the terminal, exactly like the
  // standalone launcher does: the command may carry an env overlay (Hermes
  // pins PWD to the launch cwd) that VS Code's createTerminal accepts, and a
  // provider can mint its own session id — Hermes' id format is a validated
  // upstream contract (`<YYYYmmdd_HHMMSS>_<6hex>`), so the candidate uuid only
  // seeds providers that honour it. The id we finally register must be the one
  // the launched process will carry in its hook events.
  const candidateSessionId = crypto.randomUUID();
  const launch = provider.buildLaunchCommand?.(candidateSessionId, cwd, { bypassPermissions });
  if (!launch) {
    throw new Error(`${provider.displayName} cannot be launched from the office`);
  }
  const sessionId = launch.sessionId ?? candidateSessionId;

  const idx = nextTerminalIndexRef.current++;
  const terminal = vscode.window.createTerminal({
    name: `${provider.terminalNamePrefix ?? CLAUDE_TERMINAL_NAME_PREFIX} #${idx}`,
    cwd,
    ...(launch.env ? { env: launch.env } : {}),
  });
  // When suppressShow is set (auto-spawn + autoShowPanel), keep the panel view
  // on Pixel Agents instead of switching to Terminal. Claude Code still runs
  // via sendText below; user can click the character to focus the terminal via
  // the existing focusAgent message handler.
  if (!suppressShow) {
    terminal.show();
  }

  terminal.sendText([launch.command, ...launch.args].join(' '));

  // File seams are for providers that own transcript files on disk — the same
  // contract the standalone launcher enforces (standaloneAgentLauncher.ts):
  // a push-only provider (no getSessionDirs) has no JSONL to pre-register, no
  // project to /clear-scan, and no file to poll. Its session announces itself
  // through hook events carrying the sessionId registered above; point a
  // scanner at its store-shaped home instead and it would mis-adopt unrelated
  // JSONLs. So EVERY transcript-touching step below rides this flag.
  const dirs = provider.getSessionDirs?.(cwd);
  if (dirs !== undefined && dirs.length === 0) {
    throw new Error(`${provider.displayName} returned no session directories`);
  }
  const expectsTranscript = dirs !== undefined;
  const projectDir = expectsTranscript ? getProjectDirPath(cwd, provider) : cwd;
  const expectedFile = expectsTranscript ? path.join(projectDir, `${sessionId}.jsonl`) : '';

  // Pre-register expected JSONL file so project scan won't treat it as a /clear file
  if (expectsTranscript) {
    knownJsonlFiles.add(expectedFile);
  }

  // Create agent immediately (before JSONL file exists)
  const id = nextAgentIdRef.current++;
  // The character's origin label, and the key areaMappings is looked up by.
  //
  // A launch the office aimed somewhere (a Directory row, or the Default
  // directory the caller resolved — both arrive as directoryPath) wears that
  // Directory's name as the user wrote it, so "Side Project" doesn't come out
  // as "side-project" and the Areas assigned to it in the modal match.
  //
  // Everything else keeps the old multi-root rule: the most specific containing
  // workspace folder (longest path wins for nested folders), and nothing at all
  // in a single-root window, where an origin label would say what the whole
  // office already says.
  const chosenDirectoryName =
    directoryPath === undefined ? undefined : directoryNameForLaunch(cwd, workspaceDirectories());
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
    providerId: provider.id,
    // The marker restore paths use to skip the transcript machinery for an
    // agent that has none (mirror of standaloneAgentLauncher's jsonlFile: '').
    hooksOnly: expectsTranscript ? undefined : true,
  });

  assignPaletteIfNeeded(agent, agents);
  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  console.log(`[Pixel Agents] Terminal: Agent ${id} - created for terminal ${terminal.name}`);

  if (!expectsTranscript) {
    // A push-only launch is fully wired: the process carries the sessionId we
    // registered (the caller's registerAgent loop routes its hook events).
    // No /clear project scan, no JSONL poll — see the file-seams decision
    // above; running either would walk a directory that holds no transcripts
    // of this provider and invent characters from foreign JSONLs.
    return;
  }

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
    // Background-spawn children are derived state — never persisted (the 1s
    // scan re-materializes them from sidecars after a restore).
    if (agent.spawnToolUseId) continue;
    persisted.push({
      id: agent.id,
      sessionId: agent.sessionId,
      terminalName: agent.terminalRef?.name ?? '',
      isExternal: agent.isExternal || undefined,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      directoryName: agent.directoryName,
      teamName: agent.teamName,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
      teamUsesTmux: agent.teamUsesTmux,
      backgroundAgentToolIds:
        agent.backgroundAgentToolIds.size > 0 ? [...agent.backgroundAgentToolIds] : undefined,
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

    // Background-spawn children (a leadAgentId but no teamName) are derived
    // state re-materialized by the 1s scan — never restored directly (also
    // skips stale entries written by older builds that persisted them).
    if (p.leadAgentId !== undefined && !p.teamName) continue;

    let terminal: vscode.Terminal | undefined;
    const isExternal = p.isExternal ?? false;

    if (isExternal) {
      // External agents — restore if JSONL file still exists on disk. A
      // hooks-only external agent has no transcript by definition (the
      // provider pushes); pruning it for the missing file would delete a
      // character whose session is alive — same rule standalone's
      // restoreExternalAgents applies. Without a sessionId it could never
      // route anything, so those records are dropped.
      if (p.hooksOnly) {
        if (!p.sessionId) continue;
      } else {
        try {
          if (!fs.existsSync(p.jsonlFile)) continue;
        } catch {
          continue;
        }
      }
    } else {
      // Terminal agents — find matching terminal by name
      terminal = liveTerminals.find((t) => t.name === p.terminalName);
      if (!terminal) continue;
    }

    const agent = createAgentState({
      id: p.id,
      sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
      terminalRef: terminal,
      isExternal,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
      // A restored push-only agent keeps its marker: its liveness signal is
      // the provider's push stream, and the file machinery below must stay
      // off for it exactly like at launch.
      hooksOnly: p.hooksOnly,
      // Live spawn ids survive the reload so the 1s scan can re-adopt the
      // spawns' transcripts and the completion queue-op still matches.
      backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
      directoryName: p.directoryName ?? p.folderName,
      teamName: p.teamName,
      agentName: p.agentName,
      // A named agent is a teammate; never restore it as a lead (guards against
      // state persisted before linkTeammates stopped promoting teammates).
      isTeamLead: p.agentName ? undefined : p.isTeamLead,
      leadAgentId: p.leadAgentId,
      teamUsesTmux: p.teamUsesTmux,
      palette: p.palette,
      hueShift: p.hueShift,
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
      // The 10s "no data received" sweep below culls dead terminals VS Code
      // restored after a window reload — its evidence is a transcript that
      // never produced a line. A hooks-only agent can NEVER produce one (no
      // file exists), so sweeping it would delete a live character whose
      // terminal is open. It is not a candidate.
      if (!p.hooksOnly) {
        justRestoredTerminalIds.push(p.id);
      }
    }

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Claude Code #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    // Start file watching if JSONL exists, skipping to end of file. A
    // hooks-only agent skips this entirely: existsSync('') is false, and the
    // poll branch below would otherwise spin forever on a path that will
    // never exist — a push-only provider's transcript does not live on disk.
    if (!agent.hooksOnly) {
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
