import { SEATED_FRAME, SHEET_FRAMES } from '../../../../core/src/assets/seatedFrame.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../../../core/src/defaultCharacterProfiles.js';
import type { Direction, SpriteData } from '../types.js';
import { Direction as Dir } from '../types.js';
import bubblePermissionData from './bubble-permission.json';
import bubblePetData from './bubble-pet.json';
import bubbleWaitingData from './bubble-waiting.json';

// ── Speech Bubble Sprites ───────────────────────────────────────

interface BubbleSpriteJson {
  palette: Record<string, string>;
  pixels: string[][];
}

function resolveBubbleSprite(data: BubbleSpriteJson): SpriteData {
  return data.pixels.map((row) => row.map((key) => data.palette[key] ?? key));
}

/** Permission bubble: white square with "..." in amber, and a tail pointer (11x13) */
export const BUBBLE_PERMISSION_SPRITE: SpriteData = resolveBubbleSprite(bubblePermissionData);

/** Waiting bubble: white square with green checkmark, and a tail pointer (11x13) */
export const BUBBLE_WAITING_SPRITE: SpriteData = resolveBubbleSprite(bubbleWaitingData);

/** Heart bubble: pet petting feedback (11x13) */
export const BUBBLE_HEART_SPRITE: SpriteData = resolveBubbleSprite(bubblePetData);

// ════════════════════════════════════════════════════════════════
// Loaded character sprites (from PNG assets)
// ════════════════════════════════════════════════════════════════

interface LoadedCharacterData {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
}

let loadedCharacters: LoadedCharacterData[] | null = null;

/**
 * A palette's sheet as its nth repeat (repeat ≥ 1) and/or mid-blink, or null to draw
 * the plain sheet (a palette that can't blink, or one with nothing to vary).
 */
type VariantSource = (
  palette: number,
  repeat: number,
  blink: boolean,
) => LoadedCharacterData | null;
let variants: VariantSource | null = null;

/**
 * Set the character sprites (the cast's sheets, then external char_N.png) and
 * where their repeats come from, together: both describe the same cast.
 */
export function setCharacterTemplates(
  data: LoadedCharacterData[],
  variantSource: VariantSource | null = null,
): void {
  loadedCharacters = data;
  variants = variantSource;
  // Clear cache so sprites are rebuilt from loaded data
  spriteCache.clear();
  templatesVersion++;
  for (const listener of templateListeners) listener();
}

/**
 * The number of character palettes: the drawn profiles plus external sprites once the cast
 * has rendered, the default cast's size until then (what the server starts from too).
 */
export function getLoadedCharacterCount(): number {
  return loadedCharacters ? loadedCharacters.length : DEFAULT_CHARACTER_PROFILES.length;
}

let templatesVersion = 0;
const templateListeners = new Set<() => void>();

/**
 * Which set of character sprites is current: it changes on every setCharacterTemplates,
 * so anything drawn once from the sprites (a mug shot) knows to draw again.
 */
export function getCharacterTemplatesVersion(): number {
  return templatesVersion;
}

/** Hear of every setCharacterTemplates. Returns the unsubscribe. */
export function subscribeCharacterTemplates(listener: () => void): () => void {
  templateListeners.add(listener);
  return () => templateListeners.delete(listener);
}

/** Flip a SpriteData horizontally (for generating left sprites from right) */
function flipSpriteHorizontal(sprite: SpriteData): SpriteData {
  return sprite.map((row) => [...row].reverse());
}

// ════════════════════════════════════════════════════════════════
// Sprite resolution + caching
// ════════════════════════════════════════════════════════════════

export interface CharacterSprites {
  walk: Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>;
  typing: Record<Direction, [SpriteData, SpriteData]>;
  reading: Record<Direction, [SpriteData, SpriteData]>;
  /** In the chair with nothing to do. */
  seated: Record<Direction, SpriteData>;
}

