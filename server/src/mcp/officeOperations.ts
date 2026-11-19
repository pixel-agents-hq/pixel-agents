/**
 * What the Pixel Office MCP's tools may do to the office: the ONE seam between
 * the MCP module (route, tokens, tool table) and the runtime, split by
 * capability (OfficeCapabilities). composeOfficeMcp.ts builds them from the
 * surface's office facts — one module per capability (agentsView, layoutOps,
 * messaging, visitsOps, lifecycle) — and tools only ever call these, never the
 * store or the runtime directly.
 *
 * A later tool that needs a new operation adds it HERE (typed in office
 * terms) and its implementation in its capability's module.
 */

import type { FurnitureCatalog, OfficeLayout } from '../../../core/src/layout/index.js';
import type { LayoutOp } from './layoutEditOps.js';
import type { LayoutEditOutcome, LayoutUndoOutcome } from './layoutEdits.js';

/** An agent's status, as the office shows it. */
export type OfficeAgentStatus = 'active' | 'done' | 'waiting for input' | 'permission request';

/** One agent, as the Pixel Office MCP describes it (list_agents). */
export interface OfficeAgent {
  id: number;
  /** The Directory it was launched into or adopted from: its name, and its path when the
   *  office knows that Directory. */
  directory: { name: string; path: string | null } | null;
  /** The folder its session runs in, when known. */
  workingDirectory: string | null;
  /** The Worktree it runs in, if any. */
  worktree: { name: string; branch: string } | null;
  status: OfficeAgentStatus;
  /** What it is doing right now (its newest running tool's label), if anything. */
  activity: string | null;
  /** Sub-agents it has running (foreground and unnamed background ones). */
  subagentsRunning: number;
  /** Its context window, once reported: the share left (0..1) and the tokens. */
  context: { leftShare: number; usedTokens: number; windowTokens: number } | null;
  /** Its conversation's title, as the CLI titles it; null until it has one. */
  conversationTitle: string | null;
  transcriptPath: string;
  /** Its Lead, when it is a Teammate. */
  leadId: number | null;
  /** Its Teammates, when it is a Lead. */
  teammates: Array<{ id: number; name: string | null }>;
  /** Its seat, the seat's tile, and the Area holding that tile. Null while the office
   *  has not seated it (no office open yet). */
  seat: { id: string; tile: { col: number; row: number } | null; area: string | null } | null;
  /** The character it wears: the roster label and palette index (plus which copy). */
  character: { label: string | null; palette: number; repeat: number } | null;
}

/** One seat of the layout (layoutToSeats), where it is, and who holds it. */
export interface OfficeSeat {
  /** The seat id (the chair's uid, `uid:1`, `uid:2`… for multi-seat chairs). */
  id: string;
  tile: { col: number; row: number };
  /** The label of the Area holding its tile, or null. */
  area: string | null;
  /** The agent whose seat it is, or null when free. */
  takenBy: number | null;
}

/** The office's layout as the MCP reads it (get_layout, and edit_layout's starting point). */
export interface OfficeLayoutSnapshot {
  /** The saved layout (or the default one), migrated to the current model. */
  layout: OfficeLayout;
  /** The furniture catalogue, or null when none is loaded (every type then unknown). */
  catalog: FurnitureCatalog | null;
  seats: OfficeSeat[];
  /** Area label → the Directories mapped to it (agents launched into them sit there). */
  areaDirectories: ReadonlyMap<string, Array<{ name: string; path: string | null }>>;
}

/** What the office can draw: furniture plus the counted looks a layout refers to by index. */
export interface OfficeAssets {
  catalog: FurnitureCatalog | null;
  /** Loaded floor patterns (floor_N.png); a floor tile's pattern is 1..floorPatterns. */
  floorPatterns: number;
  /** Loaded wall sets (wall_N.png), indexed 0..wallSets-1. */
  wallSets: number;
  /** Loaded carpet variants (carpet_N.png), indexed 0..carpets-1. */
  carpets: number;
  /** Loaded pets, by petType (the array index). */
  pets: Array<{ id: string; name: string }>;
}

/** Who is in the office (list_agents, and the caller check on every request). */
export interface AgentsView {
  /** Every agent in the office, sub-agents excluded (they are not agents of their own). */
  listAgents(): OfficeAgent[];
  /** Whether an agent with this id is in the office. */
  hasAgent(id: number): boolean;
}

/** The layout: read, described, and edited by agents. */
export interface LayoutOps {
  /** The layout with its seats and Area ↔ Directory mappings, or null when the office has none. */
  getLayout(): OfficeLayoutSnapshot | null;
  /** The furniture catalogue and the floor patterns, wall sets, carpets and pets loaded. */
  getAssets(): OfficeAssets;
  /** Apply `agentId`'s batch of layout ops: all or none, saved once, shown in every office
   *  (layoutEdits.ts). Refused while an office's layout editor has unsaved changes. */
  editLayout(agentId: number, ops: readonly LayoutOp[]): LayoutEditOutcome;
  /** Restore the layout before the newest agent edit; refused when it changed since, or
   *  while an office's layout editor has unsaved changes. */
  undoLayoutEdit(): LayoutUndoOutcome;
}

/** Everything the tools may call, by capability: a tool names the ones it uses
 *  (`uses`), and the MCP offers a tool only where its surface supplies them. */
export interface OfficeCapabilities {
  agents: AgentsView;
  layout: LayoutOps;
}

export type Capability = keyof OfficeCapabilities;

/** What a surface's office supplies: every capability. */
export type OfficeOperations = Pick<OfficeCapabilities, 'agents' | 'layout'>;

/** What a tool answers for an agent id that is not in the office. */
export function noAgentReason(id: number): string {
  return `There is no agent ${id} in the office: see list_agents for who is.`;
}
