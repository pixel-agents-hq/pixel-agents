/**
 * Asset Loader - Loads furniture assets from per-folder manifests
 *
 * Scans assets/furniture/ subdirectories, reads each manifest.json,
 * and loads all PNG files into SpriteData format for use in the webview.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

import {
  CHAR_COUNT,
  CHAR_FRAMES_PER_ROW,
  WALL_BITMASK_COUNT,
} from '../../core/src/assets/constants.js';
import type {
  FurnitureAsset,
  FurnitureManifest,
  InheritedProps,
  ManifestGroup,
} from '../../core/src/assets/manifestUtils.js';
import { flattenManifest } from '../../core/src/assets/manifestUtils.js';
import {
  decodeCharacterPng,
  decodeFloorPng,
  parseWallPng,
  pngToSpriteData,
} from '../../core/src/assets/pngDecoder.js';
import type { CharacterDirectionSprites } from '../../core/src/assets/types.js';
export type { CharacterDirectionSprites } from '../../core/src/assets/types.js';

import { LAYOUT_REVISION_KEY } from './constants.js';

export type { FurnitureAsset };

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Map<string, string[][]>; // assetId -> SpriteData
}

export function mergeLoadedAssets(a: LoadedAssets, b: LoadedAssets): LoadedAssets {
  const bIds = new Set(b.catalog.map((item) => item.id));
  const dedupedA = a.catalog.filter((item) => !bIds.has(item.id));
  return {
    catalog: [...dedupedA, ...b.catalog],
    sprites: new Map([...a.sprites, ...b.sprites]),
  };
}

/**
 * Load furniture assets from per-folder manifests
 */
