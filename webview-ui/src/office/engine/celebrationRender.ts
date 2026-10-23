/**
 * Draws the celebration confetti (celebrations.ts) over the scene: each flake
 * a sprite pixel (flipping to 2×1 as it tumbles), snapped to the pixel grid.
 */

import { CONFETTI_COLORS, CONFETTI_FLIP_HZ } from '../../constants.js';
import type { ConfettiBurst } from './celebrations.js';
import { particleAlpha } from './celebrations.js';

export function renderConfetti(
  ctx: CanvasRenderingContext2D,
  bursts: readonly ConfettiBurst[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (bursts.length === 0) return;
  ctx.save();
  for (const burst of bursts) {
    for (const p of burst.particles) {
      const alpha = particleAlpha(p);
      if (alpha <= 0) continue;
      const wide = Math.floor(p.age * CONFETTI_FLIP_HZ + p.phase * 2) % 2 === 0;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = CONFETTI_COLORS[p.color % CONFETTI_COLORS.length];
      ctx.fillRect(
        Math.round(offsetX + Math.round(p.x) * zoom),
        Math.round(offsetY + Math.round(p.y) * zoom),
        (wide ? 2 : 1) * zoom,
        zoom,
      );
    }
  }
  ctx.restore();
}
