import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { LEGACY_SHEET_W, widenLegacySheet } from '../../core/src/assets/seatedFrame.js';
import {
  CHARACTER_PROFILE_VERSION,
  type CharacterProfile,
} from '../../core/src/characterProfiles.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import {
  paintPixel,
  parseConfigFile,
  randomize,
  setPart,
  setUnderwear,
} from '../src/characters/profiles.js';
import { CharacterRenderer } from '../src/characters/renderer.js';
import {
  CLOTHES_COLOR_KEYS,
  repeatHueTurn,
  withRepeatClothes,
} from '../src/characters/repeatClothes.js';
import { SHEET_H, SHEET_W } from '../src/characters/sheet.js';
import {
  EYE_FOLDERS,
  layerOf,
  LAYERS,
  type RenderProfile,
  shownArt,
  wornPieces,
} from '../src/characters/slots.js';
import {
  decodeWardrobe,
  parseWardrobeManifest,
  type Rgba,
  type WardrobeManifest,
} from '../src/characters/wardrobe.js';
import { REPEAT_CLOTHES_HUES } from '../src/constants.js';
import { CHARACTER_EDITOR_COLORS } from '../src/constants.js';

const art = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/characters/art');
/** Every art PNG, keyed as loadWardrobe keys them ('hair/bob'). */
const files = new Map<string, Rgba>(
  fs
    .readdirSync(art, { recursive: true, encoding: 'utf-8' })
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const img = PNG.sync.read(fs.readFileSync(path.join(art, f)));
      const key = f
        .split(path.sep)
        .join('/')
        .replace(/\.png$/, '');
      return [key, { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }];
    }),
);
const manifest = parseWardrobeManifest(
  JSON.parse(fs.readFileSync(path.join(art, 'wardrobe.json'), 'utf-8')),
);
const renderer = new CharacterRenderer(decodeWardrobe(manifest, files, EYE_FOLDERS));
const hash = (sheet: Uint8ClampedArray) =>
  createHash('sha256').update(sheet).digest('hex').slice(0, 16);
/** A sheet's first 7 frames a row: the sheet as it was before the seated frame. */
const legacyFrames = (sheet: Uint8ClampedArray) => {
  const out = new Uint8ClampedArray(LEGACY_SHEET_W * SHEET_H * 4);
  for (let y = 0; y < SHEET_H; y++) {
    out.set(
      sheet.subarray(y * SHEET_W * 4, (y * SHEET_W + LEGACY_SHEET_W) * 4),
      y * LEGACY_SHEET_W * 4,
    );
  }
  return out;
};

