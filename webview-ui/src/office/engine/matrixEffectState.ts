/**
 * The matrix spawn/despawn effect's STATE half: starting one, advancing its
 * timer, and reporting when it finished.
 *
 * Deliberately separate from `matrixEffect.ts`, which draws it: drawing needs
 * a CanvasRenderingContext2D, and OfficeState — a pure state container the
 * Node-runner unit tests import directly — has no business pulling a DOM type
 * into its module graph just to reset three fields.
 */

import { MATRIX_SPRITE_COLS } from '../../constants.js';
import type { Character } from '../types.js';
import { MATRIX_EFFECT_DURATION } from '../types.js';

/** Per-column stagger seeds, one per sprite column. */
export function matrixEffectSeeds(): number[] {
  const seeds: number[] = [];
  for (let i = 0; i < MATRIX_SPRITE_COLS; i++) {
    seeds.push(Math.random());
  }
  return seeds;
}

/** Begin (or restart) a materialization on `ch`. The three fields always move
 *  together — setting the effect without fresh seeds replays the last one's
 *  column timing, and without a zeroed timer it finishes early. */
export function startMatrixEffect(ch: Character, kind: 'spawn' | 'despawn'): void {
  ch.matrixEffect = kind;
  ch.matrixEffectTimer = 0;
  ch.matrixEffectSeeds = matrixEffectSeeds();
}

/** What one frame of `advanceMatrixEffect` did.
 *  - `none`: no effect running; the caller's normal per-frame logic applies.
 *  - `running`: still materializing — skip the FSM this frame.
 *  - `spawned`: finished appearing; the effect is cleared and the FSM resumes
 *    next frame.
 *  - `despawned`: finished disappearing. The effect is left SET so the
 *    character keeps rendering as gone, and removing it is the caller's job. */
export type MatrixEffectTick = 'none' | 'running' | 'spawned' | 'despawned';

export function advanceMatrixEffect(ch: Character, dt: number): MatrixEffectTick {
  if (!ch.matrixEffect) return 'none';
  ch.matrixEffectTimer += dt;
  if (ch.matrixEffectTimer < MATRIX_EFFECT_DURATION) return 'running';
  if (ch.matrixEffect === 'despawn') return 'despawned';
  ch.matrixEffect = null;
  ch.matrixEffectTimer = 0;
  ch.matrixEffectSeeds = [];
  return 'spawned';
}
