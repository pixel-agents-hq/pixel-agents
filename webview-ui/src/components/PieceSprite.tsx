import { useEffect, useRef } from 'react';

import { MUGSHOT_CROP_SIDE_PX, MUGSHOT_RENDER_ZOOM } from '../constants.js';
import {
  getCatalogEntry,
  getFrontType,
  getStateVariant,
} from '../office/layout/furnitureCatalog.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import type { SpriteData } from '../office/types.js';

/** The rows and columns a sprite draws pixels in, or null for an empty one. */
function opaqueBox(sprite: SpriteData): { x: number; y: number; w: number; h: number } | null {
  let top = -1;
  let bottom = -1;
  let left = Infinity;
  let right = -1;
  sprite.forEach((row, y) =>
    row.forEach((pixel, x) => {
      if (!pixel) return;
      if (top < 0) top = y;
      bottom = y;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }),
  );
  return top < 0 ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

/**
 * A piece of furniture's sprite in a card's mug-shot square (the same size as
 * an agent's mug shot): the furniture facing the viewer, whichever way the
 * piece is turned in the office; the drawn part of its sprite, centred, whole sprite
 * pixels at MUGSHOT_RENDER_ZOOM, hanging from the square's top (its top kept
 * when it is taller than the square: a PC shows its screen, not its foot).
 * `state` draws the
 * furniture in that state where it has art for it (a PC with a live shell is
 * on). Blank for a furniture type the catalogue doesn't hold.
 */
export function PieceSprite({ type, state }: { type: string; state?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoom = MUGSHOT_RENDER_ZOOM;
  const side = MUGSHOT_CROP_SIDE_PX * zoom;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    // Always facing the viewer, whichever way the piece stands in the office.
    const front = getFrontType(type);
    const shown = (state && getStateVariant(front, state)) || front;
    const sprite = getCatalogEntry(shown)?.sprite;
    const box = sprite ? opaqueBox(sprite) : null;
    if (!sprite || !box) return;
    const w = Math.min(box.w, MUGSHOT_CROP_SIDE_PX);
    const h = Math.min(box.h, MUGSHOT_CROP_SIDE_PX);
    const sx = box.x + Math.floor((box.w - w) / 2);
    const sy = box.y;
    const dx = Math.floor((MUGSHOT_CROP_SIDE_PX - w) / 2);
    const dy = 0;
    ctx.drawImage(
      getCachedSprite(sprite, zoom),
      sx * zoom,
      sy * zoom,
      w * zoom,
      h * zoom,
      dx * zoom,
      dy * zoom,
      w * zoom,
      h * zoom,
    );
  }, [type, state, side, zoom]);

  return (
    <canvas
      ref={canvasRef}
      width={side}
      height={side}
      className="shrink-0"
      style={{ width: side, height: side, imageRendering: 'pixelated' }}
    />
  );
}
