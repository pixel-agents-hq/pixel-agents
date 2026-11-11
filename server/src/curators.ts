/**
 * Workspace curators: at most one agent per Workspace, appointed by the
 * operator from the office (standalone only).
 *
 * A curator is chosen by the operator, never derived from a Role, and lives in
 * memory only: a server restart starts with no curators. What survives is a
 * non-default Workspace's binding (see below), which lets the next matching
 * operator launch take the slot again.
 *
 * Every table key is a normalized Workspace key (capabilities.workspaceKey), so
 * the default Workspace has one key whether an agent names it `undefined` or
 * `'default'`.
 *
 * Eligibility (P2, permission-roles plan): the agent is a KNOWN STANDALONE
 * AGENT of that Workspace -- in the main store, launched by this host in a PTY
 * it still holds (ptyManager.has), not external, filed under the requested
 * Workspace. A capability is no longer a prerequisite (and isKbEnabled no
 * longer matters): the KB write rules (writeGuard/kbRules.ts) are what the
 * curator unlocks, and they only ever apply to known standalone agents.
 *
 * Clearing subscribes to the store directly: agentRemoved, agentWorkspaceChanged
 * and agentsCleared each drop the agent from the whole table (looked up by agent
 * id, not by Workspace) and broadcast `workspaceCuratorChanged` with
 * `agentId: null`. Removing a Workspace clears that Workspace's record too,
 * whoever holds it. The store is the MAIN instance: the sub-agent shadow store
 * (subagentWatch.ts) is a different instance and never reaches here.
 *
 * KB Writer 綁定（curatorBindings.ts，選用的 `bindings`）：操作者指定成功後由
 * 呼叫端以 bind() 記錄 (workspaceId, Directory realpath, roleId)；解除（dismiss）
 * 與移除 Workspace 時刪除；agent 結束、刪除、重啟都不刪（名額空著直到再次補上）。
 * restoreFromBinding() 只由四個 /ws 啟動處理器在啟動成功後明確呼叫，走同一個
 * appoint()（同樣的資格、`exists` 檢查與 workspaceCuratorChanged 廣播）。預設
 * Workspace 永遠不綁定，行為與以前相同（只在記憶體）。
 */

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import type { AgentStateStore } from './agentStateStore.js';
import { workspaceKey } from './capabilities.js';
import { bindingMatchesAgent, type CuratorBindingStore } from './curatorBindings.js';

export type CuratorRejectionCode = 'invalid' | 'exists' | 'not_eligible';

export type CuratorResult = { ok: true } | { ok: false; code: CuratorRejectionCode };

/** dismiss 的結果：刪除了綁定時另帶它的磁碟寫入結果。 */
export type CuratorDismissResult =
  { ok: true; persisted?: Promise<boolean> } | { ok: false; code: CuratorRejectionCode };

export interface CuratorEntry {
  workspaceId: string;
  agentId: number;
}

export interface CuratorTableDeps {
  store: AgentStateStore;
  /** Whether this host still holds the agent's PTY (a known standalone agent). */
  ptyManager: { has(agentId: number): boolean };
  /** Fan a message out to every connected office. */
  broadcast: (message: Record<string, unknown>) => void;
  /** KB Writer 綁定（standalone only）。缺少時行為與以前完全相同（只在記憶體）。 */
  bindings?: CuratorBindingStore;
}

export class CuratorTable {
  /** Normalized Workspace key -> curator agent id. */
  private readonly curators = new Map<string, number>();
  private readonly store: AgentStateStore;
  private readonly ptyManager: { has(agentId: number): boolean };
  private readonly broadcast: (message: Record<string, unknown>) => void;
  readonly bindings: CuratorBindingStore | undefined;

  constructor(deps: CuratorTableDeps) {
    this.store = deps.store;
    this.ptyManager = deps.ptyManager;
    this.broadcast = deps.broadcast;
    this.bindings = deps.bindings;
    this.store.on('agentRemoved', (id) => this.clearAgent(id));
    this.store.on('agentWorkspaceChanged', (id) => this.clearAgent(id));
    this.store.on('agentsCleared', (ids) => {
      for (const id of ids) this.clearAgent(id);
    });
  }

  /** Every curator, for the curatorsLoaded handshake. */
  list(): CuratorEntry[] {
    return [...this.curators].map(([workspaceId, agentId]) => ({ workspaceId, agentId }));
  }

  /** The curator of a Workspace, or null. */
  curatorOf(workspaceId: string | undefined): number | null {
    return this.curators.get(workspaceKey(workspaceId)) ?? null;
  }

