/**
 * Builds a profile's 128x96 character sheet (3 rows: down, up, right x 8 frames: walk1-3,
 * type1-2, read1-2, seated) from the wardrobe, and answers the colour questions the UI asks.
 *
 * The art is finished: each worn piece is one sheet from the wardrobe, which the profile's
 * pixel edits go over; then it is tinted and stacked in LAYERS order, and the props
 * (reading glasses, unless the eyes read bare, and the paper) go on top.
 *
 * DOM-free: works on RGBA buffers, so it runs in tests as it does in the webview.
 */

import { CHAR_FRAME_H } from '../../../core/src/assets/constants.js';
import type { CharacterColor, CharacterPixelEdits } from '../../../core/src/characterProfiles.js';
import { DEFAULT_COLORS } from './art/artColors.js';
import { colorKey, hexLum, hexToRgb, lum, rgbHex, rgbToHsl, tintPixels } from './color.js';
import { CLOTHES_COLOR_KEYS } from './repeatClothes.js';
import { cellAt, isOpaque, SHEET_H, SHEET_W } from './sheet.js';
import {
  type Art,
  colorArt,
  type ColorKey,
  editsOf,
  eyeShape,
  type LayerDef,
  layerOf,
  LAYERS,
  type RenderProfile,
  shownArt,
} from './slots.js';
import { type CategoryPalette, PROPS, type Wardrobe } from './wardrobe.js';

/** A piece's layer, with the key its tinted versions are cached under. */
interface Layer {
  data: Uint8ClampedArray;
  key: string;
}

export interface SheetOptions {
  /** Only this piece (the editor's "show in front"). */
  only?: string;
  /** Everything but this piece. */
  except?: string;
  /** Skip the props and reading glasses. */
  props?: boolean;
}

/** Dark, nearly flat parts are lifted by brightness to this share of the swatch's lightness. */
const FLAT_SWATCH: Partial<Record<ColorKey, number>> = { eyes: 0.9, lashes: 0.55 };
/** Fitting a swatch to a part's shading (swatchValue). */
const SWATCH_FIT = {
  /** Tones this light are highlights and glints, not the part's shading. */
  glint: 0.92,
  /** The outline: the tone at this share from the darkest. */
  outlineAt: 0.05,
  /** Less spread than this between outline and mean = a flat part (pupils). */
  flatSpread: 0.08,
  /** A flat part's mean lands at this share of the swatch's lightness. */
  flatLift: 0.55,
  /** The highlight: the tone at this share from the darkest. */
  highlightAt: 0.98,
  /** Highlights stop at this lightness, short of white. */
  maxLight: 0.97,
  /** Dark picks deepen the outline at most to this share of the swatch's lightness. */
  outlineFloor: 0.4,
  /** Contrast never drops below this share of the art's own. */
  minContrast: 0.35,
  maxContrast: 2,
} as const;
const CACHE_LIMIT = { tint: 600, layer: 300, sheet: 200 };

export class CharacterRenderer {
  private readonly tintCache = new Map<string, Uint8ClampedArray>();
  private readonly layerCache = new Map<string, Layer>();
  private readonly sheetCache = new Map<string, Uint8ClampedArray>();
  private readonly beardCache = new Map<string, CharacterColor>();
  readonly wardrobe: Wardrobe;

  constructor(wardrobe: Wardrobe) {
    this.wardrobe = wardrobe;
  }

  // ── Colour ─────────────────────────────────────────────────

  /**
   * The colour a key is worn in: its own; for a tie nobody has coloured, the outfit's; for a
   * beard nobody has coloured, the hair's; for gray clothes and hair nobody has coloured,
   * their default (white clothes, brown hair).
   */
  colorOf(p: RenderProfile, key: ColorKey): CharacterColor | null {
    const own = p.colors?.[key];
    if (own) return own;
    if (key === 'tie') return this.colorOf(p, 'full');
    if (key !== 'beard') return this.defaultColor(p, key);
    if (!p.beard || !p.hair) return null;
    const hex = this.hairHex(p);
    if (!hex) return null;
    const ck = `${p.beard}|${hex}`;
    let cv = this.beardCache.get(ck);
    if (!cv) {
      cv = this.swatchValue(colorArt(p, 'beard'), hex, 'beard');
      this.beardCache.set(ck, cv);
    }
    return cv;
  }

