/**
 * The office as the Pixel Office MCP reads it: the facts a surface supplies
 * (OfficeFacts — where its layout, catalogue, assets, Directories, seats and
 * Area mappings come from), and the per-call snapshot every operation works on
 * (officeSnapshot: the layout read and migrated once, the catalogue, the seats
 * with who holds each, the walk grid on first use). One request sees one
 * layout, however many operations it runs.
 */

import {
  type FurnitureCatalog,
  layoutFromJson,
  type OfficeLayout,
  type WalkGrid,
  walkGrid,
} from '../../../core/src/layout/index.js';
import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { catalogOf, type OfficePlaceFacts } from '../officeFacts.js';
import type { AreaMappings } from './layoutEditOps.js';
import type { OfficeAssets } from './officeOperations.js';
import { type SeatPlace, seatsOf } from './seatPlace.js';

/** How many floor patterns, wall sets and carpets are loaded, and the pets (by petType). */
export type AssetCounts = Omit<OfficeAssets, 'catalog'>;

/** What a surface's office is made of, as the MCP reads and writes it: the
 *  surface's one OfficePlaceFacts (../officeFacts.ts), and what only the MCP needs. */
export interface OfficeFacts extends OfficePlaceFacts {
  store: AgentStateStore;
  provider: HookProvider;
  /** Save a layout (the office's layout persistence: atomic, watchers marked). */
  writeLayout(layout: Record<string, unknown>): void;
  assets(): AssetCounts;
  /** The user's own Directories (config.json), with their default characters (palette indices). */
  userDirectories(): ReadonlyArray<{ name: string; path: string; characters: readonly number[] }>;
  /** The seats the office saved (agent id → seat id). */
  seats(): Record<string, { seatId?: string }>;
  writeAreaMappings(mappings: AreaMappings): void;
  /** The Directories' default characters or the roster's recency changed (an agent's
   *  Character edit): re-send them to every office, as a Characters-view save does. */
  characterRefsChanged(): void;
}

/** The office at one moment: what one operation (one tool call) works on. */
export interface OfficeSnapshot {
  /** The layout, migrated, or null before the office has one. */
  layout: OfficeLayout | null;
  catalog: FurnitureCatalog | null;
  /** Every seat of the layout, by seat id. */
  seats: Map<string, SeatPlace>;
  /** The seat an agent holds: its saved seat, else the one it was given. */
  seatOf(agentId: number): string | undefined;
  /** Seat id → the agent holding it (the first, when two claim one). */
  holders: Map<string, number>;
  /** The tile of an agent's seat, when the office has seated it. */
  seatTileOf(agentId: number): { col: number; row: number } | null;
  /** The layout as walking sees it (built on first use), or null without a layout or catalogue. */
  grid(): WalkGrid | null;
}

/** Read the office once: the layout read from its file and migrated once. */
export function officeSnapshot(facts: OfficeFacts): OfficeSnapshot {
  const layout = layoutFromJson(facts.layout());
  const catalog = catalogOf(facts.catalog());
  const seats = seatsOf(layout, catalog);
  const saved = facts.seats();
  const seatOf = (agentId: number): string | undefined =>
    saved[String(agentId)]?.seatId ?? facts.store.get(agentId)?.seatId;
  const holders = new Map<string, number>();
  for (const [id] of facts.store) {
    const seatId = seatOf(id);
    if (seatId && !holders.has(seatId)) holders.set(seatId, id);
  }
  let grid: WalkGrid | null | undefined;
  return {
    layout,
    catalog,
    seats,
    seatOf,
    holders,
    seatTileOf(agentId) {
      const seatId = seatOf(agentId);
      return (seatId && seats.get(seatId)?.tile) || null;
    },
    grid() {
      if (grid === undefined) grid = layout && catalog ? walkGrid(catalog, layout) : null;
      return grid;
    },
  };
}
