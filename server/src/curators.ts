/**
 * Workspace curators: at most one agent per Workspace, appointed by the
 * operator from the office (standalone only).
 *
 * A curator is chosen by the operator, never derived from a Role, and lives in
 * memory only: nothing here is persisted, so a server restart starts with no
 * curators (and, the registry being in memory too, with no capabilities).
 *
 * Every table key is a normalized Workspace key (capabilities.workspaceKey), so
 * the default Workspace has one key whether an agent names it `undefined` or
 * `'default'`. Eligibility is a live capability (CapabilityRegistry.validFor,
 * the same re-check verify() runs) issued for the requested Workspace.
 *
 * Clearing follows revocation through one entry point: the registry announces
 * every agent whose last capability went away, and clearAgent drops it from the
 * whole table (looked up by agent id, not by Workspace) and broadcasts
 * `workspaceCuratorChanged` with `agentId: null`. Removing a Workspace clears
 * that Workspace's record too, whoever holds it.
 *
 * Known consequence: S2 issues no capability (isKbEnabled defaults to false),
 * so in production every appointment answers `not_eligible`.
 */

import type { CapabilityRegistry } from './capabilities.js';
import { workspaceKey } from './capabilities.js';

export type CuratorRejectionCode = 'invalid' | 'exists' | 'not_eligible';

export type CuratorResult = { ok: true } | { ok: false; code: CuratorRejectionCode };

export interface CuratorEntry {
  workspaceId: string;
  agentId: number;
}

export interface CuratorTableDeps {
  capabilities: CapabilityRegistry;
  /** Fan a message out to every connected office. */
  broadcast: (message: Record<string, unknown>) => void;
}

export class CuratorTable {
  /** Normalized Workspace key -> curator agent id. */
  private readonly curators = new Map<string, number>();
  private readonly capabilities: CapabilityRegistry;
  private readonly broadcast: (message: Record<string, unknown>) => void;

  constructor(deps: CuratorTableDeps) {
    this.capabilities = deps.capabilities;
    this.broadcast = deps.broadcast;
    deps.capabilities.onRevoked((agentId) => this.clearAgent(agentId));
  }

  /** Every curator, for the curatorsLoaded handshake. */
  list(): CuratorEntry[] {
    return [...this.curators].map(([workspaceId, agentId]) => ({ workspaceId, agentId }));
  }

  /** The curator of a Workspace, or null. */
  curatorOf(workspaceId: string | undefined): number | null {
    return this.curators.get(workspaceKey(workspaceId)) ?? null;
  }

  /** Appoint an agent. The caller has already validated both fields. */
  appoint(workspaceId: string, agentId: number): CuratorResult {
    const key = workspaceKey(workspaceId);
    if (this.curators.has(key)) return { ok: false, code: 'exists' };
    const claims = this.capabilities.validFor(agentId);
    if (!claims || claims.workspaceId !== key) return { ok: false, code: 'not_eligible' };
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

  /** The agent lost its capability: it curates nothing any more. */
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
