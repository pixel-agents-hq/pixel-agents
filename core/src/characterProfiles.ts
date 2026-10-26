/**
 * Character profiles: the cast agents are drawn from. A profile names one wardrobe part
 * per slot plus its colours and pixel edits; the webview composes it into a 128x96
 * character sheet. Profile index N is palette N in the office. Each profile also has a
 * permanent id, so a save that inserts or deletes characters can renumber whatever named
 * them by index (characterRemap).
 *
 * Pure data and validation, safe on both sides of the wire. The server persists the
 * list as given; only the webview knows what the part ids mean.
 */

import { CHAR_FRAME_PIXELS, CHAR_SHEET_FRAMES } from './assets/constants.js';
import { widenLegacyCells } from './assets/seatedFrame.js';
import { isRecord } from './isRecord.js';
import { newLocalId } from './localId.js';
import type {
  CharacterColor,
  CharacterPixelEdits,
  CharacterProfile as GeneratedCharacterProfile,
} from './messages.js';

/**
 * The profile shapes are the wire contract's (core/asyncapi.yaml, generated into messages.ts):
 * a part's colour is HSBC sliders, optionally on top of one of the part's exact colourways
 * (`palette`); pixel edits are stored uncoloured, `cells[frame][pixel]` = '#rrggbb' to paint
 * or null to erase (frame 0-23 = row * 8 + frame, pixel y*16+x).
 */
export type { CharacterColor, CharacterPixelEdits };

/** Profile fields that hold a wardrobe part id (one per slot). */
export const CHARACTER_SLOTS = [
  'body',
  'utop',
  'under',
  'hair',
  'beard',
  'top',
  'jacket',
  'pants',
  'shoes',
  'full',
  'hat',
  'necklace',
  'lanyard',
  'earrings',
  'shades',
  'hairshades',
  'watch',
] as const;
export type CharacterSlot = (typeof CHARACTER_SLOTS)[number];

/** Which eye pixel takes the eye colour. */
export const EYE_ROWS = ['top', 'bottom', 'both'] as const;
export type EyeRows = (typeof EYE_ROWS)[number];
/** The eye rows a profile without its own wears. */
export const DEFAULT_EYE_ROWS: EyeRows = 'bottom';

/** The generated profile, with its eye rows narrowed to the ones that exist. */
export type CharacterProfile = Omit<GeneratedCharacterProfile, 'eyeRows'> & { eyeRows?: EyeRows };

/** The generated profile's string fields that aren't part ids. */
type NonSlotString = 'id' | 'name' | 'eyeShape' | 'eyeRows';
type GeneratedSlot = {
  [K in keyof GeneratedCharacterProfile]-?: GeneratedCharacterProfile[K] extends string | undefined
    ? K extends NonSlotString
      ? never
      : K
    : never;
}[keyof GeneratedCharacterProfile];
/** CHARACTER_SLOTS is exactly the contract's part-id fields: a slot added to one only fails to compile. */
const slotsMatchContract: [CharacterSlot, GeneratedSlot] extends [GeneratedSlot, CharacterSlot]
  ? true
  : never = true;
void slotsMatchContract;

/**
 * 35 (the sheet's seated frame: 8 frames a row). Older profiles (30 = the wardrobe artifact's
 * format, 31-32 never shipped, 33 = 7 frames a row, 34 = 7 frames a row, written by the
 * unmerged stable-profile-ids work) are migrated on read, see migrateCharacterProfile.
 */
export const CHARACTER_PROFILE_VERSION = 35;
/** Upper bound on a saved cast, so a hand-edited or hostile payload can't grow the file without limit. */
export const MAX_CHARACTER_PROFILES = 500;

/**
 * A pixel set's id: a piece (a sheet layer, e.g. 'hair') and the part id it draws. Keys a
 * profile's edits.
 */
export const pixId = (set: string, id: string): string => `${set}:${id}`;
/** A pixel set id split back into [set, part id] (at the first colon). */
export function parsePixId(key: string): [set: string, id: string] {
  const k = key.indexOf(':');
  return k < 0 ? [key, ''] : [key.slice(0, k), key.slice(k + 1)];
}

const EDIT_COLOR_RE = /^#[0-9a-f]{6}$/i;
const CHARACTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A fresh character id. */
export const newCharacterId = (): string => newLocalId('c', 6);
/** Every profile field that holds a string besides the body (name, eye shape, part ids). */
const STRING_FIELDS = ['name', 'eyeShape', ...CHARACTER_SLOTS.filter((s) => s !== 'body')];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** An index key ('0'..'max-1'): what the renderer turns into a pixel offset. */
function isIndexKey(key: string, max: number): boolean {
  if (!/^\d+$/.test(key)) return false;
  return Number(key) < max;
}

