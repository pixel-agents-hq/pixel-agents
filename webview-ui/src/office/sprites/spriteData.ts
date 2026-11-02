import type { ColorValue } from '../../components/ui/types.js';
import { PALETTE_COUNT } from '../../constants.js';
import { adjustSprite } from '../colorize.js';
import type { ToolProp } from '../toolUtils.js';
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

// ── Tool Prop Sprites ───────────────────────────────────────────
// Drawn above-right of a working character's head (renderer.ts). Each row is a
// string, one key per pixel: '.' transparent, 'o' the shared dark outline.

const PROP_OUTLINE = '#1c1a26';

function propSprite(palette: Record<string, string>, rows: string[]): SpriteData {
  const keys: Record<string, string> = { '.': '', o: PROP_OUTLINE, ...palette };
  return rows.map((row) => [...row].map((k) => keys[k] ?? ''));
}

export const TOOL_PROP_SPRITES: Record<ToolProp, SpriteData> = {
  magnifier: propSprite({ R: '#8a93a8', L: '#bfe3f2', W: '#ffffff', H: '#8a5a32' }, [
    '.ooo.....',
    'oRRRo....',
    'oRLWRo...',
    'oRLLRo...',
    '.oRRRoo..',
    '..ooooHo.',
    '.....oHHo',
    '......oHo',
    '.......o.',
  ]),
  pencil: propSprite({ P: '#e88a9a', Y: '#f2c230', T: '#e8cfa0', D: '#3a3440' }, [
    '......ooo',
    '.....oPPo',
    '....oYYo.',
    '...oYYo..',
    '..oYYo...',
    '.oTTo....',
    'oDTo.....',
    'oDo......',
    'oo.......',
  ]),
  wrench: propSprite({ M: '#a7afbd', W: '#e4e8ef' }, [
    'oo...oo',
    'oMo.oMo',
    'oMMoMMo',
    'oMMMMMo',
    '.oMMMo.',
    '.oMWMo.',
    '.oMWMo.',
    '.oMWMo.',
    '.oMMMo.',
    '..ooo..',
  ]),
  book: propSprite({ C: '#b04a3a', G: '#f2c230', F: '#f4efe2' }, [
    '.oooooo.',
    'oCCCCCCo',
    'oCGGGGCo',
    'oCCCCCCo',
    'oCCCCCCo',
    'oCCCCCCo',
    'oFFFFFFo',
    '.oooooo.',
  ]),
  folder: propSprite({ T: '#c99a4a', F: '#ebc77a' }, [
    '.ooo.....',
    'oTTToooo.',
    'oTTTTTTTo',
    'oFFFFFFFo',
    'oFFFFFFFo',
    'oFFFFFFFo',
    'oFFFFFFFo',
    '.ooooooo.',
  ]),
  marker: propSprite({ C: '#8a4fc0', W: '#eeeef4' }, [
    '.ooo.',
    'oCCCo',
    'oCCCo',
    'ooooo',
    'oWWWo',
    'oWWWo',
    'oWWWo',
    '.oCo.',
    '..o..',
  ]),
  question: propSprite({ A: '#f0b030', k: '#3a2410' }, [
    '..oooo..',
    '.oAkkAo.',
    'oAkAAkAo',
    'oAAAAkAo',
    'oAAAkAAo',
    'oAAAAAAo',
    '.oAAkAo.',
    '..oooo..',
  ]),
  stamp: propSprite({ H: '#8a5a32', G: '#44bb66', g: '#2a8a46' }, [
    '...ooo...',
    '..oHHHo..',
    '...oHo...',
    '...oHo...',
    '.ooooooo.',
    'oGGGGGGGo',
    'oGGGGGGGo',
    'ogggggggo',
    '.ooooooo.',
  ]),
  clipboard: propSprite({ B: '#9a6a3a', M: '#a7afbd', W: '#f4efe2', l: '#8a93a8' }, [
    '..oooo..',
    'ooMMMMoo',
    'oBWWWWBo',
    'oBWllWBo',
    'oBWWWWBo',
    'oBWllWBo',
    'oBWWWWBo',
    'oBBBBBBo',
    'oooooooo',
  ]),
};

