/**
 * The roster and the wardrobe as the Pixel Office MCP describes them
 * (list_wardrobe, list_characters): what characters are made of, each
 * character's parts and colours in words an agent can copy, the Directories
 * that use it and the agents wearing it, and a picture of it drawn here by the
 * server (characterArt.ts: core's renderer, no office needed).
 *
 * Also the ONE character resolver every tool addresses characters through (by
 * id, exact name or palette index; an ambiguous name is refused with the
 * matching ids), and the colour naming (`namedColors`, `describeColor`) that a
 * Character edit resolves colours against: what list_wardrobe offers is what
 * an edit accepts.
 */

import {
  CHARACTER_SLOTS,
  type CharacterColor,
  characterIdOf,
  type CharacterProfile,
  DEFAULT_EYE_ROWS,
  EYE_ROWS,
  MAX_CHARACTER_PROFILES,
} from '../../../core/src/characterProfiles.js';
import { SWATCHES } from '../../../core/src/characters/art/artColors.js';
import { colorKey, isAsDrawn } from '../../../core/src/characters/color.js';
import type { CharacterRenderer } from '../../../core/src/characters/renderer.js';
import {
  ACCESSORIES,
  colorArt,
  type ColorKey,
  EXCLUSIVE_SLOTS,
  EYE_SHAPES,
  eyeShape,
  layerOf,
  LAYERS,
  type SlotKey,
  TABS,
  UNDERWEAR,
} from '../../../core/src/characters/slots.js';
import { partArt, type Underwear } from '../../../core/src/characters/wardrobe.js';
import { characterPreviewPng, characterRenderer } from '../characterArt.js';
import { getCharacterProfiles, getWardrobeItems } from '../characterProfilesStore.js';
import { CHARACTER_PREVIEW_LIMIT, CHARACTER_ROSTER_HINT_MAX } from '../constants.js';
import { getPaletteCount } from '../paletteAssigner.js';
import type { CharacterEdits } from './characterEdits.js';
import type { OfficeFacts } from './officeFacts.js';
import type { CharacterOps } from './officeOperations.js';

// ── Addressing ──────────────────────────────────────────────

/** How an agent names a character: its id, its exact name, or its palette index. */
export type CharacterRef = string | number;

/** A character found (its palette index and profile), or why not. */
export type CharacterLookup =
  { ok: true; index: number; profile: CharacterProfile } | { ok: false; reason: string };

/** The roster spelled out for a refusal, or a pointer to list_characters when it is long. */
function rosterHint(profiles: readonly CharacterProfile[]): string {
  if (profiles.length > CHARACTER_ROSTER_HINT_MAX) {
    return `list_characters lists the ${profiles.length} characters.`;
  }
  const each = profiles.map((p, i) => `${i} ${p.name || '(unnamed)'} (${characterIdOf(p, i)})`);
  return `the roster is ${each.join(', ')}.`;
}

/**
 * The character `ref` names in `profiles`: a palette index, else an id, else a name —
 * exactly, else ignoring case. A name several characters share is refused with their
 * ids (an id always names one).
 */
export function findCharacter(
  profiles: readonly CharacterProfile[],
  ref: CharacterRef,
): CharacterLookup {
  if (typeof ref === 'number') {
    if (Number.isInteger(ref) && ref >= 0 && ref < profiles.length) {
      return { ok: true, index: ref, profile: profiles[ref] };
    }
    return { ok: false, reason: `There is no character ${ref}: ${rosterHint(profiles)}` };
  }
  const wanted = ref.trim();
  const found = (index: number): CharacterLookup => ({
    ok: true,
    index,
    profile: profiles[index],
  });
  const byId = profiles.findIndex((p, i) => characterIdOf(p, i) === wanted);
  if (byId >= 0) return found(byId);
  const named = (same: (name: string) => boolean): number[] =>
    profiles.flatMap((p, i) => (p.name !== undefined && same(p.name) ? [i] : []));
  let matches = named((name) => name === wanted);
  if (matches.length === 0) {
    matches = named((name) => name.toLowerCase() === wanted.toLowerCase());
  }
  if (matches.length === 1) return found(matches[0]);
  if (matches.length > 1) {
    const ids = matches.map((i) => `${characterIdOf(profiles[i], i)} (palette ${i})`);
    return {
      ok: false,
      reason: `${matches.length} characters are called ${wanted}: ${ids.join(', ')}. Name one by its id.`,
    };
  }
  return {
    ok: false,
    reason: `There is no character called ${wanted}: ${rosterHint(profiles)}`,
  };
}

