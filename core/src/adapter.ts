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

import type { PersistedAgent } from './schemas.js';

export interface StateAdapter {
  // ── Per-adapter persisted state (agents + seats) ────────────────────

  loadAgents(): PersistedAgent[];
  saveAgents(agents: PersistedAgent[]): void;

  loadSeats(): Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  saveSeats(seats: Record<string, { palette?: number; hueShift?: number; seatId?: string }>): void;

  // ── User-level settings (shared file, namespaced per adapter) ─────

  getSetting<T>(key: string, defaultValue: T): T;
  setSetting<T>(key: string, value: T): void;
}
