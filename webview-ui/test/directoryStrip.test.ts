import { describe, expect, it } from 'vitest';

import { directoryStrip } from '../src/components/directoryStrip.js';

describe('directoryStrip', () => {
  it('shows nothing without defaults', () => {
    expect(directoryStrip(undefined, undefined, 6)).toEqual({ shown: [], all: [] });
  });

  it('priority: the first three, in order', () => {
    expect(directoryStrip([4, 1, 2], 'priority', 6)).toEqual({
      shown: [4, 1, 2],
      all: [4, 1, 2],
    });
  });

  it('shows a fourth rather than a silhouette standing in for just one', () => {
    expect(directoryStrip([4, 1, 2, 0], undefined, 6)).toEqual({
      shown: [4, 1, 2, 0],
      all: [4, 1, 2, 0],
    });
  });

  it('adds the silhouette from five on', () => {
    expect(directoryStrip([4, 1, 2, 0, 5], undefined, 6)).toEqual({
      shown: [4, 1, 2],
      all: [4, 1, 2, 0, 5],
    });
  });

  it('random: three of the defaults, any of them', () => {
    // A random() of 0 rotates the list: [4, 1, 2, 0, 5] → [1, 2, 0, 5, 4].
    const { shown, all } = directoryStrip([4, 1, 2, 0, 5], 'random', 6, () => 0);
    expect(shown).toEqual(all.slice(0, 3));
    expect(shown.length).toBeLessThan(all.length);
    // The silhouette's full list keeps the shown ones first, the rest after.
    expect([...all].sort()).toEqual([0, 1, 2, 4, 5]);
  });

  it('leaves out deleted characters, and counts only the rest', () => {
    expect(directoryStrip([9, 1, 8, 2, 3], 'priority', 6)).toEqual({
      shown: [1, 2, 3],
      all: [1, 2, 3],
    });
  });
});
