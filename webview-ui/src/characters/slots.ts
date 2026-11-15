/**
 * The character model: which slots a profile has, how their pieces stack into the sheet,
 * which colour each piece takes, and which tab shows what. A piece is defined once, in
 * LAYERS; the colour → piece map, the pixel editor's pieces and the dress-up slots are
 * derived from it and TABS.
 */

import {
  CHARACTER_SLOTS,
  type CharacterPixelEdits,
  type CharacterProfile,
  type CharacterSlot,
  DEFAULT_EYE_ROWS,
  pixId,
} from '../../../core/src/characterProfiles.js';
import type { MessageKey } from '../i18n/index.js';
import { eyeArt, partArt, type Underwear, type Wardrobe } from './wardrobe.js';

/** Profile fields that hold a part id. */
export type SlotKey = CharacterSlot;
const isSlot = (key: string): key is SlotKey =>
  (CHARACTER_SLOTS as readonly string[]).includes(key);

/** A colour a profile can set (`profile.colors[key]`); `tie` = an outfit's tie (the outfit's own colour until set). */
export type ColorKey = 'skin' | 'eyes' | 'lashes' | 'tie' | Exclude<SlotKey, 'body'>;

export interface ColorPicker {
  key: ColorKey;
  /** Its heading (translated when shown). */
  label: MessageKey;
}

/** Wardrobe tabs, in order. Underwear, beards and accessories live inside other tabs. */
export type TabKey =
  'body' | 'eyes' | 'hair' | 'top' | 'jacket' | 'pants' | 'shoes' | 'full' | 'hat' | 'acc';

export interface TabDef {
  key: TabKey;
  label: MessageKey;
  /** Its own colour panels, shown while a part is worn that has art for them (the tie: only outfits with one). */
  pickers: ColorPicker[];
  /** The piece the pixel editor opens on from this tab. */
  piece: string | null;
  /** The underwear it offers (Top: the top, Pants: the bottom): no part shows it, None shows skin. */
  under?: Underwear;
  /** A slot that lives inside this tab, below its own parts (Hair: the beard). */
  inner?: Exclude<SlotKey, 'body'>;
}

export const TABS: readonly TabDef[] = [
  {
    key: 'body',
    label: 'characters.tab_body',
    pickers: [{ key: 'skin', label: 'characters.picker_skin' }],
    piece: 'body',
  },
  {
    key: 'eyes',
    label: 'characters.tab_eyes',
    pickers: [
      { key: 'eyes', label: 'characters.picker_eyes' },
      { key: 'lashes', label: 'characters.picker_lashes' },
    ],
    piece: 'whites',
  },
  {
    key: 'hair',
    label: 'characters.tab_hair',
    pickers: [{ key: 'hair', label: 'characters.picker_colour' }],
    piece: 'hair',
    inner: 'beard',
  },
  {
    key: 'top',
    label: 'characters.tab_top',
    pickers: [{ key: 'top', label: 'characters.picker_colour' }],
    piece: 'top',
    under: 'utop',
  },
  {
    key: 'jacket',
    label: 'characters.tab_jacket',
    pickers: [{ key: 'jacket', label: 'characters.picker_colour' }],
    piece: 'jacket',
  },
  {
    key: 'pants',
    label: 'characters.tab_pants',
    pickers: [{ key: 'pants', label: 'characters.picker_colour' }],
    piece: 'pants',
    under: 'under',
  },
  {
    key: 'shoes',
    label: 'characters.tab_shoes',
    pickers: [{ key: 'shoes', label: 'characters.picker_colour' }],
    piece: 'shoes',
  },
  {
    key: 'full',
    label: 'characters.tab_full',
    pickers: [
      { key: 'full', label: 'characters.picker_colour' },
      { key: 'tie', label: 'characters.picker_tie' },
    ],
    piece: 'full',
  },
  {
    key: 'hat',
    label: 'characters.tab_hat',
    pickers: [{ key: 'hat', label: 'characters.picker_colour' }],
    piece: 'hat',
  },
  { key: 'acc', label: 'characters.tab_acc', pickers: [], piece: null },
];

/** Slots with a tab of their own besides the body: hair and the clothes, each with a category palette. */
export const DRESS_SLOTS = TABS.flatMap((t) => (t.key !== 'body' && isSlot(t.key) ? [t.key] : []));

/** The underwear a tab offers, if any. */
export const underOf = (key: TabKey | SlotKey): Underwear | undefined =>
  TABS.find((t) => t.key === key)?.under;

