/**
 * edit_characters' operations: the input an agent sends (zod, snake_case, in
 * list_wardrobe / list_characters' vocabulary) and ONE pure function applying a
 * batch of them, in order, to a copy of the roster and of the Directories'
 * default characters. Every change to a profile is core's (core/src/characters/
 * profiles.ts: setPart, setColor, randomize — the functions the Characters view
 * calls), so an agent edits a character exactly as a person does; this module
 * only checks the arguments, resolves colours the way list_wardrobe offers them,
 * explains a refusal and records what the batch did.
 *
 * All or none: the first op that can't apply refuses the whole batch with its
 * index and a reason; nothing is written until every op applied.
 *
 * During the batch a Directory's defaults are held by character id, not palette
 * index: a delete moves every index after it, and an id stays put. They become
 * palette indices of the final roster at the end.
 */

import { z } from 'zod';

import {
  type CharacterColor,
  characterIdOf,
  type CharacterProfile,
  characterRemap,
  EYE_ROWS,
  GREETER_CHARACTER_ID,
  MAX_CHARACTER_PROFILES,
  newCharacterId,
  parseCharacterProfiles,
} from '../../../core/src/characterProfiles.js';
import { ZERO_COLOR } from '../../../core/src/characters/color.js';
import {
  newProfile,
  randomDressColor,
  randomEyes,
  randomize,
  randomSkin,
  setColor,
  setPart,
} from '../../../core/src/characters/profiles.js';
import type { CharacterRenderer } from '../../../core/src/characters/renderer.js';
import {
  colorArt,
  type ColorKey,
  DRESS_SLOTS,
  EXCLUSIVE_SLOTS,
  EYE_SHAPES,
  type SlotKey,
  UNDERWEAR,
} from '../../../core/src/characters/slots.js';
import { MAX_DIRECTORY_CHARACTERS } from '../../../core/src/directoryCharacters.js';
import { remapList } from '../characterRemap.js';
import { normalizeDirectoryPath } from '../directories.js';
import { canonicalJson } from './canonicalJson.js';
import {
  AS_DRAWN,
  type CharacterRef,
  COLOR_PIECES,
  findCharacter,
  isUnderwear,
  PART_SLOTS,
  swatchesOf,
} from './charactersView.js';

// ── Input ────────────────────────────────────────────────────

/** The most ops one edit_characters call may carry. */
export const MAX_CHARACTER_OPS = 50;
/** A character name's longest spelling. */
export const MAX_CHARACTER_NAME = 40;

const inRange = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;

/** A colour as an agent gives it (list_wardrobe color_formats). */
const colorSpec = z.union([
  z.null(),
  z.object({ name: z.string().min(1) }).strict(),
  z.object({ colorway: z.string().min(1) }).strict(),
  z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex colours are "#rrggbb"') }).strict(),
  z
    .object({
      h: z.number(),
      s: z.number(),
      b: z.number(),
      c: z.number(),
      colorize: z.boolean().optional(),
      palette: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      (c) =>
        (c.colorize
          ? inRange(c.h, 0, 360) && inRange(c.s, 0, 100)
          : inRange(c.h, -180, 180) && inRange(c.s, -100, 100)) &&
        inRange(c.b, -100, 100) &&
        inRange(c.c, -100, 100),
      {
        message:
          'HSBC: h -180..180 and s -100..100; with colorize: true, h 0..360 and s 0..100; b and c -100..100',
      },
    ),
]);
export type ColorSpec = z.infer<typeof colorSpec>;

const COLOR_KEYS = COLOR_PIECES.map((c) => c.key);

/** slot → part id, or null for none: every slot optional, an unknown one refused. */
const partsInput = z
  .object(
    Object.fromEntries(PART_SLOTS.map((slot) => [slot, z.string().min(1).nullable().optional()])),
  )
  .strict()
  .describe(
    'Slot → a part id (list_wardrobe slots[].parts[].id; utop/under: "basic") or null for none.',
  );

/** colour key → a colour: every key optional, an unknown one refused. */
const colorsInput = z
  .object(Object.fromEntries(COLOR_KEYS.map((key) => [key, colorSpec.optional()])))
  .strict()
  .describe(
    'Colour key → {name} | {colorway} | {hex} | {h,s,b,c} | null (list_wardrobe color_formats). ' +
      'Applied after the parts, to the part worn.',
  );

const name = z.string().trim().min(1).max(MAX_CHARACTER_NAME);
const look = {
  body: z.string().min(1).optional().describe('list_wardrobe bodies[].id'),
  eye_shape: z.string().min(1).optional().describe('list_wardrobe eye_shapes[].id'),
  eye_rows: z.enum(EYE_ROWS).optional(),
  parts: partsInput.optional(),
  colors: colorsInput.optional(),
};
const characterRef = z
  .union([z.string().min(1), z.number().int().min(0)])
  .describe(
    "A character's id, exact name or palette index, or a `ref` created earlier in the batch.",
  );
const directory = z
  .string()
  .min(1)
  .describe("A Directory's name (as launch_agent names one) or path.");

/** Every op edit_characters takes, by its `op` name. */
export const characterOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create_character'),
    name,
    ref: z
      .string()
      .min(1)
      .max(MAX_CHARACTER_NAME)
      .optional()
      .describe('Name the new character for later ops in this batch.'),
    ...look,
    randomize: z
      .boolean()
      .optional()
      .describe("Fill every slot and colour not given at random, as the view's randomize does."),
  }),
  z.object({
    op: z.literal('update_character'),
    character: characterRef,
    name: name.optional(),
    ...look,
  }),
  z.object({ op: z.literal('delete_character'), character: characterRef }),
  z.object({
    op: z.literal('add_to_directory'),
    character: characterRef,
    directory,
    position: z.number().int().min(0).optional().describe('0 = highest priority; default last.'),
  }),
  z.object({ op: z.literal('remove_from_directory'), character: characterRef, directory }),
]);

