import type { FurnitureCatalogEntry, SpriteData } from "../types.js";

export interface LoadedAssetData {
  catalog: Array<{
    id: string;
    label: string;
    category: string;
    width: number;
    height: number;
    footprintW: number;
    footprintH: number;
    isDesk: boolean;
    groupId?: string;
    orientation?: string; // 'front' | 'back' | 'left' | 'right' | 'side'
    state?: string; // 'on' | 'off'
    canPlaceOnSurfaces?: boolean;
    backgroundTiles?: number;
    canPlaceOnWalls?: boolean;
    mirrorSide?: boolean;
    rotationScheme?: string;
    animationGroup?: string;
    frame?: number;
  }>;
  sprites: Record<string, SpriteData>;
}

export type FurnitureCategory =
  | "desks"
  | "chairs"
  | "storage"
  | "decor"
  | "electronics"
  | "wall"
  | "misc";

/** @internal */
export interface CatalogEntryWithCategory extends FurnitureCatalogEntry {
  category: FurnitureCategory;
}

// ── Rotation groups ──────────────────────────────────────────────
// Flexible rotation: supports 2+ orientations (not just all 4)
interface RotationGroup {
  /** Ordered list of orientations available for this group */
  orientations: string[];
  /** Maps orientation → asset ID (for the default/off state) */
  members: Record<string, string>;
}

// Maps any member asset ID → its rotation group
const rotationGroups = new Map<string, RotationGroup>();

// ── State groups ────────────────────────────────────────────────
// Maps asset ID → its on/off counterpart (symmetric for toggle)
const stateGroups = new Map<string, string>();
// Directional maps for getOnStateType / getOffStateType
const offToOn = new Map<string, string>(); // off asset → on asset
const onToOff = new Map<string, string>(); // on asset → off asset

// ── Animation groups ────────────────────────────────────────────
// Maps animation group ID → ordered list of asset IDs by frame index
const animationGroups = new Map<string, string[]>();

// Internal catalog (includes all variants for getCatalogEntry lookups)
let internalCatalog: CatalogEntryWithCategory[] | null = null;

// Dynamic catalog built from loaded assets (when available)
// Only includes "front" variants for grouped items (shown in editor palette)
let dynamicCatalog: CatalogEntryWithCategory[] | null = null;
let dynamicCategories: FurnitureCategory[] | null = null;

/**
 * Build catalog from loaded assets. Returns true if successful.
 * Once built, all getCatalog* functions use the dynamic catalog.
 * Uses ONLY custom assets (excludes hardcoded furniture when assets are loaded).
 */
