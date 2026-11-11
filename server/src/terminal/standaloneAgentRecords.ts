/**
 * Agent records that exist before (or without) a process: `createAgent` makes
 * one, `startAgent` gives it a Claude Code process.
 *
 * A record is an ordinary AgentState with `stopped` set. Starting it goes
 * through launchStandaloneAgent -- the one place a PTY is spawned, a
 * capability issued and an exit handled -- so a started record behaves exactly
 * like an agent that was launched in one step.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  createAgentDirectories,
  describeAgentPathRefusal,
  planAgentPath,
  removeCreatedDirectories,
} from '../agentPath.js';
import { createAgentState } from '../agentState.js';
import { CREATE_AGENT_FAILED_REASON } from '../constants.js';
import { directoryNameForLaunch } from '../directories.js';
import { directoryNameFor, hostDirectory } from '../hostDirectory.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import {
  addWorkspaceDirectory,
  claimDirectoryForWorkspace,
  listWorkspaces,
  removeWorkspaceDirectory,
  workspaceIdForDirectory,
  type WorkspaceSaveEffects,
} from '../workspaces.js';
import type { PermissionRoles } from '../writeGuard/permissionRoles.js';
import type { LaunchStandaloneAgentDeps } from './standaloneAgentLauncher.js';
import { launchStandaloneAgent } from './standaloneAgentLauncher.js';

const AGENT_NAME_MAX_LENGTH = 64;

export interface CreateStoppedAgentOptions {
  directoryPath: string;
  name?: string;
  /** Same meaning as on a launch: an array is the roles, null is no roles,
   *  absent takes the Workspace default when the agent starts. */
  permissionRoles?: PermissionRoles;
  /** createAgent 帶 workspaceId：directoryPath 已驗證並 realpath，推導出的
   *  Workspace 必須是這一個，否則不建立紀錄。缺少時行為與以前相同。 */
  expectedWorkspaceId?: string;
}

export interface CreateWorkspaceAgentOptions {
  /** 用戶端送來、尚未驗證的路徑（agentPath.planAgentPath 驗證）。 */
  directoryPath: unknown;
  workspaceId: string;
  name?: string;
  permissionRoles?: PermissionRoles;
}

export interface CreateWorkspaceAgentDeps extends Pick<
  LaunchStandaloneAgentDeps,
  'store' | 'provider'
> {
  /** 與 saveWorkspace 訊息處理器相同的副作用（廣播、onWorkspaceSaved）。 */
  workspaceEffects: WorkspaceSaveEffects;
  /** 建立被拒絕或失敗時，告訴操作者原因（固定字串，不含路徑）。 */
  onRefused?: (reason: string) => void;
}

/**
 * createAgent 帶 workspaceId：驗證自由路徑（agentPath.ts），確認它可以屬於該
 * Workspace，必要時建立目錄，把 realpath 後的路徑加入 Workspace 的 Directory，
 * 初始化個人 KB 資料夾 `<final>/.note/_default/`，最後建立停止中的紀錄。
 *
 * 任何失敗都不留下東西：只移除本次建立的目錄、只回復本次加入的 Directory 項目
 * （並再次廣播），且不留下紀錄。成功時回傳紀錄 id 與 realpath 後的路徑。
 */
