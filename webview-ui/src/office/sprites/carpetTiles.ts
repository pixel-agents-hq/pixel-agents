/**
 * Carpet sprite cache + dual-color colorization for marching-squares autotiling.
 *
 * Wire format: `setCarpetSprites(sets)` receives `sets[variant][msCase]` where
 * each entry is a 16×16 SpriteData. Marching-squares case is a 4-bit bitmask
 * over the four tiles surrounding a junction (NW=1, NE=2, SE=4, SW=8).
 *
 * Dual-color: each variant is classified once at registration time by sorting
 * unique source pixels by luminance — darkest → `mainRgb`, brightest →
 * `accentRgb`. At render time, the base sprite is masked into two layers,
 * each flat-colorized with the user's `color` / `accentColor`, then merged.
 */

import type { ColorValue } from '../../components/ui/types.js';
import { CARPET_DEFAULT_ACCENT_COLOR, CARPET_DEFAULT_COLOR } from '../../constants.js';
import { flatColorizeSprite } from '../colorize.js';
import type { CarpetTile, SpriteData } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────────────────────

/** `carpetSets[variant][msCase] = SpriteData` — 16 marching-squares cases per variant. */
let carpetSets: SpriteData[][] = [];

/** Per-variant palette classification, computed once per `setCarpetSprites` call. */
let carpetVariantPalettes: Array<{ mainRgb: string | null; accentRgb: string | null }> = [];

/** Cache of fully-colorized + merged sprites, keyed by `${variant}:${msCase}:${paletteKey}`. */
const carpetCache: Map<string, SpriteData> = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register carpet sprite sheets. Invalidates the dual-color cache.
 *
 * @param sets `sets[variant][msCase]` — 16×16 SpriteData per marching-squares case.
 *             Expected 16 msCase entries per variant; missing entries are tolerated
 *             via tileHasVariant() and getCarpetJunctionSprite() guards.
 */
export function setCarpetSprites(sets: SpriteData[][]): void {
  carpetSets = sets;
  carpetCache.clear();
  carpetVariantPalettes = sets.map((variantSprites) => classifyCarpetPalette(variantSprites));
}

export function hasCarpetSprites(): boolean {
  return carpetSets.length > 0;
}

export function getCarpetSetCount(): number {
  return carpetSets.length;
}

/** Return the raw sprite sheet for a variant (or undefined). Used by editor previews. */
export function getCarpetVariantSprites(variant: number): SpriteData[] | undefined {
  if (variant < 0 || variant >= carpetSets.length) return undefined;
  return carpetSets[variant];
}

/** Stable key for a single ColorValue used in cache and palette keys. */
export function getCarpetColorKey(color: ColorValue): string {
  return `${color.h}|${color.s}|${color.b}|${color.c}|${color.colorize ? 1 : 0}`;
}

/** Composite key for the (main, accent) color pair used to invalidate the cache. */
export function getCarpetPaletteKey(color: ColorValue, accentColor: ColorValue): string {
  return `${getCarpetColorKey(color)}#${getCarpetColorKey(accentColor)}`;
}

/**
 * Resolve and return the merged, colorized SpriteData for a single junction.
 *
 * @param jx Junction column (0..cols). Junctions sit at corners.
 * @param jy Junction row (0..rows).
 * @returns null if the variant is unloaded, the junction's msCase is missing,
 *          or the variant's palette classification yielded no main color.
 */
export function getCarpetJunctionSprite(
  jx: number,
  jy: number,
  variant: number,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  color: ColorValue = CARPET_DEFAULT_COLOR,
  accentColor: ColorValue = CARPET_DEFAULT_ACCENT_COLOR,
  paletteKey: string = getCarpetPaletteKey(color, accentColor),
): SpriteData | null {
  if (variant < 0 || variant >= carpetSets.length) return null;

  const msCase = carpetJunctionCase(jx, jy, variant, carpetTiles, cols, rows, paletteKey);

  if (msCase === 0) return null;

  const variantSet = carpetSets[variant];
  const baseSprite = variantSet?.[msCase];
  if (!baseSprite) return null;

  const palette = carpetVariantPalettes[variant];
  if (!palette || !palette.mainRgb) return null;

  const cacheKey = `${variant}:${msCase}:${paletteKey}`;
  return getDualColorizedCarpetSprite(cacheKey, baseSprite, palette, color, accentColor);
}

/**
 * Compute the 4-bit marching-squares case for a junction at `(jx, jy)` from the
 * four tiles around it: NW=1, NE=2, SE=4, SW=8. Shared by the renderer
 * (`getCarpetJunctionSprite`) and the e2e observability hook so a test asserts
 * the real autotiling logic, not a copy. When `paletteKey` is omitted the
 * neighbor check ignores per-tile colors (matches any carpet of `variant`).
 */
