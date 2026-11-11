import type { StateAdapter } from '../../core/src/adapter.js';
import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import type { HookProvider } from '../../core/src/provider.js';
import { resendAgentActivity } from './agentActivityResend.js';
import { buildAgentDiagnostics } from './agentDiagnostics.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import type { CapabilityRegistry } from './capabilities.js';
import {
  getHooksConsent,
  getHooksEnabled,
  readConfig,
  setHooksEnabled,
  writeConfig,
} from './configPersistence.js';
import {
  CREATE_AGENT_INVALID_REQUEST_REASON,
  CREATE_AGENT_NOT_A_DIRECTORY_REASON,
  CREATE_AGENT_TERMINAL_UNAVAILABLE_REASON,
  HUE_SHIFT_MAX_DEG,
  PALETTE_COUNT,
  WORKSPACE_ID_MAX_LENGTH,
} from './constants.js';
import {
  curatorsAvailable,
  curatorsLoadedMessage,
  handleCuratorClientMessage,
} from './curatorClientMessages.js';
import type { CuratorTable } from './curators.js';
import {
  handleDirectoryClientMessage,
  type HostDirectoryEntry,
  listDirectories,
} from './directories.js';
import { collectDirectorySuggestions } from './directorySuggestions.js';
import { hostDirectory } from './hostDirectory.js';
import { handleKbBrowseMessage, type KbBrowseSlots } from './kbBrowse.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';
import type { ConsentEffects } from './providers/hook/consentExecutor.js';
import { applyConsentChoice } from './providers/hook/consentExecutor.js';
import { hooksConsentRequest } from './providers/hook/consentGate.js';
import { claudeProvider, hookProviderById, hookProviders } from './providers/index.js';
import { handleRoleClientMessage, type RoleMessageDeps } from './roleClientMessages.js';
import type { TaskDispatchLaunch } from './taskDispatch/launchConfig.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import type { LaunchStandaloneAgentDeps } from './terminal/standaloneAgentLauncher.js';
import { launchStandaloneAgent } from './terminal/standaloneAgentLauncher.js';
import {
  createStoppedAgent,
  createWorkspaceAgent,
  normalizeAgentName,
  startStoppedAgent,
} from './terminal/standaloneAgentRecords.js';
import {
  handleWorkspaceClientMessage,
  listWorkspaces,
  type WorkspaceMessageDeps,
  workspacesLoadedMessage,
} from './workspaces.js';
import type { GuardStatusReporter } from './writeGuard/guardStatusReporter.js';
import { parsePermissionRoles } from './writeGuard/permissionRoles.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (
  providerId: string,
  enabled: boolean,
) => Promise<void> | void;

/**
 * Reload server-side assets after an external-asset-directory change and
 * re-broadcast the updated sprites to the requesting client. Provided by cli.ts,
 * which owns the dist root needed to re-run the loaders.
 */
export type ReloadAssetsSideEffect = (send: WsSend) => Promise<void> | void;

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  pets: LoadedPetSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  carpetTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export interface ClientMessageContext {
  store: AgentStateStore;
  runtime?: AgentRuntime;
  cache: AssetCache | null;
  /** Install/uninstall hooks side effect. Needs server url+token known only to cli.ts. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Reload assets after an external-asset-directory change. Needs the dist root, known only to cli.ts. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** PTY terminals for standalone-launched agents. Absent in VS Code embedded
   *  mode, where the editor owns terminal lifecycle. */
  ptyManager?: PtySessionManager;
  /** Per-agent capabilities (standalone only, in memory). Handed to every
   *  launch; nothing is issued unless a launch is given isKbEnabled. */
  capabilities?: CapabilityRegistry;
  /** Workspace curators (standalone only, in memory). */
  curators?: CuratorTable;
  /** agentGuardStatus 回報（standalone only）：握手補送、hooks 狀態變更時重查鏈。 */
  guardStatus?: GuardStatusReporter;
  /** Whether a launch into a Workspace is issued a capability (the Workspace's
   *  KB is on). Handed to every launch. Absent while nothing can enable a KB:
   *  no agent could ever be a curator, so the office offers no curator
   *  controls (curatorsLoaded.available stays false). */
  isKbEnabled?: (workspaceId: string) => boolean;
  /** Task dispatch's launcher switch (standalone only): handed to every launch.
   *  Absent: no launch carries the dispatch shim or a capability for it. */
  taskDispatch?: TaskDispatchLaunch;
  /** 這個連線的 KB 瀏覽額度（每個 /ws 連線各一份，見 kbBrowse.ts）。缺少時
   *  listKbFiles／readKbFile 一律以 unavailable 拒絕。 */
  kbBrowse?: KbBrowseSlots;
}