function isCharacterColor(value: unknown): value is CharacterColor {
  if (!isRecord(value)) return false;
  if (!['h', 's', 'b', 'c'].every((k) => isFiniteNumber(value[k]))) return false;
  if (value.colorize !== undefined && typeof value.colorize !== 'boolean') return false;
  return value.palette === undefined || typeof value.palette === 'string';
}

/** cells[frame][pixel] '#rrggbb' or null, both keys in the sheet's range (an old format's rev, if any, finite). */
function isCharacterPixelEdits(value: unknown): value is CharacterPixelEdits {
  if (!isRecord(value) || !isRecord(value.cells)) return false;
  if (value.rev !== undefined && !isFiniteNumber(value.rev)) return false;
  return Object.entries(value.cells).every(
    ([frame, pixels]) =>
      isIndexKey(frame, CHAR_SHEET_FRAMES) &&
      isRecord(pixels) &&
      Object.entries(pixels).every(
        ([pixel, color]) =>
          isIndexKey(pixel, CHAR_FRAME_PIXELS) &&
          (color === null || (typeof color === 'string' && EDIT_COLOR_RE.test(color))),
      ),
  );
}

function isMapOf(value: unknown, isEntry: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(isEntry);
}

/**
 * A profile the renderer can draw without crashing or painting NaN: a string body, string
 * part ids, well-formed colours and pixel edits. Whether a part id exists is the webview's
 * to judge (an unknown one draws nothing). Unknown keys are allowed, so older formats
 * still reach migrateCharacterProfile.
 */
export function isCharacterProfile(value: unknown): value is CharacterProfile {
  if (!isRecord(value) || typeof value.body !== 'string') return false;
  if (value.id !== undefined && !(typeof value.id === 'string' && CHARACTER_ID_RE.test(value.id)))
    return false;
  for (const key of STRING_FIELDS) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.eyeRows !== undefined && !(EYE_ROWS as readonly unknown[]).includes(value.eyeRows))
    return false;
  if (value.v !== undefined && !isFiniteNumber(value.v)) return false;
  if (value.colors !== undefined && !isMapOf(value.colors, isCharacterColor)) return false;
  if (value.edits !== undefined && !isMapOf(value.edits, isCharacterPixelEdits)) return false;
  return true;
}

/**
 * The profiles in `value` (migrated) when it is a non-empty, bounded list of valid profiles;
 * otherwise null. The ONE validator: the server runs it before persisting and the webview
 * before drawing. A current-format profile with an id of its own comes back as the same
 * object, untouched. One without an id gets `char-<index>`, and one repeating an earlier
 * profile's id (a copy made before copies got their own) gets `<id>-<index>`: the same on
 * every read, so such a file reads alike until it is saved again.
 */
export function parseCharacterProfiles(value: unknown): CharacterProfile[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHARACTER_PROFILES) {
    return null;
  }
  if (!value.every(isCharacterProfile)) return null;
  const taken = new Set<string>();
  return value.map((p, i) => {
    const next = migrateCharacterProfile(p);
    let id = next.id ?? `char-${i}`;
    for (let n = i; taken.has(id); n += value.length) id = `${id.slice(0, 50)}-${n}`;
    taken.add(id);
    return id === next.id ? next : { ...next, id };
  });
}

/**
 * Where each character of `before` sits in `after`, matched by id, as a function from an
 * old palette index to the new one: undefined for a character `after` doesn't have.
 * Palettes past the profiles (external char_N.png sprites) keep their place after them.
 * Null when every index stays what it was, or when the lists share no character.
 */
export function characterRemap(
  before: readonly CharacterProfile[],
  after: readonly CharacterProfile[],
): ((palette: number) => number | undefined) | null {
  const at = new Map(after.map((p, i) => [p.id, i]));
  const moved = before.map((p) => at.get(p.id));
  if (before.length === after.length && moved.every((to, i) => to === i)) return null;
  // no character in common: a different cast replaced this one (the defaults standing in
  // for an unreadable file, say), not an edit of it, so there is nothing to follow
  if (moved.every((to) => to === undefined)) return null;
  return (palette) =>
    palette < before.length ? moved[palette] : palette - before.length + after.length;
}

const BODY_IDS: Record<string, string> = { light_male: 'flat', light_female: 'bust' };
const EYE_SHAPE_IDS: Record<string, string> = { light_male: 'plain', light_female: 'lashes' };

/** Part renames per slot (a slot's piece shares its name, so they also map edit keys). */
type PartIds = Partial<Record<CharacterSlot, Record<string, string>>>;

