/**
 * KB 規則的記憶體快照（P2）。WriteGuard 在事件與後備間隔時重算（此處可碰檔案系統），
 * 裁決（kbRules.ts）只讀快照，不碰檔案系統（F13）。
 *
 * 啟用條件只有一個：工作空間已設定根目錄。
 * - 工作空間 KB 區：每個有根目錄的工作空間一個（`<root>/.note`）。
 * - 個人 KB 區：每個「所屬工作空間有根目錄」的已知 Agent 的 `<Agent Directory>/.note`。
 * - F17：對「所屬工作空間有根目錄」的已知 Agent 生效。
 * 歸屬一律用啟動時記錄的 directoryRealPath 與 roleId，從不用 payload cwd。
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Workspace } from '../../../core/src/messages.js';
import { workspaceKey } from '../capabilities.js';
import {
  KB_CLAUDE_HOME_DIR_NAME,
  KB_CLAUDE_SETTINGS_FILE_PATTERN,
  LAYOUT_FILE_DIR,
  ROLE_CLAUDE_DIR_NAME,
} from '../constants.js';
import type { AgentState } from '../types.js';
import { personalKbKey, personalKbZone } from './kbIdentity.js';
import { normalizeZone } from './kbOverlap.js';
import type { PathNormalizer } from './pathNormalization.js';

export interface WorkspaceKbZone {
  workspaceKey: string;
  zone: string;
}

/** 一個已知 standalone Agent 在規則中的身分（啟動時記錄的資料推得）。 */
export interface KbAgentInfo {
  workspaceKey: string;
  /** 所屬工作空間有根目錄（F17 與自己的個人 KB 區生效）。 */
  rulesActive: boolean;
  /** 正規化後的 `<Agent Directory>/.note`；沒有記錄 Directory 時為 undefined。 */
  personalZone?: string;
  /** `<personalZone>/<識別鍵>`；識別鍵無效時為 undefined（只能被拒）。 */
  ownRoot?: string;
  /** 正規化後的 `<Agent Directory>/.claude`（F17）。 */
  claudeDir?: string;
}

export interface KbConfigGuard {
  /** `~/.pixel-agents`（正規化）。 */
  pixelAgentsDir: string;
  /** `~/.claude`（正規化）。 */
  claudeHome: string;
  /** `~/.claude/settings*.json` 目前存在者的正規化結果（含 symlink 目標）。 */
  settingsFiles: string[];
}

export interface KbState {
  workspaceZones: WorkspaceKbZone[];
  personalZones: string[];
  agents: Map<number, KbAgentInfo>;
  config: KbConfigGuard;
  /** 任一工作空間有根目錄（F7 的 unresolved deny 以此為準）。 */
  anyActive: boolean;
}

export interface KbStateInput {
  workspaces: readonly Workspace[];
  /** 已知 standalone Agent（store 中且 PTY 由本伺服器持有）。 */
  knownAgents: ReadonlyArray<[number, AgentState]>;
  homeDir: string;
  normalizer: PathNormalizer;
}

function settingsFilesIn(claudeHome: string, normalizer: PathNormalizer): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(claudeHome);
  } catch {
    return [];
  }
  return names
    .filter((name) => KB_CLAUDE_SETTINGS_FILE_PATTERN.test(name))
    .map((name) => normalizeZone(normalizer, path.join(claudeHome, name)));
}

export function computeKbState(input: KbStateInput): KbState {
  const { normalizer } = input;
  const activeKeys = new Set<string>();
  const workspaceZones: WorkspaceKbZone[] = [];
  for (const workspace of input.workspaces) {
    if (workspace.rootPath === undefined) continue;
    const key = workspaceKey(workspace.id);
    activeKeys.add(key);
    workspaceZones.push({
      workspaceKey: key,
      zone: normalizeZone(normalizer, personalKbZone(workspace.rootPath)),
    });
  }

  const agents = new Map<number, KbAgentInfo>();
  const personalZones: string[] = [];
  for (const [id, agent] of input.knownAgents) {
    const key = workspaceKey(agent.workspaceId);
    const info: KbAgentInfo = { workspaceKey: key, rulesActive: activeKeys.has(key) };
    if (agent.directoryRealPath !== undefined) {
      const zone = normalizeZone(normalizer, personalKbZone(agent.directoryRealPath));
      info.personalZone = zone;
      const identity = personalKbKey(agent.roleId);
      // 字面接上識別鍵：識別鍵子目錄若是 symlink，目標路徑解析後不會落在這裡。
      if (identity !== null) info.ownRoot = path.join(zone, identity);
      info.claudeDir = normalizeZone(
        normalizer,
        path.join(agent.directoryRealPath, ROLE_CLAUDE_DIR_NAME),
      );
      if (info.rulesActive && !personalZones.includes(zone)) personalZones.push(zone);
    }
    agents.set(id, info);
  }

  const claudeHome = normalizeZone(normalizer, path.join(input.homeDir, KB_CLAUDE_HOME_DIR_NAME));
  return {
    workspaceZones,
    personalZones,
    agents,
    config: {
      pixelAgentsDir: normalizeZone(normalizer, path.join(input.homeDir, LAYOUT_FILE_DIR)),
      claudeHome,
      settingsFiles: settingsFilesIn(path.join(input.homeDir, KB_CLAUDE_HOME_DIR_NAME), normalizer),
    },
    anyActive: workspaceZones.length > 0,
  };
}

/** 給 hook 本地 fail-closed 用的受保護根目錄（工作空間與個人 KB 區）。 */
export function kbProtectedRoots(state: KbState): string[] {
  const roots: string[] = [];
  for (const root of [...state.workspaceZones.map((z) => z.zone), ...state.personalZones]) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}
