import { EventEmitter } from 'node:events';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { AgentState, PersistedAgent } from './types.js';

/** Typed event map for AgentStateStore. */
export interface StoreEvents {
  agentAdded: (id: number, agent: AgentState) => void;
  agentRemoved: (id: number) => void;
  agentUpdated: (id: number, agent: AgentState, field: string) => void;
  broadcast: (message: Record<string, unknown>) => void;
}

/**
 * Centralized owner of the agents Map. Wraps a private Map<number, AgentState>
 * and exposes Map-compatible read/write methods. Emits typed events on
 * set()/delete() for reactive state changes.
 */
export class AgentStateStore {
  private readonly agents = new Map<number, AgentState>();
  private readonly emitter = new EventEmitter();
  readonly nextAgentId = { current: 1 };
  readonly nextTerminalIndex = { current: 1 };
  private adapter: StateAdapter | undefined;

  // ── Adapter ──────────────────────────────────────────────────

  setAdapter(adapter: StateAdapter): void {
    this.adapter = adapter;
  }

  getAdapter(): StateAdapter | undefined {
    return this.adapter;
  }

  // ── Map-compatible read ──────────────────────────────────────

  get(id: number): AgentState | undefined {
    return this.agents.get(id);
  }

  has(id: number): boolean {
    return this.agents.has(id);
  }

  get size(): number {
    return this.agents.size;
  }

  keys(): MapIterator<number> {
    return this.agents.keys();
  }

  values(): MapIterator<AgentState> {
    return this.agents.values();
  }

  entries(): MapIterator<[number, AgentState]> {
    return this.agents.entries();
  }

  forEach(
    cb: (agent: AgentState, id: number, map: Map<number, AgentState>) => void,
    thisArg?: unknown,
  ): void {
    this.agents.forEach(cb, thisArg);
  }

  [Symbol.iterator](): MapIterator<[number, AgentState]> {
    return this.agents[Symbol.iterator]();
  }

  // ── Event subscription ───────────────────────────────────────

  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // ── Map-compatible write (emits events) ─────────────────────

  set(id: number, agent: AgentState): this {
    const isNew = !this.agents.has(id);
    this.agents.set(id, agent);
    if (isNew) {
      this.emitter.emit('agentAdded', id, agent);
    }
    return this;
  }

  delete(id: number): boolean {
    const existed = this.agents.delete(id);
    if (existed) {
      this.emitter.emit('agentRemoved', id);
    }
    return existed;
  }

  clear(): void {
    this.agents.clear();
  }

  // ── Broadcast (replaces direct webview.postMessage in server/) ─

  broadcast(message: Record<string, unknown>): void {
    this.emitter.emit('broadcast', message);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  dispose(): void {
    this.emitter.removeAllListeners();
  }

  // ── Persistence ─────────────────────────────────────────────

  persist(): void {
    if (!this.adapter) {
      return;
    }
    const persisted: PersistedAgent[] = [];
    for (const agent of this.agents.values()) {
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
        sessionName: agent.sessionName,
      });
    }
    this.adapter.saveAgents(persisted);
  }

  loadPersistedAgents(): PersistedAgent[] {
    return this.adapter?.loadAgents() ?? [];
  }
}