export function buildDynamicCatalog(assets: LoadedAssetData): boolean {
  if (!assets?.catalog || !assets?.sprites) return false;

  // Build all entries (including non-front variants)
  const allEntries = assets.catalog
    .map((asset) => {
      const sprite = assets.sprites[asset.id];
      if (!sprite) {
        console.warn(`No sprite data for asset ${asset.id}`);
        return null;
      }
      return {
        type: asset.id,
        label: asset.label,
        footprintW: asset.footprintW,
        footprintH: asset.footprintH,
        sprite,
        isDesk: asset.isDesk,
        category: asset.category as FurnitureCategory,
        ...(asset.orientation ? { orientation: asset.orientation } : {}),
        ...(asset.canPlaceOnSurfaces ? { canPlaceOnSurfaces: true } : {}),
        ...(asset.backgroundTiles
          ? { backgroundTiles: asset.backgroundTiles }
          : {}),
        ...(asset.canPlaceOnWalls ? { canPlaceOnWalls: true } : {}),
        ...(asset.mirrorSide ? { mirrorSide: true } : {}),
      };
    })
    .filter((e): e is CatalogEntryWithCategory => e !== null);

  // Create virtual ":left" entries for mirrorSide assets.
  // These share the same sprite but have a distinct type ID so rotation groups work.
  for (const asset of assets.catalog) {
    if (asset.mirrorSide && asset.orientation === "side") {
      const sideEntry = allEntries.find((e) => e.type === asset.id);
      if (sideEntry) {
        allEntries.push({
          ...sideEntry,
          type: `${asset.id}:left`,
          orientation: "left",
          mirrorSide: true,
        });
      }
    }
  }

  if (allEntries.length === 0) return false;

  // Build rotation groups from groupId + orientation metadata
  rotationGroups.clear();
  stateGroups.clear();
  offToOn.clear();
  onToOff.clear();
  animationGroups.clear();

  // Phase 1: Collect orientations per group (only "off" or stateless variants for rotation)
  // For mirrorSide assets with orientation "side", register as both "right" and virtual "left"
  const groupMap = new Map<string, Map<string, string>>(); // groupId → (orientation → assetId)
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.orientation) {
      // For rotation groups, only use the "off" or stateless variant
      if (asset.state && asset.state !== "off") continue;
      let orientMap = groupMap.get(asset.groupId);
      if (!orientMap) {
        orientMap = new Map();
        groupMap.set(asset.groupId, orientMap);
      }

      if (asset.orientation === "side") {
        // "side" is registered as "right" in the rotation group
        orientMap.set("right", asset.id);
        if (asset.mirrorSide) {
          // Register the virtual ":left" entry with a distinct type ID
          orientMap.set("left", `${asset.id}:left`);
        }
      } else {
        orientMap.set(asset.orientation, asset.id);
      }
    }
  }

  // For 2-way rotation schemes, "side" maps to "right" only (no left)
  // Check rotationScheme from assets
  const rotationSchemes = new Map<string, string>(); // groupId → rotationScheme
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.rotationScheme) {
      rotationSchemes.set(asset.groupId, asset.rotationScheme);
    }
  }

  // Phase 2: Register rotation groups with 2+ orientations
  const nonFrontIds = new Set<string>();
  const orientationOrder = ["front", "right", "back", "left"];
  for (const [groupId, orientMap] of groupMap) {
    if (orientMap.size < 2) continue;
    const scheme = rotationSchemes.get(groupId);

    // For 2-way scheme, only use front and right (side)
    let allowedOrients = orientationOrder;
    if (scheme === "2-way") {
      allowedOrients = ["front", "right"];
    }

    // Build ordered list of available orientations
    const orderedOrients = allowedOrients.filter((o) => orientMap.has(o));
    if (orderedOrients.length < 2) continue;
    const members: Record<string, string> = {};
    for (const o of orderedOrients) {
      members[o] = orientMap.get(o)!;
    }
    const rg: RotationGroup = { orientations: orderedOrients, members };
    // Register each unique asset ID in the rotation group
    const registeredIds = new Set<string>();
    for (const id of Object.values(members)) {
      if (!registeredIds.has(id)) {
        rotationGroups.set(id, rg);
        registeredIds.add(id);
      }
    }
    // Track non-front IDs to exclude from visible catalog
    for (const [orient, id] of Object.entries(members)) {
      if (orient !== "front") nonFrontIds.add(id);
    }
  }

  // Phase 3: Build state groups (on ↔ off pairs within same groupId + orientation)
  const stateMap = new Map<string, Map<string, string>>(); // "groupId|orientation" → (state → assetId)
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.state) {
      const key = `${asset.groupId}|${asset.orientation || ""}`;
      let sm = stateMap.get(key);
      if (!sm) {
        sm = new Map();
        stateMap.set(key, sm);
      }
      // For animation groups, use the first frame as the "on" representative
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0)
        continue;
      sm.set(asset.state, asset.id);
    }
  }
  for (const sm of stateMap.values()) {
    const onId = sm.get("on");
    const offId = sm.get("off");
    if (onId && offId) {
      stateGroups.set(onId, offId);
      stateGroups.set(offId, onId);
      offToOn.set(offId, onId);
      onToOff.set(onId, offId);
    }
  }

  // Also register rotation groups for "on" state variants (so rotation works on on-state items too)
  for (const asset of assets.catalog) {
    if (asset.groupId && asset.orientation && asset.state === "on") {
      // Skip non-first animation frames
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0)
        continue;

      // Find the off-variant's rotation group
      const offCounterpart = stateGroups.get(asset.id);
      if (offCounterpart) {
        const offGroup = rotationGroups.get(offCounterpart);
        if (offGroup) {
          // Build an equivalent group for the "on" state
          const onMembers: Record<string, string> = {};
          for (const orient of offGroup.orientations) {
            const offId = offGroup.members[orient];
            const onId = stateGroups.get(offId);
            // Use on-state variant if available, otherwise fall back to off-state
            onMembers[orient] = onId ?? offId;
          }
          const onGroup: RotationGroup = {
            orientations: offGroup.orientations,
            members: onMembers,
          };
          for (const id of Object.values(onMembers)) {
            if (!rotationGroups.has(id)) {
              rotationGroups.set(id, onGroup);
            }
          }
        }
      }
    }
  }

  // Phase 4: Build animation groups
  const animGroupCollector = new Map<
    string,
    Array<{ id: string; frame: number }>
  >();
  for (const asset of assets.catalog) {
    if (asset.animationGroup && asset.frame !== undefined) {
      let frames = animGroupCollector.get(asset.animationGroup);
      if (!frames) {
        frames = [];
        animGroupCollector.set(asset.animationGroup, frames);
      }
      frames.push({ id: asset.id, frame: asset.frame });
    }
  }
  for (const [groupId, frames] of animGroupCollector) {
    frames.sort((a, b) => a.frame - b.frame);
    animationGroups.set(
      groupId,
      frames.map((f) => f.id),
    );
  }

  // Track "on" variant IDs and animation frame IDs (non-first) to exclude from visible catalog
  const onStateIds = new Set<string>();
  for (const asset of assets.catalog) {
    if (asset.state === "on") onStateIds.add(asset.id);
  }

  // Store full internal catalog (all variants — for getCatalogEntry lookups)
  internalCatalog = allEntries;

  // Visible catalog: exclude non-front variants and "on" state variants
  const visibleEntries = allEntries.filter(
    (e) => !nonFrontIds.has(e.type) && !onStateIds.has(e.type),
  );

  // Strip orientation/state suffix from labels for grouped variants
  for (const entry of visibleEntries) {
    if (rotationGroups.has(entry.type) || stateGroups.has(entry.type)) {
      entry.label = entry.label
        .replace(/ - Front - Off$/, "")
        .replace(/ - Front$/, "")
        .replace(/ - Off$/, "");
    }
  }

  dynamicCatalog = visibleEntries;
  dynamicCategories = Array.from(new Set(visibleEntries.map((e) => e.category)))
    .filter((c): c is FurnitureCategory => !!c)
    .sort();

  const rotGroupCount = new Set(Array.from(rotationGroups.values())).size;
  const animGroupCount = animationGroups.size;
  console.log(
    `✓ Built dynamic catalog with ${allEntries.length} assets (${visibleEntries.length} visible, ${rotGroupCount} rotation groups, ${stateGroups.size / 2} state pairs, ${animGroupCount} animation groups)`,
  );
  return true;
}