// ── Setting key constants (mirror adapters/vscode/constants.ts) ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
const KEY_GHOST_HEADLESS_AGENTS = 'pixel-agents.ghostHeadlessAgents';
const KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
const KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';
const KEY_SHOW_AREAS = 'pixel-agents.showAreas';
/** The host-wide skip-permissions posture every launch reads. Exported for
 *  task dispatch, which refuses while it is on. */
export const KEY_BYPASS_PERMISSIONS = 'pixel-agents.bypassPermissions';
const KEY_SHOW_HOST_DIRECTORIES = 'pixel-agents.showHostDirectories';

/**
 * This host's own Directory contribution: the directory the server was started
 * from. Gated on ptyManager for the same reason directoriesLoaded is — no
 * ptyManager means VS Code embedded mode, whose adapter contributes its
 * workspace folders instead and must not have this server's cwd added to them.
 */
function hostDirectoriesFor(ctx: ClientMessageContext): HostDirectoryEntry[] {
  return ctx.ptyManager ? [hostDirectory()] : [];
}

/**
 * The host Directories the drawer lists: all of them while the host's Show
 * setting is on, none while it is off (the default). Only the LIST is gated --
 * a launch still names its agent from hostDirectoriesFor, so an agent started
 * in the start directory keeps its name (and its Area mapping) either way, and
 * a hidden start directory becomes something the suggestions can offer.
 */
function shownHostDirectoriesFor(ctx: ClientMessageContext): HostDirectoryEntry[] {
  return ctx.store.getAdapter()?.getSetting(KEY_SHOW_HOST_DIRECTORIES, false)
    ? hostDirectoriesFor(ctx)
    : [];
}

/**
 * Every Directory a personal KB (`<Directory>/.note/`) can live in, for the
 * setWorkspaceRoot overlap check: the registered Directories (user + host),
 * every Workspace's Directories, and the Directory realpath of every agent
 * this host launched.
 */
function personalKbDirectoriesFor(ctx: ClientMessageContext): string[] {
  const directories = new Set<string>();
  for (const directory of listDirectories(hostDirectoriesFor(ctx))) directories.add(directory.path);
  for (const workspace of listWorkspaces()) {
    for (const directoryPath of workspace.directoryPaths) directories.add(directoryPath);
  }
  for (const [, agent] of ctx.store) {
    if (agent.directoryRealPath) directories.add(agent.directoryRealPath);
  }
  return [...directories];
}

/**
 * Roles need a standalone host that can actually launch (a ptyManager whose
 * terminal works, and a runtime) and are off on Windows until verified there.
 * VS Code embedded mode has no ptyManager, so it is always refused.
 */
function rolesAvailableFor(ctx: ClientMessageContext): boolean {
  return (
    ctx.ptyManager !== undefined &&
    ctx.runtime !== undefined &&
    process.platform !== 'win32' &&
    ctx.ptyManager.isAvailable()
  );
}

/** The Role handlers' view of this connection. Replies go to the sender only. */
/** What starting an agent's process needs, from the connection's own context. */
function launchDepsFor(
  ctx: ClientMessageContext,
  store: AgentStateStore,
  runtime: AgentRuntime,
  ptyManager: PtySessionManager,
): LaunchStandaloneAgentDeps {
  return {
    store,
    runtime,
    ptyManager,
    provider: claudeProvider,
    capabilities: ctx.capabilities,
    isKbEnabled: ctx.isKbEnabled,
    taskDispatch: ctx.taskDispatch,
  };
}

function roleDepsFor(ctx: ClientMessageContext, send: WsSend): RoleMessageDeps {
  return {
    reply: send,
    // The full registered union, as a launch names agents: membership must not
    // depend on whether the host Directory is currently shown.
    hostDirectories: () => hostDirectoriesFor(ctx),
    available: rolesAvailableFor(ctx),
    launch: ({ directoryPath, roleName, roleId, snapshotPath, permissionRoles }) => {
      if (!ctx.runtime || !ctx.ptyManager) return null;
      const id = launchStandaloneAgent(
        {
          store: ctx.store,
          runtime: ctx.runtime,
          ptyManager: ctx.ptyManager,
          provider: claudeProvider,
          capabilities: ctx.capabilities,
          isKbEnabled: ctx.isKbEnabled,
          taskDispatch: ctx.taskDispatch,
        },
        {
          directoryPath,
          // The same persisted posture as every launch; a Role never skips its
          // confirmation because of it.
          bypassPermissions:
            ctx.store.getAdapter()?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false,
          role: { name: roleName, roleId, snapshotPath },
          permissionRoles,
        },
      );
      // 第 2 個操作者啟動處理器：Role 啟動（launchAgent 帶 roleId）。
      restoreCuratorAfterOperatorLaunch(ctx, id, directoryPath);
      return id;
    },
  };
}