export type CharacterOp = z.infer<typeof characterOpSchema>;
type LookOp = Extract<CharacterOp, { op: 'create_character' | 'update_character' }>;

// ── Applying ─────────────────────────────────────────────────

/** A Directory as a batch sees it: the user's own carry default characters, the host's can't. */
export interface EditDirectory {
  name: string;
  path: string;
  /** Its default characters (palette indices), or null for a host Directory. */
  characters: readonly number[] | null;
}

/** What a batch starts from. */
export interface CharacterEditStart {
  profiles: readonly CharacterProfile[];
  /** Draws and colours them (with the custom wardrobe items). */
  renderer: CharacterRenderer;
  /** Every Directory of the office. */
  directories: readonly EditDirectory[];
  /** Mints a new character's id. Default: core's newCharacterId. */
  newId?(): string;
}

/** A character a batch touched, by op index, as it ends up. */
export interface EditedCharacter {
  op: number;
  id: string;
  name: string;
  ref?: string;
}

export type CharacterEditResult =
  | {
      ok: true;
      /** The roster to save (unchanged = the start's own array). */
      profiles: CharacterProfile[];
      rosterChanged: boolean;
      /** The Directories whose defaults the batch changed, as palette indices of `profiles`. */
      directoryWrites: Array<{ name: string; path: string; characters: number[] }>;
      created: EditedCharacter[];
      updated: EditedCharacter[];
      deleted: EditedCharacter[];
      /** Ops that changed less than they were asked to (already so), and warnings. */
      notes: string[];
    }
  /** `index`: the op refused; absent when the batch as a whole is (its roster doesn't validate). */
  | { ok: false; index?: number; reason: string };

/** A refusal of the op being applied. */
class OpRefused extends Error {}

function refuse(reason: string): never {
  throw new OpRefused(reason);
}

/** A Directory default during the batch: a roster character's id, or an external sprite's offset past the roster. */
type DefaultRef = { id: string } | { external: number };

