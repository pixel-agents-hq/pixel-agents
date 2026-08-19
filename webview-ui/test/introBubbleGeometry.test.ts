/**
 * Unit tests for the consent bubble's geometry — the pure half IntroBubble
 * renders verbatim. This is the code most likely to be wrong on a narrow
 * VS Code side panel (edge clamping, the tail chasing a clamped bubble, the
 * camera caps), and none of it needs a DOM to verify.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { IntroBubbleFrame } from '../src/components/introBubbleGeometry.js';
import { computeIntroBubbleGeometry } from '../src/components/introBubbleGeometry.js';
import {
  INTRO_BUBBLE_ANCHOR_RISE_WORLD,
  INTRO_BUBBLE_EDGE_MARGIN_PX,
  INTRO_BUBBLE_OFFSET_X_WORLD,
  INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION,
  INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD,
  INTRO_TAIL_STEPS,
  INTRO_TAIL_TARGET_RISE_WORLD,
} from '../src/constants.js';
import { TILE_SIZE } from '../src/office/types.js';

/** A roomy dpr-1, zoom-2, un-panned frame: a 20×11 map centered in an 800×600
 *  container, greeter mid-map, bubble already measured. Overridden per test. */
function roomyFrame(overrides: Partial<IntroBubbleFrame> = {}): IntroBubbleFrame {
  return {
    layout: { cols: 20, rows: 11 },
    containerRect: { width: 800, height: 600 },
    zoom: 2,
    pan: { x: 0, y: 0 },
    dpr: 1,
    greeter: { x: 10 * TILE_SIZE, y: 5 * TILE_SIZE },
    bubbleWidth: 300,
    bubbleHeight: 150,
    ...overrides,
  };
}

test('anchors the bubble bottom-left up-right of the head in a roomy container', () => {
  const frame = roomyFrame();
  const g = computeIntroBubbleGeometry(frame);

  // Reproduce the projection by hand for this un-panned, dpr-1 frame.
  const mapW = frame.layout.cols * TILE_SIZE * frame.zoom;
  const mapH = frame.layout.rows * TILE_SIZE * frame.zoom;
  const offsetX = Math.floor((frame.containerRect.width - mapW) / 2);
  const offsetY = Math.floor((frame.containerRect.height - mapH) / 2);
  const anchorX = offsetX + (frame.greeter.x + INTRO_BUBBLE_OFFSET_X_WORLD) * frame.zoom;
  const anchorY = offsetY + (frame.greeter.y - INTRO_BUBBLE_ANCHOR_RISE_WORLD) * frame.zoom;

  assert.equal(g.left, anchorX, 'left edge sits at the world anchor');
  assert.equal(g.top, anchorY - frame.bubbleHeight, 'bottom edge sits at the world anchor');
});

test('clamps the bubble inside a container too small for the preferred spot', () => {
  const g = computeIntroBubbleGeometry(
    roomyFrame({
      containerRect: { width: 320, height: 200 },
      bubbleWidth: 300,
      bubbleHeight: 150,
    }),
  );

  const margin = INTRO_BUBBLE_EDGE_MARGIN_PX;
  assert.ok(g.left >= margin, 'never past the left margin');
  assert.ok(g.left + 300 <= 320 - margin, 'never past the right margin');
  assert.ok(g.top >= margin, 'never past the top margin');
  assert.ok(g.top + 150 <= 200 - margin, 'never past the bottom margin');
});

test('tail squares step from the bubble edge toward the head, shrinking', () => {
  const frame = roomyFrame();
  const g = computeIntroBubbleGeometry(frame);

  assert.equal(g.tailSquares.length, INTRO_TAIL_STEPS.length);

  // The head in wrapper coordinates (the squares' frame of reference).
  const mapW = frame.layout.cols * TILE_SIZE * frame.zoom;
  const mapH = frame.layout.rows * TILE_SIZE * frame.zoom;
  const headX =
    Math.floor((frame.containerRect.width - mapW) / 2) + frame.greeter.x * frame.zoom - g.left;
  const headY =
    Math.floor((frame.containerRect.height - mapH) / 2) +
    (frame.greeter.y - INTRO_TAIL_TARGET_RISE_WORLD) * frame.zoom -
    g.top;

  let prevDist = Infinity;
  let prevSize = Infinity;
  for (const sq of g.tailSquares) {
    const cx = sq.x + sq.size / 2;
    const cy = sq.y + sq.size / 2;
    const dist = Math.hypot(headX - cx, headY - cy);
    assert.ok(dist < prevDist, 'each square is closer to the head than the last');
    assert.ok(sq.size < prevSize, 'each square is smaller than the last');
    prevDist = dist;
    prevSize = sq.size;
  }
});