// ════════════════════════════════════════════════════════════════
// Loaded character sprites (from PNG assets)
// ════════════════════════════════════════════════════════════════

interface LoadedCharacterData {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
}

let loadedCharacters: LoadedCharacterData[] | null = null;

/** Set pre-colored character sprites loaded from PNG assets. Call this when characterSpritesLoaded message arrives. */
export function setCharacterTemplates(data: LoadedCharacterData[]): void {
  loadedCharacters = data;
  // Clear cache so sprites are rebuilt from loaded data
  spriteCache.clear();
}

/** Return the number of loaded character palettes, or PALETTE_COUNT as fallback. */
export function getLoadedCharacterCount(): number {
  return loadedCharacters ? loadedCharacters.length : PALETTE_COUNT;
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
}

const spriteCache = new Map<string, CharacterSprites>();

/** Apply hue shift to every sprite in a CharacterSprites set */
function hueShiftSprites(sprites: CharacterSprites, hueShift: number): CharacterSprites {
  const color: ColorValue = { h: hueShift, s: 0, b: 0, c: 0 };
  const shift = (s: SpriteData) => adjustSprite(s, color);
  const shiftWalk = (
    arr: [SpriteData, SpriteData, SpriteData, SpriteData],
  ): [SpriteData, SpriteData, SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
    shift(arr[2]),
    shift(arr[3]),
  ];
  const shiftPair = (arr: [SpriteData, SpriteData]): [SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
  ];
  return {
    walk: {
      [Dir.DOWN]: shiftWalk(sprites.walk[Dir.DOWN]),
      [Dir.UP]: shiftWalk(sprites.walk[Dir.UP]),
      [Dir.RIGHT]: shiftWalk(sprites.walk[Dir.RIGHT]),
      [Dir.LEFT]: shiftWalk(sprites.walk[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>,
    typing: {
      [Dir.DOWN]: shiftPair(sprites.typing[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.typing[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.typing[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.typing[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
    reading: {
      [Dir.DOWN]: shiftPair(sprites.reading[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.reading[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.reading[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.reading[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
  };
}

/** Create a transparent placeholder sprite of given dimensions */
function emptySprite(w: number, h: number): SpriteData {
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    rows.push(new Array(w).fill(''));
  }
  return rows;
}

export function getCharacterSprites(paletteIndex: number, hueShift = 0): CharacterSprites {
  const cacheKey = `${paletteIndex}:${hueShift}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  let sprites: CharacterSprites;

  if (loadedCharacters) {
    // Use pre-colored character sprites directly (no palette swapping)
    const char = loadedCharacters[paletteIndex % loadedCharacters.length];
    const d = char.down;
    const u = char.up;
    const rt = char.right;
    const flip = flipSpriteHorizontal;

    sprites = {
      walk: {
        [Dir.DOWN]: [d[0], d[1], d[2], d[1]],
        [Dir.UP]: [u[0], u[1], u[2], u[1]],
        [Dir.RIGHT]: [rt[0], rt[1], rt[2], rt[1]],
        [Dir.LEFT]: [flip(rt[0]), flip(rt[1]), flip(rt[2]), flip(rt[1])],
      },
      typing: {
        [Dir.DOWN]: [d[3], d[4]],
        [Dir.UP]: [u[3], u[4]],
        [Dir.RIGHT]: [rt[3], rt[4]],
        [Dir.LEFT]: [flip(rt[3]), flip(rt[4])],
      },
      reading: {
        [Dir.DOWN]: [d[5], d[6]],
        [Dir.UP]: [u[5], u[6]],
        [Dir.RIGHT]: [rt[5], rt[6]],
        [Dir.LEFT]: [flip(rt[5]), flip(rt[6])],
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
    };
  }

  // Apply hue shift if non-zero
  if (hueShift !== 0) {
    sprites = hueShiftSprites(sprites, hueShift);
  }

  spriteCache.set(cacheKey, sprites);
  return sprites;
}