/**
 * The palette a launch's `character` names: a roster character (findCharacter), or a
 * palette index past the roster that an external character sprite (char_N.png) holds.
 */
export function paletteOf(
  ref: CharacterRef,
): { ok: true; palette: number } | { ok: false; reason: string } {
  const profiles = getCharacterProfiles();
  if (
    typeof ref === 'number' &&
    Number.isInteger(ref) &&
    ref >= profiles.length &&
    ref < getPaletteCount()
  ) {
    return { ok: true, palette: ref };
  }
  const found = findCharacter(profiles, ref);
  return found.ok ? { ok: true, palette: found.index } : found;
}

// ── Colours ─────────────────────────────────────────────────

/** Every colour key, in draw order, with the piece that owns it (the first to take it). */
export const COLOR_PIECES: ReadonlyArray<{ key: ColorKey; pix: string }> = LAYERS.flatMap((l, i) =>
  l.color && LAYERS.findIndex((o) => o.color === l.color) === i
    ? [{ key: l.color, pix: l.pix }]
    : [],
);

/** A colour key's name: its Characters-view picker's, else its piece's. */
function colorLabel(key: ColorKey, pix: string): string {
  for (const tab of TABS) {
    const picker = tab.pickers.find((p) => p.key === key);
    if (picker && picker.label !== 'Colour') return picker.label;
  }
  return layerOf(pix).label;
}

/** The swatches a colour key without a category palette offers (eyes, lashes, underwear, tie). */
export const swatchesOf = (key: ColorKey): readonly string[] =>
  key === 'eyes' || key === 'lashes' ? SWATCHES[key] : SWATCHES.default;

/** The name of the art's own colours, for every key. */
export const AS_DRAWN = 'As drawn';

/**
 * The named colours a colour key offers, as the Characters view shows them: its
 * category's palette squares (each part has its own value per square), or — for keys
 * without one — hex swatches fitted to the part's shading. Every key also takes
 * "As drawn" (the art's own colours).
 */
export function namedColors(
  renderer: CharacterRenderer,
  key: ColorKey,
): { named: Array<{ name: string; hex: string }> } | { swatches: readonly string[] } {
  const pix = COLOR_PIECES.find((c) => c.key === key)?.pix ?? key;
  const palette = renderer.wardrobe.manifest.palettes[pix];
  if (palette) return { named: palette.squares.map((sq) => ({ name: sq.label, hex: sq.hex })) };
  return { swatches: swatchesOf(key) };
}

/** A stored colour in words: the palette square, swatch or colourway it is, and its hex. */
export interface DescribedColor {
  /** Exactly as stored: passing it back as {h, s, b, c} (and palette) reproduces it. */
  value: CharacterColor;
  /** The named colour it is: a palette square's name, or "As drawn". */
  name?: string;
  /** The part colourway it starts from. */
  colorway?: string;
  /** Its main tone on the part worn (null when nothing worn takes it). */
  hex: string | null;
  /** True when `hex` is only the tone it shows (not a swatch it was picked as). */
  approximate?: boolean;
}

/** How colour key `key` of profile `p` reads: name, colourway or swatch hex, plus its tone. */
export function describeColor(
  renderer: CharacterRenderer,
  p: CharacterProfile,
  key: ColorKey,
  value: CharacterColor,
): DescribedColor {
  const art = colorArt(p, key);
  const out: DescribedColor = { value, hex: null };
  if (value.palette) out.colorway = value.palette;
  const same = colorKey(value);
  const palette = renderer.paletteFor(art);
  if (palette) {
    const i = palette.row.findIndex((cv) => colorKey(cv) === same);
    if (i >= 0) out.name = palette.squares[i].label;
  } else if (art) {
    const swatch = swatchesOf(key).find(
      (hex) => colorKey(renderer.swatchValue(art, hex, key)) === same,
    );
    if (swatch) out.hex = swatch;
  }
  if (!out.name && isAsDrawn(value)) out.name = AS_DRAWN;
  if (out.hex === null && art) {
    out.hex = renderer.wayHex(art, value);
    if (out.hex) out.approximate = true;
  }
  return out;
}

