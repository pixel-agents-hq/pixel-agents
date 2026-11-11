import { describe, expect, it } from 'vitest';

import {
  CHARACTER_PROFILE_VERSION,
  isCharacterProfile,
  MAX_CHARACTER_PROFILES,
  migrateCharacterProfile,
  parseCharacterProfiles,
  parsePixId,
  pixId,
} from '../../core/src/characterProfiles.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';

/* eslint-disable pixel-agents/no-inline-colors -- pixel edits are hex data, not UI colours */

/**
 * The one profile validator, run by the server before persisting and by the webview before
 * drawing. It must refuse anything the renderer would crash on or paint as NaN, and let a
 * real profile through untouched.
 */
describe('isCharacterProfile / parseCharacterProfiles', () => {
  const realistic = {
    id: 'mark',
    name: 'Mark',
    body: 'flat',
    eyeShape: 'stern',
    eyeRows: 'top',
    under: 'basic',
    hair: 'mop',
    full: 'business_suit',
    colors: {
      skin: { h: 0, s: 0, b: 0, c: 0, palette: 'Tan' },
      hair: { h: 29, s: 42, b: -18, c: 6, colorize: true },
    },
    edits: {
      'full:business_suit': { cells: { '3': { '17': '#1a2B3c', '18': null } } },
      'body:flat': { cells: {} },
    },
    v: 35,
  };

  it('accepts the six defaults and a realistic edited profile, unchanged', () => {
    expect(DEFAULT_CHARACTER_PROFILES.every(isCharacterProfile)).toBe(true);
    const list = [...DEFAULT_CHARACTER_PROFILES, realistic];
    const parsed = parseCharacterProfiles(list);
    expect(parsed).not.toBeNull();
    // current-format profiles come back as the very same objects
    parsed!.forEach((profile, i) => expect(profile).toBe(list[i]));
  });

  it('lets unknown keys through, so older formats still reach the migration', () => {
    expect(isCharacterProfile({ body: 'light_male', someLegacyField: [1], v: 30 })).toBe(true);
  });

  it.each([
    ['not an object', 'flat'],
    ['an array', [{ body: 'flat' }]],
    ['no body', { name: 'x' }],
    ['a non-string body', { body: 1 }],
    ['a non-string part id', { body: 'flat', hair: 3 }],
    ['a non-string name', { body: 'flat', name: null }],
    ['an unknown eyeRows', { body: 'flat', eyeRows: 'middle' }],
    ['a non-numeric v', { body: 'flat', v: '31' }],
    ['colors as an array', { body: 'flat', colors: [] }],
    ['a colour that is a string', { body: 'flat', colors: { hair: 'red' } }],
    ['a colour missing a channel', { body: 'flat', colors: { hair: { h: 1, s: 2, b: 3 } } }],
    ['a NaN-bound colour', { body: 'flat', colors: { hair: { h: '1', s: 2, b: 3, c: 4 } } }],
    ['an infinite colour', { body: 'flat', colors: { hair: { h: Infinity, s: 0, b: 0, c: 0 } } }],
    [
      'a non-string colourway',
      { body: 'flat', colors: { hair: { h: 0, s: 0, b: 0, c: 0, palette: 1 } } },
    ],
    [
      'a non-boolean colorize',
      { body: 'flat', colors: { hair: { h: 0, s: 0, b: 0, c: 0, colorize: 1 } } },
    ],
    ['edits that are null', { body: 'flat', edits: { 'top:x': null } }],
    ['a non-numeric rev', { body: 'flat', edits: { 'top:x': { rev: '1', cells: {} } } }],
    ['cells that are not an object', { body: 'flat', edits: { 'top:x': { rev: 1, cells: [] } } }],
    ['a null frame', { body: 'flat', edits: { 'top:x': { rev: 1, cells: { '0': null } } } }],
    [
      'a frame past the sheet',
      { body: 'flat', edits: { 'top:x': { rev: 1, cells: { '24': {} } } } },
    ],
    ['a non-index frame', { body: 'flat', edits: { 'top:x': { rev: 1, cells: { a: {} } } } }],
    [
      'a pixel past the frame',
      { body: 'flat', edits: { 'top:x': { rev: 1, cells: { '0': { '512': null } } } } },
    ],
    [
      'a non-hex pixel',
      { body: 'flat', edits: { 'top:x': { rev: 1, cells: { '0': { '1': 'red' } } } } },
    ],
    [
      'a short-hex pixel',
      { body: 'flat', edits: { 'top:x': { rev: 1, cells: { '0': { '1': '#fff' } } } } },
    ],
    [
      'a numeric pixel',
      { body: 'flat', edits: { 'top:x': { rev: 1, cells: { '0': { '1': 0 } } } } },
    ],
  ])('refuses %s', (_label, profile) => {
    expect(isCharacterProfile(profile)).toBe(false);
    expect(parseCharacterProfiles([realistic, profile])).toBeNull();
  });

  it('refuses an empty list, a non-list, and more than MAX_CHARACTER_PROFILES', () => {
    expect(parseCharacterProfiles([])).toBeNull();
    expect(parseCharacterProfiles({ 0: realistic })).toBeNull();
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...realistic, id: `m${i}` }));
    expect(parseCharacterProfiles(many(MAX_CHARACTER_PROFILES))).not.toBeNull();
    expect(parseCharacterProfiles(many(MAX_CHARACTER_PROFILES + 1))).toBeNull();
  });
});

