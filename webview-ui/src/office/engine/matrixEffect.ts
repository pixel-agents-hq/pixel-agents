import {
  MATRIX_COLUMN_STAGGER_RANGE,
  MATRIX_FLICKER_FPS,
  MATRIX_FLICKER_VISIBILITY_THRESHOLD,
  MATRIX_HEAD_COLOR,
  MATRIX_SPRITE_COLS,
  MATRIX_SPRITE_ROWS,
  MATRIX_TRAIL_DIM_THRESHOLD,
  MATRIX_TRAIL_EMPTY_ALPHA,
  MATRIX_TRAIL_LENGTH,
  MATRIX_TRAIL_MID_THRESHOLD,
  MATRIX_TRAIL_OVERLAY_ALPHA,
  matrixGreenBright,
  matrixGreenDim,
  matrixGreenMid,
} from '../../constants.js';
import type { Character, SpriteData } from '../types.js';
import { MATRIX_EFFECT_DURATION } from '../types.js';

/** Hash-based flicker: ~70% visible for shimmer effect */
function flickerVisible(col: number, row: number, time: number): boolean {
  const t = Math.floor(time * MATRIX_FLICKER_FPS);
  const hash = (col * 7 + row * 13 + t * 31) & 0xff;
  return hash < MATRIX_FLICKER_VISIBILITY_THRESHOLD;
}

/**
 * Render a character with a Matrix-style digital rain spawn/despawn effect.
 * Per-pixel rendering: each column sweeps top-to-bottom with a bright head and fading green trail.
 */
export function renderMatrixEffect(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  spriteData: SpriteData,
  drawX: number,
  drawY: number,
  zoom: number,
): void {
  if (!ch.matrixEffect) return;
  renderMatrixSprite(ctx, spriteData, drawX, drawY, zoom, {
    kind: ch.matrixEffect,
    timer: ch.matrixEffectTimer,
    seeds: ch.matrixEffectSeeds,
    cols: MATRIX_SPRITE_COLS,
    rows: MATRIX_SPRITE_ROWS,
  });
}

/**
 * The same rain over any sprite (a Buildout's removed furniture, wall or
 * floor tile dissolving): `timer` seconds into a MATRIX_EFFECT_DURATION run,
 * one stagger seed per column (cycled when the sprite is wider), over
 * `cols` × `rows` sprite pixels (the sprite's own size when not given).
 */
export function renderMatrixSprite(
  ctx: CanvasRenderingContext2D,
  spriteData: SpriteData,
  drawX: number,
  drawY: number,
  zoom: number,
  effect: {
    kind: 'spawn' | 'despawn';
    timer: number;
    seeds: readonly number[];
    cols?: number;
    rows?: number;
  },
): void {
  const progress = effect.timer / MATRIX_EFFECT_DURATION;
  const isSpawn = effect.kind === 'spawn';
  const time = effect.timer;
  const spriteRows = effect.rows ?? spriteData.length;
  const spriteCols = effect.cols ?? spriteData[0]?.length ?? 0;
  const seeds = effect.seeds;
  const totalSweep = spriteRows + MATRIX_TRAIL_LENGTH;

  for (let col = 0; col < spriteCols; col++) {
    // Stagger: each column starts at a slightly different time
    const seed = seeds.length > 0 ? seeds[col % seeds.length] : 0;
    const stagger = seed * MATRIX_COLUMN_STAGGER_RANGE;
    const colProgress = Math.max(
      0,
      Math.min(1, (progress - stagger) / (1 - MATRIX_COLUMN_STAGGER_RANGE)),
    );
    const headRow = colProgress * totalSweep;

    for (let row = 0; row < spriteRows; row++) {
      const pixel = spriteData[row]?.[col];
      const hasPixel = pixel && pixel !== '';
      const distFromHead = headRow - row;
      const px = drawX + col * zoom;
      const py = drawY + row * zoom;

      if (isSpawn) {
        // Spawn: head sweeps down revealing character pixels
        if (distFromHead < 0) {
          // Above head: invisible
          continue;
        } else if (distFromHead < 1) {
          // Head pixel: bright white-green
          ctx.fillStyle = MATRIX_HEAD_COLOR;
          ctx.fillRect(px, py, zoom, zoom);
        } else if (distFromHead < MATRIX_TRAIL_LENGTH) {
          // Trail zone: show character pixel with green overlay, or just green if no pixel
          const trailPos = distFromHead / MATRIX_TRAIL_LENGTH;
          if (hasPixel) {
            // Draw original pixel
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
            // Green overlay that fades as trail progresses
            const greenAlpha = (1 - trailPos) * MATRIX_TRAIL_OVERLAY_ALPHA;
            if (flickerVisible(col, row, time)) {
              ctx.fillStyle = matrixGreenBright(greenAlpha);
              ctx.fillRect(px, py, zoom, zoom);
            }
          } else {
            // No character pixel: fading green trail
            if (flickerVisible(col, row, time)) {
              const alpha = (1 - trailPos) * MATRIX_TRAIL_EMPTY_ALPHA;
              ctx.fillStyle =
                trailPos < MATRIX_TRAIL_MID_THRESHOLD
                  ? matrixGreenBright(alpha)
                  : trailPos < MATRIX_TRAIL_DIM_THRESHOLD
                    ? matrixGreenMid(alpha)
                    : matrixGreenDim(alpha);
              ctx.fillRect(px, py, zoom, zoom);
            }
          }
        } else {
          // Below trail: normal character pixel
          if (hasPixel) {
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
          }
        }
      } else {
        // Despawn: head sweeps down consuming character pixels
        if (distFromHead < 0) {
          // Above head: normal character pixel (not yet consumed)
          if (hasPixel) {
            ctx.fillStyle = pixel;
            ctx.fillRect(px, py, zoom, zoom);
          }
        } else if (distFromHead < 1) {
          // Head pixel: bright white-green
          ctx.fillStyle = MATRIX_HEAD_COLOR;
          ctx.fillRect(px, py, zoom, zoom);
        } else if (distFromHead < MATRIX_TRAIL_LENGTH) {
          // Trail zone: fading green
          if (flickerVisible(col, row, time)) {
            const trailPos = distFromHead / MATRIX_TRAIL_LENGTH;
            const alpha = (1 - trailPos) * MATRIX_TRAIL_EMPTY_ALPHA;
            ctx.fillStyle =
              trailPos < MATRIX_TRAIL_MID_THRESHOLD
                ? matrixGreenBright(alpha)
                : trailPos < MATRIX_TRAIL_DIM_THRESHOLD
                  ? matrixGreenMid(alpha)
                  : matrixGreenDim(alpha);
            ctx.fillRect(px, py, zoom, zoom);
          }
        }
        // Below trail: nothing (consumed)
      }
    }
  }
}
