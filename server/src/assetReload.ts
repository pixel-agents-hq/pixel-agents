import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import {
  loadCarpetTiles,
  loadCharacterSprites,
  loadDefaultLayout,
  loadExternalCharacterSprites,
  loadExternalPetSprites,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
  mergeCharacterSprites,
  mergeLoadedAssets,
  mergePetSprites,
} from './assetLoader.js';
import type { AssetCache } from './clientMessageHandler.js';

/**
 * Shared asset-loading helpers used by BOTH the VS Code adapter and the
 * standalone server, so external asset directories behave identically across
 * surfaces (no copy-paste of the load+merge loops).
 *
 * Asymmetry preserved deliberately: the bundled root uses the canonical loaders
 * (`loadCharacterSprites`/`loadPetSprites`), while external directories use the
 * flexible scanners (`loadExternalCharacterSprites`/`loadExternalPetSprites`).
 * Furniture uses `loadFurnitureAssets` for both. Callers pass `externalDirs`
 * (read from config) so these helpers stay pure and reusable.
 */
export async function loadAllFurniture(
  assetsRoot: string,
  externalDirs: string[],
): Promise<LoadedAssets | null> {
  let assets = await loadFurnitureAssets(assetsRoot);
  for (const extraDir of externalDirs) {
    const extra = await loadFurnitureAssets(extraDir);
    if (extra) {
      assets = assets ? mergeLoadedAssets(assets, extra) : extra;
    }
  }
  return assets;
}

export async function loadAllCharacters(
  assetsRoot: string,
  externalDirs: string[],
): Promise<LoadedCharacterSprites | null> {
  let chars = await loadCharacterSprites(assetsRoot);
  for (const extraDir of externalDirs) {
    const extra = await loadExternalCharacterSprites(extraDir);
    if (extra) {
      chars = chars ? mergeCharacterSprites(chars, extra) : extra;
    }
  }
  return chars;
}

export async function loadAllPets(
  assetsRoot: string,
  externalDirs: string[],
): Promise<LoadedPetSprites | null> {
  let pets = await loadPetSprites(assetsRoot);
  for (const extraDir of externalDirs) {
    const extra = await loadExternalPetSprites(extraDir);
    if (extra) {
      pets = pets ? mergePetSprites(pets, extra) : extra;
    }
  }
  return pets;
}

/**
 * Build the full in-memory asset cache for the standalone server. External
 * directories contribute characters, pets, and furniture; floor/wall/carpet
 * tiles are bundled-only. Reproduces the wrap/unwrap shape `AssetCache` expects:
 * characters/pets/furniture are wrapper objects, while floor/wall/carpet are the
 * unwrapped sprite arrays.
 */
export async function buildAssetCache(
  distRoot: string,
  externalDirs: string[],
): Promise<AssetCache> {
  return {
    characters: await loadAllCharacters(distRoot, externalDirs),
    pets: await loadAllPets(distRoot, externalDirs),
    floorTiles: await loadFloorTiles(distRoot).then((t) => t?.sprites ?? null),
    wallTiles: await loadWallTiles(distRoot).then((t) => t?.sets ?? null),
    carpetTiles: await loadCarpetTiles(distRoot).then((t) => t?.sets ?? null),
    furniture: await loadAllFurniture(distRoot, externalDirs),
    defaultLayout: loadDefaultLayout(distRoot),
  };
}
