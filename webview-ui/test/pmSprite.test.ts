/**
 * Unit tests for the PM look: a team lead is drawn as char_2 with its shirt
 * recolored to a yellow tee, regardless of the lead's own palette/hue shift.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { PM_BASE_PALETTE, PM_SHIRT_RECOLOR } from '../src/constants.js';
import {
  getCharacterSprites,
  getPmCharacterSprites,
  setCharacterTemplates,
} from '../src/office/sprites/spriteData.js';
import { Direction } from '../src/office/types.js';

// Pixels are opaque strings to the sprite code; only shirt keys need real values.
const SKIN = 'skin';
const SHIRT = Object.keys(PM_SHIRT_RECOLOR)[0];

/** One-pixel-wide fake sheet: every frame is [skin, shirt]. */
function fakeCharacter(shirt: string) {
  const frames = () => Array.from({ length: 7 }, () => [[SKIN, shirt]]);
  return { down: frames(), up: frames(), right: frames() };
}

function loadFakeCharacters(): void {
  setCharacterTemplates(
    Array.from({ length: 6 }, (_, i) =>
      fakeCharacter(i === PM_BASE_PALETTE ? SHIRT : 'other-shirt'),
    ),
  );
}

test('PM sprites recolor only char_2 shirt pixels to yellow', () => {
  loadFakeCharacters();
  const pm = getPmCharacterSprites();
  const yellow = PM_SHIRT_RECOLOR[SHIRT];
  assert.deepEqual(pm.walk[Direction.DOWN][0], [[SKIN, yellow]]);
  assert.deepEqual(pm.typing[Direction.UP][1], [[SKIN, yellow]]);
  // Left frames are the right frames mirrored.
  assert.deepEqual(pm.reading[Direction.LEFT][0], [[yellow, SKIN]]);
});

test('PM sprites leave the base palette untouched', () => {
  loadFakeCharacters();
  getPmCharacterSprites();
  assert.deepEqual(getCharacterSprites(PM_BASE_PALETTE).walk[Direction.DOWN][0], [[SKIN, SHIRT]]);
});
