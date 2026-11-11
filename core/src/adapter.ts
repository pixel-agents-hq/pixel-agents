/**
 * Pluggable persistence backend for agent state and user settings.
 *
 * Today both VS Code and the standalone CLI use FileStateAdapter, which
 * persists everything under ~/.pixel-agents/ as plain JSON. The interface
 * exists so future hosts (JetBrains plugin, browser-only mock for tests)
 * can swap in alternate backends without touching the rest of the code.
 *
 * Layout persistence (~/.pixel-agents/layout.json) is NOT part of this
 * interface -- it's already host-agnostic (plain fs I/O in layoutPersistence.ts).
 */

import type { PersistedPcShell } from './pcShells.js';
import type { PersistedAgent } from './schemas.js';

export interface StateAdapter {
  // ── Per-adapter persisted state (agents + seats) ────────────────────

  loadAgents(): PersistedAgent[];
  saveAgents(agents: PersistedAgent[]): void;

  loadSeats(): Record<string, { palette?: number; repeat?: number; seatId?: string }>;
  saveSeats(seats: Record<string, { palette?: number; repeat?: number; seatId?: string }>): void;

  /** The agent cards' order (agent ids, first card first), shared by every
   *  client of this surface. [] = creation order; an adapter without these
   *  keeps creation order and drops reorders. */
  loadCardOrder?(): number[];
  saveCardOrder?(order: number[]): void;

  /** The live PC shells, so a restart can bring back the ones whose terminals
   *  outlived it (the PTY host). An adapter without these saves none. */
  loadPcShells?(): PersistedPcShell[];
  savePcShells?(shells: PersistedPcShell[]): void;

  // ── User-level settings (shared file, namespaced per adapter) ─────

  getSetting<T>(key: string, defaultValue: T): T;
  setSetting<T>(key: string, value: T): void;
}
