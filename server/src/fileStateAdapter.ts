/**
 * FileStateAdapter: shared StateAdapter implementation for both VS Code and standalone.
 *
 * Settings (per adapter namespace) persist to
 *   ~/.pixel-agents/config.json  under keys "vscode" or "standalone".
 *
 * Agents + seats (per adapter) persist to
 *   ~/.pixel-agents/<namespace>-state.json
 *
 * Runtime visibility (which agents show in the office) is scope-controlled by the
 * runtime scanner + Watch All Sessions toggle, not by persistence. Both adapters
 * can observe the same ~/.claude/projects/ filesystem; each keeps its own local
 * agent IDs and seat mappings.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import { parseCardOrder } from './cardOrder.js';
import type { AdapterSettingKey, AdapterSettings, ConfigNamespace } from './configPersistence.js';
import { ADAPTER_SETTING_KEYS, readConfig, writeConfig } from './configPersistence.js';
import { PIXEL_AGENTS_DIR } from './constants.js';
import { removeTmp, uniqueTmpPath } from './tmpPath.js';

const ADAPTER_SETTING_KEY_SET: ReadonlySet<string> = new Set(ADAPTER_SETTING_KEYS);

/** Strip leading "pixel-agents." prefix to match AdapterSettings field names. */
function settingNameOf(key: string): AdapterSettingKey | null {
  const bare = key.startsWith('pixel-agents.') ? key.slice('pixel-agents.'.length) : key;
  return ADAPTER_SETTING_KEY_SET.has(bare) ? (bare as AdapterSettingKey) : null;
}

interface AdapterState {
  agents: PersistedAgent[];
  seats: Record<string, { palette?: number; repeat?: number; seatId?: string }>;
  cardOrder: number[];
}

const EMPTY_STATE: AdapterState = { agents: [], seats: {}, cardOrder: [] };

type SeatMeta = AdapterState['seats'][string];

/**
 * Seats as stored: only plain-object entries, each field kept only when it has
 * its type (a non-negative integer palette/repeat, a string seatId). Seats come
 * from a client's saveAgentSeats and from a file anyone can edit; a `null`
 * entry used to be stored as-is and later crash the character remap that
 * reads every seat's palette.
 */
export function sanitizeSeats(value: unknown): AdapterState['seats'] {
  const seats: AdapterState['seats'] = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return seats;
  for (const [key, meta] of Object.entries(value as Record<string, unknown>)) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const m = meta as Record<string, unknown>;
    const clean: SeatMeta = {};
    if (Number.isInteger(m.palette) && (m.palette as number) >= 0)
      clean.palette = m.palette as number;
    if (Number.isInteger(m.repeat) && (m.repeat as number) >= 0) clean.repeat = m.repeat as number;
    if (typeof m.seatId === 'string') clean.seatId = m.seatId;
    seats[key] = clean;
  }
  return seats;
}

export interface FileStateAdapterOptions {
  namespace: ConfigNamespace;
}

export class FileStateAdapter implements StateAdapter {
  private readonly namespace: ConfigNamespace;
  private readonly stateFilePath: string;

  constructor(options: FileStateAdapterOptions) {
    this.namespace = options.namespace;
    this.stateFilePath = path.join(
      os.homedir(),
      PIXEL_AGENTS_DIR,
      `${options.namespace}-state.json`,
    );
  }

  // ── Settings (shared config.json, per-namespace section) ────

  getSetting<T>(key: string, defaultValue: T): T {
    const field = settingNameOf(key);
    if (!field) return defaultValue;
    const config = readConfig();
    return config[this.namespace][field] as unknown as T;
  }

  setSetting<T>(key: string, value: T): void {
    const field = settingNameOf(key);
    if (!field) return;
    const config = readConfig();
    // Narrow by field to keep the union-safe write. Each entry is a boolean or string.
    (config[this.namespace] as unknown as Record<string, unknown>)[field] = value;
    writeConfig(config);
  }

  // ── Agents + seats (adapter-scoped file) ────────────────────

  loadAgents(): PersistedAgent[] {
    return this.readState().agents;
  }

  saveAgents(agents: PersistedAgent[]): void {
    this.patchState({ agents });
  }

  loadSeats(): Record<string, { palette?: number; repeat?: number; seatId?: string }> {
    return this.readState().seats;
  }

  saveSeats(seats: Record<string, { palette?: number; repeat?: number; seatId?: string }>): void {
    this.patchState({ seats });
  }

  loadCardOrder(): number[] {
    return this.readState().cardOrder;
  }

  saveCardOrder(order: number[]): void {
    this.patchState({ cardOrder: order });
  }

  // ── Internal state-file I/O ─────────────────────────────────

  private readState(): AdapterState {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return { ...EMPTY_STATE };
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AdapterState>;
      return {
        agents: Array.isArray(parsed.agents) ? (parsed.agents as PersistedAgent[]) : [],
        seats: sanitizeSeats(parsed.seats),
        cardOrder: parseCardOrder(parsed.cardOrder) ?? [],
      };
    } catch (err) {
      console.error('[Pixel Agents] Failed to read adapter state:', err);
      return { ...EMPTY_STATE };
    }
  }

  /** Read, change these fields, write back. */
  private patchState(patch: Partial<AdapterState>): void {
    this.writeState({ ...this.readState(), ...patch });
  }

  private writeState(state: AdapterState): void {
    const dir = path.dirname(this.stateFilePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(state, null, 2);
      const tmpPath = uniqueTmpPath(this.stateFilePath);
      try {
        fs.writeFileSync(tmpPath, json, 'utf-8');
        fs.renameSync(tmpPath, this.stateFilePath);
      } catch (err) {
        removeTmp(tmpPath);
        throw err;
      }
    } catch (err) {
      console.error('[Pixel Agents] Failed to write adapter state:', err);
    }
  }
}

// Re-export for callers that want to construct AdapterSettings defaults directly.
/** @public */
export type { AdapterSettings, ConfigNamespace };