export function getCatalogEntry(
  type: string,
): CatalogEntryWithCategory | undefined {
  // Check internal catalog (includes all variants, e.g., non-front rotations)
  if (internalCatalog) {
    return internalCatalog.find((e) => e.type === type);
  }
  return dynamicCatalog?.find((e) => e.type === type);
}

export function getCatalogByCategory(
  category: FurnitureCategory,
): CatalogEntryWithCategory[] {
  const catalog = dynamicCatalog ?? [];
  return catalog.filter((e) => e.category === category);
}

/* Currently unused since the editor palette is organized by category. */
// function getActiveCatalog(): CatalogEntryWithCategory[] {
//   return dynamicCatalog ?? [];
// }

export function getActiveCategories(): Array<{
  id: FurnitureCategory;
  label: string;
}> {
  const categories = dynamicCategories ?? [];
  return FURNITURE_CATEGORIES.filter((c) => categories.includes(c.id));
}

/** @internal */
export const FURNITURE_CATEGORIES: Array<{
  id: FurnitureCategory;
  label: string;
}> = [
  { id: "desks", label: "Desks" },
  { id: "chairs", label: "Chairs" },
  { id: "storage", label: "Storage" },
  { id: "electronics", label: "Tech" },
  { id: "decor", label: "Decor" },
  { id: "wall", label: "Wall" },
  { id: "misc", label: "Misc" },
];

// ── Rotation helpers ─────────────────────────────────────────────

/** Returns the next asset ID in the rotation group (cw or ccw), or null if not rotatable. */
export function getRotatedType(
  currentType: string,
  direction: "cw" | "ccw",
): string | null {
  const group = rotationGroups.get(currentType);
  if (!group) return null;
  const order = group.orientations.map((o) => group.members[o]);
  const idx = order.indexOf(currentType);
  if (idx === -1) return null;
  const step = direction === "cw" ? 1 : -1;
  const nextIdx = (idx + step + order.length) % order.length;
  return order[nextIdx];
}

/** Returns the toggled state variant (on↔off), or null if no state variant exists. */
export function getToggledType(currentType: string): string | null {
  return stateGroups.get(currentType) ?? null;
}

/** Returns the "on" variant if this type has one, otherwise returns the type unchanged. */
export function getOnStateType(currentType: string): string {
  return offToOn.get(currentType) ?? currentType;
}

/** Returns the "off" variant if this type has one, otherwise returns the type unchanged - unused */
// function getOffStateType(currentType: string): string {
//   return onToOff.get(currentType) ?? currentType;
// }

/** Returns true if the given furniture type is part of a rotation group. */
export function isRotatable(type: string): boolean {
  return rotationGroups.has(type);
}

/** Get ordered animation frame asset IDs for a given type, or null if not animated. */
export function getAnimationFrames(type: string): string[] | null {
  // Find the animation group this type belongs to
  for (const [, frames] of animationGroups) {
    if (frames.includes(type)) return frames;
  }
  return null;
}

/**
 * Get the orientation of a type within its rotation group, or undefined if not in a group.
 * Used by the renderer to determine if a "left" orientation should be mirrored.
 */
export function getOrientationInGroup(type: string): string | undefined {
  const group = rotationGroups.get(type);
  if (!group) return undefined;
  for (const [orient, id] of Object.entries(group.members)) {
    if (id === type) return orient;
  }
  return undefined;
}