/** Part renames: the PSD layer names parts shipped with (layer_9, ...), and parts named after people. */
const PART_IDS: PartIds = {
  pants: { layer_1: 'low_cut_jeans', layer_4: 'shorts', helly_skirt: 'skirt' },
  top: { layer_6: 'long_sleeved_shirt', layer_12: 'bowling_shirt', helly_top: 'turtleneck' },
  jacket: { layer_3: 'open_shirt' },
  shoes: { layer_1: 'boots' },
  full: {
    layer_5: 'dress',
    layer_9: 'business_suit',
    layer_10: 'red_uniform',
    layer_13: 'navy_uniform',
    mark_suit: 'suit_and_tie',
  },
  hair: {
    layer_17: 'spiky',
    layer_19: 'long_waves',
    layer_20: 'short',
    layer_21: 'mop',
    layer_22: 'bob',
    layer_23_copy: 'long',
    layer_24: 'bowl_cut',
    mark_hair: 'side_swept',
    helly_hair: 'shoulder_length',
  },
  hat: { layer_14: 'badge_cap', layer_15: 'flap_cap', layer_16: 'plain_cap' },
  lanyard: { helly_lanyard: 'lanyard' },
};

/** Retired parts, gone from the wardrobe: their edits go with them. */
const RETIRED_PARTS: PartIds = {
  top: { bowling_shirt: 'tshirt' },
  full: { navy_uniform: 'business_suit', red_uniform: 'business_suit' },
};
/** The bowling shirt was a red t-shirt under the vest's original orange. */
const BOWLING_SHIRT_TOP: CharacterColor = { h: 2, s: 75, b: -28, c: -10, colorize: true };
const BOWLING_SHIRT_VEST: CharacterColor = { h: 0, s: 0, b: 0, c: 0, palette: 'Original' };

/** `next` with its parts renamed by `ids`, in its slots and its edit keys. */
function renameParts(next: CharacterProfile, ids: PartIds): void {
  const renamed = (slot: string, id: string) => ids[slot as CharacterSlot]?.[id] ?? id;
  for (const slot of CHARACTER_SLOTS) {
    const id = next[slot];
    if (id) next[slot] = renamed(slot, id);
  }
  if (next.edits) next.edits = mapEdits(next.edits, (set, id) => pixId(set, renamed(set, id)));
}

/** `next` dressed without the retired parts (a part's colour was relative to its own art). */
function replaceRetiredParts(next: CharacterProfile): void {
  if (next.edits) {
    next.edits = Object.fromEntries(
      Object.entries(next.edits).filter(([k]) => {
        const [set, id] = parsePixId(k);
        return !RETIRED_PARTS[set as CharacterSlot]?.[id];
      }),
    );
  }
  if (next.top === 'bowling_shirt') {
    next.colors = { ...next.colors, top: BOWLING_SHIRT_TOP };
    if (!next.jacket) {
      next.jacket = 'vest';
      next.colors.jacket = BOWLING_SHIRT_VEST;
    }
  }
  if (next.full && RETIRED_PARTS.full?.[next.full] && next.colors?.full) {
    next.colors = { ...next.colors };
    delete next.colors.full;
  }
  renameParts(next, RETIRED_PARTS);
}

/** Rename the keys of `edits`; `entry` may rewrite each value. */
const mapEdits = (
  edits: Record<string, CharacterPixelEdits>,
  key: (set: string, id: string) => string,
  entry: (e: CharacterPixelEdits) => CharacterPixelEdits = (e) => e,
) => Object.fromEntries(Object.entries(edits).map(([k, e]) => [key(...parsePixId(k)), entry(e)]));

/** Piece renames (edit keys only: a piece is not a slot). */
const PIECE_IDS: Record<string, string> = { eyefix: 'whites' };

/**
 * A profile in the current format; a current one comes back as the same object. An older one
 * gets, in one pass (each rename leaves an id it doesn't name alone, so it doesn't matter which
 * older format it is): the artifact's bodies and eye shapes renamed, edits without `rev`, the
 * eye whites piece renamed, the parts renamed (slots and edit keys), the retired parts replaced,
 * and the edits moved to the 8-frame sheet (every older format drew 7 frames a row).
 */
export function migrateCharacterProfile(profile: CharacterProfile): CharacterProfile {
  if ((profile.v ?? 0) >= CHARACTER_PROFILE_VERSION) return profile;
  const next: CharacterProfile = { ...profile, v: CHARACTER_PROFILE_VERSION };
  next.body = BODY_IDS[next.body] ?? next.body;
  if (next.eyeShape) next.eyeShape = EYE_SHAPE_IDS[next.eyeShape] ?? next.eyeShape;
  if (next.edits) {
    // lash edits are filed under the eye shape, the rest under the body
    next.edits = mapEdits(
      next.edits,
      (set, id) =>
        pixId(PIECE_IDS[set] ?? set, (set === 'lashes' ? EYE_SHAPE_IDS : BODY_IDS)[id] ?? id),
      ({ cells }) => ({ cells: widenLegacyCells(cells) }),
    );
  }
  renameParts(next, PART_IDS);
  replaceRetiredParts(next);
  return next;
}
