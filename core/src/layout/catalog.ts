/**
 * The furniture catalogue's data side: entries, rotation groups, state (on/off)
 * groups and animation groups, built from catalogue data alone (no sprites).
 *
 * A catalogue is a value: build it once with createFurnitureCatalog and pass it
 * to the layout operations. The webview keeps one in module state and adds its
 * sprites to the entries (office/layout/furnitureCatalog.ts); the server builds
 * one from the furniture-catalog it already loads.
 */

import type { FurnitureInteractive } from '../furniture/interactive.js';

export type FurnitureCategory =
  'desks' | 'chairs' | 'storage' | 'decor' | 'electronics' | 'wall' | 'misc';

/** The catalogue data one asset contributes — what the server's asset loader
 *  (core/src/assets CatalogEntry) and the webview's loaded assets both carry. */
export interface CatalogSource {
  id: string;
  label: string;
  category: string;
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
  /** The furniture's validated `interactive` block (furniture/interactive.ts), on every asset of it. */
  interactive?: FurnitureInteractive;
}

/** One furniture type as the layout rules see it. */
export interface CatalogItem {
  type: string; // asset ID from furniture manifest
  label: string;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  category: FurnitureCategory;
  /** Orientation from rotation group: 'front' | 'back' | 'left' | 'right' */
  orientation?: string;
  /** Whether this item can be placed on top of desk/table surfaces */
  canPlaceOnSurfaces?: boolean;
  /** Number of tile rows from the top of the footprint that are "background" (allow placement, still block walking). Default 0. */
  backgroundTiles?: number;
  /** Whether this item can be placed on wall tiles */
  canPlaceOnWalls?: boolean;
  /** Whether this is a side-oriented asset that produces a mirrored "left" variant */
  mirrorSide?: boolean;
  /** How the furniture takes part in the office (furniture/interactive.ts); absent = plain furniture. */
  interactive?: FurnitureInteractive;
}

// ── Rotation groups ──────────────────────────────────────────────
// Flexible rotation: supports 2+ orientations (not just all 4)
export interface RotationGroup {
  /** Ordered list of orientations available for this group */
  orientations: string[];
  /** Maps orientation → asset ID (for the default/off state) */
  members: Record<string, string>;
}

/**
 * A built catalogue. `E` is the entry type: CatalogItem on the server, the
 * webview's sprite-carrying entry there.
 */
export interface FurnitureCatalog<E extends CatalogItem = CatalogItem> {
  /** Every entry, all variants (non-front rotations, on states, ":left" mirrors), by type. */
  readonly entries: ReadonlyMap<string, E>;
  /** The entries an editor palette offers: front (or ungrouped) off-state variants. */
  readonly visible: readonly E[];
  /** The categories `visible` uses, sorted. */
  readonly categories: readonly FurnitureCategory[];
  /** Any member asset ID → its rotation group. */
  readonly rotationGroups: ReadonlyMap<string, RotationGroup>;
  /** Asset ID → its on/off counterpart (symmetric). */
  readonly stateGroups: ReadonlyMap<string, string>;
  /** Off asset → on asset. */
  readonly offToOn: ReadonlyMap<string, string>;
  /** Any asset with a declared state → its furniture's variants in the same orientation,
   *  by state (an animated state by its first frame). */
  readonly stateVariants: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Animation group ID → its asset IDs by frame index. */
  readonly animationGroups: ReadonlyMap<string, readonly string[]>;
}

export const FURNITURE_CATEGORIES: Array<{ id: FurnitureCategory; label: string }> = [
  { id: 'desks', label: 'Desks' },
  { id: 'chairs', label: 'Chairs' },
  { id: 'storage', label: 'Storage' },
  { id: 'electronics', label: 'Tech' },
  { id: 'decor', label: 'Decor' },
  { id: 'wall', label: 'Wall' },
  { id: 'misc', label: 'Misc' },
];

/** A catalogue with nothing in it: every type unknown, nothing rotates or toggles. */
export function emptyFurnitureCatalog<E extends CatalogItem = CatalogItem>(): FurnitureCatalog<E> {
  return {
    entries: new Map(),
    visible: [],
    categories: [],
    rotationGroups: new Map(),
    stateGroups: new Map(),
    offToOn: new Map(),
    stateVariants: new Map(),
    animationGroups: new Map(),
  };
}

/** The data-only entry an asset makes. */
export function catalogItemOf(asset: CatalogSource): CatalogItem {
  return {
    type: asset.id,
    label: asset.label,
    footprintW: asset.footprintW,
    footprintH: asset.footprintH,
    isDesk: asset.isDesk,
    category: asset.category as FurnitureCategory,
    ...(asset.orientation ? { orientation: asset.orientation } : {}),
    ...(asset.canPlaceOnSurfaces ? { canPlaceOnSurfaces: true } : {}),
    ...(asset.backgroundTiles ? { backgroundTiles: asset.backgroundTiles } : {}),
    ...(asset.canPlaceOnWalls ? { canPlaceOnWalls: true } : {}),
    ...(asset.mirrorSide ? { mirrorSide: true } : {}),
    ...(asset.interactive ? { interactive: asset.interactive } : {}),
  };
}

