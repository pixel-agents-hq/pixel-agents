/**
 * Ansh's sprites (office/sprites/anshSprites.ts): the generated sheet
 * (scripts/generate-ansh-sprites.mjs) in the chibi sheets' format, on their
 * baselines, and drawn for Ansh whatever the Agent Look says.
 *
 * Run with: npm test
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_LOOK_DEFAULT,
  ANSH_NPC_ID,
  GREETER_ID,
  MANAGER_NPC_ID,
  RECEPTIONIST_ID,
} from '../src/constants.js';
import { setAgentLook } from '../src/office/agentLook.js';
import { characterSpritesFor } from '../src/office/sprites/agentSprites.js';
import sheetJson from '../src/office/sprites/ansh-sheet.json';
import { getAnshSprites } from '../src/office/sprites/anshSprites.js';
import { decodeClawdSheet } from '../src/office/sprites/clawdSprites.js';
import type { SpriteData } from '../src/office/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sheet = decodeClawdSheet(sheetJson);

const topRow = (f: SpriteData) => f.findIndex((row) => row.some((p) => p !== ''));
const bottomRow = (f: SpriteData) => {
  for (let y = f.length - 1; y >= 0; y--) if (f[y].some((p) => p !== '')) return y;
  return -1;
};

afterEach(() => setAgentLook(AGENT_LOOK_DEFAULT, null));

describe("Ansh's sheet", () => {
  it('is the chibi format: 3 direction rows × 7 frames of 16×32 (112×96)', () => {
    expect(sheetJson.rows).toHaveLength(96);
    for (const row of sheetJson.rows) expect(row).toHaveLength(112);
    for (const dir of ['down', 'up', 'right'] as const) {
      expect(sheet[dir]).toHaveLength(7);
      for (const f of sheet[dir]) expect(f).toHaveLength(32);
    }
  });

  it('has a PNG that matches the bundled JSON pixel for pixel', () => {
    const png = PNG.sync.read(
      fs.readFileSync(path.join(root, 'public', 'assets', 'ansh', 'ansh_0.png')),
    );
    expect([png.width, png.height]).toEqual([112, 96]);
    const palette = sheetJson.palette as Record<string, string>;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 112; x++) {
        const i = (y * 112 + x) * 4;
        const key = sheetJson.rows[y][x];
        if (key === '.') {
          expect(png.data[i + 3]).toBe(0);
        } else {
          const hex = `#${[0, 1, 2].map((k) => png.data[i + k].toString(16).padStart(2, '0')).join('')}`;
          expect(hex.toUpperCase()).toBe(palette[key]);
        }
      }
    }
  });

  it('stands on the chibi baselines: feet on row 30 standing, 31 seated, 25 seated facing away', () => {
    for (const dir of ['down', 'up', 'right'] as const) {
      for (const f of [0, 1, 2]) expect(bottomRow(sheet[dir][f])).toBe(30);
      // A full-height person, not a chibi: head near the top of the frame.
      expect(topRow(sheet[dir][1])).toBeLessThanOrEqual(2);
    }
    for (const f of [3, 4, 5, 6]) {
      expect(bottomRow(sheet.down[f])).toBe(31);
      expect(bottomRow(sheet.right[f])).toBe(31);
      expect(bottomRow(sheet.up[f])).toBe(25);
    }
  });

  it('animates: the walk strides and the typing hands move', () => {
    const same = (a: SpriteData, b: SpriteData) => JSON.stringify(a) === JSON.stringify(b);
    for (const dir of ['down', 'up', 'right'] as const) {
      expect(same(sheet[dir][0], sheet[dir][1])).toBe(false);
      expect(same(sheet[dir][0], sheet[dir][2])).toBe(false);
      expect(same(sheet[dir][3], sheet[dir][4])).toBe(false);
    }
    expect(same(sheet.down[5], sheet.down[6])).toBe(false);
  });

  it('is what Ansh is drawn with, under either look', () => {
    const ansh = { id: ANSH_NPC_ID, palette: 1, hueShift: 0, isSubagent: false };
    expect(characterSpritesFor(ansh)).toBe(getAnshSprites());
    setAgentLook('clawd', null);
    expect(characterSpritesFor(ansh)).toBe(getAnshSprites());
  });

  it('is drawn for Ansh alone: every reserved NPC id is distinct', () => {
    const ids = [GREETER_ID, ANSH_NPC_ID, MANAGER_NPC_ID, RECEPTIONIST_ID];
    expect(new Set(ids).size).toBe(ids.length);
    const receptionist = {
      id: RECEPTIONIST_ID,
      palette: 1,
      hueShift: 0,
      isSubagent: false,
      isReceptionist: true,
    };
    expect(characterSpritesFor(receptionist)).not.toBe(getAnshSprites());
  });
});
