/* eslint-disable pixel-agents/no-inline-colors -- sprite pixel fixtures, like src/office/sprites */
import { describe, expect, it } from 'vitest';

import {
  buildClothesColorMap,
  recolorClothes,
  resolveSessionColor,
} from '../src/office/sprites/sessionColor.js';
import type { SpriteData } from '../src/office/types.js';

const SKIN = '#E9A384';
const HAIR = '#8F6439';
const SHIRT = '#114978';
const SHIRT_DARK = '#071C2E';
const PANTS = '#202020';

// 16x32 frame: hair rows 0-7, face 8-14 with skin, shirt 15-23 with a hand
// (skin) at the side, pants 24-31
function frame(): SpriteData {
  const rows: SpriteData = [];
  for (let y = 0; y < 32; y++) {
    const row = new Array<string>(16).fill('');
    for (let x = 4; x < 12; x++) {
      if (y < 8) row[x] = HAIR;
      else if (y < 15) row[x] = SKIN;
      else if (y < 24) row[x] = x === 4 ? SKIN : x === 11 ? SHIRT_DARK : SHIRT;
      else row[x] = PANTS;
    }
    rows.push(row);
  }
  return rows;
}

describe('resolveSessionColor', () => {
  it('knows the /color names and ignores others', () => {
    expect(resolveSessionColor('red')).not.toBeNull();
    expect(resolveSessionColor('Blue')).not.toBeNull();
    expect(resolveSessionColor('default')).toBeNull();
    expect(resolveSessionColor(undefined)).toBeNull();
  });
});

describe('clothes recolor', () => {
  it('recolors only the shirt, keeping skin, hair and pants', () => {
    const f = frame();
    const map = buildClothesColorMap([f], [], resolveSessionColor('red')!);
    const out = recolorClothes(f, map);

    expect(out[3][6]).toBe(HAIR);
    expect(out[10][6]).toBe(SKIN);
    expect(out[18][4]).toBe(SKIN);
    expect(out[28][6]).toBe(PANTS);

    const shirt = out[18][6];
    expect(shirt).not.toBe(SHIRT);
    // red: R channel dominates
    const r = parseInt(shirt.slice(1, 3), 16);
    const g = parseInt(shirt.slice(3, 5), 16);
    const b = parseInt(shirt.slice(5, 7), 16);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('keeps the shading order of the shirt', () => {
    const f = frame();
    const map = buildClothesColorMap([f], [], resolveSessionColor('blue')!);
    const light = map.get(SHIRT.toLowerCase())!;
    const dark = map.get(SHIRT_DARK.toLowerCase())!;
    const sum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(sum(light)).toBeGreaterThan(sum(dark));
  });
});
