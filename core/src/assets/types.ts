/**
 * Asset pipeline types — shared between the extension host, Vite build
 * scripts, browser mock, and future standalone backends.
 */

export interface CharacterDirectionSprites {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface AssetIndex {
  floors: string[];
  walls: string[];
  characters: string[];
  defaultLayout: string | null;
}

export interface CatalogEntry {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  furniturePath: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  groupId?: string;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
}

export interface PetSpriteFrames {
  /** 3 frames of 16×32 — pet walking toward viewer (south). */
  walkDown: string[][][];
  /** 3 frames of 16×32 — pet idle facing viewer (south). */
  idleDown: string[][][];
  /** 3 frames of 16×32 — pet walking away from viewer (north). */
  walkUp: string[][][];
  /** 3 frames of 16×32 — pet idle facing away (north). */
  idleUp: string[][][];
  /** 3 frames of 32×32 — pet walking east. Left = horizontal flip at render time. */
  walkRight: string[][][];
}

export interface PetManifest {
  id: string;
  name: string;
}
