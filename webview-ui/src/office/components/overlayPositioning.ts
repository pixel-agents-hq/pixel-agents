import type { RefObject } from 'react';

import { CHARACTER_SITTING_OFFSET_PX, TILE_SIZE } from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import type { Character } from '../types.js';
import { CharacterState } from '../types.js';

/**
 * Precomputed world→screen transform shared by every canvas overlay
 * (ToolOverlay, ProjectLabels). Extracted so the pixel-perfect arithmetic
 * lives in exactly one place: computed once per render, then applied per
 * character via {@link characterToScreen}.
 */
export interface OverlayTransform {
  dpr: number;
  deviceOffsetX: number;
  deviceOffsetY: number;
  zoom: number;
}

/**
 * Compute the device-pixel offset that maps world coordinates onto the canvas,
 * matching the renderer's centering + pan math exactly. `el` is the element that
 * bounds the canvas (the containerRef div).
 */
export function computeOverlayTransform(
  el: HTMLDivElement,
  officeState: OfficeState,
  zoom: number,
  panRef: RefObject<{ x: number; y: number }>,
): OverlayTransform {
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);
  return { dpr, deviceOffsetX, deviceOffsetY, zoom };
}

/**
 * Map a character to CSS-pixel screen coordinates. `worldYOffset` is added (in
 * world px) to the character's y before scaling: pass a negative value to place
 * content above the character (ToolOverlay), a positive value to place it below
 * (ProjectLabels). The character's sitting offset is applied automatically so
 * overlays track the sprite when seated.
 */
export function characterToScreen(
  ch: Character,
  transform: OverlayTransform,
  worldYOffset: number,
): { screenX: number; screenY: number } {
  const { dpr, deviceOffsetX, deviceOffsetY, zoom } = transform;
  const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
  const screenY = (deviceOffsetY + (ch.y + sittingOffset + worldYOffset) * zoom) / dpr;
  return { screenX, screenY };
}