/**
 * Build a catalogue from catalogue data. `toEntry` turns each asset's data-only
 * entry into the caller's entry type, or drops it (null) — the webview attaches
 * the sprite there and drops assets without one. Rotation, state and animation
 * groups are built from all of `assets` either way. Null when no entry is left.
 */
export function createFurnitureCatalog(assets: readonly CatalogSource[]): FurnitureCatalog | null;
export function createFurnitureCatalog<E extends CatalogItem>(
  assets: readonly CatalogSource[],
  toEntry: (item: CatalogItem, asset: CatalogSource) => E | null,
): FurnitureCatalog<E> | null;
export function createFurnitureCatalog<E extends CatalogItem>(
  assets: readonly CatalogSource[],
  toEntry: (item: CatalogItem, asset: CatalogSource) => E | null = (item) => item as E,
): FurnitureCatalog<E> | null {
  // Build all entries (including non-front variants)
  const allEntries = assets
    .map((asset) => toEntry(catalogItemOf(asset), asset))
    .filter((e): e is E => e !== null);

  // Create virtual ":left" entries for mirrorSide assets.
  // These share the same sprite but have a distinct type ID so rotation groups work.
  for (const asset of assets) {
    if (asset.mirrorSide && asset.orientation === 'side') {
      const sideEntry = allEntries.find((e) => e.type === asset.id);
      if (sideEntry) {
        allEntries.push({
          ...sideEntry,
          type: `${asset.id}:left`,
          orientation: 'left',
          mirrorSide: true,
        });
      }
    }
  }

  if (allEntries.length === 0) return null;

  const rotationGroups = new Map<string, RotationGroup>();
  const stateGroups = new Map<string, string>();
  const offToOn = new Map<string, string>();
  const animationGroups = new Map<string, string[]>();

  // Phase 1: Collect orientations per group (only "off" or stateless variants for rotation)
  // For mirrorSide assets with orientation "side", register as both "right" and virtual "left"
  const groupMap = new Map<string, Map<string, string>>(); // groupId → (orientation → assetId)
  for (const asset of assets) {
    if (asset.groupId && asset.orientation) {
      // For rotation groups, only use the "off" or stateless variant
      if (asset.state && asset.state !== 'off') continue;
      let orientMap = groupMap.get(asset.groupId);
      if (!orientMap) {
        orientMap = new Map();
        groupMap.set(asset.groupId, orientMap);
      }

      if (asset.orientation === 'side') {
        // "side" is registered as "right" in the rotation group
        orientMap.set('right', asset.id);
        if (asset.mirrorSide) {
          // Register the virtual ":left" entry with a distinct type ID
          orientMap.set('left', `${asset.id}:left`);
        }
      } else {
        orientMap.set(asset.orientation, asset.id);
      }
    }
  }

  // For 2-way rotation schemes, "side" maps to "right" only (no left)
  // Check rotationScheme from assets
  const rotationSchemes = new Map<string, string>(); // groupId → rotationScheme
  for (const asset of assets) {
    if (asset.groupId && asset.rotationScheme) {
      rotationSchemes.set(asset.groupId, asset.rotationScheme);
    }
  }

  // Phase 2: Register rotation groups with 2+ orientations
  const nonFrontIds = new Set<string>();
  const orientationOrder = ['front', 'right', 'back', 'left'];
  for (const [groupId, orientMap] of groupMap) {
    if (orientMap.size < 2) continue;
    const scheme = rotationSchemes.get(groupId);

    // For 2-way scheme, only use front and right (side)
    let allowedOrients = orientationOrder;
    if (scheme === '2-way') {
      allowedOrients = ['front', 'right'];
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
      if (orient !== 'front') nonFrontIds.add(id);
    }
  }

  // Phase 3: Build state groups (on ↔ off pairs within same groupId + orientation)
  const stateMap = new Map<string, Map<string, string>>(); // "groupId|orientation" → (state → assetId)
  for (const asset of assets) {
    if (asset.groupId && asset.state) {
      const key = `${asset.groupId}|${asset.orientation || ''}`;
      let sm = stateMap.get(key);
      if (!sm) {
        sm = new Map();
        stateMap.set(key, sm);
      }
      // For animation groups, use the first frame as the "on" representative
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) continue;
      sm.set(asset.state, asset.id);
    }
  }
  const stateVariants = new Map<string, ReadonlyMap<string, string>>();
  for (const asset of assets) {
    if (!asset.groupId || !asset.state) continue;
    const sm = stateMap.get(`${asset.groupId}|${asset.orientation || ''}`);
    if (sm) stateVariants.set(asset.id, sm);
  }
  for (const sm of stateMap.values()) {
    const onId = sm.get('on');
    const offId = sm.get('off');
    if (onId && offId) {
      stateGroups.set(onId, offId);
      stateGroups.set(offId, onId);
      offToOn.set(offId, onId);
    }
  }

  // Also register rotation groups for "on" state variants (so rotation works on on-state items too)
  for (const asset of assets) {
    if (asset.groupId && asset.orientation && asset.state === 'on') {
      // Skip non-first animation frames
      if (asset.animationGroup && asset.frame !== undefined && asset.frame > 0) continue;

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
  const animGroupCollector = new Map<string, Array<{ id: string; frame: number }>>();
  for (const asset of assets) {
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
  for (const asset of assets) {
    if (asset.state === 'on') onStateIds.add(asset.id);
  }

  // Visible catalog: exclude non-front variants and "on" state variants
  const visible = allEntries.filter((e) => !nonFrontIds.has(e.type) && !onStateIds.has(e.type));

  // Strip orientation/state suffix from labels for grouped variants. The
  // entries are shared with `entries`, so lookups see the stripped label too.
  for (const entry of visible) {
    if (rotationGroups.has(entry.type) || stateGroups.has(entry.type)) {
      entry.label = entry.label
        .replace(/ - Front - Off$/, '')
        .replace(/ - Front$/, '')
        .replace(/ - Off$/, '');
    }
  }

  // All variants by type; the first entry of a type wins, as a lookup by find did.
  const entries = new Map<string, E>();
  for (const e of allEntries) if (!entries.has(e.type)) entries.set(e.type, e);

  const categories = Array.from(new Set(visible.map((e) => e.category)))
    .filter((c): c is FurnitureCategory => !!c)
    .sort();

  return {
    entries,
    visible,
    categories,
    rotationGroups,
    stateGroups,
    offToOn,
    stateVariants,
    animationGroups,
  };
}

/** A furniture type's entry (any variant), or undefined for an unknown type. */
export function catalogEntry<E extends CatalogItem>(
  catalog: FurnitureCatalog<E>,
  type: string,
): E | undefined {
  return catalog.entries.get(type);
}

/** The palette's entries of one category. */
export function catalogByCategory<E extends CatalogItem>(
  catalog: FurnitureCatalog<E>,
  category: FurnitureCategory,
): E[] {
  return catalog.visible.filter((e) => e.category === category);
}

/** The categories the palette shows, in their tab order, with labels. */
export function activeCategories(
  catalog: FurnitureCatalog,
): Array<{ id: FurnitureCategory; label: string }> {
  return FURNITURE_CATEGORIES.filter((c) => catalog.categories.includes(c.id));
}

// ── Rotation and state helpers ───────────────────────────────────

/** Returns the next asset ID in the rotation group (cw or ccw), or null if not rotatable. */
export function rotatedType(
  catalog: FurnitureCatalog,
  currentType: string,
  direction: 'cw' | 'ccw',
): string | null {
  const group = catalog.rotationGroups.get(currentType);
  if (!group) return null;
  const order = group.orientations.map((o) => group.members[o]);
  const idx = order.indexOf(currentType);
  if (idx === -1) return null;
  const step = direction === 'cw' ? 1 : -1;
  const nextIdx = (idx + step + order.length) % order.length;
  return order[nextIdx];
}

/** Returns the toggled state variant (on↔off), or null if no state variant exists. */
export function toggledType(catalog: FurnitureCatalog, currentType: string): string | null {
  return catalog.stateGroups.get(currentType) ?? null;
}

/**
 * The variant of a type's furniture showing `state` in the same orientation (an
 * animated state by its first frame), or null when the furniture has no art for
 * that state there: the piece then shows its usual sprite.
 */
export function stateVariantOf(
  catalog: FurnitureCatalog,
  type: string,
  state: string,
): string | null {
  return catalog.stateVariants.get(type)?.get(state) ?? null;
}

/** Returns true if the given furniture type is part of a rotation group. */
export function isRotatableType(catalog: FurnitureCatalog, type: string): boolean {
  return catalog.rotationGroups.has(type);
}

/** Get ordered animation frame asset IDs for a given type, or null if not animated. */
export function animationFramesOf(
  catalog: FurnitureCatalog,
  type: string,
): readonly string[] | null {
  for (const frames of catalog.animationGroups.values()) {
    if (frames.includes(type)) return frames;
  }
  return null;
}

/**
 * Get the orientation of a type within its rotation group, or undefined if not in a group.
 * Used by the renderer to determine if a "left" orientation should be mirrored.
 */
export function orientationInGroup(catalog: FurnitureCatalog, type: string): string | undefined {
  const group = catalog.rotationGroups.get(type);
  if (!group) return undefined;
  for (const [orient, id] of Object.entries(group.members)) {
    if (id === type) return orient;
  }
  return undefined;
}
