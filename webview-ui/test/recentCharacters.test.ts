import { describe, expect, it } from 'vitest';

import { rosterOrder } from '../src/characters/recent.js';

describe('rosterOrder', () => {
  it('is cast order when nothing was used', () => {
    expect(rosterOrder(4, [])).toEqual([0, 1, 2, 3]);
  });

  it('puts the used characters first, most recent first, then the rest in cast order', () => {
    expect(rosterOrder(5, [3, 1])).toEqual([3, 1, 0, 2, 4]);
  });

  it('drops indices past the end of the cast and duplicates', () => {
    expect(rosterOrder(3, [7, 2, 2, 0])).toEqual([2, 0, 1]);
  });
});
