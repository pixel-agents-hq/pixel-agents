/**
 * Build-time asset generators — shared between Vite plugin, extension host,
 * and future standalone backends.
 *
 * Reads furniture manifests and asset directories and produces
 * catalog and index structures.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { FurnitureManifest, InheritedProps, ManifestGroup } from './manifestUtils.js';
import { flattenManifest } from './manifestUtils.js';
import type { CatalogEntry } from './types.js';

// ── Furniture catalog ─────────────────────────────────────────────────────────

export function buildFurnitureCatalog(assetsDir: string): CatalogEntry[] {
  const furnitureDir = path.join(assetsDir, 'furniture');
  if (!fs.existsSync(furnitureDir)) return [];

  const catalog: CatalogEntry[] = [];
  const dirs = fs
    .readdirSync(furnitureDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const folderName of dirs) {
    const manifestPath = path.join(furnitureDir, folderName, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as FurnitureManifest;

      if (manifest.type === 'asset') {
        // Single-asset manifest — validate required fields
        if (
          manifest.width === undefined ||
          manifest.width === null ||
          manifest.height === undefined ||
          manifest.height === null ||
          manifest.footprintW === undefined ||
          manifest.footprintW === null ||
          manifest.footprintH === undefined ||
          manifest.footprintH === null
        ) {
          continue;
        }
        const file = manifest.file ?? `${manifest.id}.png`;
        catalog.push({
          id: manifest.id,
          name: manifest.name,
          label: manifest.name,
          category: manifest.category,
          file,
          furniturePath: `furniture/${folderName}/${file}`,
          width: manifest.width,
          height: manifest.height,
          footprintW: manifest.footprintW,
          footprintH: manifest.footprintH,
          isDesk: manifest.category === 'desks',
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
          groupId: manifest.id,
        });
      } else {
        // Group manifest — flatten into individual assets
        if (!manifest.members) continue;
        const inherited: InheritedProps = {
          groupId: manifest.id,
          name: manifest.name,
          category: manifest.category,
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
          ...(manifest.rotationScheme ? { rotationScheme: manifest.rotationScheme } : {}),
        };
        const rootGroup: ManifestGroup = {
          type: 'group',
          groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
          rotationScheme: manifest.rotationScheme,
          members: manifest.members,
        };
        const assets = flattenManifest(rootGroup, inherited);
        for (const asset of assets) {
          catalog.push({
            ...asset,
            furniturePath: `furniture/${folderName}/${asset.file}`,
          });
        }
      }
    } catch {
      // skip malformed manifests
    }
  }
  return catalog;
}

// ── Asset index ───────────────────────────────────────────────────────────────

export function buildAssetIndex(assetsDir: string) {
  function listSorted(subdir: string, pattern: RegExp): string[] {
    const dir = path.join(assetsDir, subdir);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => pattern.test(f))
      .sort((a, b) => {
        const na = parseInt(/(\d+)/.exec(a)?.[1] ?? '0', 10);
        const nb = parseInt(/(\d+)/.exec(b)?.[1] ?? '0', 10);
        return na - nb;
      });
  }

  let defaultLayout: string | null = null;
  let bestRev = 0;
  if (fs.existsSync(assetsDir)) {
    for (const f of fs.readdirSync(assetsDir)) {
      const m = /^default-layout-(\d+)\.json$/.exec(f);
      if (m) {
        const rev = parseInt(m[1], 10);
        if (rev > bestRev) {
          bestRev = rev;
          defaultLayout = f;
        }
      }
    }
    if (!defaultLayout && fs.existsSync(path.join(assetsDir, 'default-layout.json'))) {
      defaultLayout = 'default-layout.json';
    }
  }

  return {
    floors: listSorted('floors', /^floor_\d+\.png$/i),
    walls: listSorted('walls', /^wall_\d+\.png$/i),
    characters: listSorted('characters', /^char_\d+\.png$/i),
    defaultLayout,
  };
}