/**
 * KB Writer 自動恢復的唯一入口（curators.restoreFromBinding）。只由四個 /ws
 * 啟動處理器在啟動成功之後明確呼叫：launchAgent、Role 啟動、createAgent 帶 start、
 * startAgent。此時 agentCreated 與 terminalSessionOpened 都已送出，所以用戶端不會
 * 先收到一個未知 agent 的 workspaceCuratorChanged。store 事件、launchStandaloneAgent
 * 本身、task dispatch 與開機恢復都不經過這裡。
 */
function restoreCuratorAfterOperatorLaunch(
  ctx: ClientMessageContext,
  agentId: number | null,
  launchDirectory: string | undefined,
): void {
  if (agentId === null) return;
  ctx.curators?.restoreFromBinding(agentId, launchDirectory);
}

/** 移除一個 Workspace 的 KB Writer 綁定（Workspace 被刪除）；寫入失敗只記錄。 */
function removeCuratorBinding(ctx: ClientMessageContext, workspaceId: string): void {
  void ctx.curators?.bindings?.remove(workspaceId);
}

/** saveWorkspace 之後：綁定的 Directory 確定不再屬於該 Workspace 就刪除綁定。 */
function pruneCuratorBinding(ctx: ClientMessageContext, workspaceId: string): void {
  void ctx.curators?.bindings?.pruneIfNotMember(workspaceId);
}

/**
 * Workspace 訊息的依賴（這條連線的視角）。saveWorkspace 訊息與 createAgent 加入／回復
 * Directory 都用這一份，因此儲存後的副作用（onWorkspaceSaved、廣播）只有一套。
 */
