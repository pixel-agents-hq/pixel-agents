/**
 * The webview's side of the layout model: furniture as renderable instances
 * (sprites, colours, z order). Everything else — tile map, blocked tiles, seats,
 * (de)serialization and migration — lives in core's layoutSerializer; the
 * catalogue-taking functions are bound here to the webview's catalogue.
 */

import {
  getBlockedTiles as coreGetBlockedTiles,
  getPlacementBlockedTiles as coreGetPlacementBlockedTiles,
  layoutToSeats as coreLayoutToSeats,
} from '../../../../core/src/layout/layoutSerializer.js';
import { getColorizedSprite } from '../colorize.js';
import type { FurnitureInstance, PlacedFurniture, Seat } from '../types.js';
import { TILE_SIZE } from '../types.js';
import { activeCatalog, getCatalogEntry, getOrientationInGroup } from './furnitureCatalog.js';

export {
  createDefaultLayout,
  deserializeLayout,
  getSeatTiles,
  layoutToTileMap,
  migrateLayoutColors,
  serializeLayout,
} from '../../../../core/src/layout/layoutSerializer.js';

/** Convert placed furniture into renderable FurnitureInstance[] */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  // Pre-compute desk zY per tile so surface items can sort in front of desks
  const deskZByTile = new Map<string, number>();
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry || !entry.isDesk) continue;
    const deskZY = item.row * TILE_SIZE + entry.sprite.length;
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`;
        const prev = deskZByTile.get(key);
        if (prev === undefined || deskZY > prev) deskZByTile.set(key, deskZY);
      }
    }
  }

  const instances: FurnitureInstance[] = [];
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type);
    if (!entry) continue;
    const x = item.col * TILE_SIZE;
    const y = item.row * TILE_SIZE;
    const spriteH = entry.sprite.length;
    let zY = y + spriteH;

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of the seated character
        // (the chair back visually occludes the character behind it).
        // Use the bottom footprint row so it sorts after the character
        // even when the chair has background tiles that push seats down.
        zY = (item.row + entry.footprintH) * TILE_SIZE + 1;
      } else {
        // All other chairs: cap zY to first row bottom so characters
        // at any seat tile render in front of the chair
        zY = (item.row + 1) * TILE_SIZE;
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`);
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5;
        }
      }
    }

    // Colorize sprite if this furniture has a color override
    let sprite = entry.sprite;
    if (item.color) {
      const { h, s, b: bv, c: cv } = item.color;
      sprite = getColorizedSprite(
        `furn-${item.type}-${h}-${s}-${bv}-${cv}-${item.color.colorize ? 1 : 0}`,
        entry.sprite,
        item.color,
      );
    }

    // Determine if this instance should be mirrored (side asset used in "left" orientation)
    let mirrored = false;
    if (entry.mirrorSide) {
      const orientInGroup = getOrientationInGroup(item.type);
      if (orientInGroup === 'left') {
        mirrored = true;
      }
    }

    instances.push({ sprite, x, y, zY, uid: item.uid, ...(mirrored ? { mirrored: true } : {}) });
  }
  return instances;
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(
  furniture: PlacedFurniture[],
  excludeTiles?: Set<string>,
): Set<string> {
  return coreGetBlockedTiles(activeCatalog(), furniture, excludeTiles);
}

/** Get tiles blocked for placement purposes — skips top backgroundTiles rows per item. */
export function getPlacementBlockedTiles(
  furniture: PlacedFurniture[],
  excluded?: ReadonlySet<string>,
): Set<string> {
  return coreGetPlacementBlockedTiles(activeCatalog(), furniture, excluded);
}

/** Generate seats from chair furniture (core's layoutToSeats over the webview's catalogue). */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  return coreLayoutToSeats(activeCatalog(), furniture);
}