  /**
   * What gray art is worn in until coloured: clothes white (their palette's White square),
   * hair brown. Null for everything else, underwear included (it stays gray).
   */
  defaultColor(p: RenderProfile, key: ColorKey): CharacterColor | null {
    const art = colorArt(p, key);
    if (!this.isNeutral(art)) return null;
    const palette = this.paletteFor(art);
    if (!palette) return null; // underwear: no palette, stays gray
    const isClothes = (CLOTHES_COLOR_KEYS as readonly ColorKey[]).includes(key);
    const i = palette.squares.findIndex((sq) =>
      key === 'hair'
        ? sq.hex === DEFAULT_COLORS.hairHex
        : isClothes && sq.label === DEFAULT_COLORS.clothesSquare,
    );
    return i >= 0 ? palette.row[i] : null;
  }

  /** Whether a piece of art is shipped gray (colorize-only sliders): a gray part, or underwear. */
  isNeutral(art: Art | null): boolean {
    return !!art && (this.wardrobe.neutral.has(art.path) || !!art.layer.neutral);
  }

  /** The category palette a part offers, with its own value for each square. */
  paletteFor(
    art: Art | null,
  ): { squares: CategoryPalette['squares']; row: CharacterColor[] } | null {
    const pal = art?.part ? this.wardrobe.manifest.palettes[art.layer.pix] : undefined;
    const row = art?.part ? pal?.values[art.part] : undefined;
    return pal && row ? { squares: pal.squares, row } : null;
  }

  private source(art: Art | null): Uint8ClampedArray | undefined {
    return art ? this.wardrobe.art.get(art.path) : undefined;
  }

  private tint(key: string, src: Uint8ClampedArray, cv: CharacterColor, swapsOf: string | null) {
    const ck = `${key}|${colorKey(cv)}`;
    let out = this.tintCache.get(ck);
    if (!out) {
      out = tintPixels(src, cv, swapsOf ? this.wardrobe.swaps.get(swapsOf) : undefined);
      if (this.tintCache.size > CACHE_LIMIT.tint) this.tintCache.clear();
      this.tintCache.set(ck, out);
    }
    return out;
  }

  /**
   * A swatch hex as a colorize value fitted to the part's own shading: its mean tone lands
   * on the swatch's lightness while its darkest tone (the outline) stays put. Dark picks
   * deepen the outline too, so the art keeps at least a third of its contrast; light picks
   * stop short of pushing highlights to white.
   */
  swatchValue(art: Art | null, hex: string, key: ColorKey): CharacterColor {
    const [h, s, tl] = rgbToHsl(...hexToRgb(hex));
    const src = this.source(art);
    const ls: number[] = [];
    if (src) {
      for (let i = 0; i < src.length; i += 4) {
        if (!isOpaque(src[i + 3])) continue;
        const v = lum(src[i], src[i + 1], src[i + 2]);
        if (v < SWATCH_FIT.glint) ls.push(v);
      }
    }
    ls.sort((a, b) => a - b);
    const lmin = ls.length ? ls[Math.floor(ls.length * SWATCH_FIT.outlineAt)] : 0;
    const mean = ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : 0.5;
    let c = 0;
    let b: number;
    const flat = FLAT_SWATCH[key];
    if (flat) b = (tl * flat - mean) * 200;
    else if (mean - lmin < SWATCH_FIT.flatSpread)
      b = (tl * SWATCH_FIT.flatLift - mean) * 200; // pupils: a colour, not a glow
    else {
      const lminT = Math.min(lmin, tl * SWATCH_FIT.outlineFloor);
      const lmax = ls[Math.floor(ls.length * SWATCH_FIT.highlightAt)] || mean;
      const toWhite =
        lmax > mean ? (SWATCH_FIT.maxLight - tl) / (lmax - mean) : SWATCH_FIT.maxContrast;
      const f = Math.max(
        SWATCH_FIT.minContrast,
        Math.min(SWATCH_FIT.maxContrast, toWhite, (tl - lminT) / (mean - lmin)),
      );
      c = (f - 1) * 100;
      b = (tl - 0.5 - (mean - 0.5) * f) * 200;
    }
    const clamp = (v: number) => Math.max(-100, Math.min(100, Math.round(v)));
    return {
      h: Math.round(h * 360),
      s: Math.round(s * 100),
      b: clamp(b),
      c: clamp(c),
      colorize: true,
    };
  }

  /**
   * A colour's main tone on a part, as its swatch shows it: past the outline (the darkest
   * colour), the most common tone at or above the median lightness.
   */
  wayHex(art: Art | null, cv: CharacterColor | null): string | null {
    const src = this.source(art);
    if (!art || !src) return null;
    return mainTone(cv ? this.tint(`${art.path}|way`, src, cv, art.path) : src);
  }

