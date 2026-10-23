/**
 * Clawd sprites (office/sprites/clawdSprites.ts, agentSprites.ts): the
 * generated sheet (scripts/generate-clawd-sprites.mjs) in the chibi sheets'
 * format and frame meanings, the accessory overlay's placement per direction
 * and frame, blinking, tints, and who gets which art (NPCs stay chibis).
 *
 * Run with: npm test
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_LOOK_DEFAULT,
  ANSH_NPC_ID,
  CHARACTER_SITTING_OFFSET_PX,
  CLAWD_BODY_COLOR,
  CLAWD_EYE_COLOR,
  CLAWD_TINTS,
  CONFETTI_COLORS,
  GREETER_ID,
  MANAGER_NPC_ID,
} from '../src/constants.js';
import { CLAWD_ACCESSORIES, clawdIdentity, setAgentLook } from '../src/office/agentLook.js';
import { getCharacterSprite } from '../src/office/engine/characters.js';
import { characterSpritesFor } from '../src/office/sprites/agentSprites.js';
import { getAnshSprites } from '../src/office/sprites/anshSprites.js';
import sheetJson from '../src/office/sprites/clawd-sheet.json';
import type { SheetDirection } from '../src/office/sprites/clawdSprites.js';
import {
  accessoryFor,
  accessoryPixels,
  blinkFrame,
  bodyTopRow,
  CLAWD_DIRECTIONS,
  CLAWD_FRAME_H,
  CLAWD_FRAME_W,
  CLAWD_FRAMES_PER_ROW,
  decodeClawdSheet,
  eyePixels,
  getClawdSprites,
  glassesPixels,
} from '../src/office/sprites/clawdSprites.js';
import { getCharacterSprites, setCharacterTemplates } from '../src/office/sprites/spriteData.js';
import type { Character, SpriteData } from '../src/office/types.js';
import { CharacterState, Direction } from '../src/office/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sheet = decodeClawdSheet();

/** Last row with any pixel (the feet). */
const bottomRow = (f: SpriteData) => {
  for (let y = f.length - 1; y >= 0; y--) if (f[y].some((p) => p !== '')) return y;
  return -1;
};
const colsOf = (f: SpriteData) => {
  let l = 99;
  let r = -1;
  f.forEach((row) =>
    row.forEach((p, x) => {
      if (p !== '') {
        l = Math.min(l, x);
        r = Math.max(r, x);
      }
    }),
  );
  return { l, r };
};
/** Pixels of one row, as a string (. = empty, o = anything). */
const rowMask = (f: SpriteData, y: number) => f[y].map((p) => (p === '' ? '.' : 'o')).join('');

