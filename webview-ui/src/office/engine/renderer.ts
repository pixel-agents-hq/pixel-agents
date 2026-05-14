import type { ColorValue } from "../../components/ui/types.js";
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  BUTTON_ICON_COLOR,
  BUTTON_ICON_SIZE_FACTOR,
  BUTTON_LINE_WIDTH_MIN,
  BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  BUTTON_MIN_RADIUS,
  BUTTON_RADIUS_ZOOM_FACTOR,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  DELETE_BUTTON_BG,
  FALLBACK_FLOOR_COLOR,
  GHOST_BORDER_HOVER_FILL,
  GHOST_BORDER_HOVER_STROKE,
  GHOST_BORDER_STROKE,
  GHOST_INVALID_TINT,
  GHOST_PREVIEW_SPRITE_ALPHA,
  GHOST_PREVIEW_TINT_ALPHA,
  GHOST_VALID_TINT,
  GRID_LINE_COLOR,
  HOVERED_OUTLINE_ALPHA,
  OUTLINE_Z_SORT_OFFSET,
  ROTATE_BUTTON_BG,
  SEAT_AVAILABLE_COLOR,
  SEAT_BUSY_COLOR,
  SEAT_OWN_COLOR,
  SELECTED_OUTLINE_ALPHA,
  SELECTION_DASH_PATTERN,
  SELECTION_HIGHLIGHT_COLOR,
  VOID_TILE_DASH_PATTERN,
  VOID_TILE_OUTLINE_COLOR,
} from "../../constants.js";
import {
  getColorizedFloorSprite,
  hasFloorSprites,
  WALL_COLOR,
} from "../floorTiles.js";
import { getCachedSprite, getOutlineSprite } from "../sprites/spriteCache.js";
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_WAITING_SPRITE,
  getCharacterSprites,
} from "../sprites/spriteData.js";
import type {
  Character,
  FurnitureInstance,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
} from "../types.js";
import { CharacterState, TILE_SIZE, TileType } from "../types.js";
import {
  getWallInstances,
  hasWallSprites,
  wallColorToHex,
} from "../wallTiles.js";
import { getCharacterSprite } from "./characters.js";
import { renderMatrixEffect } from "./matrixEffect.js";

// ── Render functions ────────────────────────────────────────────

/** @internal */
export function renderTileGrid(
  ctx: CanvasRenderingContext2D,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  tileColors?: Array<ColorValue | null>,
  cols?: number,
): void {
  const s = TILE_SIZE * zoom;
  const useSpriteFloors = hasFloorSprites();
  const tmRows = tileMap.length;
  const tmCols = tmRows > 0 ? tileMap[0].length : 0;
  const layoutCols = cols ?? tmCols;

  // Floor tiles + wall base color
  for (let r = 0; r < tmRows; r++) {
    for (let c = 0; c < tmCols; c++) {
      const tile = tileMap[r][c];

      // Skip VOID tiles entirely (transparent)
      if (tile === TileType.VOID) continue;

      if (tile === TileType.WALL || !useSpriteFloors) {
        // Wall tiles or fallback: solid color
        if (tile === TileType.WALL) {
          const colorIdx = r * layoutCols + c;
          const wallColor = tileColors?.[colorIdx];
          ctx.fillStyle = wallColor ? wallColorToHex(wallColor) : WALL_COLOR;
        } else {
          ctx.fillStyle = FALLBACK_FLOOR_COLOR;
        }
        ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s);
        continue;
      }

      // Floor tile: get colorized sprite
      const colorIdx = r * layoutCols + c;
      const color = tileColors?.[colorIdx] ?? { h: 0, s: 0, b: 0, c: 0 };
      const sprite = getColorizedFloorSprite(tile, color);
      const cached = getCachedSprite(sprite, zoom);
      ctx.drawImage(cached, offsetX + c * s, offsetY + r * s);
    }
  }
}