  /**
   * A typed hex as the colorize value whose main tone (what wayHex reads back) comes
   * closest to it at contrast `c` (the slider is left where it is): brightness searched
   * over its whole range, then hue and saturation nudged. Whole steps can miss by a shade.
   */
  hexValue(art: Art | null, hex: string, c: number): CharacterColor {
    const [h0, s0] = rgbToHsl(...hexToRgb(hex));
    let best: CharacterColor = {
      h: Math.round(h0 * 360) % 360,
      s: Math.round(s0 * 100),
      b: 0,
      c,
      colorize: true,
    };
    const src = this.source(art);
    if (!src) return best;
    const target = hexToRgb(hex);
    const miss = (cv: CharacterColor) => {
      const tone = mainTone(tintPixels(src, cv, undefined));
      if (!tone) return Infinity;
      const rgb = hexToRgb(tone);
      return rgb.reduce((sum, v, i) => sum + (v - target[i]) ** 2, 0);
    };
    let bestMiss = miss(best);
    const tryValue = (cv: CharacterColor) => {
      const m = miss(cv);
      if (m < bestMiss) [best, bestMiss] = [cv, m];
    };
    for (let b = -100; b <= 100 && bestMiss > 0; b++) tryValue({ ...best, b });
    const { h, s } = best;
    for (let dh = -3; dh <= 3; dh++) {
      for (let ds = -3; ds <= 3; ds++) {
        if (bestMiss === 0) break;
        tryValue({ ...best, h: (h + dh + 360) % 360, s: Math.max(0, Math.min(100, s + ds)) });
      }
    }
    return best;
  }

  /** The hair as worn, averaged past its outline and glints: an uncoloured beard is fitted to it. */
  private hairHex(p: RenderProfile): string | null {
    const art = colorArt(p, 'hair');
    const src = this.source(art);
    if (!art || !src) return null;
    const cv = this.colorOf(p, 'hair');
    const px = cv ? this.tint(art.path, src, cv, art.path) : src;
    let dark = 1;
    for (let i = 0; i < px.length; i += 4) {
      if (isOpaque(px[i + 3])) dark = Math.min(dark, lum(px[i], px[i + 1], px[i + 2]));
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let k = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (!isOpaque(px[i + 3])) continue;
      const l = lum(px[i], px[i + 1], px[i + 2]);
      if (l > dark && l < SWATCH_FIT.glint) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
        k++;
      }
    }
    return k ? rgbHex(Math.round(r / k), Math.round(g / k), Math.round(b / k)) : null;
  }

  /** What a stored (uncoloured) edit colour looks like on a piece once its colour applies. */
  shownColor(p: RenderProfile, pix: string, hex: string): string {
    const layer = layerOf(pix);
    const cv = layer.color ? this.colorOf(p, layer.color) : null;
    if (!cv) return hex;
    const px = this.tint(
      `swatch:${hex}`,
      Uint8ClampedArray.from([...hexToRgb(hex), 255]),
      cv,
      colorArt(p, layer.color!)?.path ?? null,
    );
    return rgbHex(px[0], px[1], px[2]);
  }

  /** A piece's own colours as this profile wears it (plus the ones its edits paint), darkest first. */
  piecePalette(p: RenderProfile, pix: string): string[] {
    const src = this.source(shownArt(p, layerOf(pix)));
    const seen = new Set<string>();
    if (src) {
      for (let i = 0; i < src.length; i += 4) {
        if (isOpaque(src[i + 3])) seen.add(rgbHex(src[i], src[i + 1], src[i + 2]));
      }
    }
    for (const cell of Object.values(editsOf(p, pix)?.cells ?? {})) {
      for (const v of Object.values(cell)) if (v) seen.add(v);
    }
    return [...seen].sort((a, b) => hexLum(a) - hexLum(b));
  }

  // ── Layers and sheets ──────────────────────────────────

  /** A piece's layer with the profile's edits, uncoloured, or null when the profile doesn't show it. */
  layerBase(p: RenderProfile, layer: LayerDef): Layer | null {
    const art = shownArt(p, layer);
    const src = this.source(art);
    if (!art || !src) return null;
    const edits = editsOf(p, layer.pix);
    const key = `${art.path}|${editsKey(edits)}`;
    const cached = this.layerCache.get(key);
    if (cached) return cached;

    const out = new Uint8ClampedArray(src);
    for (const [ci, px] of Object.entries(edits?.cells ?? {})) {
      for (const [i, v] of Object.entries(px)) {
        const o = cellAt(+ci, +i);
        if (v === null) out.fill(0, o, o + 4);
        else out.set([...hexToRgb(v), 255], o);
      }
    }
    const layerOut = { data: out, key };
    if (this.layerCache.size > CACHE_LIMIT.layer) this.layerCache.clear();
    this.layerCache.set(key, layerOut);
    return layerOut;
  }

  private layerPixels(p: RenderProfile, layer: LayerDef): Uint8ClampedArray | null {
    const base = this.layerBase(p, layer);
    if (!base) return null;
    const cv = layer.color ? this.colorOf(p, layer.color) : null;
    return cv
      ? this.tint(base.key, base.data, cv, colorArt(p, layer.color!)?.path ?? null)
      : base.data;
  }

  /** Stack the layers into a fresh 128x96 RGBA sheet. */
  buildSheet(p: RenderProfile, opts: SheetOptions = {}): Uint8ClampedArray {
    const d = new Uint8ClampedArray(SHEET_W * SHEET_H * 4);
    const drawn = new Map<string, Uint8ClampedArray>();
    for (const layer of LAYERS) {
      if (opts.only && layer.pix !== opts.only) continue;
      if (opts.except && layer.pix === opts.except) continue;
      const px = this.layerPixels(p, layer);
      if (!px) continue;
      over(d, px, layer.behind ? drawn.get(layer.behind) : undefined);
      drawn.set(layer.pix, px);
    }
    if (!opts.only && opts.props !== false) {
      if (!eyeShape(p).bare) over(d, this.wardrobe.art.get(PROPS.glasses)!);
      over(d, this.wardrobe.art.get(PROPS.paper)!);
    }
    return d;
  }

  /** The finished sheet, cached by everything that changes it. Callers must not mutate it. */
  sheet(p: RenderProfile): Uint8ClampedArray {
    const key = sheetKey(p);
    let d = this.sheetCache.get(key);
    if (!d) {
      d = this.buildSheet(p);
      if (this.sheetCache.size > CACHE_LIMIT.sheet) this.sheetCache.clear();
      this.sheetCache.set(key, d);
    }
    return d;
  }
}

