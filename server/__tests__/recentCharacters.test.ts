import { describe, expect, it } from 'vitest';

import { readConfig } from '../src/configPersistence.js';
import { getPaletteCount } from '../src/paletteAssigner.js';
import { markUsed, recentCharactersMessage, recordCharacterUse } from '../src/recentCharacters.js';

// $HOME is a fresh temp dir per test file (isolateHome.setup.ts).

describe('markUsed', () => {
  it('moves the used character to the front', () => {
    expect(markUsed([3, 1, 0], 1)).toEqual([1, 3, 0]);
    expect(markUsed([], 2)).toEqual([2]);
  });
});

describe('recordCharacterUse', () => {
  it('puts each launch first, for every office', () => {
    expect(recordCharacterUse(2)).toEqual({ type: 'recentCharactersLoaded', recent: [2] });
    expect(recordCharacterUse(0)).toEqual({ type: 'recentCharactersLoaded', recent: [0, 2] });
    expect(recordCharacterUse(2)).toEqual({ type: 'recentCharactersLoaded', recent: [2, 0] });
    expect(readConfig().recentCharacters).toEqual([2, 0]);
    expect(recentCharactersMessage()).toEqual({ type: 'recentCharactersLoaded', recent: [2, 0] });
  });

  it('ignores a launch that wore no valid pick', () => {
    const before = readConfig().recentCharacters;
    for (const palette of [undefined, -1, 1.5, 'x', getPaletteCount()]) {
      expect(recordCharacterUse(palette)).toBeNull();
    }
    expect(readConfig().recentCharacters).toEqual(before);
  });
});
