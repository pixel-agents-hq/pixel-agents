/**
 * The webview's furniture catalogue: core's catalogue (layout/catalog.ts) built
 * from the loaded assets, each entry carrying its sprite, held in module state
 * so the editor and renderer can look types up without passing it around.
 * activeCatalog() hands the same value to core's layout operations.
 */

import {
  activeCategories,
  animationFramesOf,
  catalogByCategory,
  catalogEntry,
  type CatalogSource,
  createFurnitureCatalog,
  emptyFurnitureCatalog,
  FURNITURE_CATEGORIES,
  type FurnitureCatalog,
  type FurnitureCategory,
  isRotatableType,
  orientationInGroup,
  rotatedType,
  stateVariantOf,
  toggledType,
} from '../../../../core/src/layout/catalog.js';
import type { FurnitureCatalogEntry, SpriteData } from '../types.js';

export { FURNITURE_CATEGORIES, type FurnitureCategory };

export interface LoadedAssetData {
  catalog: Array<CatalogSource & { width: number; height: number }>;
  sprites: Record<string, SpriteData>;
}

/** @internal */
export interface CatalogEntryWithCategory extends FurnitureCatalogEntry {
  category: FurnitureCategory;
}

let catalog: FurnitureCatalog<CatalogEntryWithCategory> =
  emptyFurnitureCatalog<CatalogEntryWithCategory>();

/** The catalogue built last (empty until assets load), for core's layout operations. */
export function activeCatalog(): FurnitureCatalog<CatalogEntryWithCategory> {
  return catalog;
}

/**
 * Build catalog from loaded assets. Returns true if successful.
 * Once built, all getCatalog* functions use the dynamic catalog.
 * Uses ONLY custom assets (excludes hardcoded furniture when assets are loaded).
 */
export function buildDynamicCatalog(assets: LoadedAssetData): boolean {
  if (!assets?.catalog || !assets?.sprites) return false;

  const built = createFurnitureCatalog<CatalogEntryWithCategory>(assets.catalog, (item, asset) => {
    const sprite = assets.sprites[asset.id];
    if (!sprite) {
      console.warn(`No sprite data for asset ${asset.id}`);
      return null;
    }
    return { ...item, sprite };
  });
  if (!built) return false;
  catalog = built;

  const rotGroupCount = new Set(Array.from(built.rotationGroups.values())).size;
  console.log(
    `✓ Built dynamic catalog with ${built.entries.size} assets (${built.visible.length} visible, ${rotGroupCount} rotation groups, ${built.stateGroups.size / 2} state pairs, ${built.animationGroups.size} animation groups)`,
  );
  return true;
}

export function getCatalogEntry(type: string): CatalogEntryWithCategory | undefined {
  return catalogEntry(catalog, type);
}

export function getCatalogByCategory(category: FurnitureCategory): CatalogEntryWithCategory[] {
  return catalogByCategory(catalog, category);
}

export function getActiveCategories(): Array<{ id: FurnitureCategory; label: string }> {
  return activeCategories(catalog);
}

// ── Rotation helpers ─────────────────────────────────────────────

/** Returns the next asset ID in the rotation group (cw or ccw), or null if not rotatable. */
export function getRotatedType(currentType: string, direction: 'cw' | 'ccw'): string | null {
  return rotatedType(catalog, currentType, direction);
}

/** Returns the toggled state variant (on↔off), or null if no state variant exists. */
export function getToggledType(currentType: string): string | null {
  return toggledType(catalog, currentType);
}

/** The type's variant showing `state` (core's stateVariantOf), or null when it has no art for it. */
export function getStateVariant(type: string, state: string): string | null {
  return stateVariantOf(catalog, type, state);
}

/** The type turned to face the viewer (its rotation group's `front`), or itself when it has none. */
export function getFrontType(type: string): string {
  return catalog.rotationGroups.get(type)?.members.front ?? type;
}

/** Returns true if the given furniture type is part of a rotation group. */
export function isRotatable(type: string): boolean {
  return isRotatableType(catalog, type);
}

/** Get ordered animation frame asset IDs for a given type, or null if not animated. */
export function getAnimationFrames(type: string): readonly string[] | null {
  return animationFramesOf(catalog, type);
}

/**
 * Get the orientation of a type within its rotation group, or undefined if not in a group.
 * Used by the renderer to determine if a "left" orientation should be mirrored.
 */
export function getOrientationInGroup(type: string): string | undefined {
  return orientationInGroup(catalog, type);
}