describe('the generated sheet', () => {
  it('is the chibi format: 3 direction rows × 7 frames of 16×32 (112×96)', () => {
    expect(sheetJson.rows).toHaveLength(96);
    for (const row of sheetJson.rows) expect(row).toHaveLength(112);
    for (const dir of CLAWD_DIRECTIONS) {
      expect(sheet[dir]).toHaveLength(CLAWD_FRAMES_PER_ROW);
      for (const f of sheet[dir]) {
        expect(f).toHaveLength(CLAWD_FRAME_H);
        for (const row of f) expect(row).toHaveLength(CLAWD_FRAME_W);
      }
    }
  });

  it('has a PNG that matches the bundled JSON pixel for pixel', () => {
    const png = PNG.sync.read(
      fs.readFileSync(path.join(root, 'public', 'assets', 'clawd', 'clawd_0.png')),
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

  it('uses the palette constants (Claude orange, unique eye colour)', () => {
    const palette = sheetJson.palette as Record<string, string>;
    expect(palette.o).toBe(CLAWD_BODY_COLOR);
    expect(palette.e).toBe(CLAWD_EYE_COLOR);
    expect(Object.values(palette).filter((c) => c === CLAWD_EYE_COLOR)).toHaveLength(1);
  });

  it('stands on the chibi baseline: feet on row 30 standing, 31 seated; 12-14 px wide', () => {
    for (const dir of CLAWD_DIRECTIONS) {
      for (const f of [0, 1, 2]) expect(bottomRow(sheet[dir][f])).toBe(30);
      const { l, r } = colsOf(sheet[dir][1]);
      expect(r - l + 1).toBeGreaterThanOrEqual(10);
      expect(r - l + 1).toBeLessThanOrEqual(14);
    }
    for (const f of [3, 4, 5, 6]) {
      expect(bottomRow(sheet.down[f])).toBe(31);
      expect(bottomRow(sheet.right[f])).toBe(31);
      // Seated facing away, the chair back covers it below row 25 (as the chibis).
      expect(bottomRow(sheet.up[f])).toBe(25);
    }
    // Shorter than a person: the body starts in the lower half of the frame.
    for (const dir of CLAWD_DIRECTIONS)
      expect(bodyTopRow(sheet[dir][1])).toBeGreaterThanOrEqual(16);
  });

  it('walks: the legs alternate between frames 0 and 2, frame 1 stands', () => {
    for (const dir of CLAWD_DIRECTIONS) {
      const [a, stand, b] = sheet[dir];
      expect(rowMask(a, 30)).not.toBe(rowMask(b, 30)); // a different pair reaches the floor
      expect(bodyTopRow(a)).toBe(bodyTopRow(stand) - 1); // and the body bobs up a px
      expect(bodyTopRow(b)).toBe(bodyTopRow(stand) - 1);
    }
  });

  it('types: little arms tap (frames 3 and 4 differ only around the arms)', () => {
    for (const dir of ['down', 'right'] as const) {
      const [t0, t1] = [sheet[dir][3], sheet[dir][4]];
      expect(t0).not.toEqual(t1);
      // The arms reach past the body's sides.
      const body = colsOf(sheet[dir][1]);
      const typing = colsOf(t0);
      expect(typing.r).toBeGreaterThan(body.r);
    }
  });

  it('reads: the eyes look down a row, and scan between the two frames', () => {
    const eyeTop = (f: SpriteData) => Math.min(...eyePixels(f).map((p) => p.y)) - bodyTopRow(f);
    const eyeLeft = (f: SpriteData) => Math.min(...eyePixels(f).map((p) => p.x));
    for (const dir of ['down', 'right'] as const) {
      expect(eyeTop(sheet[dir][5])).toBe(eyeTop(sheet[dir][3]) + 1);
      expect(eyeTop(sheet[dir][6])).toBe(eyeTop(sheet[dir][3]) + 1);
      expect(eyeLeft(sheet[dir][5])).not.toBe(eyeLeft(sheet[dir][6]));
    }
  });

  it('has two square eyes from the front, one from the side, none from behind', () => {
    for (let f = 0; f < CLAWD_FRAMES_PER_ROW; f++) {
      expect(eyePixels(sheet.down[f])).toHaveLength(8);
      expect(eyePixels(sheet.right[f])).toHaveLength(4);
      expect(eyePixels(sheet.up[f])).toHaveLength(0);
    }
  });
});

describe('the accessory overlay', () => {
  const kinds = CLAWD_ACCESSORIES.filter((k) => k !== 'glasses');

  it('sits on top of the body, in every direction', () => {
    for (const kind of kinds) {
      for (const dir of CLAWD_DIRECTIONS) {
        const px = accessoryPixels(kind, dir, 20);
        if (kind === 'bow' || kind === 'antenna' || kind === 'cap' || kind === 'beanie') {
          // Hats, the bow and the antenna rise above the body's top row.
          expect(Math.min(...px.map((p) => p.y))).toBeLessThan(20);
        }
        for (const p of px) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThan(CLAWD_FRAME_W);
        }
      }
    }
  });

  it('follows the body: the walk bob and the sitting pose move it with the body top', () => {
    for (const kind of kinds) {
      for (const dir of CLAWD_DIRECTIONS) {
        for (let f = 0; f < CLAWD_FRAMES_PER_ROW; f++) {
          const frame = sheet[dir][f];
          const top = bodyTopRow(frame);
          const px = accessoryFor(kind, dir, frame);
          const shifted = accessoryPixels(kind, dir, top);
          expect(px).toEqual(shifted);
          // Every pixel keeps the same offset from the body top across frames.
          const ref = accessoryPixels(kind, dir, 0);
          expect(px.map((p) => p.y - top)).toEqual(ref.map((p) => p.y));
        }
      }
    }
    // Mid-stride the body (and so the cap) is a px higher than standing.
    const capY = (f: number) =>
      Math.min(...accessoryFor('cap', 'down', sheet.down[f]).map((p) => p.y));
    expect(capY(0)).toBe(capY(1) - 1);
    // Seated it is lower than standing.
    expect(capY(3)).toBeGreaterThan(capY(1));
  });

  it('turns with the direction: the cap brim points the way it faces', () => {
    const brim = (dir: SheetDirection) =>
      accessoryPixels('cap', dir, 20).filter((p) => p.y === 20 + 1);
    expect(Math.max(...brim('right').map((p) => p.x))).toBeGreaterThan(13); // sticks out front
    expect(accessoryPixels('cap', 'up', 20).some((p) => p.y === 21)).toBe(false); // no brim from behind
  });

  it('draws the bow on opposite sides from the front and from behind', () => {
    const meanX = (dir: SheetDirection) => {
      const px = accessoryPixels('bow', dir, 20);
      return px.reduce((s, p) => s + p.x, 0) / px.length;
    };
    expect(meanX('down')).toBeGreaterThan(8);
    expect(meanX('up')).toBeLessThan(8);
  });

  it('puts glasses around the eyes, two lenses with a gap, none from behind', () => {
    const front = accessoryFor('glasses', 'down', sheet.down[1]);
    const eyes = eyePixels(sheet.down[1]);
    expect(front.length).toBeGreaterThan(0);
    // No lens pixel covers an eye.
    const eyeKeys = new Set(eyes.map((p) => `${p.x},${p.y}`));
    expect(front.some((p) => eyeKeys.has(`${p.x},${p.y}`))).toBe(false);
    // Reading: the lenses follow the eyes down.
    const readTop = Math.min(...accessoryFor('glasses', 'down', sheet.down[5]).map((p) => p.y));
    const typeTop = Math.min(...accessoryFor('glasses', 'down', sheet.down[3]).map((p) => p.y));
    expect(readTop).toBe(typeTop + 1);
    expect(accessoryFor('glasses', 'up', sheet.up[1])).toEqual([]);
    expect(glassesPixels([])).toEqual([]);
    // From the side: a lens and a temple back along the head.
    const side = accessoryFor('glasses', 'right', sheet.right[1]);
    expect(Math.min(...side.map((p) => p.x))).toBeLessThan(6);
  });

  it('is part of the drawn frame, so outline, matrix and alpha treat it as the body', () => {
    const plain = getClawdSprites(0, null);
    const capped = getClawdSprites(0, 'cap');
    const capTop = bodyTopRow(capped.walk[Direction.DOWN][1]);
    expect(capTop).toBeLessThan(bodyTopRow(plain.walk[Direction.DOWN][1]));
    // Left is right mirrored, accessory included.
    const right = capped.walk[Direction.RIGHT][1];
    const left = capped.walk[Direction.LEFT][1];
    expect(left).toEqual(right.map((row) => [...row].reverse()));
  });
});

describe('tints and blinking', () => {
  it('tints the body per tint, leaving the orange one as drawn', () => {
    const orange = getClawdSprites(0, null).walk[Direction.DOWN][1];
    expect(orange).toEqual(sheet.down[1]);
    const seen = new Set<string>();
    for (let t = 0; t < CLAWD_TINTS.length; t++) {
      const f = getClawdSprites(t, null).walk[Direction.DOWN][1];
      const bodyPx = f[bodyTopRow(f) + 2][7];
      seen.add(bodyPx);
    }
    expect(seen.size).toBe(CLAWD_TINTS.length);
  });

  it('shuts the eyes for a blink and nothing else changes', () => {
    const open = sheet.down[1];
    const shut = blinkFrame(open);
    expect(eyePixels(shut)).toHaveLength(0);
    let changed = 0;
    open.forEach((row, y) => row.forEach((p, x) => p !== shut[y][x] && changed++));
    expect(changed).toBe(8);
    expect(getClawdSprites(0, null, true).walk[Direction.DOWN][1]).toEqual(shut);
  });

  it('caches one set per tint, accessory and blink', () => {
    expect(getClawdSprites(2, 'bow')).toBe(getClawdSprites(2, 'bow'));
    expect(getClawdSprites(2 + CLAWD_TINTS.length, 'bow')).toBe(getClawdSprites(2, 'bow'));
    expect(getClawdSprites(2, 'bow')).not.toBe(getClawdSprites(2, 'cap'));
  });
});

describe('who gets which art', () => {
  beforeAll(() => {
    // Two fake chibi sheets, so the classic path has something to return.
    const chibi = (c: string) => {
      const f: SpriteData = Array.from({ length: 32 }, () => new Array<string>(16).fill(''));
      for (let y = 2; y < 30; y++) for (let x = 3; x < 13; x++) f[y][x] = c;
      return { down: Array(7).fill(f), up: Array(7).fill(f), right: Array(7).fill(f) };
    };
    setCharacterTemplates([chibi(CONFETTI_COLORS[0]), chibi(CONFETTI_COLORS[1])]);
  });
  beforeEach(() => setAgentLook('clawd', null));
  afterEach(() => setAgentLook(AGENT_LOOK_DEFAULT, null));

  const subject = (over: Partial<Character> = {}) => ({
    id: 3,
    palette: 1,
    hueShift: 0,
    isSubagent: false,
    directoryName: 'hobbyfi-blog',
    ...over,
  });

  it('draws agents as Clawds under the Clawd look and as chibis under Classic', () => {
    const ch = subject();
    const id = clawdIdentity(ch);
    expect(characterSpritesFor(ch)).toBe(getClawdSprites(id.tint, id.accessory));
    setAgentLook('classic', null);
    expect(characterSpritesFor(ch)).toBe(getCharacterSprites(1, 0));
  });

  it('keeps the NPCs human whatever the setting', () => {
    expect(characterSpritesFor(subject({ id: ANSH_NPC_ID, palette: 1 }))).toBe(getAnshSprites());
    for (const npc of [
      subject({ id: MANAGER_NPC_ID, palette: 0 }),
      subject({ id: GREETER_ID, isGreeter: true }),
      subject({ id: -7, isReceptionist: true }),
    ]) {
      expect(characterSpritesFor(npc)).toBe(getCharacterSprites(npc.palette, npc.hueShift));
    }
  });

  it('gives a sub-agent its parent tint and no accessory', () => {
    const parent = subject({ id: 9 });
    const sub = subject({ id: -1, isSubagent: true, directoryName: undefined, palette: 0 });
    expect(characterSpritesFor(sub, parent)).toBe(
      getClawdSprites(clawdIdentity(parent).tint, null),
    );
  });

  it('blinks only on the clock, and never from behind', () => {
    const ch = subject();
    const id = clawdIdentity(ch);
    // Find a moment its eyes are shut.
    let shutAt = -1;
    for (let t = 0; t < 5 && shutAt < 0; t += 0.01) {
      if (
        characterSpritesFor(ch, undefined, t, Direction.DOWN) ===
        getClawdSprites(id.tint, id.accessory, true)
      )
        shutAt = t;
    }
    expect(shutAt).toBeGreaterThanOrEqual(0);
    expect(characterSpritesFor(ch, undefined, shutAt, Direction.UP)).toBe(
      getClawdSprites(id.tint, id.accessory),
    );
    expect(characterSpritesFor(ch)).toBe(getClawdSprites(id.tint, id.accessory));
  });

  it('feeds the engine frame logic unchanged (typing, reading, walking frames)', () => {
    const sprites = getClawdSprites(0, null);
    const ch = { state: CharacterState.TYPE, dir: Direction.DOWN, frame: 1, currentTool: 'Edit' };
    expect(getCharacterSprite(ch as Character, sprites)).toBe(sprites.typing[Direction.DOWN][1]);
    const walking = { ...ch, state: CharacterState.WALK, frame: 3 };
    expect(getCharacterSprite(walking as Character, sprites)).toBe(sprites.walk[Direction.DOWN][3]);
    // The sitting offset still lands a seated Clawd's feet below the chair seat line.
    expect(
      bottomRow(sprites.typing[Direction.DOWN][0]) + CHARACTER_SITTING_OFFSET_PX,
    ).toBeGreaterThan(31);
  });
});
