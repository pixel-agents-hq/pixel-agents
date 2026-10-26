/**
 * What the Characters view does to a profile: wear a part, colour it, randomize it,
 * paint pixels. Each function mutates the draft it is given (the cast store hands out
 * a fresh copy per change, so history snapshots stay untouched).
 */

import {
  CHARACTER_PROFILE_VERSION,
  type CharacterColor,
  type CharacterProfile,
  parseCharacterProfiles,
} from '../../../core/src/characterProfiles.js';
import { GREETER_CHARACTER_ID } from '../constants.js';
import { SWATCHES } from './art/artColors.js';
import type { CharacterRenderer } from './renderer.js';
import {
  ACCESSORIES,
  colorArt,
  type ColorKey,
  DRESS_SLOTS,
  editKey,
  editsOf,
  EYE_SHAPES,
  eyeShape,
  type SlotKey,
  startingUtop,
  type TabKey,
  TABS,
  underOf,
  UNDERWEAR,
} from './slots.js';
import { partArt, partLabel, type Wardrobe } from './wardrobe.js';

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
  if (id && slot === 'full') p.top = undefined;
  if (id && slot === 'top') p.full = undefined;
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
  // clothes and hair take one of their category's colours (gray parts always, coloured ones half the time)
  for (const key of DRESS_SLOTS) {
    const pix = colorArt(p, key);
    const pal = r.paletteFor(pix);
    if (pal && (r.isNeutral(pix) || chance(0.5))) p.colors[key] = { ...pick(pal.row) };
  }
  const eyes = colorArt(p, 'eyes');
  if (eyes && chance(0.3)) p.colors.eyes = r.swatchValue(eyes, pick(SWATCHES.eyes), 'eyes');
  // any skin tone (Light is the art as drawn)
  const tone = pick(['Light', ...Object.keys(r.wardrobe.swaps.get(partArt('body', p.body)) ?? {})]);
  if (tone !== 'Light') p.colors.skin = { h: 0, s: 0, b: 0, c: 0, palette: tone };
}

// ── Labels ─────────────────────────────────────────────────

/** The line under each wardrobe tab's name: what the profile wears there. */
export function tabSummary(w: Wardrobe, p: CharacterProfile, tab: TabKey): string {
  switch (tab) {
    case 'body':
      return `Chest: ${partLabel(w, 'body', p.body)}`;
    case 'eyes': {
      const { label } = eyeShape(p);
      return p.colors?.eyes || p.colors?.lashes ? `${label}, recoloured` : label;
    }
    case 'acc': {
      const worn = ACCESSORIES.filter((a) => p[a.key]).length;
      return worn ? `${worn} worn` : 'None';
    }
    default: {
      const under = underOf(tab);
      if (!p[tab] && under && p[under]) return 'Underwear';
      const { inner } = TABS.find((t) => t.key === tab)!;
      const worn = partLabel(w, tab, p[tab]);
      return inner && p[inner] ? `${worn}, ${partLabel(w, inner, p[inner])}` : worn;
    }
  }
}

/** A file name from the profile's name (char_N when unnamed). */
export function fileBaseName(p: CharacterProfile, index: number): string {
  const printable = [...(p.name ?? '')].map((ch) => (ch < ' ' ? '-' : ch)).join('');
  const cleaned = printable.replace(/[\\/:*?"<>|]+/g, '-').replace(/^[\s.]+|[\s.]+$/g, '');
  return cleaned || `char_${index}`;
}

/** fileBaseName for a whole roster, numbered on from a repeat (Bob, Bob 2) so no file overwrites another. */
export function rosterFileNames(profiles: readonly CharacterProfile[]): string[] {
  const taken = new Set<string>();
  return profiles.map((p, i) => {
    const base = fileBaseName(p, i);
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

/**
 * Profiles from a config file: one profile, a list, or a saved roster ({ roster: [...] }),
 * as saved by this view or the wardrobe artifact, migrated to the current format. Null when
 * the file isn't one (parseCharacterProfiles' rules, at most MAX_CHARACTER_PROFILES, and
 * every body one the wardrobe has).
 */
export function parseConfigFile(
  w: Wardrobe,
  text: string,
  fileName: string,
): CharacterProfile[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const roster = data && typeof data === 'object' && (data as { roster?: unknown }).roster;
  const profiles = parseCharacterProfiles(
    Array.isArray(data) ? data : Array.isArray(roster) ? roster : [data],
  );
  const bodies = new Set(w.manifest.parts.body.map((b) => b.id));
  if (!profiles?.every((p) => bodies.has(p.body))) return null;
  // the parsed file is ours to change: name the unnamed after it
  return profiles.map((p) => ({ ...p, name: p.name || fileName.replace(/\.json$/i, '') }));
}

/** A character's name as the rosters show it: its name, else its sheet's file name. */
export const characterLabel = (profile: CharacterProfile | undefined, index: number): string =>
  profile?.name || `char_${index}`;

/** The Intro greeter's character (a palette index): the profile whose id is
 *  GREETER_CHARACTER_ID, else the first in the cast. */
export function greeterPalette(profiles: readonly CharacterProfile[]): number {
  const index = profiles.findIndex((p) => p.id === GREETER_CHARACTER_ID);
  return index >= 0 ? index : 0;
}