/** The piece the pixel editor opens on from a tab: its underwear while nothing is worn over it. */
export const tabPiece = (tab: TabDef, p: CharacterProfile): string | null =>
  tab.under && isSlot(tab.key) && !p[tab.key] ? tab.under : tab.piece;

/** The one underwear style. */
export const UNDERWEAR = 'basic';

/** Each body's defaults: the eye shape it has until one is chosen, and whether it starts in the underwear top. */
const BODIES: Record<string, { eyes: string; utop: boolean }> = {
  flat: { eyes: 'plain', utop: false },
  bust: { eyes: 'lashes', utop: true },
};

/** The underwear top a body starts in. */
export const startingUtop = (body: string): string | undefined =>
  BODIES[body]?.utop ? UNDERWEAR : undefined;

/** What every piece of the sheet has: `pix` names it (and its art folder). */
interface LayerBase {
  pix: string;
  /** The colour it takes; the first piece with a colour key owns that colour's colourways. */
  color: ColorKey | null;
  /** Its name in the pixel editor. */
  label: MessageKey;
  /** Its place among the pixel editor's pieces (they don't follow draw order). */
  chip: number;
  /** Underwear: drawn only while nothing covers it. */
  when?: Underwear;
  /** In the back view (the up row) this piece goes under that earlier one instead of over it. */
  behind?: string;
  /** Shipped near-gray on every body: its sliders are colorize-only (underwear). */
  neutral?: boolean;
}

/** A piece a slot's part picks (<pix>/<part>.png); the body's own pieces are picked by the body. */
export interface PartLayer extends LayerBase {
  kind: 'part';
  sel: SlotKey;
}

/** A piece of the eyes, drawn from the eye-shape folder (eyes/<shape>/<pix>.png). */
export interface EyeLayer extends LayerBase {
  kind: 'eye';
  /** What its pixel edits are filed under: the eye shape, or the body (the shape's when it is drawn). */
  filedBy: 'shape' | 'body';
  /** Comes in one sheet per eye-row variant (<pix>.<rows>.png). */
  rows?: boolean;
}

/** A piece of the sheet. */
export type LayerDef = PartLayer | EyeLayer;

/** Draw order, bottom to top. */
export const LAYERS: readonly LayerDef[] = [
  {
    kind: 'part',
    pix: 'body',
    sel: 'body',
    color: 'skin',
    label: 'characters.piece_body',
    chip: 0,
  },
  {
    kind: 'part',
    pix: 'under',
    sel: 'body',
    color: 'under',
    label: 'characters.piece_under',
    chip: 6,
    when: 'under',
    neutral: true,
  },
  {
    kind: 'part',
    pix: 'utop',
    sel: 'body',
    color: 'utop',
    label: 'characters.piece_utop',
    chip: 5,
    when: 'utop',
    neutral: true,
  },
  {
    kind: 'eye',
    pix: 'whites',
    filedBy: 'body',
    color: null,
    label: 'characters.piece_whites',
    chip: 1,
  }, // whites and pupils, never recoloured
  {
    kind: 'eye',
    pix: 'iris',
    filedBy: 'body',
    color: 'eyes',
    label: 'characters.piece_iris',
    chip: 2,
    rows: true,
  },
  {
    kind: 'eye',
    pix: 'lashes',
    filedBy: 'shape',
    color: 'lashes',
    label: 'characters.piece_lashes',
    chip: 3,
  },
  {
    kind: 'part',
    pix: 'pants',
    sel: 'pants',
    color: 'pants',
    label: 'characters.piece_pants',
    chip: 10,
  },
  { kind: 'part', pix: 'top', sel: 'top', color: 'top', label: 'characters.piece_top', chip: 8 },
  {
    kind: 'part',
    pix: 'full',
    sel: 'full',
    color: 'full',
    label: 'characters.piece_full',
    chip: 12,
  },
  { kind: 'part', pix: 'tie', sel: 'full', color: 'tie', label: 'characters.piece_tie', chip: 21 }, // the outfit's tie (tie/<outfit>.png), when it has one
  {
    kind: 'part',
    pix: 'jacket',
    sel: 'jacket',
    color: 'jacket',
    label: 'characters.piece_jacket',
    chip: 9,
  }, // over the top or the outfit
  {
    kind: 'part',
    pix: 'lanyard',
    sel: 'lanyard',
    color: 'lanyard',
    label: 'characters.piece_lanyard',
    chip: 15,
  },
  {
    kind: 'part',
    pix: 'necklace',
    sel: 'necklace',
    color: 'necklace',
    label: 'characters.piece_necklace',
    chip: 14,
  },
  {
    kind: 'part',
    pix: 'watch',
    sel: 'watch',
    color: 'watch',
    label: 'characters.piece_watch',
    chip: 19,
  },
  {
    kind: 'part',
    pix: 'shoes',
    sel: 'shoes',
    color: 'shoes',
    label: 'characters.piece_shoes',
    chip: 11,
  },
  {
    kind: 'part',
    pix: 'hair',
    sel: 'hair',
    color: 'hair',
    label: 'characters.piece_hair',
    chip: 7,
  },
  {
    kind: 'part',
    pix: 'earrings',
    sel: 'earrings',
    color: 'earrings',
    label: 'characters.piece_earrings',
    chip: 16,
    behind: 'hair', // over the hair, under it from behind
  },
  {
    kind: 'part',
    pix: 'beard',
    sel: 'beard',
    color: 'beard',
    label: 'characters.piece_beard',
    chip: 20,
  }, // over the hair, under sunglasses
  {
    kind: 'part',
    pix: 'shades',
    sel: 'shades',
    color: 'shades',
    label: 'characters.piece_shades',
    chip: 17,
  },
  {
    kind: 'part',
    pix: 'hairshades',
    sel: 'hairshades',
    color: 'hairshades',
    label: 'characters.piece_hairshades',
    chip: 18,
  },
  { kind: 'part', pix: 'hat', sel: 'hat', color: 'hat', label: 'characters.piece_hat', chip: 13 },
];

