/**
 * One-time migration of VS Code-native state into ~/.pixel-agents/.
 *
 * Sources:
 *   - context.globalState (settings) → config.json[vscode]
 *   - context.workspaceState['pixel-agents.agents'] → vscode-state.json.agents
 *   - context.workspaceState['pixel-agents.agentSeats'] → vscode-state.json.seats
 *   - context.workspaceState['pixel-agents.layout'] → ~/.pixel-agents/layout.json
 *
 * Runs on every extension activate(). Idempotent: if nothing legacy remains,
 * it's a no-op. Verifies file writes before clearing VS Code keys, so a disk
 * error cannot result in state loss. If any key fails to migrate, logs a warning
 * and shows a VS Code notification on every launch until the user resolves it.
 */

import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../server/src/layoutPersistence.js';

/** VS Code globalState keys → setting key passed to adapter.getSetting/setSetting. */
const SETTINGS_MIGRATIONS: readonly { vscodeKey: string; settingKey: string }[] = [
  { vscodeKey: 'pixel-agents.soundEnabled', settingKey: 'pixel-agents.soundEnabled' },
  { vscodeKey: 'pixel-agents.lastSeenVersion', settingKey: 'pixel-agents.lastSeenVersion' },
  { vscodeKey: 'pixel-agents.alwaysShowLabels', settingKey: 'pixel-agents.alwaysShowLabels' },
  { vscodeKey: 'pixel-agents.watchAllSessions', settingKey: 'pixel-agents.watchAllSessions' },
  { vscodeKey: 'pixel-agents.hooksEnabled', settingKey: 'pixel-agents.hooksEnabled' },
  { vscodeKey: 'pixel-agents.hooksInfoShown', settingKey: 'pixel-agents.hooksInfoShown' },
];

const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
const WORKSPACE_KEY_LAYOUT = 'pixel-agents.layout';

export function migrateVsCodeState(context: vscode.ExtensionContext, adapter: StateAdapter): void {
  const pending: string[] = [];

  // ── Settings (globalState) ──
  for (const { vscodeKey, settingKey } of SETTINGS_MIGRATIONS) {
    const legacyValue = context.globalState.get<unknown>(vscodeKey);
    if (legacyValue === undefined) continue;

    try {
      adapter.setSetting(settingKey, legacyValue);
      const verify = adapter.getSetting<unknown>(settingKey, undefined);
      if (deepEqual(verify, legacyValue)) {
        void context.globalState.update(vscodeKey, undefined);
      } else {
        pending.push(vscodeKey);
      }
    } catch {
      pending.push(vscodeKey);
    }
  }

  // ── Agents (workspaceState) ──
  const legacyAgents = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS);
  if (legacyAgents && legacyAgents.length > 0) {
    try {
      adapter.saveAgents(legacyAgents);
      if (deepEqual(adapter.loadAgents(), legacyAgents)) {
        void context.workspaceState.update(WORKSPACE_KEY_AGENTS, undefined);
      } else {
        pending.push(WORKSPACE_KEY_AGENTS);
      }
    } catch {
      pending.push(WORKSPACE_KEY_AGENTS);
    }
  }

  // ── Seats (workspaceState) ──
  type SeatsMap = Record<string, { palette?: number; hueShift?: number; seatId?: string }>;
  const legacySeats = context.workspaceState.get<SeatsMap>(WORKSPACE_KEY_AGENT_SEATS);
  if (legacySeats && Object.keys(legacySeats).length > 0) {
    try {
      adapter.saveSeats(legacySeats);
      if (deepEqual(adapter.loadSeats(), legacySeats)) {
        void context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, undefined);
      } else {
        pending.push(WORKSPACE_KEY_AGENT_SEATS);
      }
    } catch {
      pending.push(WORKSPACE_KEY_AGENT_SEATS);
    }
  }

  // ── Layout (workspaceState → ~/.pixel-agents/layout.json) ──
  // Old VS Code versions stored layout in workspaceState. New code reads from a
  // user-level file. Migrate, but never clobber an existing file (it's the
  // source of truth once written). If the file already exists, just clear the
  // legacy key.
  const legacyLayout = context.workspaceState.get<Record<string, unknown>>(WORKSPACE_KEY_LAYOUT);
  if (legacyLayout) {
    try {
      if (readLayoutFromFile()) {
        void context.workspaceState.update(WORKSPACE_KEY_LAYOUT, undefined);
      } else {
        writeLayoutToFile(legacyLayout);
        if (deepEqual(readLayoutFromFile(), legacyLayout)) {
          void context.workspaceState.update(WORKSPACE_KEY_LAYOUT, undefined);
        } else {
          pending.push(WORKSPACE_KEY_LAYOUT);
        }
      }
    } catch {
      pending.push(WORKSPACE_KEY_LAYOUT);
    }
  }

  if (pending.length > 0) {
    console.warn(
      `[Pixel Agents] Migration incomplete -- ${pending.length} legacy VS Code ` +
        `key(s) still present. Will retry next activate. Keys: ${pending.join(', ')}`,
    );
    void vscode.window.showWarningMessage(
      `Pixel Agents: ${pending.length} legacy setting(s) could not be migrated to ` +
        `~/.pixel-agents/config.json. Check ~/.pixel-agents/ is writable.`,
    );
  }
}

/** Shallow-friendly deep equality for JSON-persisted values (objects/arrays/primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