describe('migrateCharacterProfile', () => {
  it('v31: renames the PSD layer ids in slots and edit keys, per slot, and drops rev', () => {
    const v31 = {
      name: 'Old',
      body: 'bust',
      eyeShape: 'lashes',
      hair: 'layer_23_copy',
      pants: 'layer_1',
      shoes: 'layer_1',
      top: 'tshirt',
      colors: { hair: { h: 1, s: 2, b: 3, c: 4, colorize: true } },
      edits: {
        'hair:layer_23_copy': { rev: 5, cells: { '0': { '1': '#000000' } } },
        'pants:layer_1': { rev: 6, cells: {} },
        'shoes:layer_1': { rev: 7, cells: {} },
        'body:bust': { rev: 8, cells: {} },
        'lashes:lashes': { rev: 9, cells: {} },
      },
      v: 31,
    };
    const before = structuredClone(v31);
    expect(migrateCharacterProfile(v31)).toEqual({
      name: 'Old',
      body: 'bust',
      eyeShape: 'lashes',
      hair: 'long',
      pants: 'low_cut_jeans',
      shoes: 'boots',
      top: 'tshirt',
      colors: { hair: { h: 1, s: 2, b: 3, c: 4, colorize: true } },
      edits: {
        'hair:long': { cells: { '0': { '1': '#000000' } } },
        'pants:low_cut_jeans': { cells: {} },
        'shoes:boots': { cells: {} },
        'body:bust': { cells: {} },
        'lashes:lashes': { cells: {} },
      },
      v: CHARACTER_PROFILE_VERSION,
    });
    expect(v31).toEqual(before); // the input is left alone
  });

  it('v30: bodies and eye shapes first, then the parts', () => {
    const v30 = {
      body: 'light_male',
      eyeShape: 'light_female',
      full: 'layer_9',
      edits: { 'body:light_male': { rev: 1, cells: {} }, 'full:layer_9': { rev: 1, cells: {} } },
      v: 30,
    };
    expect(migrateCharacterProfile(v30)).toEqual({
      body: 'flat',
      eyeShape: 'lashes',
      full: 'business_suit',
      edits: { 'body:flat': { cells: {} }, 'full:business_suit': { cells: {} } },
      v: CHARACTER_PROFILE_VERSION,
    });
  });

  it('v32: the eye whites edits move from eyefix to whites', () => {
    const v32 = {
      body: 'flat',
      eyeShape: 'stern',
      edits: { 'eyefix:stern': { cells: { '3': { '40': null } } }, 'iris:flat': { cells: {} } },
      v: 32,
    };
    expect(migrateCharacterProfile(v32)).toEqual({
      body: 'flat',
      eyeShape: 'stern',
      // frame 3 (front type1) is also where the seated frame's right half comes from
      edits: {
        'whites:stern': { cells: { '3': { '40': null }, '7': { '40': null } } },
        'iris:flat': { cells: {} },
      },
      v: CHARACTER_PROFILE_VERSION,
    });
  });

  it("v33: edits move to the 8-frame sheet, the seated frame taking the typing frames' edits", () => {
    const red = '#ff0000';
    const blue = '#0000ff';
    const v33 = {
      body: 'flat',
      edits: {
        'top:tshirt': {
          cells: {
            '1': { '5': red }, // front walk2: stays frame 1
            // front type1 (3) and type2 (4): pixel 2 is x 2 (left half), 13 is x 13 (right half)
            '3': { '2': red, '13': red },
            '4': { '2': blue, '13': blue },
            '8': { '0': red }, // back walk2: row 1 frame 1 = 9
            '17': { '20': red }, // side type1 (row 2 frame 3 = 19): the whole seated side frame
            '18': { '20': blue }, // side type2: not seated
            '20': { '1': null }, // side read2 = 22
          },
        },
      },
      v: 33,
    };
    expect(migrateCharacterProfile(v33).edits).toEqual({
      'top:tshirt': {
        cells: {
          '1': { '5': red },
          '3': { '2': red, '13': red },
          '4': { '2': blue, '13': blue },
          '7': { '2': blue, '13': red }, // left half from type2, right half from type1
          '9': { '0': red },
          '19': { '20': red },
          '20': { '20': blue },
          '22': { '1': null },
          '23': { '20': red },
        },
      },
    });
  });

  it('v32: parts named after people are renamed, in slots and edit keys', () => {
    const v32 = {
      body: 'bust',
      hair: 'helly_hair',
      top: 'helly_top',
      pants: 'helly_skirt',
      lanyard: 'helly_lanyard',
      edits: { 'top:helly_top': { cells: {} } },
      v: 32,
    };
    expect(migrateCharacterProfile(v32)).toEqual({
      body: 'bust',
      hair: 'shoulder_length',
      top: 'turtleneck',
      pants: 'skirt',
      lanyard: 'lanyard',
      edits: { 'top:turtleneck': { cells: {} } },
      v: CHARACTER_PROFILE_VERSION,
    });
    expect(
      migrateCharacterProfile({ body: 'flat', full: 'mark_suit', hair: 'mark_hair', v: 32 }),
    ).toMatchObject({ full: 'suit_and_tie', hair: 'side_swept' });
  });

  it('v32: the bowling shirt becomes a red t-shirt under the orange vest; its edits go', () => {
    const v32 = {
      body: 'flat',
      top: 'bowling_shirt',
      colors: { top: { h: 90, s: 0, b: 0, c: 0 }, hair: { h: 1, s: 2, b: 3, c: 4 } },
      edits: { 'top:bowling_shirt': { cells: {} }, 'hair:bob': { cells: {} } },
      v: 32,
    };
    expect(migrateCharacterProfile(v32)).toEqual({
      body: 'flat',
      top: 'tshirt',
      jacket: 'vest',
      colors: {
        top: { h: 2, s: 75, b: -28, c: -10, colorize: true },
        jacket: { h: 0, s: 0, b: 0, c: 0, palette: 'Original' },
        hair: { h: 1, s: 2, b: 3, c: 4 },
      },
      edits: { 'hair:bob': { cells: {} } },
      v: CHARACTER_PROFILE_VERSION,
    });
    // a jacket already worn stays
    expect(
      migrateCharacterProfile({ body: 'flat', top: 'bowling_shirt', jacket: 'blazer', v: 32 }),
    ).toMatchObject({ top: 'tshirt', jacket: 'blazer' });
  });

  it('v32: the uniforms become the business suit in its own colours', () => {
    expect(
      migrateCharacterProfile({
        body: 'flat',
        full: 'layer_13',
        colors: { full: { h: 9, s: 0, b: 0, c: 0 } },
        v: 31,
      }),
    ).toEqual({ body: 'flat', full: 'business_suit', colors: {}, v: CHARACTER_PROFILE_VERSION });
  });

  it('pixId and parsePixId round-trip at the first colon', () => {
    expect(pixId('hair', 'mop')).toBe('hair:mop');
    expect(parsePixId('hair:mop')).toEqual(['hair', 'mop']);
    expect(parsePixId('a:b:c')).toEqual(['a', 'b:c']);
  });
});