export const layerOf = (pix: string): LayerDef => {
  const layer = LAYERS.find((l) => l.pix === pix);
  if (!layer) throw new Error(`Unknown piece ${pix}`);
  return layer;
};

/** The layer that owns each colour key (the first to take it: skin is the body's). */
const COLOR_LAYER = new Map<ColorKey, LayerDef>();
for (const l of LAYERS) if (l.color && !COLOR_LAYER.has(l.color)) COLOR_LAYER.set(l.color, l);

/** Pieces the pixel editor offers, in chip order. */
export const EDIT_PIECES: readonly LayerDef[] = [...LAYERS].sort((a, b) => a.chip - b.chip);

/** Accessories: each worn or not, each in its own colour. `styles` = one card, its parts picked as styles. */
const ACCESSORY_DEFS = [
  { key: 'necklace', styles: 'characters.acc_style' },
  { key: 'lanyard' },
  { key: 'earrings' },
  { key: 'shades' },
  { key: 'hairshades', label: 'characters.acc_hairshades' }, // the pixel editor's chip is shorter
  { key: 'watch', styles: 'characters.acc_wrist' },
] as const satisfies readonly { key: SlotKey; label?: MessageKey; styles?: MessageKey }[];

export type AccessoryKey = (typeof ACCESSORY_DEFS)[number]['key'];

export interface AccessoryDef {
  key: AccessoryKey;
  label: MessageKey;
  styles?: MessageKey;
}

export const ACCESSORIES: readonly AccessoryDef[] = ACCESSORY_DEFS.map((d): AccessoryDef => ({
  key: d.key,
  label: 'label' in d ? d.label : layerOf(d.key).label,
  styles: 'styles' in d ? d.styles : undefined,
}));

export interface EyeShape {
  /** Its folder under eyes/. */
  id: string;
  label: MessageKey;
  /** Its card's tooltip. */
  title: MessageKey;
  /** Its eye pieces are its own drawing: their edits are filed under the shape, not the body. */
  drawn?: boolean;
  /** Reads without the reading glasses. */
  bare?: boolean;
  /** Its blink keeps its own brows: eyes/closed-<id>/lashes.png. */
  blinkLashes?: boolean;
}

export const EYE_SHAPES: readonly EyeShape[] = [
  { id: 'plain', label: 'characters.eye_plain', title: 'characters.eye_plain_title' },
  { id: 'lashes', label: 'characters.eye_lashes', title: 'characters.eye_lashes_title' },
  {
    id: 'lidded',
    label: 'characters.eye_lidded',
    title: 'characters.eye_lidded_title',
    drawn: true,
    bare: true,
  },
  {
    id: 'stern',
    label: 'characters.eye_stern',
    title: 'characters.eye_stern_title',
    drawn: true,
    bare: true,
    blinkLashes: true,
  },
  {
    id: 'closed',
    label: 'characters.eye_closed',
    title: 'characters.eye_closed_title',
    drawn: true,
  },
];
const shapeById = (id: string | undefined) => EYE_SHAPES.find((s) => s.id === id);
const CLOSED = shapeById('closed')!;