// ── The wardrobe (list_wardrobe) ────────────────────────────

/** Slots a character wears parts in, besides its body. */
export const PART_SLOTS = CHARACTER_SLOTS.filter((slot) => slot !== 'body');

const UNDERWEAR_SLOTS: readonly Underwear[] = ['utop', 'under'];
export const isUnderwear = (slot: SlotKey): slot is Underwear =>
  (UNDERWEAR_SLOTS as readonly string[]).includes(slot);

/** A slot's name: its accessory card's, else its piece's. */
const slotLabel = (slot: SlotKey): string =>
  ACCESSORIES.find((a) => a.key === slot)?.label ?? layerOf(slot).label;

const COLOR_FORMATS = {
  name: '{"name": "Yellow"}: a named colour of that colour key (colors[].named), or "As drawn" (the art\'s own colours).',
  colorway:
    '{"colorway": "Navy"}: one of the worn part\'s exact colourways (slots[].parts[].colorways).',
  hex: '{"hex": "#rrggbb"}: any colour, fitted to the part\'s shading as the swatches are (colors[].swatches are hexes too).',
  hsbc: '{"h", "s", "b", "c"} (optionally "colorize": true): exact slider values, as list_characters shows them under `value`.',
  none: "null: unset (the art's own colours, or the default the rules name).",
};

/** The wardrobe in an agent's terms (list_wardrobe): parts, colours, eyes, bodies, rules. */
export function wardrobeListing(renderer: CharacterRenderer): Record<string, unknown> {
  const { wardrobe } = renderer;
  const parts = wardrobe.manifest.parts;
  const slots = PART_SLOTS.filter((slot) => !isUnderwear(slot)).map((slot) => ({
    slot,
    label: slotLabel(slot),
    parts: (parts[slot] ?? []).map((part) => {
      const colorways = Object.keys(wardrobe.swaps.get(partArt(slot, part.id)) ?? {});
      return {
        id: part.id,
        label: part.label,
        ...(part.base ? { custom: true, base: part.base } : {}),
        ...(colorways.length ? { colorways } : {}),
        ...(slot === 'full' && wardrobe.art.has(partArt('tie', part.id)) ? { has_tie: true } : {}),
      };
    }),
  }));
  // Keys sharing one palette (the clothes) list it once, at the first of them.
  const listed = new Map<string, ColorKey>();
  const colors = COLOR_PIECES.map(({ key, pix }) => {
    const offered = namedColors(renderer, key);
    const content = JSON.stringify(offered);
    const first = listed.get(content);
    if (!first) listed.set(content, key);
    return { key, label: colorLabel(key, pix), ...(first ? { same_as: first } : offered) };
  });
  return {
    sprite:
      'A character is 16x32 pixels a frame: a part is a few pixels, so looks come from shapes and colours, not detail.',
    slots,
    bodies: (parts.body ?? []).map((body) => ({
      id: body.id,
      label: body.label,
      default_eye_shape: eyeShape({ body: body.id }).id,
    })),
    underwear: {
      slots: { utop: slotLabel('utop'), under: slotLabel('under') },
      part: UNDERWEAR,
      note: 'Each is "basic" or none. It shows only where nothing covers it: the under top without a top or outfit, the under bottom without pants or an outfit.',
    },
    eye_shapes: EYE_SHAPES.map((shape) => ({
      id: shape.id,
      label: shape.label,
      description: shape.title,
    })),
    eye_rows: {
      values: EYE_ROWS,
      default: DEFAULT_EYE_ROWS,
      note: 'Which pixel of each eye takes the eye colour (the other stays black pupil).',
    },
    colors,
    color_formats: COLOR_FORMATS,
    rules: {
      exclusive_slots: EXCLUSIVE_SLOTS,
      roster_limit: MAX_CHARACTER_PROFILES,
      notes: [
        'A colour applies to the part worn in its slot; skin colours the body.',
        'The tie colour shows only on an outfit with has_tie; uncoloured, it wears the outfit colour.',
        'An uncoloured beard wears the hair colour.',
        'Gray clothes nobody coloured are worn white, gray hair dark brown.',
        'Named colours give each part its own value: the same name looks alike on every part.',
      ],
    },
  };
}

// ── The roster (list_characters) ────────────────────────────

