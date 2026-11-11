import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
  MUGSHOT_RENDER_ZOOM,
} from '../constants.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import {
  getCharacterSprites,
  getCharacterTemplatesVersion,
  subscribeCharacterTemplates,
} from '../office/sprites/spriteData.js';
import { Direction } from '../office/types.js';

interface CharacterMugShotProps {
  palette: number;
  repeat: number;
  /** Sprite pixels to CSS pixels, a whole number. Defaults to MUGSHOT_RENDER_ZOOM. */
  zoom?: number;
  /** First sprite row of the crop. Defaults to MUGSHOT_CROP_TOP_ROW. */
  cropTop?: number;
}

/**
 * A square "mug shot" — the head region of an agent's front-facing sprite,
 * scaled up crisply. Used as the terminal tab's identity in place of a label.
 *
 * Reuses the office sprite cache: the full front sprite is rendered once per
 * palette:repeat, and we blit just the head square out of it — again whenever
 * the character sprites are replaced, so a mounted mug shot never goes stale.
 */
export function CharacterMugShot({
  palette,
  repeat,
  zoom = MUGSHOT_RENDER_ZOOM,
  cropTop = MUGSHOT_CROP_TOP_ROW,
}: CharacterMugShotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Redraw when the character sprites change (the cast arrives or is edited).
  const sprites = useSyncExternalStore(subscribeCharacterTemplates, getCharacterTemplatesVersion);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const front = getCharacterSprites(palette, repeat).walk[Direction.DOWN][0];
    const full = getCachedSprite(front, zoom);

    const side = MUGSHOT_CROP_SIDE_PX * zoom;
    canvas.width = side;
    canvas.height = side;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(full, MUGSHOT_CROP_LEFT_COL * zoom, cropTop * zoom, side, side, 0, 0, side, side);
  }, [palette, repeat, zoom, cropTop, sprites]);

  return (
    <canvas
      ref={canvasRef}
      width={MUGSHOT_CROP_SIDE_PX * zoom}
      height={MUGSHOT_CROP_SIDE_PX * zoom}
      style={{
        width: MUGSHOT_CROP_SIDE_PX * zoom,
        height: MUGSHOT_CROP_SIDE_PX * zoom,
        imageRendering: 'pixelated',
      }}
    />
  );
}
