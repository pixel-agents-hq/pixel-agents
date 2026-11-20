import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { COLORIZE_CACHE_LIMIT } from '../src/constants.js';
import { clearColorizeCache, getColorizedSprite } from '../src/office/colorize.js';
import type { SpriteData } from '../src/office/types.js';

/** One transparent pixel: the cache is under test, not the colour maths. */
const SPRITE: SpriteData = [['']];
const COLOR = { h: 10, s: 50, b: 0, c: 0 };

beforeEach(() => clearColorizeCache());

test('a cached sprite is returned as the same object', () => {
  const a = getColorizedSprite('k', SPRITE, COLOR);
  assert.equal(getColorizedSprite('k', SPRITE, COLOR), a);
});

test('the cache evicts its oldest entry once past the limit', () => {
  const first = getColorizedSprite('key-0', SPRITE, COLOR);
  for (let i = 1; i <= COLORIZE_CACHE_LIMIT; i++) {
    getColorizedSprite(`key-${i}`, SPRITE, COLOR);
  }
  const newest = getColorizedSprite(`key-${COLORIZE_CACHE_LIMIT}`, SPRITE, COLOR);
  // The newest is still cached; the oldest was dropped and is recomputed.
  assert.equal(getColorizedSprite(`key-${COLORIZE_CACHE_LIMIT}`, SPRITE, COLOR), newest);
  assert.notEqual(getColorizedSprite('key-0', SPRITE, COLOR), first);
});