test('keeps the tail attached when clamping moves the bubble away from the head', () => {
  // Greeter at the far right of the map; the clamp pins the bubble short of
  // its preferred spot, so the tail must bridge the gap from the bubble's
  // nearest EDGE point — not from the stale unclamped anchor.
  const frame = roomyFrame({
    containerRect: { width: 400, height: 300 },
    greeter: { x: 19 * TILE_SIZE, y: 5 * TILE_SIZE },
    bubbleWidth: 300,
    bubbleHeight: 150,
  });
  const g = computeIntroBubbleGeometry(frame);

  // The head in wrapper coordinates.
  const mapW = frame.layout.cols * TILE_SIZE * frame.zoom;
  const mapH = frame.layout.rows * TILE_SIZE * frame.zoom;
  const headX =
    Math.floor((frame.containerRect.width - mapW) / 2) + frame.greeter.x * frame.zoom - g.left;
  const headY =
    Math.floor((frame.containerRect.height - mapH) / 2) +
    (frame.greeter.y - INTRO_TAIL_TARGET_RISE_WORLD) * frame.zoom -
    g.top;

  // Squares sit at fraction t along the root→head segment; de-interpolate the
  // first one to recover the ROOT and pin it to the bubble's own rectangle.
  const first = g.tailSquares[0];
  const t = INTRO_TAIL_STEPS[0].t;
  const cx = first.x + first.size / 2;
  const cy = first.y + first.size / 2;
  const rootX = (cx - headX * t) / (1 - t);
  const rootY = (cy - headY * t) / (1 - t);
  assert.ok(
    rootX >= -1e-6 && rootX <= 300 + 1e-6 && rootY >= -1e-6 && rootY <= 150 + 1e-6,
    `tail root (${rootX.toFixed(1)}, ${rootY.toFixed(1)}) stays on the clamped bubble`,
  );
});

test('unmeasured bubble (first frame): position is computed, tail waits', () => {
  const g = computeIntroBubbleGeometry(roomyFrame({ bubbleWidth: 0, bubbleHeight: 0 }));
  assert.equal(g.tailSquares.length, 0, 'no tail to a box with no size');
  assert.ok(Number.isFinite(g.left) && Number.isFinite(g.top));
});

test('camera target sits up-right of the greeter in a roomy viewport', () => {
  const frame = roomyFrame();
  const g = computeIntroBubbleGeometry(frame);

  assert.ok(g.cameraTarget.x > frame.greeter.x, 'composition center is right of the character');
  // The down-shift is small relative to the bubble rise, so the target stays
  // above the greeter's feet — centering the pair, not the character alone.
  assert.ok(g.cameraTarget.y < frame.greeter.y, 'and above its feet');
});

test('camera x-offset is capped on a narrow viewport', () => {
  const narrow = computeIntroBubbleGeometry(
    roomyFrame({ containerRect: { width: 240, height: 600 } }),
  );
  const cap = (240 / 2) * INTRO_CAMERA_MAX_X_OFFSET_VIEWPORT_FRACTION; // width in world units × fraction
  assert.ok(
    narrow.cameraTarget.x - roomyFrame().greeter.x <= cap + 1e-9,
    'x offset never exceeds the viewport fraction cap',
  );
});

test('camera y-offset always keeps the character in view on a short viewport', () => {
  const frame = roomyFrame({
    containerRect: { width: 800, height: 180 },
    bubbleHeight: 400,
  });
  const g = computeIntroBubbleGeometry(frame);

  // Uncapped, half the (rise + 400px-tall bubble) would center far above the
  // greeter and push it below the bottom edge. The cap guarantees at least
  // INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD of world height under the target.
  const viewportWorldH = (180 * frame.dpr) / frame.zoom;
  const visibleBelowTarget = viewportWorldH / 2 - (frame.greeter.y - g.cameraTarget.y);
  assert.ok(
    visibleBelowTarget >= INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD - 1e-9,
    `character keeps ${INTRO_CAMERA_MIN_CHAR_VISIBLE_WORLD} world px of view below center (got ${visibleBelowTarget.toFixed(1)})`,
  );
});