/** Apply `ops` in order to a copy of `start`. Pure apart from `start.newId` and randomize's dice. */
export function applyCharacterOps(
  start: CharacterEditStart,
  ops: readonly CharacterOp[],
): CharacterEditResult {
  const r = start.renderer;
  const newId = start.newId ?? newCharacterId;
  let profiles: CharacterProfile[] = [...start.profiles];
  const refs = new Map<string, string>();
  /** Directory path key → its defaults, for Directories the batch touched. */
  const touched = new Map<string, { dir: EditDirectory; list: DefaultRef[] }>();
  const created: EditedCharacter[] = [];
  const updated: EditedCharacter[] = [];
  const deleted: EditedCharacter[] = [];
  const notes: string[] = [];

  const idAt = (i: number): string => characterIdOf(profiles[i], i);

  /** The character an op names: a batch `ref` first, then the roster's resolver. */
  const resolve = (ref: CharacterRef): number => {
    if (typeof ref === 'string' && refs.has(ref)) {
      const id = refs.get(ref)!;
      const at = profiles.findIndex((p, i) => characterIdOf(p, i) === id);
      if (at < 0) refuse(`${ref} was deleted earlier in this batch`);
      return at;
    }
    const found = findCharacter(profiles, ref);
    if (!found.ok) refuse(found.reason);
    return found.index;
  };

  const directoryOf = (wanted: string): { dir: EditDirectory; list: DefaultRef[] } => {
    const dir = findDirectory(start.directories, wanted);
    if (!dir.characters) {
      refuse(
        `${dir.name} is the host's Directory (this window's own folder), and only Directories of your ` +
          "own carry default characters. Ask the user to add it in the launch drawer's + Directory",
      );
    }
    const key = normalizeDirectoryPath(dir.path);
    let entry = touched.get(key);
    if (!entry) {
      const before = start.profiles;
      entry = {
        dir,
        list: dir.characters.map((i): DefaultRef =>
          i < before.length ? { id: characterIdOf(before[i], i) } : { external: i - before.length },
        ),
      };
      touched.set(key, entry);
    }
    return entry;
  };

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    const note = (text: string) => notes.push(`op ${index} (${op.op}): ${text}`);
    try {
      switch (op.op) {
        case 'create_character': {
          if (profiles.length >= MAX_CHARACTER_PROFILES) {
            refuse(
              `the roster is full (${MAX_CHARACTER_PROFILES} characters, the most it holds): ` +
                'delete one first (delete_character)',
            );
          }
          if (op.ref !== undefined && refs.has(op.ref)) {
            refuse(`ref ${op.ref} already names a character created earlier in this batch`);
          }
          const p = newProfile();
          if (op.randomize) randomize(r, p);
          applyLook(r, p, op, op.randomize === true);
          p.name = op.name;
          p.id = newId();
          if (sameName(profiles, op.name)) {
            note(
              `another character is also called ${op.name}: address this one by its id, ${p.id}`,
            );
          }
          profiles.push(p);
          if (op.ref !== undefined) refs.set(op.ref, p.id);
          created.push({ op: index, id: p.id, name: op.name, ...(op.ref ? { ref: op.ref } : {}) });
          break;
        }
        case 'update_character': {
          const at = resolve(op.character);
          const p = structuredClone(profiles[at]);
          applyLook(r, p, op, false);
          if (op.name !== undefined && op.name !== p.name) {
            if (
              sameName(
                profiles.filter((_, i) => i !== at),
                op.name,
              )
            ) {
              note(`another character is also called ${op.name}: address this one by its id`);
            }
            p.name = op.name;
          }
          profiles = profiles.map((q, i) => (i === at ? p : q));
          const id = idAt(at);
          if (!updated.some((u) => u.id === id) && !created.some((c) => c.id === id)) {
            updated.push({ op: index, id, name: p.name ?? '' });
          }
          break;
        }
        case 'delete_character': {
          const at = resolve(op.character);
          const id = idAt(at);
          if (id === GREETER_CHARACTER_ID) {
            refuse(
              `${profiles[at].name || id} (${id}) is the character the Intro's greeter wears, so it can't be deleted`,
            );
          }
          if (profiles.length === 1)
            refuse('the roster cannot be empty: create another character first');
          // A character created in this batch and deleted again was never there; one
          // changed and then deleted is only deleted.
          if (!dropId(created, id)) deleted.push({ op: index, id, name: profiles[at].name ?? '' });
          dropId(updated, id);
          profiles = profiles.filter((_, i) => i !== at);
          for (const entry of touched.values()) {
            entry.list = entry.list.filter((d) => !('id' in d) || d.id !== id);
          }
          break;
        }
        case 'add_to_directory': {
          const at = resolve(op.character);
          const id = idAt(at);
          const entry = directoryOf(op.directory);
          const was = entry.list.findIndex((d) => 'id' in d && d.id === id);
          const rest = entry.list.filter((_, i) => i !== was);
          const position = Math.min(op.position ?? rest.length, rest.length);
          if (was === position) {
            note(`${profiles[at].name || id} already is ${entry.dir.name}'s default at that place`);
            break;
          }
          if (was < 0 && entry.list.length >= MAX_DIRECTORY_CHARACTERS) {
            refuse(
              `${entry.dir.name} already has ${MAX_DIRECTORY_CHARACTERS} default characters, the most a Directory keeps`,
            );
          }
          entry.list = [...rest.slice(0, position), { id }, ...rest.slice(position)];
          break;
        }
        case 'remove_from_directory': {
          const at = resolve(op.character);
          const id = idAt(at);
          const entry = directoryOf(op.directory);
          const before = entry.list.length;
          entry.list = entry.list.filter((d) => !('id' in d) || d.id !== id);
          if (entry.list.length === before) {
            note(`${profiles[at].name || id} is not one of ${entry.dir.name}'s default characters`);
          }
          break;
        }
      }
    } catch (err) {
      if (err instanceof OpRefused) return { ok: false, index, reason: err.message };
      throw err;
    }
  }

  const named = created.length + updated.length + deleted.length > 0;
  if (named) {
    // The ONE validator the Characters view's Save goes through too.
    const parsed = parseCharacterProfiles(profiles);
    if (!parsed) return { ok: false, reason: 'the edited roster does not validate' };
    profiles = parsed;
  }
  // An op naming a character may still leave it as it was (a name or a part it already has).
  const rosterChanged = named && canonicalJson(profiles) !== canonicalJson(start.profiles);
  if (named && !rosterChanged) {
    // Only updates can come to nothing (a create or a delete changes the list).
    ops.forEach((op, i) => {
      if (op.op === 'update_character') notes.push(`op ${i} (${op.op}): nothing changed`);
    });
    updated.length = 0;
  }

  // What the roster save alone will leave each Directory's defaults as (it renumbers them,
  // characterRemap.ts): a Directory the batch leaves at that needs no write of its own.
  const remap = rosterChanged ? characterRemap(start.profiles, profiles) : null;
  const positionOf = new Map(profiles.map((p, i) => [characterIdOf(p, i), i]));
  const directoryWrites: Array<{ name: string; path: string; characters: number[] }> = [];
  for (const { dir, list } of touched.values()) {
    const characters = list.flatMap((d) => {
      if ('external' in d) return [profiles.length + d.external];
      const at = positionOf.get(d.id);
      return at === undefined ? [] : [at];
    });
    const saved = dir.characters ?? [];
    if (!sameIndices(characters, remap ? remapList(saved, remap) : [...saved])) {
      directoryWrites.push({ name: dir.name, path: dir.path, characters });
    }
  }

  return {
    ok: true,
    profiles: rosterChanged ? profiles : [...start.profiles],
    rosterChanged,
    directoryWrites,
    created,
    updated,
    deleted,
    notes,
  };
}