function workspaceMessageDepsFor(ctx: ClientMessageContext, send: WsSend): WorkspaceMessageDeps {
  const { store } = ctx;
  return {
    broadcast: (message) => store.broadcast(message),
    reply: send,
    personalKbDirectories: () => personalKbDirectoriesFor(ctx),
    onWorkspaceRemoved: (workspaceId) => {
      for (const [id, agent] of [...store]) {
        if (agent.workspaceId === workspaceId) {
          store.setAgentWorkspace(id, DEFAULT_WORKSPACE_ID);
        }
      }
      // Moving its agents already cleared their curator record (the curator
      // table follows agentWorkspaceChanged); the record goes too, whoever holds it.
      ctx.curators?.clearWorkspace(workspaceId);
      // KB Writer 綁定也一併移除。
      removeCuratorBinding(ctx, workspaceId);
    },
    onWorkspaceSaved: (workspaceId) => pruneCuratorBinding(ctx, workspaceId),
  };
}

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'launchAgent': {
      // A launch carrying a roleId (any value) takes the Role path, which
      // validates everything before a launch and answers roleRejected
      // otherwise -- including in embedded mode. Without one: unchanged.
      if (msg.roleId !== undefined) {
        void handleRoleClientMessage(msg, roleDepsFor(ctx, send));
        break;
      }
      // Standalone can launch: the agent runs in a server-side PTY streamed to
      // the browser drawer (a shell running as the operator).
      if (!runtime || !ctx.ptyManager) break;
      // P3 permission-role override: validated before anything starts; an
      // invalid one launches nothing (never falls back to the Workspace default).
      const permissionRoles =
        msg.permissionRoles === undefined ? undefined : parsePermissionRoles(msg.permissionRoles);
      if (msg.permissionRoles !== undefined && permissionRoles === undefined) {
        console.warn('[Pixel Agents] Terminal: not launching -- invalid permissionRoles');
        break;
      }
      // Permission posture is a persisted per-host setting, never a per-launch
      // field: the client sends only where to launch. Every launch comes from a
      // drawer row and carries its Directory's path; no directoryPath falls
      // back to the server cwd (launchStandaloneAgent's own default).
      const directoryPath = msg.directoryPath as string | undefined;
      const id = launchStandaloneAgent(
        {
          store,
          runtime,
          ptyManager: ctx.ptyManager,
          provider: claudeProvider,
          capabilities: ctx.capabilities,
          isKbEnabled: ctx.isKbEnabled,
          taskDispatch: ctx.taskDispatch,
        },
        {
          directoryPath,
          bypassPermissions: adapter?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false,
          ...(permissionRoles !== undefined ? { permissionRoles } : {}),
        },
      );
      // 第 1 個操作者啟動處理器：launchAgent（不帶 roleId）。
      restoreCuratorAfterOperatorLaunch(ctx, id, directoryPath);
      break;
    }

    case 'createAgent': {
      // A record with no process: standalone only. Starting it is a separate
      // step (or `start`).
      const ptyManager = ctx.ptyManager;
      if (!runtime || !ptyManager) {
        send({ type: 'workspaceRejected', reason: CREATE_AGENT_TERMINAL_UNAVAILABLE_REASON });
        break;
      }
      if (typeof msg.directoryPath !== 'string' || msg.directoryPath === '') {
        send({ type: 'workspaceRejected', reason: CREATE_AGENT_INVALID_REQUEST_REASON });
        break;
      }
      const permissionRoles =
        msg.permissionRoles === undefined ? undefined : parsePermissionRoles(msg.permissionRoles);
      if (msg.permissionRoles !== undefined && permissionRoles === undefined) {
        console.warn('[Pixel Agents] Terminal: not creating -- invalid permissionRoles');
        send({ type: 'workspaceRejected', reason: CREATE_AGENT_INVALID_REQUEST_REASON });
        break;
      }
      if (
        msg.workspaceId !== undefined &&
        (typeof msg.workspaceId !== 'string' ||
          msg.workspaceId.length === 0 ||
          msg.workspaceId.length > WORKSPACE_ID_MAX_LENGTH)
      ) {
        console.warn('[Pixel Agents] Terminal: not creating -- invalid workspaceId');
        send({ type: 'workspaceRejected', reason: CREATE_AGENT_INVALID_REQUEST_REASON });
        break;
      }
      // 帶 workspaceId：自由路徑，必要時建立目錄並加入該 Workspace（見 createWorkspaceAgent）；
      // 紀錄存的是 realpath 後的路徑。不帶：與以前完全相同，路徑必須已存在。
      let created: { id: number; directoryPath: string } | null;
      if (typeof msg.workspaceId === 'string') {
        created = createWorkspaceAgent(
          {
            store,
            provider: claudeProvider,
            workspaceEffects: workspaceMessageDepsFor(ctx, send),
            onRefused: (reason) => send({ type: 'workspaceRejected', reason }),
          },
          {
            directoryPath: msg.directoryPath,
            workspaceId: msg.workspaceId,
            name: normalizeAgentName(msg.name),
            ...(permissionRoles !== undefined ? { permissionRoles } : {}),
          },
        );
      } else {
        const id = createStoppedAgent(
          { store, provider: claudeProvider },
          {
            directoryPath: msg.directoryPath,
            name: normalizeAgentName(msg.name),
            ...(permissionRoles !== undefined ? { permissionRoles } : {}),
          },
        );
        if (id === null) {
          send({ type: 'workspaceRejected', reason: CREATE_AGENT_NOT_A_DIRECTORY_REASON });
        }
        created = id === null ? null : { id, directoryPath: msg.directoryPath };
      }
      if (created !== null && msg.start === true) {
        const started = startStoppedAgent(
          launchDepsFor(ctx, store, runtime, ptyManager),
          created.id,
          { bypassPermissions: adapter?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false },
        );
        // 第 3 個操作者啟動處理器：createAgent 帶 start。
        if (started) restoreCuratorAfterOperatorLaunch(ctx, created.id, created.directoryPath);
      }
      break;
    }

    case 'startAgent': {
      const ptyManager = ctx.ptyManager;
      if (!runtime || !ptyManager) break;
      const id = msg.id as number;
      // 啟動後 launchDirectory 會被清掉，先取下來給比對規則用。
      const launchDirectory = store.get(id)?.launchDirectory;
      const started = startStoppedAgent(launchDepsFor(ctx, store, runtime, ptyManager), id, {
        bypassPermissions: adapter?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false,
      });
      // 第 4 個操作者啟動處理器：startAgent。
      if (started) restoreCuratorAfterOperatorLaunch(ctx, id, launchDirectory);
      break;
    }

    case 'closeAgent': {
      // Two shapes now: a PTY-backed agent we launched (kill the process -- the
      // counterpart of VS Code's terminalRef.dispose()), or an external agent we
      // merely observed (dismiss the file so the scanner doesn't re-adopt it,
      // then remove). removeAgent fires agentRemoved, which httpServer maps to
      // an agentClosed broadcast.
      const id = msg.id as number;
      const agent = store.get(id);
      if (agent && runtime) {
        // dispose() is a no-op for agents with no terminal, so this is safe for
        // both shapes. The PTY's onExit handler does the store cleanup for
        // PTY-backed agents; do it here too so external agents (and a PTY that
        // never exits) are still removed promptly.
        ctx.ptyManager?.dispose(id);
        runtime.closeAgent(id);
      }
      break;
    }

    case 'requestDiagnostics':
      // Point-to-point reply to the requesting socket (NOT a broadcast).
      send({ type: 'agentDiagnostics', agents: buildAgentDiagnostics(store) });
      break;

    case 'saveLayout':
      if (msg.layout) {
        writeLayoutToFile(msg.layout as Record<string, unknown>);
      }
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        const seats = msg.seats as Record<
          string,
          { palette?: number; hueShift?: number; seatId?: string }
        >;
        // Sync palette/hueShift back to AgentState so existingAgents stays
        // consistent across reconnects. Validate ranges to keep a remote
        // client (or a hand-edited payload) from corrupting the stored
        // values with out-of-range inputs that would render as a glitch.
        // Palette ceiling is dynamic: external asset directories can add
        // char_N.png beyond the bundled 6, so read the count from the asset
        // cache instead of hardcoding PALETTE_COUNT.
        const paletteCount = cache?.characters?.characters.length ?? PALETTE_COUNT;
        for (const [idStr, meta] of Object.entries(seats)) {
          const id = Number(idStr);
          const agent = store.get(id);
          if (agent) {
            if (
              meta.palette !== undefined &&
              Number.isInteger(meta.palette) &&
              meta.palette >= 0 &&
              meta.palette < paletteCount
            ) {
              agent.palette = meta.palette;
            }
            if (
              meta.hueShift !== undefined &&
              Number.isInteger(meta.hueShift) &&
              meta.hueShift >= 0 &&
              meta.hueShift <= HUE_SHIFT_MAX_DEG
            ) {
              agent.hueShift = meta.hueShift;
            }
          }
        }
        adapter?.saveSeats(seats);
      }
      break;

    case 'setSoundEnabled':
      adapter?.setSetting(KEY_SOUND_ENABLED, msg.enabled);
      break;

    case 'setLastSeenVersion':
      adapter?.setSetting(KEY_LAST_SEEN_VERSION, msg.version as string);
      break;

    case 'setAlwaysShowLabels':
      adapter?.setSetting(KEY_ALWAYS_SHOW_LABELS, msg.enabled);
      break;

    case 'setGhostHeadlessAgents':
      adapter?.setSetting(KEY_GHOST_HEADLESS_AGENTS, msg.enabled);
      break;

    case 'setWatchAllSessions': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_WATCH_ALL_SESSIONS, enabled);
      if (runtime) runtime.watchAllSessions.current = enabled;
      break;
    }

    case 'setHooksEnabled': {
      const enabled = msg.enabled as boolean;
      // The provider id is echoed by the client, never originated: an unknown
      // id names nothing to install into, so it is dropped like a junk choice.
      const provider = hookProviderById(msg.providerId);
      if (!provider) break;
      void applyHooksPreference(ctx, send, provider, enabled);
      break;
    }

    case 'hooksConsentResponse': {
      // Fail-closed on the provider exactly like on the choice: an id naming
      // no registered provider writes nothing.
      const provider = hookProviderById(msg.providerId);
      if (!provider) break;
      void applyConsentChoice(
        provider.id,
        msg.choice,
        standaloneConsentEffects(ctx, send, provider),
      );
      break;
    }

    case 'setHooksInfoShown':
      adapter?.setSetting(KEY_HOOKS_INFO_SHOWN, true);
      break;

    case 'addExternalAssetDirectory': {
      const newPath = msg.path as string | undefined;
      if (!newPath) break;
      const cfg = readConfig();
      if (!cfg.externalAssetDirectories.includes(newPath)) {
        cfg.externalAssetDirectories.push(newPath);
        writeConfig(cfg);
      }
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void ctx.onReloadAssets?.(send);
      break;
    }

    case 'removeExternalAssetDirectory': {
      const removePath = msg.path as string | undefined;
      if (!removePath) break;
      const cfg = readConfig();
      cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter((d) => d !== removePath);
      writeConfig(cfg);
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void ctx.onReloadAssets?.(send);
      break;
    }

    case 'saveAreaMappings': {
      const rawMappings = msg.mappings;
      if (!rawMappings || typeof rawMappings !== 'object') {
        break;
      }
      const cfg = readConfig();
      cfg.standalone.areaMappings = rawMappings as Record<string, string[]>;
      writeConfig(cfg);
      break;
    }

    case 'setShowAreas': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_SHOW_AREAS, enabled);
      break;
    }

    case 'setBypassPermissions': {
      if (typeof msg.enabled !== 'boolean' || !adapter) break;
      adapter.setSetting(KEY_BYPASS_PERMISSIONS, msg.enabled);
      // Every launch reads the persisted posture, so every office must show it:
      // a second tab still reading "off" would launch with the flag regardless.
      // Published as read back, so a failed write shows the truth, not the ask.
      store.broadcast({
        type: 'bypassPermissionsUpdated',
        enabled: adapter.getSetting(KEY_BYPASS_PERMISSIONS, false),
      });
      break;
    }

    case 'setShowHostDirectories': {
      if (typeof msg.enabled !== 'boolean' || !adapter) break;
      adapter.setSetting(KEY_SHOW_HOST_DIRECTORIES, msg.enabled);
      // The list is what changed, so every office gets it again -- the same
      // signal a Directory mutation sends.
      store.broadcast({
        type: 'directoriesLoaded',
        directories: listDirectories(shownHostDirectoriesFor(ctx)),
      });
      break;
    }

    case 'saveDirectory':
    case 'removeDirectory':
    case 'requestDirectorySuggestions':
      // Shared with the VS Code adapter: same validation, same union, same
      // machine-wide config. Success rebroadcasts to every connected office
      // (store.broadcast fans out to all sockets); a rejection — and the
      // suggestion list — answers only the client that asked.
      handleDirectoryClientMessage(msg, {
        hostDirectories: () => shownHostDirectoriesFor(ctx),
        broadcast: (message) => store.broadcast(message),
        reply: send,
        suggestions: () =>
          collectDirectorySuggestions(claudeProvider, shownHostDirectoriesFor(ctx)),
      });
      break;

    case 'saveWorkspace':
    case 'removeWorkspace':
    case 'setWorkspaceRoot':
    case 'setWorkspacePermissionRoles':
      // Same shape as the Directory messages: success rebroadcasts the list to
      // every office, a rejection answers only the sender. Deleting a Workspace
      // sends its agents back to the default first, one agentWorkspaceChanged each.
      handleWorkspaceClientMessage(msg, workspaceMessageDepsFor(ctx, send));
      break;

    case 'setWorkspaceCurator':
    case 'unsetWorkspaceCurator':
      // Success broadcasts workspaceCuratorChanged to every office; a refusal
      // answers only the sender.
      handleCuratorClientMessage(msg, {
        available: curatorsAvailable(ctx),
        curators: ctx.curators,
        reply: send,
      });
      break;

    case 'requestRoles':
    case 'requestRolePreview':
    case 'confirmRole':
      // Point-to-point only: a preview carries the Role's content and must
      // never go through store.broadcast.
      void handleRoleClientMessage(msg, roleDepsFor(ctx, send));
      break;

    case 'listKbFiles':
    case 'readKbFile':
      // 只回給發問者：kbFileRead 帶著檔案內容，絕不能經過 store.broadcast。
      void handleKbBrowseMessage(msg, { reply: send, store, slots: ctx.kbBrowse });
      break;

    default:
      // focusAgent is handled entirely client-side in standalone (it focuses the
      // drawer tab, which the server has no say in). exportLayout / importLayout
      // still require IDE-specific handling.
      break;
  }
}

