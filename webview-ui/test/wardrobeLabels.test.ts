import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { wrapHue } from '../src/characters/color.js';
import { tabSummary } from '../src/characters/profiles.js';
import {
  parseWardrobeManifest,
  partInfo,
  partLabel,
  type Wardrobe,
} from '../src/characters/wardrobe.js';

const art = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/characters/art');
const manifest = parseWardrobeManifest(
  JSON.parse(fs.readFileSync(path.join(art, 'wardrobe.json'), 'utf-8')),
);
// The labels read only the manifest.
const w = { manifest } as Wardrobe;

describe('wardrobe labels', () => {
  it('partInfo finds a part by id; partLabel says None otherwise', () => {
    expect(partInfo(w, 'hair', 'spiky')?.label).toBe('Spiky');
    expect(partInfo(w, 'hair', 'nope')).toBeUndefined();
    expect(partInfo(w, 'nope', 'spiky')).toBeUndefined();
    expect(partLabel(w, 'hair', undefined)).toBe('None');
  });

  it("the Hair tab's summary names the beard inside it", () => {
    const p = { ...structuredClone(DEFAULT_CHARACTER_PROFILES[0]), hair: 'spiky' };
    delete p.beard;
    expect(tabSummary(w, p, 'hair')).toBe('Spiky');
    expect(tabSummary(w, { ...p, beard: 'stubble' }, 'hair')).toBe('Spiky, Stubble');
    expect(tabSummary(w, { ...p, hair: undefined, beard: 'stubble' }, 'hair')).toBe(
      'None, Stubble',
    );
  });
});

describe('wrapHue', () => {
  it('brings any hue into [0, 360)', () => {
    expect([0, 359, 360, 725, -1, -360, -725].map(wrapHue)).toEqual([0, 359, 0, 5, 359, 0, 355]);
  });
});
