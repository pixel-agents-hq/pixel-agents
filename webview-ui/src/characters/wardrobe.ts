/**
 * The wardrobe: every part a character can wear, one finished PNG each.
 *
 * Every PNG under art/ is a 128x96 sheet in the office layout (rows down, up, right x 8
 * frames walk1-3, type1-2, read1-2, seated), uncoloured, drawn exactly as it shows:
 *   <piece>/<part id>.png        a part, e.g. hair/bob.png, full/business_suit.png
 *   body/<body>.png              the bare (doll) body; under/<body>.png, utop/<body>.png its underwear
 *   eyes/<shape>/<piece>         whites (whites and pupils), iris.<rows> (rows: top, bottom, both:
 *                                which pupil pixels take the eye colour, drawn over the pupils) and
 *                                lashes, the same for every body; a shape has only the files it draws.
 *                                closed-stern/ is the blink over Stern: what differs from closed/
 *   tie/<outfit id>.png          an outfit's tie, coloured apart from it (only outfits with one)
 *   props/reading-glasses.png, props/paper.png
 * art/wardrobe.json holds the rest: each part's label and colourways, and the category palettes.
 * Adding a part = its PNG plus its line in wardrobe.json; the two must match or loading fails.
 */

import {
  type CharacterColor,
  EYE_ROWS,
  type EyeRows,
} from '../../../core/src/characterProfiles.js';
import { isRecord } from '../../../core/src/isRecord.js';
import { SHEET_H, SHEET_W } from './sheet.js';

export interface PartInfo {
  id: string;
  label: string;
  /** Shipped gray, meant to be colourised: sliders are colorize-only. */
  neutral?: boolean;
  /** Exact colourways: name → { '#from': '#to' }. */
  swaps?: Record<string, Record<string, string>>;
  /** A custom item (saved from the pixel editor): the built-in part it was started from. */
  base?: string;
}

export interface PaletteSquare {
  label: string;
  hex: string;
}

/** A category's colour squares, and per part the setting each square stands for. */
export interface CategoryPalette {
  squares: PaletteSquare[];
  values: Record<string, CharacterColor[]>;
}

export interface WardrobeManifest {
  parts: Record<string, PartInfo[]>;
  palettes: Record<string, CategoryPalette>;
}

/** Decoded RGBA image. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Wardrobe {
  manifest: WardrobeManifest;
  /** Art path ('hair/bob', 'eyes/plain/iris.bottom', ...) → 128x96 RGBA. */
  art: Map<string, Uint8ClampedArray>;
  /** Parts shipped gray, as art paths (their sliders are colorize-only). */
  neutral: Set<string>;
  /** Art path → the part's exact colourways. */
  swaps: Map<string, Record<string, Record<string, string>>>;
}

export type Underwear = 'under' | 'utop';

/** The part category that names the bodies (each body owns its underwear). */
const BODY = 'body';
/** Sheets every body has one of: its underwear. */
const BODY_SHEETS: readonly Underwear[] = ['under', 'utop'];
/** An eye folder's pieces: the iris comes in one sheet per eye-row variant (which eye pixel takes the eye colour). */
const EYE_PIECES = ['whites', ...EYE_ROWS.map((rows) => `iris.${rows}`), 'lashes'];
export const PROPS = { glasses: 'props/reading-glasses', paper: 'props/paper' } as const;
/** Pieces a part of a category may come with, each its own sheet (<piece>/<part id>.png): an outfit's tie. */
const PART_EXTRAS: Record<string, readonly string[]> = { full: ['tie'] };

/** A part's art path. */
export const partArt = (piece: string, id: string): string => `${piece}/${id}`;
/** An eye piece's art path; `rows` for the iris. */
export const eyeArt = (folder: string, piece: string, rows?: EyeRows): string =>
  `eyes/${folder}/${piece}${rows ? `.${rows}` : ''}`;

/**
 * Every art path the wardrobe needs (required) or may have (optional: eye files, since a
 * shape has only the ones it draws, and a part's extra pieces). `eyeFolders` are the folders under eyes/.
 */
function expectedArt(manifest: WardrobeManifest, eyeFolders: readonly string[]) {
  const required = new Set<string>(Object.values(PROPS));
  const optional = new Set<string>();
  for (const [cat, parts] of Object.entries(manifest.parts)) {
    for (const { id } of parts) {
      required.add(partArt(cat, id));
      for (const piece of PART_EXTRAS[cat] ?? []) optional.add(partArt(piece, id));
    }
  }
  for (const { id: body } of manifest.parts[BODY] ?? []) {
    for (const piece of BODY_SHEETS) required.add(partArt(piece, body));
  }
  for (const folder of eyeFolders) {
    for (const piece of EYE_PIECES) optional.add(eyeArt(folder, piece));
  }
  return { required, optional };
}

