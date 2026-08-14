/**
 * The consent bubble's geometry, as one pure function of the measurable frame:
 * greeter position, container size, zoom, pan, and the bubble's own measured
 * box. IntroBubble calls it every frame and renders the result verbatim.
 *
 * Split out of the component because this is the half most likely to be wrong
 * on a narrow VS Code side panel — edge clamping, the tail chasing a clamped
 * bubble, the camera caps — and none of it needs a DOM to verify. `dpr` is a
 * parameter for the same reason.
 */

import {
  CHARACTER_HIT_HALF_WIDTH,
  INTRO_BUBBLE_ANCHOR_RISE_WORLD,
  INTRO_BUBBLE_EDGE_MARGIN_PX,
  INTRO_BUBBLE_OFFSET_X_WORLD,
  INTRO_CAMERA_DOWN_SHIFT_PX,
  INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION,
  INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD,
  INTRO_TAIL_STEPS,
  INTRO_TAIL_TARGET_RISE_WORLD,
} from '../constants.js';
import { overlayProjection } from '../office/projection.js';

export interface IntroBubbleFrame {
  layout: { cols: number; rows: number };
  containerRect: { width: number; height: number };
  zoom: number;
  pan: { x: number; y: number };
  dpr: number;
  /** Greeter anchor (feet), world coords. */
  greeter: { x: number; y: number };
  /** The bubble's measured box in CSS px (0×0 until the first layout pass). */
  bubbleWidth: number;
  bubbleHeight: number;
}

export interface IntroBubbleGeometry {
  /** Bubble top-left in container CSS px, clamped inside the container. */
  left: number;
  top: number;
  /** Speech-tail squares in BUBBLE-WRAPPER coordinates, stepping from the
   *  bubble's nearest edge point toward the greeter's head and shrinking as
   *  they go. Empty until the bubble has a measured size to step from. */
  tailSquares: Array<{ x: number; y: number; size: number }>;
  /** World-space point for the camera: the character+bubble composition
   *  center, capped so a small viewport cannot shove the greeter off-screen,
   *  shifted down so the pair lands a bit above dead center. */
  cameraTarget: { x: number; y: number };
}

export function computeIntroBubbleGeometry(frame: IntroBubbleFrame): IntroBubbleGeometry {
  const { greeter, containerRect, bubbleWidth, bubbleHeight } = frame;
  const project = overlayProjection(frame.layout, containerRect, frame.zoom, frame.pan, frame.dpr);
  const margin = INTRO_BUBBLE_EDGE_MARGIN_PX;

  // Anchor the bubble's bottom-left up-right of the greeter's head, clamped
  // into the container.
  const anchorX = project.toScreenX(greeter.x + INTRO_BUBBLE_OFFSET_X_WORLD);
  const anchorY = project.toScreenY(greeter.y - INTRO_BUBBLE_ANCHOR_RISE_WORLD);
  const left = Math.max(margin, Math.min(anchorX, containerRect.width - bubbleWidth - margin));
  const top = Math.max(
    margin,
    Math.min(anchorY - bubbleHeight, containerRect.height - bubbleHeight - margin),
  );

  // Head point (container CSS px) and its closest point on the bubble's
  // rectangle — squares step along that segment, shrinking toward the head.
  // Recomputed from the live geometry every frame, so the tail keeps pointing
  // at the head even when edge-clamping or a manual pan moves the bubble away
  // from its preferred spot above the character.
  let tailSquares: IntroBubbleGeometry['tailSquares'] = [];
  if (bubbleWidth > 0 && bubbleHeight > 0) {
    const headX = project.toScreenX(greeter.x);
    const headY = project.toScreenY(greeter.y - INTRO_TAIL_TARGET_RISE_WORLD);
    const edgeX = Math.max(left, Math.min(headX, left + bubbleWidth));
    const edgeY = Math.max(top, Math.min(headY, top + bubbleHeight));
    tailSquares = INTRO_TAIL_STEPS.map(({ t, size }) => ({
      x: edgeX + (headX - edgeX) * t - left - size / 2,
      y: edgeY + (headY - edgeY) * t - top - size / 2,
      size,
    }));
  }

  // Camera: center the character+bubble composition, with both offsets CAPPED
  // against the viewport. The ideal composition assumes the bubble fits
  // up-right of the character; when a small viewport clamps the bubble to the
  // screen instead, the uncapped center would shove the greeter to the edge.
  const bubbleWorldW = project.toWorldLength(bubbleWidth);
  const bubbleWorldH = project.toWorldLength(bubbleHeight);
  const offX = Math.min(
    (INTRO_BUBBLE_OFFSET_X_WORLD + bubbleWorldW - CHARACTER_HIT_HALF_WIDTH) / 2,
    project.viewportWorldWidth * INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION,
  );
  const offY = Math.min(
    (INTRO_BUBBLE_ANCHOR_RISE_WORLD + bubbleWorldH) / 2,
    project.viewportWorldHeight / 2 - INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD,
  );
  // Aim BELOW the composition center: the camera moves down, so the character
  // + bubble land a bit above the vertical center of the view.
  const downShift = project.toWorldLength(INTRO_CAMERA_DOWN_SHIFT_PX);
  const cameraTarget = {
    x: greeter.x + offX,
    y: greeter.y - Math.max(0, offY) + downShift,
  };

  return { left, top, tailSquares, cameraTarget };
}
