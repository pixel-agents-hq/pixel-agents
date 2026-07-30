/**
 * Shared data types used across extension, server, and webview.
 * Extracted from src/types.ts, webview-ui/src/office/types.ts, shared/assets/types.ts.
 *
 * This is the core package's public contract, so every type here is exported whether or
 * not it currently has an importer: some are mirrored by local copies (webview-ui keeps
 * its own OfficeLayout/SpriteData) and some describe wire/persistence shapes consumed
 * across the process boundary. Deleting one because knip reports it unused would break
 * the contract, hence the @public tags.
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
  /** Live background-spawn tool ids on a lead. Persisted so the spawns'
   *  transcripts are re-adopted after a reload; the spawned children
   *  themselves are derived state and never persisted. */
  backgroundAgentToolIds?: string[];
}

/** Agent seat assignment with visual identity
 *
 * @public
 */
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

/** Complete office layout data
 *
 * @public
 */
export interface OfficeLayout {
  version: number;
  cols: number;
  rows: number;
  tiles: number[];
  furniture: PlacedFurniture[];
  tileColors?: FloorColor[];
}

// ── Sprites & Assets ─────────────────────────────────────────

/** 2D array of hex color strings: '' = transparent, '#RRGGBB' = opaque, '#RRGGBBAA' = semi-transparent
 *
 * @public
 */
export type SpriteData = string[][];

/** Furniture catalog entry (from furniture-catalog.json)
 *
 * @public
 */
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

/** Raw hook event received from any provider's hook script via HTTP server
 *
 * @public
 */
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  [key: string]: unknown;
}

// ── Disposable ───────────────────────────────────────────────

/** Generic disposable pattern (matches VS Code's Disposable)
 *
 * @public
 */
export interface Disposable {
  dispose(): void;
}
