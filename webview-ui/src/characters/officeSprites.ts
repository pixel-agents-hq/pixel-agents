/**
 * The office wears the cast: profile N is palette N, followed by any char_N.png sprites
 * from external asset directories. Follows the cast store as a subscriber; the store
 * doesn't know about the office. A repeated character's sheet (repeatClothes.ts) is
 * rendered on demand: a profile's with its clothes recoloured, an external sprite
 * hue-turned whole.
 */

import { sheetToDirectionSprites } from '../../../core/src/assets/characterSheet.js';
import type { CharacterDirectionSprites } from '../../../core/src/assets/types.js';
import { CAST_OFFICE_SYNC_MS } from '../constants.js';
import { adjustSprite } from '../office/colorize.js';
import { setCharacterTemplates } from '../office/sprites/spriteData.js';
import type { CastState } from './cast.js';
import { repeatHueTurn, withRepeatClothes } from './repeatClothes.js';
import { SHEET_W } from './sheet.js';

/** A composed 128x96 character sheet as the office's per-direction frame sprites. */
export function sheetToOfficeSprites(sheet: Uint8ClampedArray): CharacterDirectionSprites {
  return sheetToDirectionSprites(sheet, SHEET_W);
}

interface CastSource {
  subscribe: (listener: () => void) => () => void;
  getState: () => CastState;
}

/** Each sheet's office sprites, converted once (sheets are cached, immutable buffers). */
const converted = new WeakMap<Uint8ClampedArray, CharacterDirectionSprites>();
let external: CharacterDirectionSprites[] = [];
let source: CastSource | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Whether the office has had the cast yet (until then, sync at once). */
let synced = false;

/** A sheet's office sprites, converted once per sheet. */
function officeSpritesOf(sheet: Uint8ClampedArray): CharacterDirectionSprites {
  let set = converted.get(sheet);
  if (!set) {
    set = sheetToOfficeSprites(sheet);
    converted.set(sheet, set);
  }
  return set;
}

/** An external sprite hue-turned whole for its repeat (repeatHueTurn). */
function hueTurned(sprites: CharacterDirectionSprites, repeat: number): CharacterDirectionSprites {
  const shift = { h: repeatHueTurn(repeat), s: 0, b: 0, c: 0 };
  const turn = (frames: string[][][]) => frames.map((frame) => adjustSprite(frame, shift));
  return { down: turn(sprites.down), up: turn(sprites.up), right: turn(sprites.right) };
}

function sync(): void {
  timer = null;
  if (!source) return;
  const { renderer, profiles } = source.getState();
  if (!renderer || !profiles.length) return;
  const sprites = profiles.map((p) => officeSpritesOf(renderer.sheet(p)));
  // The repeats are drawn from this same cast, so they never fall out of step.
  setCharacterTemplates([...sprites, ...external], (palette, repeat) => {
    const profile = profiles[palette];
    if (profile) return officeSpritesOf(renderer.sheet(withRepeatClothes(profile, repeat)));
    const sprite = external[palette - profiles.length];
    return sprite ? hueTurned(sprite, repeat) : null;
  });
  synced = true;
}

/** Sync after `delay` ms, coalescing with one already scheduled. */
function schedule(delay: number): void {
  if (!timer) timer = setTimeout(sync, delay);
}

/**
 * Keep the office's character sprites in step with the cast: at once for the first cast,
 * then at most every CAST_OFFICE_SYNC_MS while it changes (a drag re-renders often).
 * Returns the unsubscribe.
 */
export function startOfficeSync(cast: CastSource): () => void {
  source = cast;
  let { renderer, profiles } = cast.getState();
  sync();
  const unsubscribe = cast.subscribe(() => {
    const state = cast.getState();
    if (state.renderer === renderer && state.profiles === profiles) return;
    ({ renderer, profiles } = state);
    schedule(synced ? CAST_OFFICE_SYNC_MS : 0);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
    if (source === cast) source = null;
  };
}

/** External asset directories' char_N.png, worn after the profiles. */
export function setExternalCharacterSprites(sprites: CharacterDirectionSprites[]): void {
  external = sprites;
  schedule(0);
}
