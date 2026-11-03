/**
 * The loading screen's scene (pure): two characters typing at a table of PCs, a third
 * walking circles around it, the cat sitting on it. Laid out on the office's tile grid
 * and layered by the office's own z rules (layoutSerializer, renderer), so it looks like a
 * corner of the office.
 */

import { SHEET_FRAMES } from '../../../core/src/assets/seatedFrame.js';
import type { CharacterDirectionSprites } from '../../../core/src/assets/types.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  LOADING_VIGNETTE_DARKEST,
  PET_IDLE_FRAME_DURATION_SEC,
  PET_IDLE_SEQUENCE,
  TILE_SIZE,
  TYPE_FRAME_DURATION_SEC,
  WALK_FRAME_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
} from '../constants.js';
import type { SpriteData } from '../office/types.js';
import type { LoadingArt } from './loadingSceneArt.js';

export interface SceneCast {
  /** Seated left of the table, facing it. */
  left: CharacterDirectionSprites;
  /** Seated right of the table, facing it. */
  right: CharacterDirectionSprites;
  /** Walking around the table. */
  walker: CharacterDirectionSprites;
}

export interface Drawable {
  sprite: SpriteData;
  /** Top-left, in sprite pixels. */
  x: number;
  y: number;
  zY: number;
  mirrored?: boolean;
  /** A radial fade to transparent: opaque out to `solid` from (x, y), gone by `gone`, and
   *  a vignette darkening it into the screen's colour from `vignetteFrom` out to
   *  `vignetteDarkest` (that colour's share) at
   *  `gone` (sprite pixels, scene coordinates). */
  fade?: {
    x: number;
    y: number;
    solid: number;
    gone: number;
    vignetteFrom: number;
    vignetteDarkest: number;
  };
}

type Facing = 'down' | 'up' | 'right' | 'left';

const HALF = TILE_SIZE / 2;
const center = (tile: number) => tile * TILE_SIZE + HALF;

/** The walker's loop through these tiles' centres, just outside the chairs (the top edge
 *  through the table's back row). */
const RING = { left: 0, top: 1, right: 6, bottom: 6 } as const;
const RING_W = (RING.right - RING.left) * TILE_SIZE;
const RING_H = (RING.bottom - RING.top) * TILE_SIZE;

const TABLE = { col: 2, row: 1 };

/** The floor: solid out to FLOOR_SOLID from the table's centre, faded away by FLOOR_GONE. */
const FLOOR_CENTER = { x: (TABLE.col + 1.5) * TILE_SIZE, y: (TABLE.row + 2.5) * TILE_SIZE };
const FLOOR_SOLID = 4.5 * TILE_SIZE;
const FLOOR_GONE = 5.5 * TILE_SIZE;
/** The vignette: the floor darkens into the screen's colour from around the table outward. */
const VIGNETTE_FROM = 1.5 * TILE_SIZE;

/** What the scene covers, in sprite pixels: the floor's full fade (the ring and the walker's
 *  head sit inside it). */
export const LOADING_VIEW = {
  x: FLOOR_CENTER.x - FLOOR_GONE,
  y: FLOOR_CENTER.y - FLOOR_GONE,
  w: 2 * FLOOR_GONE,
  h: 2 * FLOOR_GONE,
} as const;

const floors = new WeakMap<SpriteData, Drawable>();

/** Under everything that stands. */
const FLOOR_Z = -1;

/** The floor tile repeated over the view, with its radial fade for the painter. Built once
 *  per tile. */
function fadedFloor(tile: SpriteData): Drawable {
  const cached = floors.get(tile);
  if (cached) return cached;
  const size = tile.length;
  const mod = (n: number) => ((n % size) + size) % size;
  const sprite: SpriteData = Array.from({ length: LOADING_VIEW.h }, (_, py) =>
    Array.from(
      { length: LOADING_VIEW.w },
      (_, px) => tile[mod(LOADING_VIEW.y + py)][mod(LOADING_VIEW.x + px)],
    ),
  );
  const floor: Drawable = {
    sprite,
    x: LOADING_VIEW.x,
    y: LOADING_VIEW.y,
    zY: FLOOR_Z,
    fade: {
      ...FLOOR_CENTER,
      solid: FLOOR_SOLID,
      gone: FLOOR_GONE,
      vignetteFrom: VIGNETTE_FROM,
      vignetteDarkest: LOADING_VIGNETTE_DARKEST,
    },
  };
  floors.set(tile, floor);
  return floor;
}

/** The table's z: furniture sorts by its bottom edge. */
const TABLE_Z = TABLE.row * TILE_SIZE + 4 * TILE_SIZE;
/** Things on the table sort just in front of it. */
const ON_TABLE_Z = TABLE_Z + 0.5;

