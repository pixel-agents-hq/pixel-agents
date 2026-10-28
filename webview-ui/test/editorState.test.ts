/**
 * Unit tests for the placement-colour rule in EditorState: what the Furniture
 * Copy tool lifts off a placed item — a colour or its absence — styles that
 * copy over the palette colour, until the palette sliders are touched again.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ColorValue } from '../src/components/ui/types.js';
import { EditorState } from '../src/office/editor/editorState.js';

const PALETTE: ColorValue = { h: 0, s: 0, b: 0, c: 0, colorize: true };
const COPIED: ColorValue = { h: 200, s: 50, b: 10, c: 0 };

function withPalette(): EditorState {
  const state = new EditorState();
  state.setPaletteColor(PALETTE);
  return state;
}

test('a plain catalog pick takes the palette colour', () => {
  const state = withPalette();
  state.placing = { type: 'PC_FRONT_OFF' };
  assert.deepEqual(state.placementColor(), PALETTE);
});

test('a copied colour wins over the palette colour', () => {
  const state = withPalette();
  state.pickUpCopy({ type: 'PC_FRONT_OFF', color: COPIED });
  assert.deepEqual(state.placementColor(), COPIED);
});

test('a copy of an uncoloured item stays uncoloured under a palette colour', () => {
  const state = withPalette();
  state.pickUpCopy({ type: 'PC_FRONT_OFF' });
  assert.equal(state.placementColor(), null);
});

test('rotating or toggling the copy keeps its copied absence of colour', () => {
  const state = withPalette();
  state.pickUpCopy({ type: 'PC_FRONT_OFF' });
  state.placing = { ...state.placing!, type: 'PC_SIDE' };
  assert.equal(state.placementColor(), null);
});

test('touching the palette after a copy hands the colour back to the palette', () => {
  for (const color of [COPIED, undefined]) {
    const state = withPalette();
    state.pickUpCopy({ type: 'PC_FRONT_OFF', color });
    const next: ColorValue = { h: 30, s: 0, b: 0, c: 0, colorize: true };
    state.setPaletteColor(next);
    assert.deepEqual(state.placementColor(), next);
  }
});

test('the copied colour is the copy’s own — editing the source later does not restyle it', () => {
  const state = new EditorState();
  const source = { type: 'PC_FRONT_OFF', color: { ...COPIED } };
  state.pickUpCopy(source);
  source.color.h = 0;
  assert.deepEqual(state.placementColor(), COPIED);
});
