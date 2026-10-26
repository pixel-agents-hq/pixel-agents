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
  directoryName?: string;
  /** Pre-Directory spelling of `directoryName`, written by releases up to
   *  v1.4.x. Read as a fallback on restore; never written. */
  folderName?: string;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
  /** A lead's live background spawns: the tool id each runs under, plus the
   *  agent (task) id the CLI gave it when known. Persisted so the spawns'
   *  transcripts are re-adopted after a reload and their completion still
   *  matches (an agent revived by SendMessage is tied to its transcript only
   *  by the task id); the spawned children themselves are derived state and
   *  never persisted. */
  backgroundSpawns?: { toolId: string; taskId?: string }[];
  /** Pre-`backgroundSpawns` form (tool ids only), written by releases up to
   *  v1.5.x. Read on restore; never written. */
  backgroundAgentToolIds?: string[];
  /** Preferred character palette (0-5). Persisted so colors stay stable
   *  across server restarts; assignPaletteIfNeeded is a no-op on restore. */
  palette?: number;
  /** Which copy of its character the agent is (core paletteUtils Look): 0 or
   *  absent = the character as drawn, n = its nth repeat. Persisted alongside palette. */
  repeat?: number;
  /** Older forms of `repeat`, in degrees: `clothesHue` (a clothes colour) and,
   *  up to v1.5.x, `hueShift` (a whole-sprite hue shift). Read on restore as
   *  "a repeat" (non-zero = 1); never written. */
  clothesHue?: number;
  hueShift?: number;
}

/** Agent seat assignment with visual identity
 *
 * @public
 */
export interface AgentMeta {
  palette: number;
  repeat: number;
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