interface ZDrawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** @internal */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  furniture: FurnitureInstance[],
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  selectedAgentId: number | null,
  hoveredAgentId: number | null,
): void {
  const drawables: ZDrawable[] = [];

  // Furniture
  for (const f of furniture) {
    const cached = getCachedSprite(f.sprite, zoom);
    const fx = offsetX + f.x * zoom;
    const fy = offsetY + f.y * zoom;
    if (f.mirrored) {
      drawables.push({
        zY: f.zY,
        draw: (c) => {
          c.save();
          c.translate(fx + cached.width, fy);
          c.scale(-1, 1);
          c.drawImage(cached, 0, 0);
          c.restore();
        },
      });
    } else {
      drawables.push({
        zY: f.zY,
        draw: (c) => {
          c.drawImage(cached, fx, fy);
        },
      });
    }
  }

  // Characters
  for (const ch of characters) {
    const sprites = getCharacterSprites(ch.palette, ch.hueShift);
    const spriteData = getCharacterSprite(ch, sprites);
    const cached = getCachedSprite(spriteData, zoom);
    // Sitting offset: shift character down when seated so they visually sit in the chair
    const sittingOffset =
      ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2);
    const drawY = Math.round(
      offsetY + (ch.y + sittingOffset) * zoom - cached.height,
    );

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX;
      const mDrawY = drawY;
      const mSpriteData = spriteData;
      const mCh = ch;
      drawables.push({
        zY: charZY,
        draw: (c) => {
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom);
        },
      });
      continue;
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId;
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId;
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected
        ? SELECTED_OUTLINE_ALPHA
        : HOVERED_OUTLINE_ALPHA;
      const outlineData = getOutlineSprite(spriteData);
      const outlineCached = getCachedSprite(outlineData, zoom);
      const olDrawX = drawX - zoom; // 1 sprite-pixel offset, scaled
      const olDrawY = drawY - zoom; // outline follows sitting offset via drawY
      drawables.push({
        zY: charZY - OUTLINE_Z_SORT_OFFSET, // sort just before character
        draw: (c) => {
          c.save();
          c.globalAlpha = outlineAlpha;
          c.drawImage(outlineCached, olDrawX, olDrawY);
          c.restore();
        },
      });
    }

    drawables.push({
      zY: charZY,
      draw: (c) => {
        c.drawImage(cached, drawX, drawY);
      },
    });
  }

  // Sort by Y (lower = in front = drawn later)
  drawables.sort((a, b) => a.zY - b.zY);

  for (const d of drawables) {
    d.draw(ctx);
  }
}

// ── Seat indicators ─────────────────────────────────────────────

function renderSeatIndicators(
  ctx: CanvasRenderingContext2D,
  seats: Map<string, Seat>,
  characters: Map<number, Character>,
  selectedAgentId: number | null,
  hoveredTile: { col: number; row: number } | null,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (selectedAgentId === null || !hoveredTile) return;
  const selectedChar = characters.get(selectedAgentId);
  if (!selectedChar) return;

  // Only show indicator for the hovered seat tile
  for (const [uid, seat] of seats) {
    if (seat.seatCol !== hoveredTile.col || seat.seatRow !== hoveredTile.row)
      continue;

    const s = TILE_SIZE * zoom;
    const x = offsetX + seat.seatCol * s;
    const y = offsetY + seat.seatRow * s;

    if (selectedChar.seatId === uid) {
      // Selected agent's own seat — blue
      ctx.fillStyle = SEAT_OWN_COLOR;
    } else if (!seat.assigned) {
      // Available seat — green
      ctx.fillStyle = SEAT_AVAILABLE_COLOR;
    } else {
      // Busy (assigned to another agent) — red
      ctx.fillStyle = SEAT_BUSY_COLOR;
    }
    ctx.fillRect(x, y, s, s);
    break;
  }
}

// ── Edit mode overlays ──────────────────────────────────────────

/** @internal */
export function renderGridOverlay(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  tileMap?: TileTypeVal[][],
): void {
  const s = TILE_SIZE * zoom;
  ctx.strokeStyle = GRID_LINE_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Vertical lines — offset by 0.5 for crisp 1px lines
  for (let c = 0; c <= cols; c++) {
    const x = offsetX + c * s + 0.5;
    ctx.moveTo(x, offsetY);
    ctx.lineTo(x, offsetY + rows * s);
  }
  // Horizontal lines
  for (let r = 0; r <= rows; r++) {
    const y = offsetY + r * s + 0.5;
    ctx.moveTo(offsetX, y);
    ctx.lineTo(offsetX + cols * s, y);
  }
  ctx.stroke();

  // Draw faint dashed outlines on VOID tiles
  if (tileMap) {
    ctx.save();
    ctx.strokeStyle = VOID_TILE_OUTLINE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash(VOID_TILE_DASH_PATTERN);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (tileMap[r]?.[c] === TileType.VOID) {
          ctx.strokeRect(
            offsetX + c * s + 0.5,
            offsetY + r * s + 0.5,
            s - 1,
            s - 1,
          );
        }
      }
    }
    ctx.restore();
  }
}