describe('CharacterRenderer', () => {
  // Pinned against the wardrobe artifact's renderer (v126), which drew these pixel for pixel
  // (Aura since moved to the Bust body; Bob since given the Bust's Dark skin on the head).
  // The artifact drew 7 frames a row: the seated frame is checked below.
  it('draws the six default characters exactly', () => {
    expect(DEFAULT_CHARACTER_PROFILES.map((p) => hash(legacyFrames(renderer.buildSheet(p)))))
      .toMatchInlineSnapshot(`
        [
          "5403cbdf31985b24",
          "162d0d6af0731950",
          "9bf485a05dca9247",
          "7e83d17e6ac256f7",
          "9c426783c1a3c874",
          "f01fb7d82cbb79e4",
        ]
      `);
  });

  it('draws the seated frame from the typing frames', () => {
    for (const p of DEFAULT_CHARACTER_PROFILES) {
      const sheet = renderer.buildSheet(p);
      expect(widenLegacySheet(legacyFrames(sheet)), p.name).toEqual(sheet);
    }
  });

  it('caches sheets by look, not by name', () => {
    const [suit] = DEFAULT_CHARACTER_PROFILES;
    expect(renderer.sheet({ ...suit, name: 'Other' })).toBe(renderer.sheet(suit));
  });

  it('a pixel edit changes only that pixel', () => {
    const p: CharacterProfile = structuredClone(DEFAULT_CHARACTER_PROFILES[0]);
    const before = renderer.buildSheet(p);
    paintPixel(p, 'body', 0, 20 * 16 + 1, CHARACTER_EDITOR_COLORS.edited);
    const after = renderer.buildSheet(p);
    let changed = 0;
    for (let i = 0; i < before.length; i += 4)
      if (before[i] !== after[i] || before[i + 3] !== after[i + 3]) changed++;
    expect(changed).toBe(1);
  });

  it("an outfit's tie wears the outfit's colour until given its own, which changes only the tie", () => {
    const suit: CharacterProfile = {
      ...DEFAULT_CHARACTER_PROFILES[0],
      full: 'suit_and_tie',
      colors: { full: { h: 130, s: 0, b: -38, c: -56, colorize: true } },
    };
    const sameColour = { ...suit, colors: { ...suit.colors, tie: suit.colors!.full } };
    expect(renderer.buildSheet(sameColour)).toEqual(renderer.buildSheet(suit));

    const yellow = { ...suit, colors: { ...suit.colors, tie: { h: 45, s: 80, b: 0, c: 0 } } };
    const before = renderer.buildSheet(suit);
    const after = renderer.buildSheet(yellow);
    const tieOnly = renderer.buildSheet({ ...yellow }, { only: 'tie' });
    let changed = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (before[i] === after[i] && before[i + 1] === after[i + 1]) continue;
      changed++;
      expect(tieOnly[i + 3]).toBeGreaterThan(0);
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('wardrobe art', () => {
  const decode = (m: WardrobeManifest, f: Map<string, Rgba>) => () =>
    decodeWardrobe(m, f, EYE_FOLDERS);

  it('has a PNG for every part in wardrobe.json and no PNG without one', () => {
    expect(decode(manifest, files)).not.toThrow();
    const extra: WardrobeManifest = structuredClone(manifest);
    extra.parts.hair.push({ id: 'no_such_hair', label: 'Missing' });
    expect(decode(extra, files)).toThrow(/missing hair\/no_such_hair/);
    const stray = new Map(files).set('hair/unlisted', files.get('hair/bob')!);
    expect(decode(manifest, stray)).toThrow(/not in wardrobe.json: hair\/unlisted/);
    const small = new Map(files).set('hair/bob', {
      width: 16,
      height: 32,
      data: new Uint8ClampedArray(0),
    });
    expect(decode(manifest, small)).toThrow(/not 128x96: hair\/bob/);
  });

  it('finds each piece by path: parts by id, underwear by body, eyes by shape and rows', () => {
    const p: CharacterProfile = {
      body: 'bust',
      hair: 'bob',
      under: 'basic',
      eyeShape: 'stern',
      eyeRows: 'top',
    };
    const at = (pix: string, q: RenderProfile = p) => shownArt(q, layerOf(pix))?.path ?? null;
    expect(at('hair')).toBe('hair/bob');
    expect(at('body')).toBe('body/bust');
    expect(at('under')).toBe('under/bust');
    expect(at('utop')).toBeNull(); // not worn
    expect(at('under', { ...p, pants: 'jeans' })).toBeNull(); // covered
    expect(at('iris')).toBe('eyes/stern/iris.top');
    expect(at('iris', { ...p, eyeRows: undefined })).toBe('eyes/stern/iris.bottom');
    expect(at('whites')).toBe('eyes/stern/whites'); // one sheet: the iris covers the pupils
    // a blink is the Closed folder; over Stern it keeps Stern's brows (its own lashes)
    const blink = (eyeShape: string): RenderProfile => ({ ...p, eyeShape, blink: true });
    expect(at('lashes', blink('stern'))).toBe('eyes/closed-stern/lashes');
    expect(at('iris', blink('stern'))).toBe('eyes/closed/iris.top');
    expect(at('lashes', blink('lidded'))).toBe('eyes/closed/lashes');
  });

  it('a missing eye file draws nothing: Lidded eyes have no iris to edit', () => {
    const pieces = (q: CharacterProfile) => wornPieces(renderer.wardrobe, q).map((l) => l.pix);
    expect(pieces({ body: 'flat', eyeShape: 'plain' })).toContain('iris');
    expect(pieces({ body: 'flat', eyeShape: 'lidded' })).not.toContain('iris');
    expect(renderer.layerBase({ body: 'flat', eyeShape: 'lidded' }, layerOf('iris'))).toBeNull();
  });
});

describe('profile changes', () => {
  it('an outfit and a top replace each other; Top/Pants None takes the underwear off', () => {
    const p: CharacterProfile = { body: 'flat', top: 'tshirt', under: 'basic' };
    setPart(p, 'full', 'business_suit');
    expect(p.top).toBeUndefined();
    setUnderwear(p, 'pants', false);
    expect(p.under).toBeUndefined();
  });

  it('randomize keeps the name and accessories', () => {
    const p: CharacterProfile = { name: 'Kept', body: 'flat', necklace: 'necklace' };
    randomize(renderer, p);
    expect(p.name).toBe('Kept');
    expect(p.necklace).toBe('necklace');
  });

  it('reads one profile, a list, or a saved roster; refuses anything else', () => {
    const w = renderer.wardrobe;
    expect(parseConfigFile(w, JSON.stringify({ body: 'flat' }), 'Mark.json')?.[0].name).toBe(
      'Mark',
    );
    expect(
      parseConfigFile(
        w,
        JSON.stringify({ roster: [{ body: 'bust' }, { body: 'flat' }] }),
        'r.json',
      ),
    ).toHaveLength(2);
    // the wardrobe artifact's configs (v30) load with the renamed bodies and eye shapes
    expect(
      parseConfigFile(
        w,
        JSON.stringify({ body: 'light_female', eyeShape: 'light_female', v: 30 }),
        'Old.json',
      )?.[0],
    ).toMatchObject({ body: 'bust', eyeShape: 'lashes', v: CHARACTER_PROFILE_VERSION });
    expect(parseConfigFile(w, JSON.stringify({ body: 'robot' }), 'x.json')).toBeNull();
    expect(parseConfigFile(w, 'not json', 'x.json')).toBeNull();
  });
});

describe('withRepeatClothes', () => {
  const clothes = new Set<string>(CLOTHES_COLOR_KEYS);
  const isClothes = (pix: string) => clothes.has(layerOf(pix).color ?? '');

  it('recolours only the clothes, the first repeat all red', () => {
    for (const p of DEFAULT_CHARACTER_PROFILES) {
      const red = withRepeatClothes(p, 1);
      let clothesSeen = 0;
      for (const layer of LAYERS) {
        const own = renderer.buildSheet(p, { only: layer.pix });
        const dressed = renderer.buildSheet(red, { only: layer.pix });
        if (!isClothes(layer.pix)) {
          expect(hash(dressed), `${p.name} ${layer.pix}`).toBe(hash(own));
          continue;
        }
        for (let i = 0; i < dressed.length; i += 4) {
          if (dressed[i + 3] < 2) continue;
          const [r, g, b] = [dressed[i], dressed[i + 1], dressed[i + 2]];
          // Red: the red channel leads, green and blue move together.
          expect(r, `${p.name} ${layer.pix}`).toBeGreaterThanOrEqual(Math.max(g, b));
          expect(Math.abs(g - b), `${p.name} ${layer.pix}`).toBeLessThanOrEqual(1);
          clothesSeen++;
        }
      }
      expect(clothesSeen, p.name).toBeGreaterThan(0);
    }
  });

  it('leaves the first of a character in its own colours', () => {
    const p = DEFAULT_CHARACTER_PROFILES[0];
    expect(withRepeatClothes(p, 0)).toBe(p);
  });

  it('goes red, blue, green… and cycles past the last colour', () => {
    const p = DEFAULT_CHARACTER_PROFILES[0];
    const hueOf = (repeat: number) => withRepeatClothes(p, repeat).colors?.top?.h;
    expect([1, 2, 3].map(hueOf)).toEqual([0, 220, 120]);
    expect(hueOf(REPEAT_CLOTHES_HUES.length + 1)).toBe(hueOf(1));
  });
});

describe('repeatHueTurn', () => {
  it('turns every repeat of an external sprite by a different amount, none by zero', () => {
    const turns = REPEAT_CLOTHES_HUES.map((_, i) => repeatHueTurn(i + 1));
    expect(new Set(turns).size).toBe(turns.length);
    expect(turns.every((t) => t > 0 && t < 360)).toBe(true);
    expect(repeatHueTurn(0)).toBe(0);
  });
});
