/**
 * Camera controls as pure math: Fit (the zoom + pan that shows the whole
 * office), keyboard panning (arrow keys / WASD) and the drag-to-pan threshold.
 * The DOM adapters — OfficeCanvas, useKeyboardPan, useCameraFit — read the
 * environment and feed these; nothing here touches `window`.
 *
 * Pan is in device pixels, the renderer's own frame: pan (0, 0) centers the
 * map in the canvas, +x moves the map right (see projection.mapOffset).
 */

import { ZOOM_QUANTUM, ZOOM_STEP_RATIO } from '../constants.js';
import { TILE_SIZE, TileType } from './types.js';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CameraFit {
  zoom: number;
  panX: number;
  panY: number;
}

/** A rectangle of the tile grid: top-left tile and size, in tiles. */
export interface TileRect {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/**
 * The part of the grid that has an office in it: the bounding box of every
 * non-VOID tile. Layouts carry VOID margins (the default one is 22 rows with
 * only 11 built), and fitting those would zoom out to frame empty space. When
 * the top built row has walls, the box gains the row above it — wall faces and
 * wall-hung furniture rise a tile above their tile. An all-VOID grid is
 * returned whole.
 */
export function contentBounds(layout: {
  cols: number;
  rows: number;
  tiles: readonly number[];
}): TileRect {
  const { cols, rows, tiles } = layout;
  let minCol = cols;
  let minRow = rows;
  let maxCol = -1;
  let maxRow = -1;
  for (let i = 0; i < Math.min(tiles.length, cols * rows); i++) {
    if (tiles[i] === TileType.VOID) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }
  if (maxCol < 0) return { col: 0, row: 0, cols, rows };
  const topRow = tiles.slice(minRow * cols + minCol, minRow * cols + maxCol + 1);
  if (minRow > 0 && topRow.includes(TileType.WALL)) minRow -= 1;
  return { col: minCol, row: minRow, cols: maxCol - minCol + 1, rows: maxRow - minRow + 1 };
}

/**
 * The largest integer zoom in [zoomMin, zoomMax] at which the office's built
 * part (`bounds`, default the whole cols×rows grid) fits the viewport minus
 * `margins`, and the pan that centers it in that remaining space. Integer
 * because the renderer is pixel-perfect: zoom is device pixels per sprite
 * pixel and the sprite cache is keyed by it. Where the margins would leave
 * nothing (a tiny viewport) they're ignored on that axis rather than forcing
 * the minimum zoom. All sizes in device pixels.
 */
export function fitCamera(
  cols: number,
  rows: number,
  viewport: { width: number; height: number },
  margins: Margins,
  zoomMin: number,
  zoomMax: number,
  bounds: TileRect = { col: 0, row: 0, cols, rows },
): CameraFit {
  const boxW = Math.max(1, bounds.cols) * TILE_SIZE;
  const boxH = Math.max(1, bounds.rows) * TILE_SIZE;
  const axis = (size: number, before: number, after: number) => {
    const room = size - before - after;
    return room > 0 ? { room, pan: (before - after) / 2 } : { room: size, pan: 0 };
  };
  const x = axis(viewport.width, margins.left, margins.right);
  const y = axis(viewport.height, margins.top, margins.bottom);
  const fits = Math.floor(Math.min(x.room / boxW, y.room / boxH));
  const zoom = Math.max(zoomMin, Math.min(zoomMax, fits));
  // The renderer centers the whole grid; shift so the box's center sits at
  // the center of the room the margins leave instead.
  const offX = ((cols - bounds.cols) / 2 - bounds.col) * TILE_SIZE * zoom;
  const offY = ((rows - bounds.rows) / 2 - bounds.row) * TILE_SIZE * zoom;
  return {
    zoom,
    panX: Math.round(offX + x.pan) || 0,
    panY: Math.round(offY + y.pan) || 0,
  };
}

/**
 * The pan that keeps the same office point at the center of the view across
 * a zoom change — the zoom buttons, Ctrl+wheel and pinch zoom about the
 * middle of the screen instead of sliding the office off it. (Pan is device
 * px from the centered grid, and the world point at the center is
 * gridCenter − pan / zoom, so pan scales with zoom.)
 */
export function scalePan(
  pan: { x: number; y: number },
  fromZoom: number,
  toZoom: number,
): { x: number; y: number } {
  if (fromZoom <= 0) return pan;
  return { x: (pan.x * toZoom) / fromZoom, y: (pan.y * toZoom) / fromZoom };
}

/** A unit step in the direction the VIEW moves (right = +x, down = +y). */
export interface PanDirection {
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
}

const ARROW_KEYS: Record<string, PanDirection> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
};