/**
 * Run the install/uninstall side effect, then persist the provider's preference — only after it settled and only when
 * the on-disk result agrees. Writing it first strands the user when an uninstall fails: entries keep firing while the
 * persisted hooks-off makes the next startup skip the gate entirely. Shared by the Settings toggle and the consent
 * dialog's Install (both are grants). Never rejects — it is fire-and-forget and bound by the ConsentEffects contract,
 * so a failure surfaces on the console here or nowhere.
 */
async function applyHooksPreference(
  ctx: ClientMessageContext,
  send: WsSend,
  provider: HookProvider,
  enabled: boolean,
): Promise<void> {
  try {
    await ctx.onSetHooksEnabled?.(provider.id, enabled);
    const installed = await provider.areHooksInstalled();
    if (installed === enabled) {
      setHooksEnabled(provider.id, enabled);
      // The runtime's single hooksEnabled ref gates the CLAUDE scanners; it
      // follows only the Claude provider until the scanners grow per-provider
      // awareness alongside the Settings UI.
      if (ctx.runtime && provider.id === claudeProvider.id) {
        ctx.runtime.hooksEnabled.current = enabled;
      }
    }
    // Always report the ACTUAL install state — the toggle expresses intent,
    // not outcome (the installer refuses to touch an unparseable file).
    ctx.guardStatus?.refreshChain();
    send({ type: 'hooksStatus', providerId: provider.id, installed });
  } catch (err) {
    console.error('[Pixel Agents] Applying the hooks preference failed:', err);
  }
}