/** Each edits object's content as a cache key, computed once per object (profiles are immutable snapshots). */
const editsKeys = new WeakMap<CharacterPixelEdits, string>();
function editsKey(edits: CharacterPixelEdits | undefined): string {
  if (!edits) return '';
  let key = editsKeys.get(edits);
  if (key === undefined) {
    key = JSON.stringify(edits.cells);
    editsKeys.set(edits, key);
  }
  return key;
}

/** The fields a sheet depends on (part ids, colours, edits, eyes, blink), by content. */
function sheetKey(p: RenderProfile): string {
  const edits = Object.entries(p.edits ?? {}).map(([k, e]) => `${k}=${editsKey(e)}`);
  const look = { ...p, name: undefined, v: undefined, edits: undefined };
  return JSON.stringify([look, edits]);
}

/** The back view: the sheet's middle (up) row of frames. */
const BACK_ROW = [CHAR_FRAME_H * SHEET_W * 4, 2 * CHAR_FRAME_H * SHEET_W * 4] as const;

/** Alpha-composite `px` over `d`; in the back view, not where `behind` (a layer below) has pixels. */
function over(d: Uint8ClampedArray, px: Uint8ClampedArray, behind?: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (!isOpaque(a)) continue;
    if (behind && i >= BACK_ROW[0] && i < BACK_ROW[1] && isOpaque(behind[i + 3])) continue;
    if (a === 255) {
      d[i] = px[i];
      d[i + 1] = px[i + 1];
      d[i + 2] = px[i + 2];
      d[i + 3] = 255;
      continue;
    }
    const ao = d[i + 3] / 255;
    const as = a / 255;
    const ar = as + ao * (1 - as);
    for (let c = 0; c < 3; c++) d[i + c] = (px[i + c] * as + d[i + c] * ao * (1 - as)) / ar;
    d[i + 3] = ar * 255;
  }
}

/**
 * A colour's main tone, as its swatch shows it: past the outline (the darkest colour), the
 * most common tone at or above the median lightness.
 */
function mainTone(px: Uint8ClampedArray): string | null {
  const counts = new Map<string, number>();
  for (let i = 0; i < px.length; i += 4) {
    if (!isOpaque(px[i + 3])) continue;
    const hex = rgbHex(px[i], px[i + 1], px[i + 2]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const dark = [...counts.keys()].reduce((a, h) => (hexLum(h) < hexLum(a) ? h : a));
  if (counts.size > 1) counts.delete(dark);
  const ls: number[] = [];
  for (const [hex, k] of counts) for (let j = 0; j < k; j++) ls.push(hexLum(hex));
  ls.sort((a, b) => a - b);
  const med = ls[ls.length >> 1];
  let best: string | null = null;
  let bn = 0;
  for (const [hex, k] of counts) {
    if (hexLum(hex) >= med && k > bn) {
      best = hex;
      bn = k;
    }
  }
  return best;
}