export function carpetJunctionCase(
  jx: number,
  jy: number,
  variant: number,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  paletteKey?: string,
): number {
  let msCase = 0;
  if (tileHasVariant(jx - 1, jy - 1, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 1;
  if (tileHasVariant(jx, jy - 1, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 2;
  if (tileHasVariant(jx, jy, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 4;
  if (tileHasVariant(jx - 1, jy, variant, carpetTiles, cols, rows, paletteKey)) msCase |= 8;
  return msCase;
}

// ─────────────────────────────────────────────────────────────────────────────
// Junction participation predicate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true iff cell (col, row) is inside the grid, has a CarpetTile, the
 * tile's variant matches, and (when paletteKey provided) the tile's palette
 * key matches. The palette match prevents two carpets of the same variant but
 * different colors from merging across the junction.
 */
function tileHasVariant(
  col: number,
  row: number,
  variant: number,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  paletteKey?: string,
): boolean {
  if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
  const tile = carpetTiles[row * cols + col];
  if (!tile || tile.variant !== variant) return false;
  if (paletteKey !== undefined) {
    const tileColor = tile.color ?? CARPET_DEFAULT_COLOR;
    const tileAccent = tile.accentColor ?? CARPET_DEFAULT_ACCENT_COLOR;
    if (getCarpetPaletteKey(tileColor, tileAccent) !== paletteKey) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan every sprite of a variant once, collect the unique non-empty hex strings,
 * sort by luminance ascending, and assign:
 *   - lowest luminance  → mainRgb
 *   - highest luminance → accentRgb
 *
 * Edge cases:
 *   - 0 unique colors → { mainRgb: null, accentRgb: null }   (variant fully transparent)
 *   - 1 unique color  → { mainRgb: color, accentRgb: color } (single-pass colorize)
 */
function classifyCarpetPalette(variantSprites: SpriteData[]): {
  mainRgb: string | null;
  accentRgb: string | null;
} {
  const unique = new Set<string>();
  for (const sprite of variantSprites) {
    if (!sprite) continue;
    for (const row of sprite) {
      for (const pixel of row) {
        if (pixel === '') continue;
        // Strip optional alpha so '#RRGGBBAA' and '#RRGGBB' share a bucket.
        const rgb = pixel.length === 9 ? pixel.slice(0, 7) : pixel;
        unique.add(rgb);
      }
    }
  }

  if (unique.size === 0) {
    return { mainRgb: null, accentRgb: null };
  }

  const sorted = [...unique].sort((a, b) => luminanceFromRgb(a) - luminanceFromRgb(b));

  if (sorted.length === 1) {
    return { mainRgb: sorted[0], accentRgb: sorted[0] };
  }

  return {
    mainRgb: sorted[0],
    accentRgb: sorted[sorted.length - 1],
  };
}

/** Rec. 601 relative luminance from `#RRGGBB` (or `#RRGGBBAA`, alpha ignored). */
function luminanceFromRgb(rgb: string): number {
  const r = parseInt(rgb.slice(1, 3), 16);
  const g = parseInt(rgb.slice(3, 5), 16);
  const b = parseInt(rgb.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dual-color colorization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce the merged main+accent colorized sprite. Memoizes per cache key.
 *
 * Algorithm:
 *   1. Mask base sprite → mainSprite (only `mainRgb` pixels survive).
 *   2. Mask base sprite → accentSprite (only `accentRgb` pixels survive).
 *   3. flatColorizeSprite each with the user-supplied ColorValue.
 *   4. Merge: accent over main (accent takes precedence on overlapping pixels).
 *
 * When mainRgb === accentRgb (variant has one color), the two masks are
 * identical; merge collapses to a single-color result and the user's `color`
 * is overpainted by `accentColor`.
 */
function getDualColorizedCarpetSprite(
  cacheKey: string,
  baseSprite: SpriteData,
  palette: { mainRgb: string | null; accentRgb: string | null },
  color: ColorValue,
  accentColor: ColorValue,
): SpriteData | null {
  const cached = carpetCache.get(cacheKey);
  if (cached) return cached;

  if (!palette.mainRgb) return null;

  const accentRgb = palette.accentRgb ?? palette.mainRgb;

  const mainMask = maskCarpetSprite(baseSprite, palette.mainRgb);
  const accentMask = maskCarpetSprite(baseSprite, accentRgb);

  const mainLayer = flatColorizeSprite(mainMask, color);
  const accentLayer = flatColorizeSprite(accentMask, accentColor);

  const merged = mergeCarpetLayers(mainLayer, accentLayer);
  carpetCache.set(cacheKey, merged);
  return merged;
}

/**
 * Return a SpriteData identical in dimensions to `sprite`, but with only the
 * pixels whose RGB component equals `rgb` retained. Alpha is preserved.
 */
function maskCarpetSprite(sprite: SpriteData, rgb: string): SpriteData {
  return sprite.map((row) =>
    row.map((pixel) => {
      if (pixel === '') return '';
      const pixelRgb = pixel.length === 9 ? pixel.slice(0, 7) : pixel;
      return pixelRgb === rgb ? pixel : '';
    }),
  );
}

/**
 * Merge two layers: pixel from `accent` if non-empty, else from `base`. Both
 * layers must have identical dimensions (they always derive from the same
 * source sprite, so this is guaranteed by construction).
 */
function mergeCarpetLayers(base: SpriteData, accent: SpriteData): SpriteData {
  const rows = base.length;
  const result: SpriteData = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const baseRow = base[r];
    const accentRow = accent[r];
    const cols = baseRow.length;
    const out: string[] = new Array(cols);
    for (let c = 0; c < cols; c++) {
      const accentPixel = accentRow[c];
      out[c] = accentPixel !== '' ? accentPixel : baseRow[c];
    }
    result[r] = out;
  }
  return result;
}