export async function loadFurnitureAssets(workspaceRoot: string): Promise<LoadedAssets | null> {
  try {
    console.log(`[AssetLoader] workspaceRoot received: "${workspaceRoot}"`);
    const furnitureDir = path.join(workspaceRoot, 'assets', 'furniture');
    console.log(`[AssetLoader] Scanning furniture directory: ${furnitureDir}`);

    if (!fs.existsSync(furnitureDir)) {
      console.log('ℹ️  No furniture directory found at:', furnitureDir);
      return null;
    }

    const entries = fs.readdirSync(furnitureDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    if (dirs.length === 0) {
      console.log('ℹ️  No furniture subdirectories found');
      return null;
    }

    console.log(`📦 Found ${dirs.length} furniture folders`);

    const catalog: FurnitureAsset[] = [];
    const sprites = new Map<string, string[][]>();

    for (const dir of dirs) {
      const itemDir = path.join(furnitureDir, dir.name);
      const manifestPath = path.join(itemDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        console.warn(`  ⚠️  No manifest.json in ${dir.name}`);
        continue;
      }

      try {
        const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as FurnitureManifest;

        // Build the inherited props from the root manifest
        const inherited: InheritedProps = {
          groupId: manifest.id,
          name: manifest.name,
          category: manifest.category,
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
        };

        let assets: FurnitureAsset[];

        if (manifest.type === 'asset') {
          // Single asset manifest (no groups) — file defaults to {id}.png
          assets = [
            {
              id: manifest.id,
              name: manifest.name,
              label: manifest.name,
              category: manifest.category,
              file: manifest.file ?? `${manifest.id}.png`,
              width: manifest.width!,
              height: manifest.height!,
              footprintW: manifest.footprintW!,
              footprintH: manifest.footprintH!,
              isDesk: manifest.category === 'desks',
              canPlaceOnWalls: manifest.canPlaceOnWalls,
              canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
              backgroundTiles: manifest.backgroundTiles,
              groupId: manifest.id,
            },
          ];
        } else {
          // Group manifest — flatten recursively
          if (manifest.rotationScheme) {
            inherited.rotationScheme = manifest.rotationScheme;
          }
          const rootGroup: ManifestGroup = {
            type: 'group',
            groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
            rotationScheme: manifest.rotationScheme,
            members: manifest.members!,
          };
          assets = flattenManifest(rootGroup, inherited);
        }

        // Load PNGs for each asset
        for (const asset of assets) {
          try {
            const assetPath = path.join(itemDir, asset.file);
            const resolvedAsset = path.resolve(assetPath);
            const resolvedDir = path.resolve(itemDir);
            if (
              !resolvedAsset.startsWith(resolvedDir + path.sep) &&
              resolvedAsset !== resolvedDir
            ) {
              console.warn(
                `  [AssetLoader] Skipping asset with path outside directory: ${asset.file}`,
              );
              continue;
            }
            if (!fs.existsSync(assetPath)) {
              console.warn(`  ⚠️  Asset file not found: ${asset.file} in ${dir.name}`);
              continue;
            }

            const pngBuffer = fs.readFileSync(assetPath);
            const spriteData = pngToSpriteData(pngBuffer, asset.width, asset.height);
            sprites.set(asset.id, spriteData);
          } catch (err) {
            console.warn(
              `  ⚠️  Error loading ${asset.id}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        catalog.push(...assets);
      } catch (err) {
        console.warn(
          `  ⚠️  Error processing ${dir.name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    console.log(`  ✓ Loaded ${sprites.size} / ${catalog.length} assets`);
    console.log(`[AssetLoader] ✅ Successfully loaded ${sprites.size} furniture sprites`);

    return { catalog, sprites };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading furniture assets: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ── Default layout loading ───────────────────────────────────

/**
 * Load the bundled default layout with the highest revision.
 * Scans for assets/default-layout-{N}.json files and picks the one
 * with the largest N. Falls back to assets/default-layout.json for
 * backward compatibility.
 */
export function loadDefaultLayout(assetsRoot: string): Record<string, unknown> | null {
  const assetsDir = path.join(assetsRoot, 'assets');
  try {
    // Scan for versioned default layouts: default-layout-{N}.json
    let bestRevision = 0;
    let bestPath: string | null = null;

    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          const rev = parseInt(match[1], 10);
          if (rev > bestRevision) {
            bestRevision = rev;
            bestPath = path.join(assetsDir, file);
          }
        }
      }
    }

    // Fall back to unversioned default-layout.json
    if (!bestPath) {
      const fallback = path.join(assetsDir, 'default-layout.json');
      if (fs.existsSync(fallback)) {
        bestPath = fallback;
      }
    }

    if (!bestPath) {
      console.log('[AssetLoader] No default layout found in:', assetsDir);
      return null;
    }

    const content = fs.readFileSync(bestPath, 'utf-8');
    const layout = JSON.parse(content) as Record<string, unknown>;
    // Ensure layoutRevision matches the file's revision number
    if (bestRevision > 0 && !layout[LAYOUT_REVISION_KEY]) {
      layout[LAYOUT_REVISION_KEY] = bestRevision;
    }
    console.log(
      `[AssetLoader] Loaded default layout (${layout.cols}×${layout.rows}, revision ${layout[LAYOUT_REVISION_KEY] ?? 0}) from ${path.basename(bestPath)}`,
    );
    return layout;
  } catch (err) {
    console.error(
      `[AssetLoader] Error loading default layout: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ── Wall tile loading ────────────────────────────────────────

interface LoadedWallTiles {
  /** Array of wall sets, each containing 16 sprites indexed by bitmask (N=1,E=2,S=4,W=8) */
  sets: string[][][][];
}

/**
 * Load wall tile sets from assets/walls/ folder.
 * Each file is named wall_N.png (e.g. wall_0.png, wall_1.png, ...).
 * Files are loaded in numeric order; each PNG is a 64×128 grid of 16 bitmask pieces.
 */
export async function loadWallTiles(assetsRoot: string): Promise<LoadedWallTiles | null> {
  try {
    const wallsDir = path.join(assetsRoot, 'assets', 'walls');
    if (!fs.existsSync(wallsDir)) {
      console.log('[AssetLoader] No walls/ directory found at:', wallsDir);
      return null;
    }

    console.log('[AssetLoader] Loading wall tiles from:', wallsDir);

    // Find all wall_N.png files and sort by index
    const entries = fs.readdirSync(wallsDir);
    const wallFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^wall_(\d+)\.png$/i.exec(entry);
      if (match) {
        wallFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (wallFiles.length === 0) {
      console.log('[AssetLoader] No wall_N.png files found in walls/');
      return null;
    }

    wallFiles.sort((a, b) => a.index - b.index);

    const sets: string[][][][] = [];
    for (const { filename } of wallFiles) {
      const filePath = path.join(wallsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprites = parseWallPng(pngBuffer);
      sets.push(sprites);
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${sets.length} wall tile set(s) (${sets.length * WALL_BITMASK_COUNT} pieces total)`,
    );
    return { sets };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading wall tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Send wall tiles to webview
 */
export function sendWallTilesToWebview(webview: vscode.Webview, wallTiles: LoadedWallTiles): void {
  webview.postMessage({
    type: 'wallTilesLoaded',
    sets: wallTiles.sets,
  });
  console.log(`📤 Sent ${wallTiles.sets.length} wall tile set(s) to webview`);
}

interface LoadedFloorTiles {
  sprites: string[][][]; // N sprites (one per floor_N.png), each 16x16 SpriteData
}

/**
 * Load floor tile patterns from assets/floors/ folder.
 * Each file is named floor_N.png (e.g. floor_0.png, floor_1.png, ...).
 * Files are loaded in numeric order; each PNG is a 16×16 grayscale tile.
 */
export async function loadFloorTiles(assetsRoot: string): Promise<LoadedFloorTiles | null> {
  try {
    const floorsDir = path.join(assetsRoot, 'assets', 'floors');
    if (!fs.existsSync(floorsDir)) {
      console.log('[AssetLoader] No floors/ directory found at:', floorsDir);
      return null;
    }

    console.log('[AssetLoader] Loading floor tiles from:', floorsDir);

    // Find all floor_N.png files and sort by index
    const entries = fs.readdirSync(floorsDir);
    const floorFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^floor_(\d+)\.png$/i.exec(entry);
      if (match) {
        floorFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (floorFiles.length === 0) {
      console.log('[AssetLoader] No floor_N.png files found in floors/');
      return null;
    }

    floorFiles.sort((a, b) => a.index - b.index);

    const sprites: string[][][] = [];
    for (const { filename } of floorFiles) {
      const filePath = path.join(floorsDir, filename);
      const pngBuffer = fs.readFileSync(filePath);
      const sprite = decodeFloorPng(pngBuffer);
      sprites.push(sprite);
    }

    console.log(`[AssetLoader] ✅ Loaded ${sprites.length} floor tile patterns from floors/`);
    return { sprites };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading floor tiles: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Send floor tiles to webview
 */
export function sendFloorTilesToWebview(
  webview: vscode.Webview,
  floorTiles: LoadedFloorTiles,
): void {
  webview.postMessage({
    type: 'floorTilesLoaded',
    sprites: floorTiles.sprites,
  });
  console.log(`📤 Sent ${floorTiles.sprites.length} floor tile patterns to webview`);
}

// ── Character sprite loading ────────────────────────────────

export interface LoadedCharacterSprites {
  /** Pre-colored characters, each with 7 frames per direction */
  characters: CharacterDirectionSprites[];
}

export function mergeCharacterSprites(
  a: LoadedCharacterSprites,
  b: LoadedCharacterSprites,
): LoadedCharacterSprites {
  return { characters: [...a.characters, ...b.characters] };
}

/**
 * Load pre-colored character sprites from assets/characters/ (6 PNGs, each 112×96).
 * Each PNG has 3 direction rows (down, up, right) × 7 frames (16×32 each).
 */
export async function loadCharacterSprites(
  assetsRoot: string,
): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(assetsRoot, 'assets', 'characters');
    const characters: CharacterDirectionSprites[] = [];

    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const filePath = path.join(charDir, `char_${ci}.png`);
      if (!fs.existsSync(filePath)) {
        console.log(`[AssetLoader] No character sprite found at: ${filePath}`);
        return null;
      }

      const pngBuffer = fs.readFileSync(filePath);
      characters.push(decodeCharacterPng(pngBuffer));
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${characters.length} character sprites (${CHAR_FRAMES_PER_ROW} frames × 3 directions each)`,
    );
    return { characters };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading character sprites: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Load character sprites from an external asset directory.
 * Scans assets/characters/ for char_N.png files (any N, sorted numerically).
 * Returns null if no characters found.
 */
export async function loadExternalCharacterSprites(
  externalRoot: string,
): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(externalRoot, 'assets', 'characters');
    if (!fs.existsSync(charDir)) {
      return null;
    }

    const entries = fs.readdirSync(charDir);
    const charFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^char_(\d+)\.png$/i.exec(entry);
      if (match) {
        charFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (charFiles.length === 0) {
      return null;
    }

    charFiles.sort((a, b) => a.index - b.index);

    const characters: CharacterDirectionSprites[] = [];
    for (const { filename } of charFiles) {
      const filePath = path.join(charDir, filename);
      const resolvedFile = path.resolve(filePath);
      const resolvedDir = path.resolve(charDir);
      if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
        console.warn(`  [AssetLoader] Skipping character with path outside directory: ${filename}`);
        continue;
      }
      try {
        const pngBuffer = fs.readFileSync(filePath);
        characters.push(decodeCharacterPng(pngBuffer));
      } catch (err) {
        console.warn(
          `  [AssetLoader] ⚠️  Error loading character ${filename}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (characters.length === 0) {
      return null;
    }

    console.log(
      `[AssetLoader] ✅ Loaded ${characters.length} external character sprites from ${externalRoot}`,
    );
    return { characters };
  } catch (err) {
    console.error(
      `[AssetLoader] ❌ Error loading external character sprites: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Send character sprites to webview
 */
export function sendCharacterSpritesToWebview(
  webview: vscode.Webview,
  charSprites: LoadedCharacterSprites,
): void {
  webview.postMessage({
    type: 'characterSpritesLoaded',
    characters: charSprites.characters,
  });
  console.log(`📤 Sent ${charSprites.characters.length} character sprites to webview`);
}

/**
 * Send loaded assets to webview
 */
export function sendAssetsToWebview(webview: vscode.Webview, assets: LoadedAssets): void {
  if (!assets) {
    console.log('[AssetLoader] ⚠️  No assets to send');
    return;
  }

  console.log('[AssetLoader] Converting sprites Map to object...');
  // Convert sprites Map to plain object for JSON serialization
  const spritesObj: Record<string, string[][]> = {};
  for (const [id, spriteData] of assets.sprites) {
    spritesObj[id] = spriteData;
  }

  console.log(
    `[AssetLoader] Posting furnitureAssetsLoaded message with ${assets.catalog.length} assets`,
  );
  webview.postMessage({
    type: 'furnitureAssetsLoaded',
    catalog: assets.catalog,
    sprites: spritesObj,
  });

  console.log(`📤 Sent ${assets.catalog.length} furniture assets to webview`);
}