const sameIndices = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Take character `id` off `list`; whether it was on it. */
function dropId(list: EditedCharacter[], id: string): boolean {
  const at = list.findIndex((c) => c.id === id);
  if (at >= 0) list.splice(at, 1);
  return at >= 0;
}

const sameName = (profiles: readonly CharacterProfile[], name: string): boolean =>
  profiles.some((p) => (p.name ?? '').toLowerCase() === name.toLowerCase());

/** The Directory `wanted` names: by name (exactly, else ignoring case), else by path. */
function findDirectory(directories: readonly EditDirectory[], wanted: string): EditDirectory {
  const w = wanted.trim();
  const found =
    directories.find((d) => d.name === w) ??
    directories.find((d) => d.name.toLowerCase() === w.toLowerCase()) ??
    directories.find((d) => normalizeDirectoryPath(d.path) === normalizeDirectoryPath(w));
  if (found) return found;
  const names = directories.map((d) => d.name).join(', ');
  return refuse(`There is no Directory called ${w}: the Directories are ${names || 'none'}`);
}

// ── A look ───────────────────────────────────────────────────

/** Body, eyes, parts, then colours: in that order, so a colour lands on the part worn. */
function applyLook(
  r: CharacterRenderer,
  p: CharacterProfile,
  op: LookOp,
  randomized: boolean,
): void {
  const manifestParts = r.wardrobe.manifest.parts;
  // What randomize coloured, by key, to see which colours a given body, eye shape or part
  // makes stale.
  const randomArt = randomized
    ? new Map(COLOR_PIECES.map(({ key }) => [key, colorArt(p, key)?.path]))
    : null;

  if (op.body !== undefined) {
    if (!(manifestParts.body ?? []).some((b) => b.id === op.body)) {
      refuse(
        `there is no body ${op.body}: the bodies are ${(manifestParts.body ?? []).map((b) => b.id).join(', ')}`,
      );
    }
    setPart(p, 'body', op.body);
  }
  if (op.eye_shape !== undefined) {
    if (!EYE_SHAPES.some((s) => s.id === op.eye_shape)) {
      refuse(
        `there is no eye shape ${op.eye_shape}: they are ${EYE_SHAPES.map((s) => s.id).join(', ')}`,
      );
    }
    p.eyeShape = op.eye_shape;
  }
  if (op.eye_rows !== undefined) p.eyeRows = op.eye_rows;

  const parts = (op.parts ?? {}) as Partial<Record<SlotKey, string | null>>;
  const clash = EXCLUSIVE_SLOTS.find(([a, b]) => parts[a] && parts[b]);
  if (clash) {
    refuse(`${clash[0]} and ${clash[1]} take each other off: give only one of them`);
  }
  for (const [slot, id] of Object.entries(parts) as Array<[SlotKey, string | null | undefined]>) {
    if (id === undefined) continue;
    if (isUnderwear(slot)) {
      if (id !== null && id !== UNDERWEAR) refuse(`${slot} is "${UNDERWEAR}" or null`);
      p[slot] = id ?? undefined;
      continue;
    }
    if (id !== null && !(manifestParts[slot] ?? []).some((part) => part.id === id)) {
      refuse(`there is no ${slot} part ${id}: list_wardrobe lists each slot's parts`);
    }
    setPart(p, slot, id);
  }

  if (randomArt) rerollStaleColors(r, p, randomArt);

  for (const [key, spec] of Object.entries(op.colors ?? {}) as Array<
    [ColorKey, ColorSpec | undefined]
  >) {
    if (spec === undefined) continue;
    setColor(p, key, resolveColor(r, p, key, spec));
  }
}

