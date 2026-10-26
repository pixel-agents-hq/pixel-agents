import { describe, expect, it } from 'vitest';

import {
  MAX_DIRECTORY_CHARACTERS,
  parseCharacterOrder,
  parseDirectoryCharacters,
  pickDirectoryCharacter,
} from '../../core/src/directoryCharacters.js';
import {
  chooseLook,
  pickRandomPalette,
  repeatFor,
  rosterPick,
} from '../../core/src/paletteUtils.js';

describe('parseDirectoryCharacters', () => {
  it('keeps non-negative integers in order, first occurrence wins', () => {
    expect(parseDirectoryCharacters([2, 0, 2, -1, 1.5, '3', null, 5])).toEqual([2, 0, 5]);
  });

  it('is empty for anything but an array', () => {
    expect(parseDirectoryCharacters(undefined)).toEqual([]);
    expect(parseDirectoryCharacters({ 0: 1 })).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_DIRECTORY_CHARACTERS + 5 }, (_, i) => i);
    expect(parseDirectoryCharacters(many)).toHaveLength(MAX_DIRECTORY_CHARACTERS);
  });
});

describe('parseCharacterOrder', () => {
  it("defaults to 'priority'", () => {
    expect(parseCharacterOrder('random')).toBe('random');
    expect(parseCharacterOrder('priority')).toBe('priority');
    expect(parseCharacterOrder('shuffle')).toBe('priority');
    expect(parseCharacterOrder(undefined)).toBe('priority');
  });
});

describe('pickDirectoryCharacter', () => {
  const none = new Set<number>();

  it('priority: the first default nobody wears', () => {
    expect(pickDirectoryCharacter([3, 1, 2], 'priority', 6, none)).toBe(3);
    expect(pickDirectoryCharacter([3, 1, 2], 'priority', 6, new Set([3]))).toBe(1);
  });

  it('priority: undefined when every default is worn (the server picks at random)', () => {
    expect(pickDirectoryCharacter([3, 1], 'priority', 6, new Set([1, 3]))).toBeUndefined();
  });

  it('random: among the defaults nobody wears', () => {
    const worn = new Set([3]);
    expect(pickDirectoryCharacter([3, 1, 2], 'random', 6, worn, () => 0)).toBe(1);
    expect(pickDirectoryCharacter([3, 1, 2], 'random', 6, worn, () => 0.99)).toBe(2);
  });

  it('random: undefined when every default is worn, never a repeat', () => {
    const worn = new Set([1, 3]);
    expect(pickDirectoryCharacter([3, 1], 'random', 6, worn, () => 0.99)).toBeUndefined();
  });

  it('skips defaults past the cast', () => {
    expect(pickDirectoryCharacter([9, 2], 'priority', 6, none)).toBe(2);
    expect(pickDirectoryCharacter([9], 'random', 6, none)).toBeUndefined();
  });

  it('is undefined with no defaults', () => {
    expect(pickDirectoryCharacter([], 'priority', 6, none)).toBeUndefined();
    expect(pickDirectoryCharacter([], 'random', 6, none)).toBeUndefined();
  });
});

/** Agents wearing these palettes, each the first of its character. */
const wearing = (...palettes: number[]) => palettes.map((palette) => ({ palette }));

describe('pickRandomPalette', () => {
  it('never repeats a character in the office while another is free', () => {
    expect(pickRandomPalette(4, wearing(0, 2), () => 0)).toBe(1);
    expect(pickRandomPalette(4, wearing(0, 2), () => 0.99)).toBe(3);
  });

  it('prefers free characters no Directory reserves', () => {
    const reserved = new Set([1, 2]);
    expect(pickRandomPalette(4, wearing(3), () => 0, reserved)).toBe(0);
    expect(pickRandomPalette(4, wearing(3), () => 0.99, reserved)).toBe(0);
  });

  it("takes a reserved one when every free character is some Directory's", () => {
    expect(pickRandomPalette(4, wearing(0, 3), () => 0.99, new Set([1, 2]))).toBe(2);
  });

  it('repeats only when the whole cast is in the office', () => {
    expect(pickRandomPalette(3, wearing(0, 1, 2), () => 0.5)).toBe(1);
  });
});

describe('repeatFor', () => {
  it('is 0 when no one wears the character as drawn', () => {
    expect(repeatFor(1, [])).toBe(0);
    expect(repeatFor(1, [{ palette: 1, repeat: 1 }])).toBe(0);
  });

  it('counts up for each further copy', () => {
    const worn: { palette: number; repeat: number }[] = [];
    const repeats: number[] = [];
    for (let i = 0; i < 4; i++) {
      const repeat = repeatFor(1, worn);
      repeats.push(repeat);
      worn.push({ palette: 1, repeat });
    }
    expect(repeats).toEqual([0, 1, 2, 3]);
  });

  it("takes the lowest one a copy that left freed, and ignores other characters' repeats", () => {
    const worn = [
      { palette: 1, repeat: 0 },
      { palette: 1, repeat: 2 },
      { palette: 2, repeat: 1 },
    ];
    expect(repeatFor(1, worn)).toBe(1);
  });
});

describe('rosterPick', () => {
  it('takes an integer naming a character in the cast', () => {
    expect(rosterPick(0, 3)).toBe(0);
    expect(rosterPick(2, 3)).toBe(2);
  });

  it('drops anything else off the wire', () => {
    for (const raw of [undefined, null, '1', 1.5, -1, 3, Number.NaN, Infinity]) {
      expect(rosterPick(raw, 3)).toBeUndefined();
    }
  });
});

describe('chooseLook', () => {
  const directory = { characters: [3, 1], characterOrder: 'priority' as const };

  it('wears a roster pick even when it is taken, as its next repeat', () => {
    expect(chooseLook({ paletteCount: 6, worn: wearing(4), picked: 4, directory })).toEqual({
      palette: 4,
      repeat: 1,
    });
  });

  it("ignores a pick outside the cast, then takes the Directory's first free default", () => {
    expect(chooseLook({ paletteCount: 6, worn: wearing(3), picked: 9, directory })).toEqual({
      palette: 1,
      repeat: 0,
    });
  });

  it('falls back to a random free character when every default is worn', () => {
    const look = chooseLook({
      paletteCount: 6,
      worn: wearing(1, 3),
      directory,
      random: () => 0,
    });
    expect(look).toEqual({ palette: 0, repeat: 0 });
  });

  it('a full cast repeats at random, as the next copy', () => {
    const look = chooseLook({ paletteCount: 2, worn: wearing(0, 1), random: () => 0.99 });
    expect(look).toEqual({ palette: 1, repeat: 1 });
  });
});