export function createWorkspaceAgent(
  deps: CreateWorkspaceAgentDeps,
  options: CreateWorkspaceAgentOptions,
): { id: number; directoryPath: string } | null {
  const { store } = deps;
  const workspaceRoots = listWorkspaces()
    .map((w) => w.rootPath)
    .filter((root): root is string => root !== undefined);
  const plan = planAgentPath(options.directoryPath, { homeDir: os.homedir(), workspaceRoots });
  if (!plan.ok) {
    console.error(`[Pixel Agents] Terminal: not creating -- path refused (${plan.reason})`);
    deps.onRefused?.(describeAgentPathRefusal(plan.reason));
    return null;
  }
  const claim = claimDirectoryForWorkspace(options.workspaceId, plan.finalPath);
  if (!claim.ok) {
    console.error(`[Pixel Agents] Terminal: not creating -- ${claim.reason}`);
    deps.onRefused?.(`Couldn't create the Agent: ${claim.reason}`);
    return null;
  }

  const directories = createAgentDirectories(plan);
  if (!directories.ok) {
    console.error(`[Pixel Agents] Terminal: not creating -- path refused (${directories.reason})`);
    deps.onRefused?.(describeAgentPathRefusal(directories.reason));
    return null;
  }

  let addedToWorkspace = false;
  const undo = (why: string): null => {
    console.error(`[Pixel Agents] Terminal: not creating -- ${why}; rolling back`);
    deps.onRefused?.(CREATE_AGENT_FAILED_REASON);
    if (addedToWorkspace) {
      let reason: string | undefined;
      try {
        const reverted = removeWorkspaceDirectory(
          options.workspaceId,
          plan.finalPath,
          deps.workspaceEffects,
        );
        if (!reverted.ok) reason = reverted.reason;
      } catch (err) {
        reason = String(err);
      }
      if (reason !== undefined) {
        console.error(
          `[Pixel Agents] Terminal: could not remove ${JSON.stringify(plan.finalPath)} from the Workspace: ${reason}`,
        );
      }
    }
    // 先回復 Directory 項目再移除目錄：項目指向的路徑在回復之前一直存在。
    removeCreatedDirectories(directories.created);
    return null;
  };

  if (claim.add) {
    let saved: ReturnType<typeof addWorkspaceDirectory>;
    try {
      saved = addWorkspaceDirectory(options.workspaceId, plan.finalPath, deps.workspaceEffects);
    } catch (err) {
      // 寫入之後的廣播或 hook 丟出例外：以檔案上的實際清單判斷是否要回復。
      addedToWorkspace = listWorkspaces().some(
        (w) => w.id === options.workspaceId && w.directoryPaths.includes(plan.finalPath),
      );
      return undo(`adding the Directory failed (${String(err)})`);
    }
    if (!saved.ok) return undo(`adding the Directory failed (${saved.reason})`);
    addedToWorkspace = true;
  }

  const candidateId = store.nextAgentId.current;
  let id: number | null;
  try {
    id = createStoppedAgent(deps, {
      directoryPath: plan.finalPath,
      name: options.name,
      ...(options.permissionRoles !== undefined
        ? { permissionRoles: options.permissionRoles }
        : {}),
      expectedWorkspaceId: options.workspaceId,
    });
  } catch (err) {
    // 例如 store 監聽者或持久化丟出例外：已登記的紀錄一併移除。
    if (store.has(candidateId)) {
      store.delete(candidateId);
      try {
        store.persist();
      } catch {
        /* best effort */
      }
    }
    return undo(`creating the record failed (${String(err)})`);
  }
  if (id === null) return undo('creating the record failed');
  return { id, directoryPath: plan.finalPath };
}

/** Normalize a client-supplied display name; undefined when nothing is left. */
export function normalizeAgentName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim().slice(0, AGENT_NAME_MAX_LENGTH);
  return trimmed === '' ? undefined : trimmed;
}

/** Register a stopped record; returns its id, or null when it cannot be created. */
export function createStoppedAgent(
  deps: Pick<LaunchStandaloneAgentDeps, 'store' | 'provider'>,
  options: CreateStoppedAgentOptions,
): number | null {
  const { store, provider } = deps;
  const cwd = options.directoryPath;

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(cwd).isDirectory();
  } catch {
    /* missing path: refused below */
  }
  if (!isDirectory) {
    console.error(`[Pixel Agents] Terminal: cannot create an agent -- not a directory: ${cwd}`);
    return null;
  }

  const projectDir = provider.getSessionDirs?.(cwd)[0];
  if (projectDir === undefined) {
    console.error('[Pixel Agents] Terminal: provider returned no session dirs');
    return null;
  }

  // Workspace 一律由 Directory 推導；呼叫端指定了 Workspace 時，推導結果必須相符。
  const workspaceId = workspaceIdForDirectory(cwd);
  if (options.expectedWorkspaceId !== undefined && workspaceId !== options.expectedWorkspaceId) {
    console.error('[Pixel Agents] Terminal: cannot create an agent -- Workspace mismatch');
    return null;
  }

  const id = store.nextAgentId.current++;
  const sessionId = crypto.randomUUID();
  const agent = createAgentState({
    id,
    sessionId,
    isExternal: false,
    projectDir,
    jsonlFile: path.join(projectDir, `${sessionId}.jsonl`),
    directoryName: directoryNameForLaunch(cwd, [hostDirectory()]) ?? directoryNameFor(cwd),
    providerId: provider.id,
    workspaceId,
    displayName: options.name,
    stopped: true,
    launchDirectory: cwd,
    permissionRoles: options.permissionRoles,
  });
  assignPaletteIfNeeded(agent, store);
  store.set(id, agent);
  store.persist();
  return id;
}

/** Start a stopped record; false when it is not startable or the spawn failed. */
export function startStoppedAgent(
  deps: LaunchStandaloneAgentDeps,
  id: number,
  options: { bypassPermissions?: boolean } = {},
): boolean {
  const agent = deps.store.get(id);
  if (!agent?.stopped || agent.launchDirectory === undefined) return false;
  if (deps.ptyManager.has(id)) return false;

  return (
    launchStandaloneAgent(deps, {
      directoryPath: agent.launchDirectory,
      bypassPermissions: options.bypassPermissions,
      permissionRoles: agent.permissionRoles,
      // The transcript only exists once the conversation had a first turn;
      // before that there is nothing to resume and a fresh session id is used.
      existing: { id, sessionId: agent.sessionId, resume: fs.existsSync(agent.jsonlFile) },
    }) !== null
  );
}
