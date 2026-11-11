import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { CHAR_FRAME_H, CHAR_FRAME_W } from '../../core/src/assets/constants.js';
import { SHEET_FRAMES } from '../../core/src/assets/seatedFrame.js';
import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { cellAt, SHEET_H, SHEET_W } from '../../core/src/characters/sheet.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import type { WardrobeItem } from '../../core/src/wardrobeItems.js';
import {
  characterPreviewPng,
  characterRenderer,
  findWardrobeDir,
  loadWardrobeFrom,
  renderCharacterSheet,
} from '../src/characterArt.js';
import { CHARACTER_PREVIEW_SCALE } from '../src/constants.js';

const hash = (data: Uint8Array | Uint8ClampedArray) =>
  createHash('sha256').update(data).digest('hex').slice(0, 16);
/** A sheet's first 7 frames a row, as characterRenderer.test.ts pins them. */
const legacyFrames = (sheet: Uint8ClampedArray) => {
  const w = CHAR_FRAME_W * 7;
  const out = new Uint8ClampedArray(w * SHEET_H * 4);
  for (let y = 0; y < SHEET_H; y++) {
    out.set(sheet.subarray(y * SHEET_W * 4, (y * SHEET_W + w) * 4), y * w * 4);
  }
  return out;
};

describe('the server wardrobe', () => {
  it('is found next to the source when run from it', () => {
    const dir = findWardrobeDir();
    expect(dir).not.toBeNull();
    expect(fs.existsSync(path.join(dir!, 'wardrobe.json'))).toBe(true);
  });

  it('draws the six default characters exactly as the webview pins them', () => {
    // The same pins as webview-ui/test/characterRenderer.test.ts: the pngjs-loaded wardrobe
    // must give the same sheets the webview's loader does.
    expect(
      DEFAULT_CHARACTER_PROFILES.map((p) => hash(legacyFrames(renderCharacterSheet(p)))),
    ).toEqual([
      '5403cbdf31985b24',
      '162d0d6af0731950',
      '9bf485a05dca9247',
      '7e83d17e6ac256f7',
      '9c426783c1a3c874',
      'f01fb7d82cbb79e4',
    ]);
  });

  it('loads every part of the manifest from the art folder', () => {
    const w = loadWardrobeFrom(findWardrobeDir()!);
    for (const [cat, parts] of Object.entries(w.manifest.parts)) {
      for (const part of parts) expect(w.art.has(`${cat}/${part.id}`), part.id).toBe(true);
    }
  });

  it('wears a custom item like the part it was saved from', () => {
    const dir = findWardrobeDir()!;
    const item: WardrobeItem = {
      id: 'custom_mine',
      piece: 'hair',
      label: 'Mine',
      base: 'bob',
      png: fs.readFileSync(path.join(dir, 'hair', 'bob.png')).toString('base64'),
    };
    const p: CharacterProfile = { ...DEFAULT_CHARACTER_PROFILES[0], hair: 'bob' };
    const own = renderCharacterSheet({ ...p, hair: item.id }, [item]);
    expect(own).toEqual(renderCharacterSheet(p));
    expect(characterRenderer([item])).toBe(characterRenderer([item]));
  });
});

describe('characterPreviewPng', () => {
  it('is the standing frames facing down, up and right, each pixel scaled whole', () => {
    const p = DEFAULT_CHARACTER_PROFILES[2];
    const sheet = renderCharacterSheet(p);
    const png = PNG.sync.read(characterPreviewPng(p));
    const scale = CHARACTER_PREVIEW_SCALE;
    expect(Number.isInteger(scale) && scale >= 1).toBe(true);
    expect(png.width).toBe(3 * CHAR_FRAME_W * scale);
    expect(png.height).toBe(CHAR_FRAME_H * scale);
    const standing = SHEET_FRAMES.walk[1];
    for (let row = 0; row < 3; row++) {
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < CHAR_FRAME_W * scale; x++) {
          const src = cellAt(
            row * 8 + standing,
            Math.floor(y / scale) * CHAR_FRAME_W + Math.floor(x / scale),
          );
          const dst = (y * png.width + row * CHAR_FRAME_W * scale + x) * 4;
          const want = [...sheet.subarray(src, src + 4)];
          const got = [...png.data.subarray(dst, dst + 4)];
          // a transparent pixel's colour doesn't matter
          if (want[3] === 0) expect(got[3]).toBe(0);
          else expect(got).toEqual(want);
        }
      }
    }
  });

  it('takes another whole-pixel scale', () => {
    const png = PNG.sync.read(characterPreviewPng(DEFAULT_CHARACTER_PROFILES[0], { scale: 1 }));
    expect([png.width, png.height]).toEqual([3 * CHAR_FRAME_W, CHAR_FRAME_H]);
    expect(() => characterPreviewPng(DEFAULT_CHARACTER_PROFILES[0], { scale: 1.5 })).toThrow();
  });
});
