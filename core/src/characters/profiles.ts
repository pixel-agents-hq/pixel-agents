/**
 * What the Characters view does to a profile: wear a part, colour it, randomize it,
 * paint pixels. Each function mutates the draft it is given (the cast store hands out
 * a fresh copy per change, so history snapshots stay untouched).
 */

import {
  CHARACTER_PROFILE_VERSION,
  type CharacterColor,
  type CharacterProfile,
} from '../characterProfiles.js';
import { SWATCHES } from './art/artColors.js';
import type { CharacterRenderer } from './renderer.js';
import {
  colorArt,
  type ColorKey,
  DRESS_SLOTS,
  editKey,
  editsOf,
  EXCLUSIVE_SLOTS,
  EYE_SHAPES,
  eyeShape,
  type SlotKey,
  startingUtop,
  underOf,
  UNDERWEAR,
} from './slots.js';
import { partArt } from './wardrobe.js';

export function newProfile(): CharacterProfile {
  return { name: '', body: 'flat', under: UNDERWEAR, colors: {}, v: CHARACTER_PROFILE_VERSION };
}

/**
 * Wear a part (or take the slot off with null). An outfit and a top replace each other; a
 * new body keeps the eyes as they are and starts in its own underwear top. Touches only
 * the profile's own fields (never colours or edits), so a shallow copy previews it.
 */
export function setPart(p: CharacterProfile, slot: SlotKey, id: string | null): void {
  if (slot === 'body') {
    if (!id || id === p.body) return;
    p.eyeShape ??= eyeShape(p).id;
    p.utop = startingUtop(id);
    p.body = id;
    return;
  }
  p[slot] = id ?? undefined;
  for (const [a, b] of EXCLUSIVE_SLOTS) {
    if (id && slot === a) p[b] = undefined;
    if (id && slot === b) p[a] = undefined;
  }
}

/** Top/Pants' first two options: nothing worn there, with or without the underwear. */
export function setUnderwear(p: CharacterProfile, slot: SlotKey, on: boolean): void {
  const under = underOf(slot);
  if (!under || slot === 'body') return;
  p[slot] = undefined;
  p[under] = on ? UNDERWEAR : undefined;
}

export function setColor(p: CharacterProfile, key: ColorKey, cv: CharacterColor | null): void {
  p.colors ??= {};
  if (cv) p.colors[key] = cv;
  else delete p.colors[key];
}

// ── Pixel edits ────────────────────────────────────────────

/** The edits on one piece, created on demand. */
function pieceEdits(p: CharacterProfile, pix: string) {
  const key = editKey(p, pix);
  p.edits ??= {};
  p.edits[key] ??= { cells: {} };
  return p.edits[key];
}

/** Paint (hex), erase (null) or restore (undefined) one pixel of a piece in one frame. */
export function paintPixel(
  p: CharacterProfile,
  pix: string,
  frame: number,
  pixel: number,
  value: string | null | undefined,
): boolean {
  const edits = pieceEdits(p, pix);
  const cell = (edits.cells[frame] ??= {});
  if (value === undefined ? !(pixel in cell) : cell[pixel] === value) {
    if (!Object.keys(cell).length) delete edits.cells[frame];
    return false;
  }
  if (value === undefined) delete cell[pixel];
  else cell[pixel] = value;
  if (!Object.keys(cell).length) delete edits.cells[frame];
  return true;
}

export function clearFrameEdits(p: CharacterProfile, pix: string, frame: number): void {
  const edits = pieceEdits(p, pix);
  delete edits.cells[frame];
}

export function clearPieceEdits(p: CharacterProfile, pix: string): void {
  if (p.edits) delete p.edits[editKey(p, pix)];
}

/** Whether a piece has edits (in one frame, or anywhere). */
export function hasEdits(p: CharacterProfile, pix: string, frame?: number): boolean {
  const cells = editsOf(p, pix)?.cells;
  if (!cells) return false;
  return frame === undefined ? Object.keys(cells).length > 0 : !!cells[frame];
}

// ── Randomize ──────────────────────────────────────────────

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const chance = (odds: number) => Math.random() < odds;

/** Re-roll the body, eyes, hair, clothes and their colours; accessories and edits stay. */
export function randomize(r: CharacterRenderer, p: CharacterProfile): void {
  const parts = r.wardrobe.manifest.parts;
  // built-in parts only: a custom item may be one the draft has deleted
  const any = (cat: string) => pick(parts[cat].filter((part) => !part.base)).id;
  p.body = any('body');
  p.hair = chance(0.92) ? any('hair') : undefined;
  if (chance(0.35)) {
    p.full = any('full');
    p.top = undefined;
    p.pants = chance(0.5) ? any('pants') : undefined;
  } else {
    p.full = undefined;
    p.top = any('top');
    p.pants = any('pants');
  }
  p.jacket = chance(0.4) ? any('jacket') : undefined;
  p.hat = chance(0.15) ? any('hat') : undefined;
  p.shoes = chance(0.85) ? any('shoes') : undefined;
  p.eyeShape = pick(EYE_SHAPES).id;
  p.beard = chance(0.2) ? any('beard') : undefined;
  p.utop = startingUtop(p.body);
  p.under = UNDERWEAR;
  p.colors = {};
  p.v = CHARACTER_PROFILE_VERSION;
  for (const key of DRESS_SLOTS) {
    const color = randomDressColor(r, p, key);
    if (color) p.colors[key] = color;
  }
  const eyes = randomEyes(r, p);
  if (eyes) p.colors.eyes = eyes;
  const skin = randomSkin(r, p.body);
  if (skin) p.colors.skin = skin;
}

/** A clothes or hair colour as randomize draws one: one of the category's colours, for a gray part always, a coloured one half the time. */
export function randomDressColor(
  r: CharacterRenderer,
  p: CharacterProfile,
  key: ColorKey,
): CharacterColor | undefined {
  const pix = colorArt(p, key);
  const pal = r.paletteFor(pix);
  return pal && (r.isNeutral(pix) || chance(0.5)) ? { ...pick(pal.row) } : undefined;
}

/** An eye colour as randomize draws one: a swatch, 30% of the time. */
export function randomEyes(r: CharacterRenderer, p: CharacterProfile): CharacterColor | undefined {
  const eyes = colorArt(p, 'eyes');
  return eyes && chance(0.3) ? r.swatchValue(eyes, pick(SWATCHES.eyes), 'eyes') : undefined;
}

/** A skin tone as randomize draws one: any of the body's (Light, the art as drawn, = none). */
export function randomSkin(r: CharacterRenderer, body: string): CharacterColor | undefined {
  const tone = pick(['Light', ...Object.keys(r.wardrobe.swaps.get(partArt('body', body)) ?? {})]);
  return tone !== 'Light' ? { h: 0, s: 0, b: 0, c: 0, palette: tone } : undefined;
}