/** Draw faint expansion placeholders 1 tile outside grid bounds (ghost border). */
function renderGhostBorder(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  zoom: number,
  cols: number,
  rows: number,
  ghostHoverCol: number,
  ghostHoverRow: number,
): void {
  const s = TILE_SIZE * zoom;
  ctx.save();

  // Collect ghost border tiles: one ring around the grid
  const ghostTiles: Array<{ c: number; r: number }> = [];
  // Top and bottom rows
  for (let c = -1; c <= cols; c++) {
    ghostTiles.push({ c, r: -1 });
    ghostTiles.push({ c, r: rows });
  }
  // Left and right columns (excluding corners already added)
  for (let r = 0; r < rows; r++) {
    ghostTiles.push({ c: -1, r });
    ghostTiles.push({ c: cols, r });
  }

  for (const { c, r } of ghostTiles) {
    const x = offsetX + c * s;
    const y = offsetY + r * s;
    const isHovered = c === ghostHoverCol && r === ghostHoverRow;
    if (isHovered) {
      ctx.fillStyle = GHOST_BORDER_HOVER_FILL;
      ctx.fillRect(x, y, s, s);
    }
    ctx.strokeStyle = isHovered
      ? GHOST_BORDER_HOVER_STROKE
      : GHOST_BORDER_STROKE;
    ctx.lineWidth = 1;
    ctx.setLineDash(VOID_TILE_DASH_PATTERN);
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
  }

  ctx.restore();
}

/** @internal */
export function renderGhostPreview(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteData,
  col: number,
  row: number,
  valid: boolean,
  offsetX: number,
  offsetY: number,
  zoom: number,
  mirrored: boolean = false,
): void {
  const cached = getCachedSprite(sprite, zoom);
  const x = offsetX + col * TILE_SIZE * zoom;
  const y = offsetY + row * TILE_SIZE * zoom;
  ctx.save();
  ctx.globalAlpha = GHOST_PREVIEW_SPRITE_ALPHA;
  if (mirrored) {
    ctx.translate(x + cached.width, y);
    ctx.scale(-1, 1);
    ctx.drawImage(cached, 0, 0);
  } else {
    ctx.drawImage(cached, x, y);
  }
  // Tint overlay — reset transform for correct fill position
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = GHOST_PREVIEW_TINT_ALPHA;
  ctx.fillStyle = valid ? GHOST_VALID_TINT : GHOST_INVALID_TINT;
  ctx.fillRect(x, y, cached.width, cached.height);
  ctx.restore();
}

/** @internal */
export function renderSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const s = TILE_SIZE * zoom;
  const x = offsetX + col * s;
  const y = offsetY + row * s;
  ctx.save();
  ctx.strokeStyle = SELECTION_HIGHLIGHT_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash(SELECTION_DASH_PATTERN);
  ctx.strokeRect(x + 1, y + 1, w * s - 2, h * s - 2);
  ctx.restore();
}

/** @internal */
export function renderDeleteButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): DeleteButtonBounds {
  const s = TILE_SIZE * zoom;
  // Position at top-right corner of selected furniture
  const cx = offsetX + (col + w) * s + 1;
  const cy = offsetY + row * s - 1;
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR);

  // Circle background
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = DELETE_BUTTON_BG;
  ctx.fill();

  // X mark
  ctx.strokeStyle = BUTTON_ICON_COLOR;
  ctx.lineWidth = Math.max(
    BUTTON_LINE_WIDTH_MIN,
    zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  );
  ctx.lineCap = "round";
  const xSize = radius * BUTTON_ICON_SIZE_FACTOR;
  ctx.beginPath();
  ctx.moveTo(cx - xSize, cy - xSize);
  ctx.lineTo(cx + xSize, cy + xSize);
  ctx.moveTo(cx + xSize, cy - xSize);
  ctx.lineTo(cx - xSize, cy + xSize);
  ctx.stroke();
  ctx.restore();

  return { cx, cy, radius };
}

