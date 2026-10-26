import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import {
  loadCarpetTiles,
  loadDefaultLayout,
  loadExternalCharacterSprites,
  loadExternalPetSprites,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
  mergeLoadedAssets,
  mergePetSprites,
} from './assetLoader.js';
import type { AssetCache } from './clientMessageHandler.js';
import { setExternalCharacterCount } from './paletteAssigner.js';

/**
 * Shared asset-loading helpers used by BOTH the VS Code adapter and the
 * standalone server, so external asset directories behave identically across
 * surfaces (no copy-paste of the load+merge loops).
 *
 * Asymmetry preserved deliberately: the bundled root uses the canonical loader
 * (`loadPetSprites`), while external directories use the flexible scanners
 * (`loadExternalCharacterSprites`/`loadExternalPetSprites`). Furniture uses
 * `loadFurnitureAssets` for both. Characters have no bundled sprites: the built-in
 * cast is the character profiles, which the webview draws. Callers pass `externalDirs`
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

/**
 * Character sprites from external asset directories (char_N.png), worn by palettes past
 * the character profiles. Always a list (possibly empty), so the handshake always says.
 */
export async function loadExternalCharacters(
  externalDirs: string[],
): Promise<LoadedCharacterSprites> {
  const loaded = await Promise.all(externalDirs.map(loadExternalCharacterSprites));
  const chars: LoadedCharacterSprites = {
    characters: loaded.flatMap((extra) => extra?.characters ?? []),
  };
  // Sync the server-side palette count so assignPaletteIfNeeded and the
  // saveAgentSeats guard use the dynamic ceiling. Centralizing here means every
  // entry point -- standalone startup, standalone reload, VS Code startup,
  // VS Code reload -- sees the same count without four scattered calls.
  setExternalCharacterCount(chars.characters.length);
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
    characters: await loadExternalCharacters(externalDirs),
    pets: await loadAllPets(distRoot, externalDirs),
    floorTiles: await loadFloorTiles(distRoot).then((t) => t?.sprites ?? null),
    wallTiles: await loadWallTiles(distRoot).then((t) => t?.sets ?? null),
    carpetTiles: await loadCarpetTiles(distRoot).then((t) => t?.sets ?? null),
    furniture: await loadAllFurniture(distRoot, externalDirs),
    defaultLayout: loadDefaultLayout(distRoot),
  };
}
