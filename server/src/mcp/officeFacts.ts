/**
 * The office as the Pixel Office MCP reads it: the facts a surface supplies
 * (OfficeFacts — where its layout, catalogue, Directories and seats
 * come from), and the per-call snapshot every operation works on
 * (officeSnapshot: the layout read and migrated once, the catalogue, the seats
 * with who holds each, the walk grid on first use). One request sees one
 * layout, however many operations it runs.
 */

import {
  type CatalogSource,
  type FurnitureCatalog,
  layoutFromJson,
  type OfficeLayout,
} from '../../../core/src/layout/index.js';
import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { catalogOf, type SeatPlace, seatsOf } from './seatPlace.js';

/** What a surface's office is made of, as the MCP reads and writes it. */
export interface OfficeFacts {
  store: AgentStateStore;
  provider: HookProvider;
  /** The saved layout (or the default one), as JSON. */
  layout(): Record<string, unknown> | null;
  /** The furniture catalogue data (empty before it is loaded). */
  catalog(): readonly CatalogSource[];
  /** This host's Directories (name → path). */
  directories(): ReadonlyArray<{ name: string; path: string }>;
  /** The seats the office saved (agent id → seat id). */
  seats(): Record<string, { seatId?: string }>;
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
  return {
    layout,
    catalog,
    seats,
    seatOf,
    holders,
  };
}
