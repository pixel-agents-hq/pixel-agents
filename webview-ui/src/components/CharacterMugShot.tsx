import { useEffect, useRef } from 'react';

import {
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_DISPLAY_PX,
  MUGSHOT_RENDER_ZOOM,
} from '../constants.js';
import { useAgentLookVersion } from '../hooks/useAgentLook.js';
import { lookMetrics, lookOf } from '../office/agentLook.js';
import { characterSpritesFor } from '../office/sprites/agentSprites.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { Direction } from '../office/types.js';
import type { AgentAppearance } from './AgentCard.js';

interface CharacterMugShotProps {
  appearance: AgentAppearance;
  /** On-screen side length in CSS px. Defaults to MUGSHOT_DISPLAY_PX. */
  size?: number;
}

/**
 * A square "mug shot" — the head region of an agent's front-facing sprite,
 * scaled up crisply. Used as the terminal tab's identity in place of a label.
 *
 * Reuses the office sprite cache: the full front sprite (a Clawd in its repo's
 * tint and accessory, or the chibi) is rendered once per look, and we blit
 * just the head square out of it — cropped lower for a Clawd, which lives in
 * the bottom half of its frame.
 */
export function CharacterMugShot({ appearance, size = MUGSHOT_DISPLAY_PX }: CharacterMugShotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Redraw when the look flips or this Clawd's tint/accessory is handed out.
  const lookVersion = useAgentLookVersion();
  const { id, palette, hueShift, directoryName, isTeamLead } = appearance;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const subject = { id, palette, hueShift, directoryName, isTeamLead, isSubagent: false };
    const front = characterSpritesFor(subject).walk[Direction.DOWN][0];
    const full = getCachedSprite(front, MUGSHOT_RENDER_ZOOM);
    const cropTop = lookMetrics(lookOf(subject)).mugshotCropTop;

    const side = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM;
    canvas.width = side;
    canvas.height = side;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(
      full,
      MUGSHOT_CROP_LEFT_COL * MUGSHOT_RENDER_ZOOM,
      cropTop * MUGSHOT_RENDER_ZOOM,
      side,
      side,
      0,
      0,
      side,
      side,
    );
  }, [id, palette, hueShift, directoryName, isTeamLead, lookVersion]);

  return (
    <canvas
      ref={canvasRef}
      width={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      height={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}