function furniture(sprite: SpriteData, col: number, row: number, zY: number, mirrored = false) {
  return { sprite, x: col * TILE_SIZE, y: row * TILE_SIZE, zY, mirrored };
}

/** A non-back chair sorts at its first row's bottom; a back chair just past its footprint. */
const chairZ = (row: number) => (row + 1) * TILE_SIZE;
const backChairZ = (row: number) => (row + 1) * TILE_SIZE + 1;

/** A character standing (or sitting) on a tile centre, anchored bottom-centre like the office,
 *  sorted at its tile's bottom edge (`zY` overrides). */
function character(
  sprites: CharacterDirectionSprites,
  facing: Facing,
  frame: number,
  cx: number,
  cy: number,
  seated: boolean,
  zY = cy + HALF + CHARACTER_Z_SORT_OFFSET,
): Drawable {
  const sprite = sprites[facing === 'left' ? 'right' : facing][frame];
  return {
    sprite,
    x: cx - sprite[0].length / 2,
    y: cy + (seated ? CHARACTER_SITTING_OFFSET_PX : 0) - sprite.length,
    zY,
    mirrored: facing === 'left',
  };
}

/** Where the walker is `distance` pixels along its clockwise loop, and which way it faces. */
export function walkerAt(distance: number): { x: number; y: number; facing: Facing } {
  const loop = 2 * (RING_W + RING_H);
  let d = ((distance % loop) + loop) % loop;
  const [x0, y0] = [center(RING.left), center(RING.top)];
  const [x1, y1] = [center(RING.right), center(RING.bottom)];
  if (d < RING_W) return { x: x0 + d, y: y0, facing: 'right' };
  d -= RING_W;
  if (d < RING_H) return { x: x1, y: y0 + d, facing: 'down' };
  d -= RING_H;
  if (d < RING_W) return { x: x1 - d, y: y1, facing: 'left' };
  d -= RING_W;
  return { x: x0, y: y1 - d, facing: 'up' };
}

/** The frame showing at `timeSec` (which may be a hair below 0: a first animation frame's
 *  timestamp can predate the start). */
function cycle<T>(frames: readonly T[], timeSec: number, frameSec: number): T {
  const n = frames.length;
  return frames[((Math.floor(timeSec / frameSec) % n) + n) % n];
}

/** Everything to draw at `timeSec`, back to front. */
export function loadingSceneAt(timeSec: number, art: LoadingArt, cast: SceneCast): Drawable[] {
  // the two typists out of step, so they don't type in unison
  const leftType = cycle(SHEET_FRAMES.type, timeSec, TYPE_FRAME_DURATION_SEC);
  const rightType = cycle(
    SHEET_FRAMES.type,
    timeSec + TYPE_FRAME_DURATION_SEC / 2,
    TYPE_FRAME_DURATION_SEC,
  );
  const walk = walkerAt(timeSec * WALK_SPEED_PX_PER_SEC);
  const catFrame = cycle(PET_IDLE_SEQUENCE, timeSec, PET_IDLE_FRAME_DURATION_SEC);
  const cat = art.catSitting[catFrame];
  // the table's free front corner, beside the front PC
  const catTile = { col: 4, row: 4 };

  const drawables: Drawable[] = [
    fadedFloor(art.floor),
    furniture(art.table, TABLE.col, TABLE.row, TABLE_Z),
    furniture(art.pcBack, 3, 1, ON_TABLE_Z),
    furniture(art.pcSide, 2, 2, ON_TABLE_Z),
    furniture(art.pcSide, 4, 2, ON_TABLE_Z, true),
    furniture(art.pcFront, 3, 3, ON_TABLE_Z),
    furniture(art.chairFront, 3, 1, chairZ(1)),
    furniture(art.chairSide, 1, 3, chairZ(3)),
    furniture(art.chairSide, 5, 3, chairZ(3), true),
    furniture(art.chairBack, 3, 5, backChairZ(5)),
    character(cast.left, 'right', leftType, center(1), center(3), true),
    character(cast.right, 'left', rightType, center(5), center(3), true),
    character(
      cast.walker,
      walk.facing,
      cycle(SHEET_FRAMES.walk, timeSec, WALK_FRAME_DURATION_SEC),
      walk.x,
      walk.y,
      false,
      // by its feet: on the top edge it walks behind the chair and PC in the table's back row
      walk.y + CHARACTER_Z_SORT_OFFSET,
    ),
    {
      sprite: cat,
      x: center(catTile.col) - cat[0].length / 2,
      y: center(catTile.row) - cat.length,
      // on the table, in front of the PCs
      zY: ON_TABLE_Z + 0.5,
    },
  ];
  // stable: equal z keeps the order above (the PCs after the table)
  return drawables.sort((a, b) => a.zY - b.zY);
}
