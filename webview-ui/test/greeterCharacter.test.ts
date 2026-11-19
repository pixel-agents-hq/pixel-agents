/**
 * The Intro greeter's character is found by the profile's permanent id, so
 * renaming or moving the character keeps the same greeter.
 */

import { describe, expect, it } from 'vitest';

import { GREETER_CHARACTER_ID } from '../../core/src/characterProfiles.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { greeterPalette } from '../src/characters/profiles.js';

describe('greeterPalette', () => {
  it("is the default cast's Byte", () => {
    const index = greeterPalette(DEFAULT_CHARACTER_PROFILES);
    expect(DEFAULT_CHARACTER_PROFILES[index].id).toBe(GREETER_CHARACTER_ID);
    expect(DEFAULT_CHARACTER_PROFILES[index].name).toBe('Byte');
  });

  it('survives a rename', () => {
    const cast = DEFAULT_CHARACTER_PROFILES.map((p) =>
      p.id === GREETER_CHARACTER_ID ? { ...p, name: 'Boss' } : p,
    );
    expect(cast[greeterPalette(cast)].id).toBe(GREETER_CHARACTER_ID);
  });

  it('follows the character when the cast is reordered', () => {
    const [byte, ...rest] = DEFAULT_CHARACTER_PROFILES;
    const cast = [...rest.slice(0, 2), byte, ...rest.slice(2)];
    expect(greeterPalette(cast)).toBe(2);
  });

  it('another character named Byte is not the greeter; without it, the first is', () => {
    const cast = DEFAULT_CHARACTER_PROFILES.slice(1).map((p, i) =>
      i === 2 ? { ...p, name: 'Byte' } : p,
    );
    expect(greeterPalette(cast)).toBe(0);
  });
});
