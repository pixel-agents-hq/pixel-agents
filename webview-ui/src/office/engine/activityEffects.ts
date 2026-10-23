import {
  ACTIVITY_EFFECT_COLORS,
  ACTIVITY_EFFECT_OPACITY,
  ACTIVITY_GROUND_ALPHA,
  ACTIVITY_PANEL_BG,
  ACTIVITY_SHADOW_COLOR,
} from '../../constants.js';
import type { Character } from '../types.js';
import { CharacterState, Direction } from '../types.js';
import { activityPhase, completionProgress, getCharacterActivity } from './activityEffectState.js';
import { isOfficeEffectsEnabled } from './activityPreferences.js';

export { characterPoseOffset } from './activityEffectState.js';
export {
  areOfficeEffectsAnimated,
  isOfficeEffectsEnabled,
  setOfficeEffectsEnabled,
} from './activityPreferences.js';

/** Floor pass, below furniture: stepped pixel shadows and screen light pools. */
export function renderActivityGroundEffects(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  x: number,
  y: number,
  zoom: number,
  animate: boolean,
): void {
  if (!isOfficeEffectsEnabled() || ch.matrixEffect || ch.isGreeter) return;
  const px = (dx: number, dy: number, w: number, h: number) =>
    ctx.fillRect(Math.round(x + dx * zoom), Math.round(y + dy * zoom), w * zoom, h * zoom);
  ctx.save();
  ctx.fillStyle = ACTIVITY_SHADOW_COLOR;
  px(-5, -1, 10, 2);
  px(-3, -2, 6, 4);

  if (animate && ch.state === CharacterState.TYPE && ch.isActive && !ch.bubbleType) {
    const activity = getCharacterActivity(ch);
    ctx.fillStyle = ACTIVITY_EFFECT_COLORS[activity];
    ctx.globalAlpha = ACTIVITY_GROUND_ALPHA;
    const dx = ch.dir === Direction.LEFT ? -9 : ch.dir === Direction.RIGHT ? 9 : 0;
    const dy = ch.dir === Direction.UP ? -11 : ch.dir === Direction.DOWN ? 4 : -4;
    px(dx - 6, dy - 2, 12, 4);
    px(dx - 4, dy - 3, 8, 6);
  }

  if (animate && ch.state === CharacterState.WALK) {
    const phase = activityPhase(ch, 0.52);
    const behindX = ch.dir === Direction.LEFT ? 1 : ch.dir === Direction.RIGHT ? -1 : 0;
    const behindY = ch.dir === Direction.UP ? 1 : ch.dir === Direction.DOWN ? -1 : 0;
    ctx.globalAlpha = (1 - phase) * 0.28;
    ctx.fillStyle = ACTIVITY_EFFECT_COLORS.walking;
    px(behindX * (3 + Math.floor(phase * 5)) - 3, behindY * 4, 1, 1);
    px(behindX * (5 + Math.floor(phase * 5)) + 2, behindY * 6 - 1, 1, 1);
  }
  ctx.restore();
}

/** Small hand-level pixel effects, z-sorted with the original character.
 * All particles are deterministic functions of time: no emitters, timers,
 * per-frame randomness, gradients, filters, or particle allocations. */
export function renderCharacterActivityEffects(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  x: number,
  y: number,
  zoom: number,
  animate: boolean,
): void {
  if (!isOfficeEffectsEnabled() || !animate || ch.matrixEffect || ch.isGreeter) return;
  const activity = getCharacterActivity(ch);
  const color = ACTIVITY_EFFECT_COLORS[activity];
  const phase = activityPhase(ch, 1.8);
  const px = (dx: number, dy: number, w = 1, h = 1) =>
    ctx.fillRect(Math.round(x + dx * zoom), Math.round(y + dy * zoom), w * zoom, h * zoom);
  ctx.save();
  const effectAlpha = ctx.globalAlpha * ACTIVITY_EFFECT_OPACITY;
  ctx.globalAlpha = effectAlpha;
  ctx.fillStyle = color;

  const completion = completionProgress(ch);
  if (completion !== null) {
    ctx.globalAlpha *= 1 - completion;
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const radius = 4 + completion * 10;
      const dx = Math.round(Math.cos(angle) * radius);
      const dy = Math.round(Math.sin(angle) * radius - 14 - completion * 5);
      px(dx, dy, 1, i % 2 === 0 ? 2 : 1);
    }
    ctx.restore();
    return;
  }

  if (activity === 'permission' || activity === 'waiting') {
    // Persistent, subdued invitation. The authoritative speech bubble stays
    // in ToolOverlay; this never fabricates a checkmark or another status.
    ctx.globalAlpha *= 0.5;
    const offset = Math.floor(phase * 3);
    for (let i = 0; i < 3; i++) px(10, -11 - i * 3, 1, i === offset ? 2 : 1);
  } else if (activity === 'thinking') {
    const cursor = Math.floor(phase * 3);
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = effectAlpha * (i === cursor ? 0.8 : 0.22);
      px(9 + i * 2, -14 - (i === cursor ? 1 : 0));
    }
  } else if (activity === 'reading') {
    // A little document, line scan, and occasional page turn.
    ctx.fillStyle = ACTIVITY_PANEL_BG;
    px(9, -16, 7, 9);
    ctx.fillStyle = color;
    px(10, -15, 4, 1);
    px(10, -12, 3, 1);
    px(10, -9, 4, 1);
    ctx.globalAlpha *= 0.5;
    px(8, -15 + Math.floor(phase * 7), 9, 1);
    if (phase > 0.82) px(14, -17, 2, 3);
  } else if (activity === 'typing') {
    ctx.fillStyle = ACTIVITY_PANEL_BG;
    px(9, -15, 10, 8);
    ctx.fillStyle = color;
    px(10, -14, 2, 1);
    px(13, -14, 4, 1);
    px(10, -12, 3, 1);
    px(14, -12, 2 + Math.floor(phase * 3), 1);
    px(10, -10, 2 + Math.floor(phase * 5), 1);
    if (phase < 0.55) px(13 + Math.floor(phase * 5), -9, 1, 1);
  } else if (activity === 'executing') {
    // Terminal chevron plus data packets; distinct from writing and reading.
    ctx.fillStyle = ACTIVITY_PANEL_BG;
    px(9, -15, 10, 8);
    ctx.fillStyle = color;
    px(10, -14);
    px(11, -13);
    px(10, -12);
    if (phase < 0.65) px(13, -11, 3, 1);
    const step = Math.floor(phase * 7);
    px(10 + step, -6, 2, 1);
    px(16 - step, -17, 2, 1);
  } else if (activity === 'delegating') {
    // A lead coordinating multiple streams: an animated, branching pixel graph.
    px(9, -11, 2, 2);
    ctx.globalAlpha *= 0.38;
    px(11, -11, 4, 1);
    px(14, -16, 1, 11);
    px(14, -16, 3, 1);
    px(14, -6, 3, 1);
    ctx.globalAlpha = effectAlpha * 0.9;
    px(17, phase < 0.5 ? -17 : -7, 2, 2);
  }
  ctx.restore();
}
