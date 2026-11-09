/**
 * Workspace curators: at most one agent per Workspace, appointed by the
 * operator from the office (standalone only).
 *
 * A curator is chosen by the operator, never derived from a Role, and lives in
 * memory only: nothing here is persisted, so a server restart starts with no
 * curators.
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
 */

import type { AgentStateStore } from './agentStateStore.js';
import { workspaceKey } from './capabilities.js';

export type CuratorRejectionCode = 'invalid' | 'exists' | 'not_eligible';

export type CuratorResult = { ok: true } | { ok: false; code: CuratorRejectionCode };

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
}

export class CuratorTable {
  /** Normalized Workspace key -> curator agent id. */
  private readonly curators = new Map<string, number>();
  private readonly store: AgentStateStore;
  private readonly ptyManager: { has(agentId: number): boolean };
  private readonly broadcast: (message: Record<string, unknown>) => void;

  constructor(deps: CuratorTableDeps) {
    this.store = deps.store;
    this.ptyManager = deps.ptyManager;
    this.broadcast = deps.broadcast;
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

  /** Remove a Workspace's curator; `invalid` when it has none. */
  dismiss(workspaceId: string): CuratorResult {
    const key = workspaceKey(workspaceId);
    if (!this.curators.has(key)) return { ok: false, code: 'invalid' };
    this.curators.delete(key);
    this.broadcast({ type: 'workspaceCuratorChanged', workspaceId: key, agentId: null });
    return { ok: true };
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