function renderRotateButton(
  ctx: CanvasRenderingContext2D,
  col: number,
  row: number,
  _w: number,
  _h: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): RotateButtonBounds {
  const s = TILE_SIZE * zoom;
  // Position to the left of the delete button (which is at top-right corner)
  const radius = Math.max(BUTTON_MIN_RADIUS, zoom * BUTTON_RADIUS_ZOOM_FACTOR);
  const cx = offsetX + col * s - 1;
  const cy = offsetY + row * s - 1;

  // Circle background
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = ROTATE_BUTTON_BG;
  ctx.fill();

  // Circular arrow icon
  ctx.strokeStyle = BUTTON_ICON_COLOR;
  ctx.lineWidth = Math.max(
    BUTTON_LINE_WIDTH_MIN,
    zoom * BUTTON_LINE_WIDTH_ZOOM_FACTOR,
  );
  ctx.lineCap = "round";
  const arcR = radius * BUTTON_ICON_SIZE_FACTOR;
  ctx.beginPath();
  // Draw a 270-degree arc
  ctx.arc(cx, cy, arcR, -Math.PI * 0.8, Math.PI * 0.7);
  ctx.stroke();
  // Draw arrowhead at the end of the arc
  const endAngle = Math.PI * 0.7;
  const endX = cx + arcR * Math.cos(endAngle);
  const endY = cy + arcR * Math.sin(endAngle);
  const arrowSize = radius * 0.35;
  ctx.beginPath();
  ctx.moveTo(endX + arrowSize * 0.6, endY - arrowSize * 0.3);
  ctx.lineTo(endX, endY);
  ctx.lineTo(endX + arrowSize * 0.7, endY + arrowSize * 0.5);
  ctx.stroke();
  ctx.restore();

  return { cx, cy, radius };
}

// ── Speech bubbles ──────────────────────────────────────────────

function renderBubbles(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const ch of characters) {
    if (!ch.bubbleType) continue;

    const sprite =
      ch.bubbleType === "permission"
        ? BUBBLE_PERMISSION_SPRITE
        : BUBBLE_WAITING_SPRITE;

    // Compute opacity: permission = full, waiting = fade in last 0.5s
    let alpha = 1.0;
    if (
      ch.bubbleType === "waiting" &&
      ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
    ) {
      alpha = ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC;
    }

    const cached = getCachedSprite(sprite, zoom);
    // Position: centered above the character's head
    // Character is anchored bottom-center at (ch.x, ch.y), sprite is 16x24
    // Place bubble above head with a small gap; follow sitting offset
    const sittingOff =
      ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
    const bubbleX = Math.round(offsetX + ch.x * zoom - cached.width / 2);
    const bubbleY = Math.round(
      offsetY +
        (ch.y + sittingOff - BUBBLE_VERTICAL_OFFSET_PX) * zoom -
        cached.height -
        1 * zoom,
    );

    ctx.save();
    if (alpha < 1.0) ctx.globalAlpha = alpha;
    ctx.drawImage(cached, bubbleX, bubbleY);
    ctx.restore();
  }
}

export interface ButtonBounds {
  /** Center X in device pixels */
  cx: number;
  /** Center Y in device pixels */
  cy: number;
  /** Radius in device pixels */
  radius: number;
}

export type DeleteButtonBounds = ButtonBounds;
export type RotateButtonBounds = ButtonBounds;

export interface EditorRenderState {
  showGrid: boolean;
  ghostSprite: SpriteData | null;
  ghostMirrored: boolean;
  ghostCol: number;
  ghostRow: number;
  ghostValid: boolean;
  selectedCol: number;
  selectedRow: number;
  selectedW: number;
  selectedH: number;
  hasSelection: boolean;
  isRotatable: boolean;
  /** Updated each frame by renderDeleteButton */
  deleteButtonBounds: DeleteButtonBounds | null;
  /** Updated each frame by renderRotateButton */
  rotateButtonBounds: RotateButtonBounds | null;
  /** Whether to show ghost border (expansion tiles outside grid) */
  showGhostBorder: boolean;
  /** Hovered ghost border tile col (-1 to cols) */
  ghostBorderHoverCol: number;
  /** Hovered ghost border tile row (-1 to rows) */
  ghostBorderHoverRow: number;
}

