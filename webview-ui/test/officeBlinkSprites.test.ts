import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { expect, it } from 'vitest';

import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { startOfficeSync } from '../src/characters/officeSprites.js';
import { CharacterRenderer } from '../src/characters/renderer.js';
import { EYE_FOLDERS } from '../src/characters/slots.js';
import { decodeWardrobe, parseWardrobeManifest, type Rgba } from '../src/characters/wardrobe.js';
import { getCharacterSprites } from '../src/office/sprites/spriteData.js';
import { Direction } from '../src/office/types.js';

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

function sync(profiles: readonly CharacterProfile[]): () => void {
  const state = { renderer, profiles };
  return startOfficeSync({ subscribe: () => () => {}, getState: () => state as never });
}

const differs = (a: string[][], b: string[][]) =>
  a.some((row, y) => row.some((px, x) => px !== b[y][x]));

it('office characters shut their eyes mid-blink, facing the viewer', () => {
  const stop = sync(DEFAULT_CHARACTER_PROFILES);
  DEFAULT_CHARACTER_PROFILES.forEach((_, i) => {
    const open = getCharacterSprites(i, 0, false);
    const shut = getCharacterSprites(i, 0, true);
    expect(differs(open.typing[Direction.DOWN][0], shut.typing[Direction.DOWN][0])).toBe(true);
    expect(differs(open.walk[Direction.DOWN][1], shut.walk[Direction.DOWN][1])).toBe(true);
    // A repeat blinks in its own clothes.
    const repeatShut = getCharacterSprites(i, 1, true);
    expect(differs(repeatShut.walk[Direction.DOWN][1], shut.walk[Direction.DOWN][1])).toBe(true);
  });
  stop();
});

it('a character whose eyes are always shut has no blink', () => {
  const closed = { ...DEFAULT_CHARACTER_PROFILES[0], eyeShape: 'closed' };
  const stop = sync([closed]);
  expect(getCharacterSprites(0, 0, true)).toBe(getCharacterSprites(0, 0, false));
  stop();
});
