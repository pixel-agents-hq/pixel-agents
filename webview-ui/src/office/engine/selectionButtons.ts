import { ICONS } from '../../components/ui/pixelIcons.js';
import { devicePixelsPerArtPixel } from '../../components/ui/pixelSnap.js';
import {
  SELECTION_BUTTON_GAP_PX,
  SELECTION_BUTTON_ICON_SCALE,
  SELECTION_BUTTON_PADDING_PX,
  SELECTION_BUTTON_SHADOW_PX,
} from '../../constants.js';
import type { SelectionButton } from '../editor/editorState.js';
import { TILE_SIZE } from '../types.js';

/**
 * The selected furniture item's two buttons (rotate, delete): their geometry,
 * where they go, and which one a point hits. DOM-free; the renderer draws them
 * from `placeSelectionButtons` (renderer.ts `renderSelectionButtons`), and the
 * hit test lives here so it agrees with the bounds that drawing reports.
 */

export interface ButtonBounds {
  /** Center X in device pixels */
  cx: number;
  /** Center Y in device pixels */
  cy: number;
  /** Half its side in device pixels (the buttons are square) */
  half: number;
}

export type DeleteButtonBounds = ButtonBounds;
export type RotateButtonBounds = ButtonBounds;

/** Slack (device px) around a button that still counts as a hit. */
const HIT_SLACK_PX = 2;

/** The buttons' geometry in device pixels (the same for every icon: all 8×8). */
export function buttonGeometry(dpr: number) {
  const unit = devicePixelsPerArtPixel(SELECTION_BUTTON_ICON_SCALE, dpr);
  const pad = Math.round(SELECTION_BUTTON_PADDING_PX * dpr);
  return {
    unit,
    pad,
    size: ICONS.close.length * unit + pad * 2,
    shadow: Math.max(1, Math.round(SELECTION_BUTTON_SHADOW_PX * dpr)),
    gap: Math.round(SELECTION_BUTTON_GAP_PX * dpr),
  };
}

export type ButtonGeometry = ReturnType<typeof buttonGeometry>;

/** Where the buttons go for an item's footprint (tiles) on screen. */
export interface ButtonPlacement {
  col: number;
  row: number;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
  zoom: number;
  rotatable: boolean;
}

/**
 * The selected item's buttons' top-left corners, in a row just above it
 * (never over it), flush with its right edge: rotate (when it rotates), then
 * delete. An item at the top of the screen gets them just below it instead,
 * and the row is kept inside the canvas's left edge. Unrounded: drawing
 * rounds them to whole device pixels.
 */
export function placeSelectionButtons(
  { col, row, w, h, offsetX, offsetY, zoom, rotatable }: ButtonPlacement,
  { size, gap }: ButtonGeometry,
): { delete: { x: number; y: number }; rotate: { x: number; y: number } | null } {
  const s = TILE_SIZE * zoom;
  const above = offsetY + row * s - gap - size;
  const y = above >= gap ? above : offsetY + (row + h) * s + gap;
  const right = Math.max(offsetX + (col + w) * s, (rotatable ? size * 2 + gap : size) + gap);
  return {
    delete: { x: right - size, y },
    rotate: rotatable ? { x: right - size * 2 - gap, y } : null,
  };
}

/** A button drawn with its top-left at (x, y) rests here (whole device pixels). */
export function restingBounds(x: number, y: number, { size }: ButtonGeometry): ButtonBounds {
  x = Math.round(x);
  y = Math.round(y);
  return { cx: x + size / 2, cy: y + size / 2, half: size / 2 };
}

function hits(bounds: ButtonBounds | null, x: number, y: number): boolean {
  if (!bounds) return false;
  const reach = bounds.half + HIT_SLACK_PX;
  return Math.abs(x - bounds.cx) <= reach && Math.abs(y - bounds.cy) <= reach;
}

/** Which button is under these device-pixel coords (rotate checked first),
 *  given the bounds the last frame drew them at. */
export function selectionButtonAt(
  bounds: { delete: ButtonBounds | null; rotate: ButtonBounds | null },
  x: number,
  y: number,
): SelectionButton | null {
  if (hits(bounds.rotate, x, y)) return 'rotate';
  if (hits(bounds.delete, x, y)) return 'delete';
  return null;
}