/**
 * This surface's half of carrying out a consent answer for one provider. The choice→action rule and the write order
 * live in the shared consent modules; only these effects are standalone-specific (console, socket), each bound to the
 * one provider being answered.
 */
function standaloneConsentEffects(
  ctx: ClientMessageContext,
  send: WsSend,
  provider: HookProvider,
): ConsentEffects {
  return {
    setHooksEnabled: (enabled) => applyHooksPreference(ctx, send, provider, enabled),
    uninstallHooks: async () => {
      // The same side effect the toggle runs, minus the preference write. The
      // catch keeps the never-reject contract true by construction — the host
      // callback's own contract is unstated.
      try {
        await ctx.onSetHooksEnabled?.(provider.id, false);
      } catch (err) {
        console.error('[Pixel Agents] Hook uninstall failed:', err);
      }
    },
    areHooksInstalled: () => provider.areHooksInstalled(),
    syncHooksPreferenceOff: () => {
      // Durable writes are the executor's own atomic recordHooksDecline; this
      // only mirrors the live runtime ref the CLAUDE scanners read, so another
      // provider's answer can never flip Claude's fallback behavior.
      if (ctx.runtime && provider.id === claudeProvider.id) {
        ctx.runtime.hooksEnabled.current = false;
      }
    },
    reportHooksStatus: async () => {
      try {
        ctx.guardStatus?.refreshChain();
        send({
          type: 'hooksStatus',
          providerId: provider.id,
          installed: await provider.areHooksInstalled(),
        });
      } catch {
        // Never let a status broadcast mask the error already surfaced.
      }
    },
  };
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  // 1. Provider capabilities (must arrive before any agent messages)
  send({
    type: 'providerCapabilities',
    readingTools: [...claudeProvider.readingTools],
    subagentToolNames: [...claudeProvider.subagentToolNames],
  });

  // 1b. Terminal availability. Gates the whole terminal UI (the + Agent button
  // and the drawer), so it must land before the client can act on agents.
  // Absent ptyManager = VS Code embedded mode, which owns its own terminals and
  // must not be told the standalone terminal is unavailable.
  if (ctx.ptyManager) {
    send({
      type: 'terminalAvailability',
      available: ctx.ptyManager.isAvailable(),
      reason: ctx.ptyManager.unavailableReason() ?? undefined,
    });
  }

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.pets) {
      send({
        type: 'petSpritesLoaded',
        pets: cache.pets.pets,
        petNames: cache.pets.manifests.map((m) => m.name),
      });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.carpetTiles) {
      send({ type: 'carpetTilesLoaded', sets: cache.carpetTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  // 3. Layout is sent AFTER existingAgents — see step 7 below. The webview
  // buffers agents from existingAgents and only materializes them on the next
  // layoutLoaded (useExtensionMessages.ts: "Buffer agents — they'll be added
  // in layoutLoaded"), so layout-first would leave a client that connects
  // after agent creation with no characters.

  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const settings = settingsSnapshot(adapter);
  const { watchAllSessions, hooksEnabled } = settings;
  send(settings);

  // 4a. Actual install state, distinct from the hooksEnabled preference —
  // hooksEnabled defaults true while first-run consent is still pending. The
  // provider checks are async, so these land as follow-ups right after the
  // synchronous handshake; the webview's default (not installed) is the safe
  // assumption until each arrives. One status + at most one ask PER PROVIDER.
  for (const provider of hookProviders) {
    // One provider's unreadable settings file must degrade to
    // installed=false (matching the executor's fail-closed read: no choice
    // ever uninstalls on a guess) rather than surface as an unhandled
    // rejection that can take the process down — and must never block the
    // other providers' statuses.
    void provider
      .areHooksInstalled()
      .catch((err: unknown) => {
        console.error(`[Pixel Agents] hooks status check failed for provider ${provider.id}:`, err);
        return false;
      })
      .then((installed) => {
        send({ type: 'hooksStatus', providerId: provider.id, installed });
        // 4a-bis. First-run consent, asked in the app: this connect is the moment the user can be asked, so the ask
        // rides the handshake and consentGate owns every condition (VS Code calls the same function). The record is
        // re-read here rather than taken from startup — another tab may have answered while this one loaded.
        // Dismissing sends nothing, so the ask returns on the next connect: fail-closed, never nagging in-session.
        const request = hooksConsentRequest(
          {
            installed,
            hooksEnabled: getHooksEnabled(provider.id),
            consentAnswered: getHooksConsent(provider.id) !== 'unanswered',
          },
          provider,
        );
        if (request) send({ ...request }); // spread: WsSend takes an index-signature shape
      });
  }

  // 4b. Directory→Area mappings (must arrive before existingAgents so the
  // webview seat-preference logic has the dict when characters are created).
  send({
    type: 'areaMappingsLoaded',
    mappings: cfg.standalone.areaMappings ?? {},
  });

  // 4c. Directories: the user-defined ones from the shared config merged with
  // standalone's native context, the directory the server was started from —
  // one read-only host entry, the counterpart of VS Code contributing its
  // workspace folders. Gated on ptyManager for the same reason
  // terminalAvailability is: no ptyManager means VS Code embedded mode, whose
  // adapter contributes its own Directories.
  if (ctx.ptyManager) {
    send({
      type: 'directoriesLoaded',
      directories: listDirectories(shownHostDirectoriesFor(ctx)),
    });
  }

  // 4d. Workspaces, after the Directories they group and before any agent
  // names one (existingAgents), so the client can place every agent on arrival.
  send(workspacesLoadedMessage());

  // 4e. Curators, to this client only.
  // No longer gated on isKbEnabled (P2): curator eligibility does not need a capability.
  send(curatorsLoadedMessage(curatorsAvailable(ctx), ctx.curators));

  // Sync runtime refs with the persisted settings so scanners behave correctly
  // from the first tick after a server restart.
  if (runtime) {
    runtime.watchAllSessions.current = watchAllSessions;
    runtime.hooksEnabled.current = hooksEnabled;
  }

  // 5. Restore persisted external agents (standalone only; VS Code handles its own restore)
  runtime?.restoreExternalAgents();

  // 6. Existing agents (either just restored, or from VS Code adapter if present)
  const agentIds: number[] = [];
  const directoryNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  // Only agents outside the default: an absent entry means the default.
  const workspaceIds: Record<number, string> = {};
  // Only agents launched with a Role, and only its display name.
  const roleNames: Record<number, string> = {};
  // Only agents created with a display name, and only agents with no process yet.
  const names: Record<number, string> = {};
  const stoppedAgents: Record<number, boolean> = {};
  const persistedSeats = adapter?.loadSeats() ?? {};
  const agentMeta: Record<number, { palette?: number; hueShift?: number; seatId?: string }> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.directoryName) {
      directoryNames[id] = agent.directoryName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
    if (agent.workspaceId) {
      workspaceIds[id] = agent.workspaceId;
    }
    if (agent.roleName) {
      roleNames[id] = agent.roleName;
    }
    if (agent.displayName) {
      names[id] = agent.displayName;
    }
    if (agent.stopped) {
      stoppedAgents[id] = true;
    }
    const persisted = persistedSeats[String(id)];
    agentMeta[id] = {
      palette: agent.palette,
      hueShift: agent.hueShift,
      seatId: persisted?.seatId,
    };
  }
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    directoryNames,
    externalAgents,
    workspaceIds,
    roleNames,
    names,
    stoppedAgents,
  });

  // 6b. Write-guard status for every existing agent, AFTER existingAgents.
  ctx.guardStatus?.sendAll(send);

  // 7. Layout last (see step 3): flushes the webview's buffered existingAgents
  // into characters once seats are rebuilt.
  const savedLayout = readLayoutFromFile();
  send({ type: 'layoutLoaded', layout: savedLayout ?? cache?.defaultLayout ?? null });

  // 8. Agent state, AFTER layoutLoaded -- the characters they target only
  // exist once the layout flush creates them. Without this a reconnecting
  // client shows bare characters until each agent takes another turn.
  resendAgentActivity(send, store);

  // 9. Re-announce live terminals AFTER existingAgents, so a browser that
  // reloaded (or a second tab) rebuilds its drawer tabs. The PTY outlives the
  // socket, so these sessions are still attachable and their scrollback replays
  // on connect.
  if (ctx.ptyManager) {
    for (const id of agentIds) {
      if (ctx.ptyManager.has(id)) {
        send({ type: 'terminalSessionOpened', agentId: id });
      }
    }
  }
}

/** The settingsLoaded snapshot sent on connect. */
function settingsSnapshot(adapter: StateAdapter | undefined) {
  return {
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions: adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    ghostHeadlessAgents: adapter?.getSetting(KEY_GHOST_HEADLESS_AGENTS, false) ?? false,
    // A single boolean carrying the CLAUDE provider's preference until the
    // Settings UI grows a per-provider list -- its sole webview reader is the
    // hooks tooltip gate.
    hooksEnabled: getHooksEnabled(claudeProvider.id),
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: readConfig().externalAssetDirectories,
    showAreas: adapter?.getSetting(KEY_SHOW_AREAS, false) ?? false,
    bypassPermissions: adapter?.getSetting(KEY_BYPASS_PERMISSIONS, false) ?? false,
    showHostDirectories: adapter?.getSetting(KEY_SHOW_HOST_DIRECTORIES, false) ?? false,
  } as const;
}