const LETTER_KEYS: Record<string, PanDirection> = {
  a: { dx: -1, dy: 0 },
  d: { dx: 1, dy: 0 },
  w: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
};

/**
 * The pan direction a key stands for, or null. Arrows always; WASD only when
 * `letters` (off in the layout editor, where letters are tool shortcuts).
 * Case-insensitive, so Shift or Caps Lock doesn't strand a held key.
 */
export function keyPanDirection(key: string, letters: boolean): PanDirection | null {
  const arrow = ARROW_KEYS[key];
  if (arrow) return arrow;
  if (!letters || key.length !== 1) return null;
  return LETTER_KEYS[key.toLowerCase()] ?? null;
}

/** The structural slice of an Element that `isEditableTarget` reads. */
export interface FocusTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** Whether keystrokes into `el` are typing — an input, textarea (xterm's own
 *  input is one), select, or contenteditable — and so never pan the office. */
export function isEditableTarget(el: FocusTargetLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface KeyPanStep {
  /** Pan delta to apply this frame (device px, pan space: +x moves the map right). */
  panDX: number;
  panDY: number;
  /** Press glide still to come after this frame. */
  glideX: number;
  glideY: number;
}

/** Below this much glide (device px) the ease-out snaps to rest. */
const GLIDE_REST_PX = 0.5;

/**
 * One frame of keyboard panning. Two sources add up: the glide (each press
 * queues a fixed step, which eases out exponentially at `glideRate`/s) and the
 * held keys (`heldX`/`heldY`: view direction, −1/0/1 per axis), which drift at
 * `holdSpeed` device px/s for as long as they stay down. A tap therefore moves
 * a few tiles and stops smoothly; holding keeps going.
 */
export function stepKeyPan(input: {
  glideX: number;
  glideY: number;
  heldX: number;
  heldY: number;
  dt: number;
  glideRate: number;
  holdSpeed: number;
}): KeyPanStep {
  const { dt, glideRate, holdSpeed } = input;
  const share = 1 - Math.exp(-glideRate * dt);
  const ease = (glide: number) => {
    const move = Math.abs(glide) <= GLIDE_REST_PX ? glide : glide * share;
    return { move, rest: glide - move };
  };
  const gx = ease(input.glideX);
  const gy = ease(input.glideY);
  // Held keys move the VIEW; the map (pan) goes the other way.
  return {
    panDX: gx.move - input.heldX * holdSpeed * dt,
    panDY: gy.move - input.heldY * holdSpeed * dt,
    glideX: gx.rest,
    glideY: gy.rest,
  };
}

/** The glide one key press queues, in pan space (device px). */
export function keyPanImpulse(dir: PanDirection, stepPx: number): { x: number; y: number } {
  // `|| 0`: no -0 for the still axis.
  return { x: -dir.dx * stepPx || 0, y: -dir.dy * stepPx || 0 };
}

/** Whether a left-button press that has moved (dx, dy) CSS px is now a drag. */
export function pastDragThreshold(dx: number, dy: number, threshold: number): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/**
 * The zoom one step in (`dir` 1) or out (-1) from `zoom`: about
 * ZOOM_STEP_RATIO, snapped to a multiple of ZOOM_QUANTUM and always at least
 * one quantum, clamped to [min, max].
 */
export function stepZoom(zoom: number, dir: 1 | -1, min: number, max: number): number {
  const snap = (z: number) => Math.round(z / ZOOM_QUANTUM) * ZOOM_QUANTUM;
  const from = snap(zoom);
  let to = snap(dir > 0 ? from * ZOOM_STEP_RATIO : from / ZOOM_STEP_RATIO);
  if (to === from) to = from + dir * ZOOM_QUANTUM;
  return Math.max(min, Math.min(max, to));
}
