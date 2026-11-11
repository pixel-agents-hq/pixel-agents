import { useEffect, useRef } from 'react';

import { MUGSHOT_CROP_SIDE_PX, MUGSHOT_RENDER_ZOOM } from '../constants.js';
import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
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
 * an agent's mug shot): the drawn part of the sprite, centred, whole sprite
 * pixels at MUGSHOT_RENDER_ZOOM, its foot kept when it is taller than the
 * square. Blank for a furniture type the catalogue doesn't hold.
 */
export function PieceSprite({ type }: { type: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoom = MUGSHOT_RENDER_ZOOM;
  const side = MUGSHOT_CROP_SIDE_PX * zoom;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    const sprite = getCatalogEntry(type)?.sprite;
    const box = sprite ? opaqueBox(sprite) : null;
    if (!sprite || !box) return;
    const w = Math.min(box.w, MUGSHOT_CROP_SIDE_PX);
    const h = Math.min(box.h, MUGSHOT_CROP_SIDE_PX);
    const sx = box.x + Math.floor((box.w - w) / 2);
    const sy = box.y + box.h - h;
    const dx = Math.floor((MUGSHOT_CROP_SIDE_PX - w) / 2);
    const dy = Math.floor((MUGSHOT_CROP_SIDE_PX - h) / 2);
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
  }, [type, side, zoom]);

  return (
    <canvas
      ref={canvasRef}
      width={side}
      height={side}
      style={{ width: side, height: side, imageRendering: 'pixelated' }}
    />
  );
}