/**
 * After a randomized look's body, eye shape or parts were overridden: a random colour
 * picked for art no longer worn is dropped, and the new art gets one the way randomize
 * gives one (core's randomDressColor, randomEyes, randomSkin).
 */
function rerollStaleColors(
  r: CharacterRenderer,
  p: CharacterProfile,
  randomArt: ReadonlyMap<ColorKey, string | undefined>,
): void {
  p.colors ??= {};
  for (const { key } of COLOR_PIECES) {
    const art = colorArt(p, key);
    if (art?.path === randomArt.get(key)) continue;
    delete p.colors[key];
    if (!art) continue;
    const color =
      key === 'skin'
        ? randomSkin(r, p.body)
        : key === 'eyes'
          ? randomEyes(r, p)
          : (DRESS_SLOTS as readonly string[]).includes(key)
            ? randomDressColor(r, p, key)
            : undefined;
    if (color) p.colors[key] = color;
  }
}

/**
 * A colour as list_wardrobe offers it, as the value the profile stores: a named colour
 * (the part's palette square, or "As drawn"), one of the worn part's colourways, a hex
 * fitted to the part (a swatch key's swatch fit; else the colour panel's typed-hex fit at
 * the current contrast), or exact HSBC. Null unsets it.
 */
export function resolveColor(
  r: CharacterRenderer,
  p: CharacterProfile,
  key: ColorKey,
  spec: ColorSpec,
): CharacterColor | null {
  if (spec === null) return null;
  const art = colorArt(p, key);
  if (!art) {
    refuse(
      `colour ${key}: nothing this character wears takes it (wear a part in its slot first` +
        (key === 'tie' ? ', an outfit with has_tie' : '') +
        ')',
    );
  }
  if ('name' in spec) {
    const wanted = spec.name.trim().toLowerCase();
    if (wanted === AS_DRAWN.toLowerCase()) return { ...ZERO_COLOR };
    const palette = r.paletteFor(art);
    if (!palette) {
      refuse(
        `colour ${key} has no named colours besides "${AS_DRAWN}": give a hex (its swatches: ` +
          `${swatchesOf(key).join(', ')})`,
      );
    }
    const i = palette.squares.findIndex((sq) => sq.label.toLowerCase() === wanted);
    if (i < 0) {
      refuse(
        `colour ${key} has no named colour ${spec.name}: they are ` +
          `${palette.squares.map((sq) => sq.label).join(', ')}, or "${AS_DRAWN}"`,
      );
    }
    return { ...palette.row[i] };
  }
  if ('colorway' in spec) {
    const ways = Object.keys(r.wardrobe.swaps.get(art.path) ?? {});
    const way = ways.find((w) => w.toLowerCase() === spec.colorway.trim().toLowerCase());
    if (!way) {
      refuse(
        `the ${key} worn has no colourway ${spec.colorway}` +
          (ways.length ? `: its colourways are ${ways.join(', ')}` : ': it has none'),
      );
    }
    return { ...ZERO_COLOR, palette: way };
  }
  if ('hex' in spec) {
    const hex = spec.hex.toLowerCase();
    return r.paletteFor(art)
      ? r.hexValue(art, hex, p.colors?.[key]?.c ?? 0)
      : r.swatchValue(art, hex, key);
  }
  if (spec.palette !== undefined) {
    const ways = Object.keys(r.wardrobe.swaps.get(art.path) ?? {});
    if (!ways.includes(spec.palette)) {
      refuse(`the ${key} worn has no colourway ${spec.palette}`);
    }
  }
  const { h, s, b, c, colorize, palette } = spec;
  return {
    h,
    s,
    b,
    c,
    ...(colorize ? { colorize: true } : {}),
    ...(palette !== undefined ? { palette } : {}),
  };
}