/**
 * The wardrobe from its manifest and its PNGs (art path without '.png' → image). Fails
 * loudly when a part has no PNG, a PNG belongs to nothing, or a PNG isn't 128x96.
 */
export function decodeWardrobe(
  manifest: WardrobeManifest,
  files: ReadonlyMap<string, Rgba>,
  eyeFolders: readonly string[],
): Wardrobe {
  const { required, optional } = expectedArt(manifest, eyeFolders);
  const missing = [...required].filter((p) => !files.has(p));
  const stray = [...files.keys()].filter((p) => !required.has(p) && !optional.has(p));
  const misfit = [...files].filter(([, img]) => img.width !== SHEET_W || img.height !== SHEET_H);
  const problems = [
    missing.length && `missing ${missing.join(', ')}`,
    stray.length && `not in wardrobe.json: ${stray.join(', ')}`,
    misfit.length && `not ${SHEET_W}x${SHEET_H}: ${misfit.map(([p]) => p).join(', ')}`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`[Webview] wardrobe art: ${problems.join('; ')}`);

  const w: Wardrobe = { manifest, art: new Map(), neutral: new Set(), swaps: new Map() };
  for (const [path, img] of files) w.art.set(path, img.data);
  for (const [cat, parts] of Object.entries(manifest.parts)) {
    for (const part of parts) {
      if (part.neutral) w.neutral.add(partArt(cat, part.id));
      if (part.swaps) w.swaps.set(partArt(cat, part.id), part.swaps);
    }
  }
  return w;
}

/** A part of a category by id (built-in or custom), if the wardrobe has it. */
export const partInfo = (w: Wardrobe, cat: string, id: string | undefined): PartInfo | undefined =>
  w.manifest.parts[cat]?.find((p) => p.id === id);

/** A part's label, or 'None'. */
export function partLabel(w: Wardrobe, cat: string, id: string | undefined): string {
  return partInfo(w, cat, id)?.label ?? 'None';
}

const isPart = (v: unknown) =>
  isRecord(v) && typeof v.id === 'string' && typeof v.label === 'string';
const isPalette = (v: unknown) =>
  isRecord(v) &&
  Array.isArray(v.squares) &&
  isRecord(v.values) &&
  Object.values(v.values).every(Array.isArray);

/** Whether `value` has the shape the decoder and the renderer index into. */
function isWardrobeManifest(value: unknown): value is WardrobeManifest {
  return (
    isRecord(value) &&
    isRecord(value.parts) &&
    Object.values(value.parts).every((parts) => Array.isArray(parts) && parts.every(isPart)) &&
    isRecord(value.palettes) &&
    Object.values(value.palettes).every(isPalette)
  );
}

/** The manifest (art/wardrobe.json), checked at the boundary: a bad one fails loudly at load. */
export function parseWardrobeManifest(value: unknown): WardrobeManifest {
  if (!isWardrobeManifest(value))
    throw new Error('[Webview] wardrobe.json is not a wardrobe manifest');
  return value;
}

/** A custom item's art, decoded: what withItems adds to the wardrobe. */
export interface ItemArt {
  id: string;
  piece: string;
  label: string;
  base: string;
  data: Uint8ClampedArray;
}

/**
 * The wardrobe with custom items added after each slot's built-in parts. An item wears
 * its base part's colours: gray-ness, colourways and palette row. Items whose base the
 * wardrobe doesn't have still show, uncoloured.
 */
export function withItems(w: Wardrobe, items: readonly ItemArt[]): Wardrobe {
  if (!items.length) return w;
  const parts: Record<string, PartInfo[]> = { ...w.manifest.parts };
  const palettes: Record<string, CategoryPalette> = { ...w.manifest.palettes };
  const out: Wardrobe = {
    manifest: { parts, palettes },
    art: new Map(w.art),
    neutral: new Set(w.neutral),
    swaps: new Map(w.swaps),
  };
  for (const item of items) {
    const builtIn = w.manifest.parts[item.piece]?.find((p) => p.id === item.base);
    const path = partArt(item.piece, item.id);
    parts[item.piece] = [
      ...(parts[item.piece] ?? []),
      { id: item.id, label: item.label, base: item.base, neutral: builtIn?.neutral },
    ];
    out.art.set(path, item.data);
    const basePath = partArt(item.piece, item.base);
    if (w.neutral.has(basePath)) out.neutral.add(path);
    const swaps = w.swaps.get(basePath);
    if (swaps) out.swaps.set(path, swaps);
    const pal = palettes[item.piece];
    const row = pal?.values[item.base];
    if (pal && row) palettes[item.piece] = { ...pal, values: { ...pal.values, [item.id]: row } };
  }
  return out;
}