  /** Whether the agent is a known standalone agent filed under this Workspace key. */
  private isEligible(agentId: number, key: string): boolean {
    const agent = this.store.get(agentId);
    if (!agent || agent.isExternal) return false;
    if (!this.ptyManager.has(agentId)) return false;
    return workspaceKey(agent.workspaceId) === key;
  }

  /** Appoint an agent. The caller has already validated both fields. */
  appoint(workspaceId: string, agentId: number): CuratorResult {
    const key = workspaceKey(workspaceId);
    if (this.curators.has(key)) return { ok: false, code: 'exists' };
    if (!this.isEligible(agentId, key)) return { ok: false, code: 'not_eligible' };
    this.curators.set(key, agentId);
    this.broadcast({ type: 'workspaceCuratorChanged', workspaceId: key, agentId });
    return { ok: true };
  }

  /**
   * Remove a Workspace's curator and its binding; `invalid` only when it has
   * neither. A vacant slot with a binding still succeeds (and still broadcasts
   * workspaceCuratorChanged null). 記憶體清除與廣播先行，撤銷從不等磁碟。
   */
  dismiss(workspaceId: string): CuratorDismissResult {
    const key = workspaceKey(workspaceId);
    if (!this.curators.has(key) && !this.bindings?.has(key)) {
      return { ok: false, code: 'invalid' };
    }
    this.curators.delete(key);
    this.broadcast({ type: 'workspaceCuratorChanged', workspaceId: key, agentId: null });
    const persisted = this.bindings?.remove(key);
    return persisted ? { ok: true, persisted } : { ok: true };
  }

  /**
   * 操作者指定成功之後記錄綁定：agent 的 Directory realpath 與 roleId。預設
   * Workspace（或沒有綁定表）回 null，什麼都不寫；無法綁定（agent 沒有 realpath、
   * 已不是該 Workspace 的 curator）或寫入失敗時，回傳的 promise 為 false。
   */
  bind(workspaceId: string, agentId: number): Promise<boolean> | null {
    const key = workspaceKey(workspaceId);
    if (!this.bindings || key === DEFAULT_WORKSPACE_ID) return null;
    const agent = this.store.get(agentId);
    if (this.curators.get(key) !== agentId || agent?.directoryRealPath === undefined) {
      return Promise.resolve(false);
    }
    const persisted = this.bindings.set({
      workspaceId: key,
      directoryPath: agent.directoryRealPath,
      ...(agent.roleId !== undefined ? { roleId: agent.roleId } : {}),
    });
    return persisted ?? Promise.resolve(false);
  }

  /**
   * 剛由操作者啟動的 agent 若符合其 Workspace 的綁定、且名額空著，就經由 appoint()
   * 重新指定。只能由四個 /ws 啟動處理器在啟動成功後明確呼叫（不掛在 store 事件、
   * 不在 launchStandaloneAgent 裡、不給 task dispatch 或其他內部啟動者）。絕不丟例外。
   */
  restoreFromBinding(agentId: number, launchDirectory: string | undefined): boolean {
    try {
      const agent = this.store.get(agentId);
      if (!agent || !this.bindings) return false;
      const key = workspaceKey(agent.workspaceId);
      if (key === DEFAULT_WORKSPACE_ID || this.curators.has(key)) return false;
      const binding = this.bindings.get(key);
      if (!binding || !bindingMatchesAgent(binding, agent, launchDirectory)) return false;
      if (!this.appoint(key, agentId).ok) return false;
      // 稽核：只記 id，不記路徑或內容。
      console.log(
        `[Pixel Agents] Curator: Agent ${agentId} restored as KB Writer of Workspace ${key} from its binding.`,
      );
      return true;
    } catch (err) {
      console.error(
        `[Pixel Agents] Curator: restore from binding failed (${err instanceof Error ? err.name : 'unknown'}).`,
      );
      return false;
    }
  }

  /** The agent left the store or its Workspace: it curates nothing any more. */
  clearAgent(agentId: number): void {
    for (const [key, curator] of [...this.curators]) {
      if (curator === agentId) {
        this.curators.delete(key);
        this.broadcast({ type: 'workspaceCuratorChanged', workspaceId: key, agentId: null });
      }
    }
  }

  /** The Workspace was removed: drop its record, whoever holds it. */
  clearWorkspace(workspaceId: string): void {
    const key = workspaceKey(workspaceId);
    if (!this.curators.has(key)) return;
    this.curators.delete(key);
    this.broadcast({ type: 'workspaceCuratorChanged', workspaceId: key, agentId: null });
  }
}