/** The eye shape a profile wears: its own, or its body's. */
export const eyeShape = (p: CharacterProfile): EyeShape =>
  shapeById(p.eyeShape) ?? shapeById(BODIES[p.body]?.eyes) ?? EYE_SHAPES[0];

/** A profile as the renderer draws it; `blink`: mid-blink, Closed eyes drawn over its own. */
export type RenderProfile = CharacterProfile & { blink?: boolean };

/** Whether a profile blinks: not with its eyes shut, nor reading with bare eyes (the blink would flash the glasses). */
export function canBlink(p: CharacterProfile, reading: boolean): boolean {
  const shape = eyeShape(p);
  return shape !== CLOSED && !(reading && shape.bare);
}

/** The eyes drawn: Closed mid-blink, the profile's own otherwise. */
const shownEyes = (p: RenderProfile): EyeShape => (p.blink ? CLOSED : eyeShape(p));

/** The eye folder a layer draws from: the shown shape's, or a blink's own lashes. */
function eyeFolder(p: RenderProfile, layer: LayerDef): string {
  const own = eyeShape(p);
  if (p.blink && layer.pix === 'lashes' && own.blinkLashes) return `closed-${own.id}`;
  return shownEyes(p).id;
}

/** Every folder under eyes/. */
export const EYE_FOLDERS: readonly string[] = [
  ...EYE_SHAPES.map((s) => s.id),
  ...EYE_SHAPES.filter((s) => s.blinkLashes).map((s) => `closed-${s.id}`),
];

/** The part id a layer's pixel edits are filed under ('<piece>:<id>'). */
function editId(p: RenderProfile, layer: LayerDef): string | undefined {
  if (layer.kind === 'part') return p[layer.sel];
  // lashes by eye shape; whites and iris by body, but by shape for a drawn shape
  const shape = shownEyes(p);
  return layer.filedBy === 'shape' || shape.drawn ? shape.id : p.body;
}

/** The key a piece's pixel edits are filed under ('<piece>:<part id>'). */
export const editKey = (p: RenderProfile, pix: string) => pixId(pix, editId(p, layerOf(pix)) ?? '');

/** A piece's pixel edits on this profile, if any. */
export const editsOf = (p: RenderProfile, pix: string): CharacterPixelEdits | undefined =>
  p.edits?.[editKey(p, pix)];

/** Underwear shows only where nothing is worn over it (jackets don't count). */
export const wornUnder = (p: CharacterProfile): Record<Underwear, boolean> => ({
  utop: !!p.utop && !p.top && !p.full,
  under: !!p.under && !p.pants && !p.full,
});

/** A sheet of wardrobe art: its path, its layer, and the wardrobe part it is (null: eye art). */
export interface Art {
  path: string;
  layer: LayerDef;
  part: string | null;
}

/**
 * The art a layer draws for this profile, worn or not (null: nothing in its slot):
 * a part's '<piece>/<id>', the body's '<piece>/<body>', or its eye art.
 */
function layerArt(p: RenderProfile, layer: LayerDef): Art | null {
  if (layer.kind === 'eye') {
    const rows = layer.rows ? (p.eyeRows ?? DEFAULT_EYE_ROWS) : undefined;
    return { path: eyeArt(eyeFolder(p, layer), layer.pix, rows), layer, part: null };
  }
  const id = p[layer.sel];
  if (!id) return null;
  return { path: partArt(layer.pix, id), layer, part: id };
}

/** The art a layer draws on this profile, or null when it doesn't show (underwear covered). */
export function shownArt(p: RenderProfile, layer: LayerDef): Art | null {
  if (layer.when && !wornUnder(p)[layer.when]) return null;
  return layerArt(p, layer);
}

/** The art a colour key is judged against on this profile (its colourways, palette, shading), if worn. */
export function colorArt(p: RenderProfile, key: ColorKey): Art | null {
  const layer = COLOR_LAYER.get(key);
  if (!layer || (layer.when && !p[layer.when])) return null;
  return layerArt(p, layer);
}

/** The pieces this profile shows (worn, and with art to draw): the ones the pixel editor can edit. */
export const wornPieces = (w: Wardrobe, p: RenderProfile) =>
  EDIT_PIECES.filter((l) => {
    const art = shownArt(p, l);
    return !!art && w.art.has(art.path);
  });
