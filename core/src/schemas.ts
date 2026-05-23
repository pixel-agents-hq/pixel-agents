/**
 * Shared data types used across extension, server, and webview.
 * Extracted from src/types.ts, webview-ui/src/office/types.ts, shared/assets/types.ts.
 */

// ── Agent State ──────────────────────────────────────────────

/** Persisted agent data (survives F5 reload / restart) */
export interface PersistedAgent {
  id: number;
  sessionId?: string;
  terminalName: string;
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  folderName?: string;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
  hooksOnly?: boolean;
  providerId?: string;
}

/** Agent seat assignment with visual identity */
export interface AgentMeta {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

// ── Layout ───────────────────────────────────────────────────

/** Color value for floor/wall/furniture colorization */
export interface ColorValue {
  h: number;
  s: number;
  b: number;
  c: number;
  colorize?: boolean;
}

/** A placed furniture item in the layout */
export interface PlacedFurniture {
  type: string;
  uid: string;
  col: number;
  row: number;
  color?: ColorValue;
}

/** Floor color for a specific tile */
export interface FloorColor {
  tileIndex: number;
  pattern: number;
  h: number;
  s: number;
  b: number;
  c: number;
  colorize?: boolean;
}

/** Complete office layout data */
export interface OfficeLayout {
  version: number;
  cols: number;
  rows: number;
  tiles: number[];
  furniture: PlacedFurniture[];
  tileColors?: FloorColor[];
}

// ── Sprites & Assets ─────────────────────────────────────────

/** 2D array of hex color strings: '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent */
export type SpriteData = string[][];

/** Furniture catalog entry (from furniture-catalog.json) */
export interface FurnitureCatalogEntry {
  id: string;
  name: string;
  label: string;
  category: string;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

// ── Hook Events ──────────────────────────────────────────────

/** Raw hook event received from any provider's hook script via HTTP server */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  [key: string]: unknown;
}

// ── Disposable ───────────────────────────────────────────────

/** Generic disposable pattern (matches VS Code's Disposable) */
export interface Disposable {
  dispose(): void;
}
