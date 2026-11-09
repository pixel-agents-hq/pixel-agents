import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import {
  currentSheetPixels,
  sheetToDirectionSprites,
} from '../../core/src/assets/characterSheet.js';
import { rgbaToHex } from '../../core/src/assets/colorUtils.js';
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
} from '../../core/src/assets/constants.js';
import { decodeCharacterPng } from '../../core/src/assets/pngDecoder.js';
import { LEGACY_SHEET_W, widenLegacySheet } from '../../core/src/assets/seatedFrame.js';
import type { CharacterDirectionSprites } from '../../core/src/assets/types.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { sheetToOfficeSprites } from '../src/characters/officeSprites.js';
import { CharacterRenderer } from '../src/characters/renderer.js';
import { decodeSheet, SHEET_H, SHEET_W } from '../src/characters/sheet.js';
import { EYE_FOLDERS } from '../src/characters/slots.js';
import { decodeWardrobe, parseWardrobeManifest, type Rgba } from '../src/characters/wardrobe.js';

// ── The slicing as it was written before characterSheet.ts (reference copies) ──

function oldDecodeCharacterPng(pngBuffer: Buffer): CharacterDirectionSprites {
  const png = PNG.sync.read(pngBuffer);
  const legacy = png.width === LEGACY_SHEET_W;
  const width = legacy ? CHAR_FRAME_W * CHAR_FRAMES_PER_ROW : png.width;
  const data = legacy ? widenLegacySheet(png.data) : png.data;
  const charData: CharacterDirectionSprites = { down: [], up: [], right: [] };
  for (let dirIdx = 0; dirIdx < CHARACTER_DIRECTIONS.length; dirIdx++) {
    const dir = CHARACTER_DIRECTIONS[dirIdx];
    const rowOffsetY = dirIdx * CHAR_FRAME_H;
    const frames: string[][][] = [];
    for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
      const sprite: string[][] = [];
      const frameOffsetX = f * CHAR_FRAME_W;
      for (let y = 0; y < CHAR_FRAME_H; y++) {
        const row: string[] = [];
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          const idx = ((rowOffsetY + y) * width + (frameOffsetX + x)) * 4;
          row.push(rgbaToHex(data[idx], data[idx + 1], data[idx + 2], data[idx + 3]));
        }
        sprite.push(row);
      }
      frames.push(sprite);
    }
    charData[dir] = frames;
  }
  return charData;
}

function oldSheetToOfficeSprites(sheet: Uint8ClampedArray): CharacterDirectionSprites {
  const sprites: CharacterDirectionSprites = { down: [], up: [], right: [] };
  CHARACTER_DIRECTIONS.forEach((dir, row) => {
    for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
      const frame: string[][] = [];
      for (let y = 0; y < CHAR_FRAME_H; y++) {
        const line: string[] = [];
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          const i = ((row * CHAR_FRAME_H + y) * SHEET_W + f * CHAR_FRAME_W + x) * 4;
          line.push(rgbaToHex(sheet[i], sheet[i + 1], sheet[i + 2], sheet[i + 3]));
        }
        frame.push(line);
      }
      sprites[dir].push(frame);
    }
  });
  return sprites;
}

function oldDecodeSheet(img: Rgba): Uint8ClampedArray | null {
  if (img.height !== SHEET_H) return null;
  if (img.width === SHEET_W) return img.data;
  return img.width === LEGACY_SHEET_W ? widenLegacySheet(img.data) : null;
}

// ── Fixtures: every bundled art PNG and the six default sheets, plus their 112-wide forms ──

const art = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/characters/art');
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

const encode = (img: Rgba): Buffer => {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  return PNG.sync.write(png);
};

const sheets: Array<[string, Uint8ClampedArray]> = [
  ...[...files].map(([key, img]) => [key, img.data] as [string, Uint8ClampedArray]),
  ...DEFAULT_CHARACTER_PROFILES.map(
    (p) => [`default ${p.name}`, renderer.buildSheet(p)] as [string, Uint8ClampedArray],
  ),
];
const current: Rgba[] = sheets.map(([, data]) => ({ width: SHEET_W, height: SHEET_H, data }));
const legacy: Rgba[] = sheets.map(([, data]) => ({
  width: LEGACY_SHEET_W,
  height: SHEET_H,
  data: legacyFrames(data),
}));

describe('character sheet slicing', () => {
  it('has fixtures: every art PNG is a current sheet', () => {
    expect(files.size).toBeGreaterThan(50);
    for (const [key, img] of files)
      expect([img.width, img.height], key).toEqual([SHEET_W, SHEET_H]);
  });

  it('decodeCharacterPng slices current and legacy sheets exactly as before', () => {
    for (const [i, [key]] of sheets.entries()) {
      for (const img of [current[i], legacy[i]]) {
        const png = encode(img);
        expect(decodeCharacterPng(png), `${key} ${img.width}`).toEqual(oldDecodeCharacterPng(png));
      }
    }
  });

  it('sheetToOfficeSprites slices composed sheets exactly as before', () => {
    for (const [key, data] of sheets) {
      expect(sheetToOfficeSprites(data), key).toEqual(oldSheetToOfficeSprites(data));
    }
  });

  it('decodeSheet widens and rejects exactly as before', () => {
    const bytes = (a: Uint8ClampedArray | null) => (a ? Buffer.from(a).toString('base64') : null);
    for (const img of [...current, ...legacy]) {
      expect(bytes(decodeSheet(img))).toBe(bytes(oldDecodeSheet(img)));
    }
    const odd = (width: number, height: number): Rgba => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    });
    for (const img of [odd(SHEET_W, 64), odd(96, SHEET_H), odd(LEGACY_SHEET_W, 32)]) {
      expect(decodeSheet(img)).toBeNull();
      expect(oldDecodeSheet(img)).toBeNull();
    }
    // A current sheet comes back as the very buffer it was given.
    expect(decodeSheet(current[0])).toBe(current[0].data);
  });

  it('currentSheetPixels widens only a legacy sheet', () => {
    const data = legacy[0].data;
    expect(currentSheetPixels(LEGACY_SHEET_W, data)).toEqual({
      width: SHEET_W,
      data: widenLegacySheet(data),
    });
    const same = current[0].data;
    expect(currentSheetPixels(SHEET_W, same).data).toBe(same);
    expect(sheetToDirectionSprites(same, SHEET_W)).toEqual(oldSheetToOfficeSprites(same));
  });
});
