/**
 * Canvas drawing for the living office's ambience (the rules are in
 * ambience.ts, namePlates.ts, coffeeRuns.ts and receptionist.ts): the text on
 * a name plate, the night lights, a carried coffee cup and the receptionist's
 * wave. Called by renderer.ts; device px snapped to the sprite-pixel grid.
 */

import {
  CHARACTER_SITTING_OFFSET_PX,
  NAME_PLATE_FACE,
  NAME_PLATE_TEXT_COLOR,
  NIGHT_DIM_ALPHA,
  NIGHT_DIM_COLOR,
  NIGHT_EMPTY_ROOM_DIM_ALPHA,
  RECEPTIONIST_HAND_COLOR,
  RECEPTIONIST_HAND_OUTLINE_COLOR,
} from '../../constants.js';
import { metricsOf } from '../agentLook.js';
import type { Character } from '../types.js';
import { CharacterState, TILE_SIZE } from '../types.js';
import { emptyRoomTiles, occupiedTiles, TimeOfDay, timeOfDay } from './ambience.js';
import { wateringCanPixels } from './anshErrands.js';
import { cupPixels } from './coffeeRuns.js';
import { GLYPH_H, plateText, plateTextFit, plateTextPixels } from './namePlates.js';
import { outlinePixels, waveHandPixels } from './receptionist.js';

/** The repo on a plate whose sprite is drawn at device (fx, fy), centred on its face. */
export function renderPlateText(
  ctx: CanvasRenderingContext2D,
  repo: string,
  fx: number,
  fy: number,
  zoom: number,
): void {
  const { px, maxChars } = plateTextFit(zoom);
  const text = plateText(repo, maxChars);
  if (!text) return;
  const { pixels, width } = plateTextPixels(text);
  const faceX = fx + NAME_PLATE_FACE.x * zoom;
  const faceY = fy + NAME_PLATE_FACE.y * zoom;
  const x0 = faceX + Math.floor((NAME_PLATE_FACE.w * zoom - width * px) / 2);
  const y0 = faceY + Math.floor((NAME_PLATE_FACE.h * zoom - GLYPH_H * px) / 2);
  ctx.fillStyle = NAME_PLATE_TEXT_COLOR;
  for (const p of pixels) ctx.fillRect(x0 + p.x * px, y0 + p.y * px, px, px);
}

/**
 * At night, a gentle wash over everything drawn so far (source-atop: the
 * transparent page around the office stays as it is), and a further one over
 * each room nobody is in. Labels and other UI are DOM, above the canvas.
 */
export function renderNightLights(
  ctx: CanvasRenderingContext2D,
  date: Date,
  characters: readonly Character[],
  areaTiles: ReadonlyArray<string | null> | undefined,
  cols: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  if (timeOfDay(date) !== TimeOfDay.NIGHT) return;
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = NIGHT_DIM_COLOR;
  ctx.globalAlpha = NIGHT_DIM_ALPHA;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  const rooms = emptyRoomTiles(areaTiles, cols, occupiedTiles(characters));
  if (rooms.size > 0) {
    const s = TILE_SIZE * zoom;
    ctx.globalAlpha = NIGHT_EMPTY_ROOM_DIM_ALPHA;
    ctx.beginPath();
    for (const tiles of rooms.values()) {
      for (const t of tiles) ctx.rect(offsetX + t.col * s, offsetY + t.row * s, s, s);
    }
    ctx.fill();
  }
  ctx.restore();
}

/** Sprite px (from the character's feet anchor, seated or not) → device px. */
function fillAt(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  dx: number,
  dy: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const sit = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  ctx.fillRect(
    Math.round(offsetX + (ch.x + dx) * zoom),
    Math.round(offsetY + (ch.y + sit + dy) * zoom),
    zoom,
    zoom,
  );
}

/** A coffee run's cup, in hand on the way back (and for a while at the desk);
 *  at a Clawd's hand when it is one. */
export function renderCoffeeCup(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const p of cupPixels(ch.dir, metricsOf(ch))) {
    ctx.fillStyle = p.color;
    fillAt(ctx, ch, p.dx, p.dy, offsetX, offsetY, zoom);
  }
}

/** Ansh's watering can over a plant, `t` seconds into the watering (anshErrands.ts). */
export function renderWateringCan(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  t: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const p of wateringCanPixels(ch.dir, t, metricsOf(ch))) {
    ctx.fillStyle = p.color;
    fillAt(ctx, ch, p.dx, p.dy, offsetX, offsetY, zoom);
  }
}

/** The receptionist's waving hand (the bob is applied to her sprite). */
export function renderWave(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  frame: 0 | 1,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const bob = frame === 1 ? -1 : 0;
  const arm = waveHandPixels(frame);
  ctx.fillStyle = RECEPTIONIST_HAND_OUTLINE_COLOR;
  for (const p of outlinePixels(arm)) fillAt(ctx, ch, p.dx, p.dy + bob, offsetX, offsetY, zoom);
  ctx.fillStyle = RECEPTIONIST_HAND_COLOR;
  for (const p of arm) fillAt(ctx, ch, p.dx, p.dy + bob, offsetX, offsetY, zoom);
}