/** One roster character, as list_characters describes it. */
export interface OfficeCharacter {
  id: string;
  name: string | null;
  palette: number;
  body: string;
  eyeShape: string;
  eyeRows: string;
  /** Slot → the part worn (absent slots wear nothing). */
  parts: Record<string, { id: string; label: string }>;
  /** Colour key → its colour, for the colours set (the rest are the art's own or a default). */
  colors: Record<string, DescribedColor>;
  /** Pieces carrying pixel edits ('<piece>:<part>'): the picture shows them, parts and colours don't. */
  editedPieces: string[];
  /** The Directories using it as a default character, in their order. */
  directories: string[];
  /** The agents wearing it now. */
  agents: number[];
}

function describeCharacter(
  renderer: CharacterRenderer,
  p: CharacterProfile,
  index: number,
  directories: ReadonlyArray<{ name: string; characters: readonly number[] }>,
  wearers: number[],
): OfficeCharacter {
  const parts: OfficeCharacter['parts'] = {};
  for (const slot of PART_SLOTS) {
    const id = p[slot];
    if (!id) continue;
    const label = isUnderwear(slot)
      ? 'Underwear'
      : (renderer.wardrobe.manifest.parts[slot]?.find((part) => part.id === id)?.label ??
        `${id} (not in the wardrobe)`);
    parts[slot] = { id, label };
  }
  const colors: OfficeCharacter['colors'] = {};
  for (const { key } of COLOR_PIECES) {
    const value = p.colors?.[key];
    if (value) colors[key] = describeColor(renderer, p, key, value);
  }
  return {
    id: characterIdOf(p, index),
    name: p.name || null,
    palette: index,
    body: p.body,
    eyeShape: eyeShape(p).id,
    eyeRows: p.eyeRows ?? DEFAULT_EYE_ROWS,
    parts,
    colors,
    editedPieces: Object.keys(p.edits ?? {}),
    directories: directories.filter((d) => d.characters?.includes(index)).map((d) => d.name),
    agents: wearers,
  };
}

/** A character's picture, labelled. */
export interface CharacterPreview {
  id: string;
  name: string | null;
  palette: number;
  png: Buffer;
}

/** The characters capability: the wardrobe, the roster and its pictures, and agents'
 *  Character edits (committed by `edits`, characterEdits.ts). */
export function createCharacterOps(
  facts: Pick<OfficeFacts, 'store' | 'userDirectories'>,
  edits: Pick<CharacterEdits, 'edit' | 'undo'>,
): CharacterOps {
  const renderer = () => characterRenderer(getWardrobeItems());
  return {
    listWardrobe: () => wardrobeListing(renderer()),

    listCharacters() {
      const r = renderer();
      const directories = facts.userDirectories();
      const wearers = new Map<number, number[]>();
      for (const [id, agent] of facts.store) {
        if (agent.palette === undefined) continue;
        wearers.set(agent.palette, [...(wearers.get(agent.palette) ?? []), id]);
      }
      const profiles = getCharacterProfiles();
      return {
        characters: profiles.map((p, i) =>
          describeCharacter(r, p, i, directories, wearers.get(i) ?? []),
        ),
        externalSprites: Math.max(0, getPaletteCount() - profiles.length),
      };
    },

    characterAt(ref) {
      const found = findCharacter(getCharacterProfiles(), ref);
      return found.ok
        ? {
            id: characterIdOf(found.profile, found.index),
            name: found.profile.name ?? '',
            palette: found.index,
          }
        : { palette: ref };
    },

    previews(refs) {
      const profiles = getCharacterProfiles();
      const indices: number[] = [];
      for (const ref of refs) {
        const found = findCharacter(profiles, ref);
        if (!found.ok) return found;
        if (!indices.includes(found.index)) indices.push(found.index);
      }
      const items = getWardrobeItems();
      return {
        ok: true,
        previews: indices.slice(0, CHARACTER_PREVIEW_LIMIT).map((index) => ({
          id: characterIdOf(profiles[index], index),
          name: profiles[index].name || null,
          palette: index,
          png: characterPreviewPng(profiles[index], { items }),
        })),
        asked: indices.length,
      };
    },

    editCharacters: (agentId, ops) => edits.edit(agentId, ops),

    undoCharacterEdit: () => edits.undo(),
  };
}