export interface SelectionRenderState {
  selectedAgentId: number | null;
  hoveredAgentId: number | null;
  hoveredTile: { col: number; row: number } | null;
  seats: Map<string, Seat>;
  characters: Map<number, Character>;
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  tileMap: TileTypeVal[][],
  furniture: FurnitureInstance[],
  characters: Character[],
  zoom: number,
  panX: number,
  panY: number,
  selection?: SelectionRenderState,
  editor?: EditorRenderState,
  tileColors?: Array<ColorValue | null>,
  layoutCols?: number,
  layoutRows?: number,
): { offsetX: number; offsetY: number } {
  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0);
  const rows = layoutRows ?? tileMap.length;

  // Center map in viewport + pan offset (integer device pixels)
  const mapW = cols * TILE_SIZE * zoom;
  const mapH = rows * TILE_SIZE * zoom;
  const offsetX = Math.floor((canvasWidth - mapW) / 2) + Math.round(panX);
  const offsetY = Math.floor((canvasHeight - mapH) / 2) + Math.round(panY);

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols);

  // Seat indicators (below furniture/characters, on top of floor)
  if (selection) {
    renderSeatIndicators(
      ctx,
      selection.seats,
      selection.characters,
      selection.selectedAgentId,
      selection.hoveredTile,
      offsetX,
      offsetY,
      zoom,
    );
  }

  // Build wall instances for z-sorting with furniture and characters
  const wallInstances = hasWallSprites()
    ? getWallInstances(tileMap, tileColors, layoutCols)
    : [];
  const allFurniture =
    wallInstances.length > 0 ? [...wallInstances, ...furniture] : furniture;

  // Draw walls + furniture + characters (z-sorted)
  const selectedId = selection?.selectedAgentId ?? null;
  const hoveredId = selection?.hoveredAgentId ?? null;
  renderScene(
    ctx,
    allFurniture,
    characters,
    offsetX,
    offsetY,
    zoom,
    selectedId,
    hoveredId,
  );

  // Speech bubbles (always on top of characters)
  renderBubbles(ctx, characters, offsetX, offsetY, zoom);

  // Editor overlays
  if (editor) {
    if (editor.showGrid) {
      renderGridOverlay(ctx, offsetX, offsetY, zoom, cols, rows, tileMap);
    }
    if (editor.showGhostBorder) {
      renderGhostBorder(
        ctx,
        offsetX,
        offsetY,
        zoom,
        cols,
        rows,
        editor.ghostBorderHoverCol,
        editor.ghostBorderHoverRow,
      );
    }
    if (editor.ghostSprite && editor.ghostCol >= 0) {
      renderGhostPreview(
        ctx,
        editor.ghostSprite,
        editor.ghostCol,
        editor.ghostRow,
        editor.ghostValid,
        offsetX,
        offsetY,
        zoom,
        editor.ghostMirrored,
      );
    }
    if (editor.hasSelection) {
      renderSelectionHighlight(
        ctx,
        editor.selectedCol,
        editor.selectedRow,
        editor.selectedW,
        editor.selectedH,
        offsetX,
        offsetY,
        zoom,
      );
      editor.deleteButtonBounds = renderDeleteButton(
        ctx,
        editor.selectedCol,
        editor.selectedRow,
        editor.selectedW,
        editor.selectedH,
        offsetX,
        offsetY,
        zoom,
      );
      if (editor.isRotatable) {
        editor.rotateButtonBounds = renderRotateButton(
          ctx,
          editor.selectedCol,
          editor.selectedRow,
          editor.selectedW,
          editor.selectedH,
          offsetX,
          offsetY,
          zoom,
        );
      } else {
        editor.rotateButtonBounds = null;
      }
    } else {
      editor.deleteButtonBounds = null;
      editor.rotateButtonBounds = null;
    }
  }

  return { offsetX, offsetY };
}