const spriteCache = new Map<string, CharacterSprites>();

/** Create a transparent placeholder sprite of given dimensions */
function emptySprite(w: number, h: number): SpriteData {
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    rows.push(new Array(w).fill(''));
  }
  return rows;
}

/** A character's sprites: its own sheet, or the nth repeat's (its clothes recoloured),
 *  with its eyes shut when `blink`. */
export function getCharacterSprites(
  paletteIndex: number,
  repeat = 0,
  blink = false,
): CharacterSprites {
  const cacheKey = `${paletteIndex}:${repeat}:${blink ? 1 : 0}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  let sprites: CharacterSprites;

  if (loadedCharacters) {
    // Use pre-colored character sprites directly (no palette swapping)
    const palette = paletteIndex % loadedCharacters.length;
    const variant = repeat || blink ? variants?.(palette, repeat, blink) : null;
    if (!variant && blink) {
      // No blink for this one: its open-eyed sprites, shared under this key too.
      sprites = getCharacterSprites(paletteIndex, repeat);
      spriteCache.set(cacheKey, sprites);
      return sprites;
    }
    const char = variant ?? loadedCharacters[palette];
    const d = char.down;
    const u = char.up;
    const rt = char.right;
    const flip = flipSpriteHorizontal;

    // A row's sprites at an animation's frames, one sprite per frame (same length).
    type Frames<F extends readonly number[]> = { -readonly [K in keyof F]: SpriteData };
    const at = <F extends readonly number[]>(row: SpriteData[], frames: F) =>
      frames.map((i) => row[i]) as Frames<F>;
    const flipped = <F extends readonly number[]>(frames: F) =>
      frames.map((i) => flip(rt[i])) as Frames<F>;
    const { walk, type, read } = SHEET_FRAMES;

    sprites = {
      walk: {
        [Dir.DOWN]: at(d, walk),
        [Dir.UP]: at(u, walk),
        [Dir.RIGHT]: at(rt, walk),
        [Dir.LEFT]: flipped(walk),
      },
      typing: {
        [Dir.DOWN]: at(d, type),
        [Dir.UP]: at(u, type),
        [Dir.RIGHT]: at(rt, type),
        [Dir.LEFT]: flipped(type),
      },
      reading: {
        [Dir.DOWN]: at(d, read),
        [Dir.UP]: at(u, read),
        [Dir.RIGHT]: at(rt, read),
        [Dir.LEFT]: flipped(read),
      },
      seated: {
        [Dir.DOWN]: d[SEATED_FRAME],
        [Dir.UP]: u[SEATED_FRAME],
        [Dir.RIGHT]: rt[SEATED_FRAME],
        [Dir.LEFT]: flip(rt[SEATED_FRAME]),
      },
    };
  } else {
    // Fallback: return transparent placeholder sprites (16×32)
    const e = emptySprite(16, 32);
    const walkSet: [SpriteData, SpriteData, SpriteData, SpriteData] = [e, e, e, e];
    const pairSet: [SpriteData, SpriteData] = [e, e];
    sprites = {
      walk: {
        [Dir.DOWN]: walkSet,
        [Dir.UP]: walkSet,
        [Dir.RIGHT]: walkSet,
        [Dir.LEFT]: walkSet,
      },
      typing: {
        [Dir.DOWN]: pairSet,
        [Dir.UP]: pairSet,
        [Dir.RIGHT]: pairSet,
        [Dir.LEFT]: pairSet,
      },
      reading: {
        [Dir.DOWN]: pairSet,
        [Dir.UP]: pairSet,
        [Dir.RIGHT]: pairSet,
        [Dir.LEFT]: pairSet,
      },
      seated: { [Dir.DOWN]: e, [Dir.UP]: e, [Dir.RIGHT]: e, [Dir.LEFT]: e },
    };
  }

  spriteCache.set(cacheKey, sprites);
  return sprites;
}
