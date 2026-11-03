import { gridRuns, litBox } from '../../components/ui/pixelGrid.js';
import type { PixelIconName } from '../../components/ui/pixelIcons.js';
import { ICONS } from '../../components/ui/pixelIcons.js';
import type { ColorValue } from '../../components/ui/types.js';
import {
  AREA_ACTIVE_ALPHA_MULTIPLIER,
  AREA_LABEL_ALPHA,
  AREA_LABEL_FALLBACK_COLOR,
  AREA_LABEL_FONT_SIZE_PX,
  AREA_LABEL_MIN_FONT_SIZE_PX,
  AREA_LABEL_SHADOW_ALPHA,
  AREA_LABEL_SHADOW_COLOR,
  AREA_OVERLAY_ALPHA,
  BUBBLE_FADE_DURATION_SEC,
  BUTTON_ICON_COLOR,
  BUTTON_SHADOW_COLOR,
  CARPET_DEFAULT_ACCENT_COLOR,
  CARPET_DEFAULT_COLOR,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_Z_SORT_OFFSET,
  DELETE_BUTTON_BG,
  DELETE_BUTTON_HOVER_BG,
  FALLBACK_FLOOR_COLOR,
  GHOST_BORDER_HOVER_FILL,
  GHOST_BORDER_HOVER_STROKE,
  GHOST_BORDER_STROKE,
  GHOST_INVALID_TINT,
  GHOST_PREVIEW_SPRITE_ALPHA,
  GHOST_PREVIEW_TINT_ALPHA,
  GHOST_VALID_TINT,
  GRID_LINE_COLOR,
  HEADLESS_CHARACTER_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  OUTLINE_Z_SORT_OFFSET,
  ROTATE_BUTTON_BG,
  ROTATE_BUTTON_HOVER_BG,
  SEAT_AVAILABLE_COLOR,
  SEAT_BUSY_COLOR,
  SEAT_OWN_COLOR,
  SELECTED_OUTLINE_ALPHA,
  SELECTION_DASH_PATTERN,
  SELECTION_HIGHLIGHT_COLOR,
  VOID_TILE_DASH_PATTERN,
  VOID_TILE_OUTLINE_COLOR,
} from '../../constants.js';
import type { SelectionButton } from '../editor/editorState.js';
import { getColorizedFloorSprite, hasFloorSprites, WALL_COLOR } from '../floorTiles.js';
import { mapOffset } from '../projection.js';
import {
  getCarpetJunctionSprite,
  getCarpetPaletteKey,
  hasCarpetSprites,
} from '../sprites/carpetTiles.js';
import { getPetSprites } from '../sprites/petSpriteData.js';
import { getCachedSprite, getOutlineSprite } from '../sprites/spriteCache.js';
import { BUBBLE_HEART_SPRITE, getCharacterSprites } from '../sprites/spriteData.js';
import type {
  AreaDefinition,
  CarpetTile,
  Character,
  FurnitureInstance,
  Pet,
  Seat,
  SpriteData,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterState, TILE_SIZE, TileType } from '../types.js';
import { getWallInstances, hasWallSprites, wallColorToHex } from '../wallTiles.js';
import { getCharacterSprite } from './characters.js';
import { renderMatrixEffect } from './matrixEffect.js';
import { getPetSpriteData } from './petEntity.js';
import type {
  ButtonBounds,
  ButtonGeometry,
  ButtonPlacement,
  DeleteButtonBounds,
  RotateButtonBounds,
} from './selectionButtons.js';
import { buttonGeometry, placeSelectionButtons, restingBounds } from './selectionButtons.js';

// ── Settings ────────────────────────────────────────────────────

/**
 * "Display headless as ghosts" — whether headless agents render translucent.
 * Module state rather than a render param: the rAF loop reads it every frame,
 * so a toggle takes effect on the next one without threading a 21st argument
 * through renderFrame. Same shape as setProviderCapabilities / setSoundEnabled.
 * Mirrors the server default (off) — the cue is opt-in, so an office looks the
 * same as it did before the setting existed until someone turns it on.
 */
let ghostHeadlessAgents = false;

export function setGhostHeadlessAgents(enabled: boolean): void {
  ghostHeadlessAgents = enabled;
}

export function isGhostHeadlessAgentsEnabled(): boolean {
  return ghostHeadlessAgents;
}

// ── Render functions ────────────────────────────────────────────

/**
 * Render the carpet layer. Called AFTER renderTileGrid and BEFORE seat
 * indicators / characters / furniture.
 *
 * Per junction (cols+1 × rows+1 grid of corners), we gather every
 * (variant, palette) pair from the up-to-4 adjacent tiles. Each pair becomes
 * one local "layer" drawn in ascending `order`, so the highest-order carpet
 * visually wins at overlaps. Sprite anchor: each 16×16 junction sprite is
 * centered on the corner — drawn at (offsetX + jx*s - halfS, offsetY + jy*s - halfS).
 *
 * @internal
 */
export function renderCarpetLayer(
  ctx: CanvasRenderingContext2D,
  carpetTiles: Array<CarpetTile | null>,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!hasCarpetSprites()) return;
  if (!carpetTiles || carpetTiles.length === 0) return;

  const s = TILE_SIZE * zoom;
  const halfS = s / 2;

  for (let jy = 0; jy <= rows; jy++) {
    for (let jx = 0; jx <= cols; jx++) {
      const localGroups = new Map<
        string,
        {
          variant: number;
          color: ColorValue;
          accentColor: ColorValue;
          paletteKey: string;
          order: number;
        }
      >();

      const adjacent = [
        { col: jx - 1, row: jy - 1 }, // NW
        { col: jx, row: jy - 1 }, // NE
        { col: jx, row: jy }, // SE
        { col: jx - 1, row: jy }, // SW
      ];

      for (const pos of adjacent) {
        if (pos.col < 0 || pos.row < 0 || pos.col >= cols || pos.row >= rows) continue;
        const tile = carpetTiles[pos.row * cols + pos.col];
        if (!tile) continue;
        const color = tile.color ?? CARPET_DEFAULT_COLOR;
        const accentColor = tile.accentColor ?? CARPET_DEFAULT_ACCENT_COLOR;
        const paletteKey = getCarpetPaletteKey(color, accentColor);
        const key = `${tile.variant}:${paletteKey}`;
        const order = tile.order ?? 0;
        const existing = localGroups.get(key);
        if (!existing || order > existing.order) {
          localGroups.set(key, { variant: tile.variant, color, accentColor, paletteKey, order });
        }
      }

      if (localGroups.size === 0) continue;

      // Ascending order → drawn lowest first; highest-order layer ends on top.
      const ordered = [...localGroups.values()].sort((a, b) => a.order - b.order);
      for (const { variant, color, accentColor, paletteKey } of ordered) {
        const sprite = getCarpetJunctionSprite(
          jx,
          jy,
          variant,
          carpetTiles,
          cols,
          rows,
          color,
          accentColor,
          paletteKey,
        );
        if (!sprite) continue;
        const cached = getCachedSprite(sprite, zoom);
        ctx.drawImage(cached, offsetX + jx * s - halfS, offsetY + jy * s - halfS);
      }
    }
  }
}

/**
 * Translucent per-tile color wash for Areas. Runs ABOVE carpets/floor and
 * BELOW seat indicators / characters / furniture. The active area (the one
 * the editor has currently selected) gets a multiplier-bumped alpha so users
 * can see which area they're editing without changing every other area's
 * visibility.
 *
 * @internal
 */
export function renderAreaOverlay(
  ctx: CanvasRenderingContext2D,
  areaTiles: Array<string | null> | undefined,
  areas: AreaDefinition[] | undefined,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  activeAreaLabel?: string | null,
): void {
  if (!areaTiles || areaTiles.length === 0) return;
  if (!areas || areas.length === 0) return;

  const s = TILE_SIZE * zoom;
  const colorMap = new Map<string, string>();
  for (const a of areas) colorMap.set(a.label, a.color);

  ctx.save();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const label = areaTiles[r * cols + c];
      if (!label) continue;
      const color = colorMap.get(label);
      if (!color) continue;
      ctx.globalAlpha =
        activeAreaLabel === label
          ? AREA_OVERLAY_ALPHA * AREA_ACTIVE_ALPHA_MULTIPLIER
          : AREA_OVERLAY_ALPHA;
      ctx.fillStyle = color;
      ctx.fillRect(offsetX + c * s, offsetY + r * s, s, s);
    }
  }
  ctx.restore();
}

/**
 * Render the centroid label for each Area, ABOVE characters/bubbles. Centroid
 * = arithmetic mean of all tile centers belonging to a given label. Pixel-art
 * drop shadow (no blur) for legibility on light backgrounds.
 *
 * @internal
 */
export function renderAreaLabels(
  ctx: CanvasRenderingContext2D,
  areaTiles: Array<string | null> | undefined,
  areas: AreaDefinition[] | undefined,
  cols: number,
  rows: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  if (!areaTiles || areaTiles.length === 0) return;
  if (!areas || areas.length === 0) return;

  const s = TILE_SIZE * zoom;
  const colorMap = new Map<string, string>();
  for (const a of areas) colorMap.set(a.label, a.color);

  // Centroid accumulator: label → { sumX, sumY, count }.
  const centroids = new Map<string, { sumX: number; sumY: number; count: number }>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const label = areaTiles[r * cols + c];
      if (!label) continue;
      const acc = centroids.get(label);
      if (acc) {
        acc.sumX += c;
        acc.sumY += r;
        acc.count += 1;
      } else {
        centroids.set(label, { sumX: c, sumY: r, count: 1 });
      }
    }
  }

  if (centroids.size === 0) return;

  const fontSize = Math.max(AREA_LABEL_FONT_SIZE_PX * zoom, AREA_LABEL_MIN_FONT_SIZE_PX);

  ctx.save();
  ctx.font = `bold ${fontSize}px 'FS Pixel Sans'`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const [label, acc] of centroids) {
    const cx = offsetX + (acc.sumX / acc.count + 0.5) * s;
    const cy = offsetY + (acc.sumY / acc.count + 0.5) * s;

    // Pixel-art drop shadow (1px right + down, no blur).
    ctx.globalAlpha = AREA_LABEL_SHADOW_ALPHA;
    ctx.fillStyle = AREA_LABEL_SHADOW_COLOR;
    ctx.fillText(label, cx + 1, cy + 1);

    // Main label — area's own color, falling back to white if missing.
    ctx.globalAlpha = AREA_LABEL_ALPHA;
    ctx.fillStyle = colorMap.get(label) ?? AREA_LABEL_FALLBACK_COLOR;
    ctx.fillText(label, cx, cy);
  }
  ctx.restore();
}

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
  pets: Pet[] = [],
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
    const sprites = getCharacterSprites(ch.palette, ch.repeat, ch.blinkShut > 0);
    const spriteData = getCharacterSprite(ch, sprites);
    const cached = getCachedSprite(spriteData, zoom);
    // Sitting offset: shift character down when seated so they visually sit in the chair
    const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
    // Anchor at bottom-center of character — round to integer device pixels
    const drawX = Math.round(offsetX + ch.x * zoom - cached.width / 2);
    const drawY = Math.round(offsetY + (ch.y + sittingOffset) * zoom - cached.height);

    // Sort characters by bottom of their tile (not center) so they render
    // in front of same-row furniture (e.g. chairs) but behind furniture
    // at lower rows (e.g. desks, bookshelves that occlude from below).
    const charZY = ch.y + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;

    // Headless agents (adopted, no terminal to focus) render translucent while
    // the "Display headless as ghosts" setting is on.
    const alpha = ch.isHeadless && ghostHeadlessAgents ? HEADLESS_CHARACTER_ALPHA : 1;

    // Matrix spawn/despawn effect — skip outline, use per-pixel rendering
    if (ch.matrixEffect) {
      const mDrawX = drawX;
      const mDrawY = drawY;
      const mSpriteData = spriteData;
      const mCh = ch;
      drawables.push({
        zY: charZY,
        draw: (c) => {
          c.save();
          c.globalAlpha = alpha;
          renderMatrixEffect(c, mCh, mSpriteData, mDrawX, mDrawY, zoom);
          c.restore();
        },
      });
      continue;
    }

    // White outline: full opacity for selected, 50% for hover
    const isSelected = selectedAgentId !== null && ch.id === selectedAgentId;
    const isHovered = hoveredAgentId !== null && ch.id === hoveredAgentId;
    if (isSelected || isHovered) {
      const outlineAlpha = isSelected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA;
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
        if (alpha === 1) {
          c.drawImage(cached, drawX, drawY);
          return;
        }
        c.save();
        c.globalAlpha = alpha;
        c.drawImage(cached, drawX, drawY);
        c.restore();
      },
    });
  }

  // ── Pets ──────────────────────────────────────────────
  for (const pet of pets) {
    const petSprites = getPetSprites(pet.petType);
    const spriteData = getPetSpriteData(pet, petSprites);
    if (!spriteData) continue;

    const cached = getCachedSprite(spriteData, zoom);
    // Anchor at bottom-center at (pet.x, pet.y) — round to integer device pixels
    const drawX = Math.round(offsetX + pet.x * zoom - cached.width / 2);
    const drawY = Math.round(offsetY + pet.y * zoom - cached.height);

    // Z-sort key: matches the chair/character "row boundary" formula.
    // pet.y is the pixel center, so + TILE_SIZE/2 lifts us to the row's bottom edge.
    const petZY = pet.y + TILE_SIZE / 2;

    drawables.push({
      zY: petZY,
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
    if (seat.seatCol !== hoveredTile.col || seat.seatRow !== hoveredTile.row) continue;

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
          ctx.strokeRect(offsetX + c * s + 0.5, offsetY + r * s + 0.5, s - 1, s - 1);
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
    ctx.strokeStyle = isHovered ? GHOST_BORDER_HOVER_STROKE : GHOST_BORDER_STROKE;
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

/**
 * One of the selected item's buttons, drawn like the app's own: a square in a
 * solid brand colour with a hard shadow and an 8×8 pixel icon in white, every
 * edge on a whole device pixel, its top-left at (x, y). Hovered it lights up
 * (the brighter colour); pressed it also sinks into its shadow, which halves,
 * as a pressed toolbar button does. The icon is centred by its lit pixels, not
 * its 8×8 box (the × only fills 5×5 of it). Sized in screen pixels, not by
 * zoom, so it stays the toolbar icons' size.
 */
function renderSelectionButton(
  ctx: CanvasRenderingContext2D,
  geometry: ButtonGeometry,
  at: { x: number; y: number },
  colors: { idle: string; lit: string },
  icon: PixelIconName,
  state: 'idle' | 'hover' | 'pressed',
): ButtonBounds {
  const { unit, size, shadow } = geometry;
  const grid = ICONS[icon];
  // Hit-tested where it rests, so sinking never moves it out from under the pointer.
  const bounds = restingBounds(at.x, at.y, geometry);
  const sink = state === 'pressed' ? Math.ceil(shadow / 2) : 0;
  const x = Math.round(at.x) + sink;
  const y = Math.round(at.y) + sink;

  // The lit pixels' box, to centre the glyph rather than its grid.
  const { minX, maxX, minY, maxY } = litBox(grid);
  const left = x + Math.round((size - (maxX - minX + 1) * unit) / 2) - minX * unit;
  const top = y + Math.round((size - (maxY - minY + 1) * unit) / 2) - minY * unit;

  ctx.save();
  ctx.fillStyle = BUTTON_SHADOW_COLOR;
  ctx.fillRect(x + shadow - sink, y + shadow - sink, size, size);
  ctx.fillStyle = state === 'idle' ? colors.idle : colors.lit;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = BUTTON_ICON_COLOR;
  for (const [ix, iy, w] of gridRuns(grid)) {
    ctx.fillRect(left + ix * unit, top + iy * unit, w * unit, unit);
  }
  ctx.restore();
  return bounds;
}

/** The selected item's buttons (selectionButtons.ts places them), and where
 *  each one rests for the hit test. */
function renderSelectionButtons(
  ctx: CanvasRenderingContext2D,
  placement: ButtonPlacement,
  hovered: SelectionButton | null,
  pressed: SelectionButton | null,
): { deleteButton: DeleteButtonBounds; rotateButton: RotateButtonBounds | null } {
  const stateOf = (b: SelectionButton) =>
    pressed === b ? 'pressed' : hovered === b && pressed === null ? 'hover' : 'idle';
  const geometry = buttonGeometry(window.devicePixelRatio || 1);
  const spots = placeSelectionButtons(placement, geometry);
  const deleteButton = renderSelectionButton(
    ctx,
    geometry,
    spots.delete,
    { idle: DELETE_BUTTON_BG, lit: DELETE_BUTTON_HOVER_BG },
    'close',
    stateOf('delete'),
  );
  const rotateButton = spots.rotate
    ? renderSelectionButton(
        ctx,
        geometry,
        spots.rotate,
        { idle: ROTATE_BUTTON_BG, lit: ROTATE_BUTTON_HOVER_BG },
        'reset',
        stateOf('rotate'),
      )
    : null;
  return { deleteButton, rotateButton };
}

// ── Speech bubbles ──────────────────────────────────────────────
// Character bubbles (permission dots / done checkmark) are rendered by
// ToolOverlay as DOM elements so they stack ABOVE the DOM status labels —
// canvas content can never out-paint the DOM overlay. Pet heart bubbles stay
// here: pets have no overlay labels to collide with.

function renderPetBubbles(
  ctx: CanvasRenderingContext2D,
  pets: Pet[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  for (const pet of pets) {
    if (!pet.bubbleType) continue;

    const sprite = BUBBLE_HEART_SPRITE;

    // Fade in the last BUBBLE_FADE_DURATION_SEC of the lifetime
    let alpha = 1.0;
    if (pet.bubbleTimer < BUBBLE_FADE_DURATION_SEC) {
      alpha = Math.max(0, pet.bubbleTimer / BUBBLE_FADE_DURATION_SEC);
    }

    const cached = getCachedSprite(sprite, zoom);
    // Anchor: centered above the pet's head. Pet is anchored bottom-center at
    // (pet.x, pet.y); sprite is ~16 tall, so back up TILE_SIZE pixels and add
    // a 1-sprite-pixel gap (scaled by zoom).
    const bubbleX = Math.round(offsetX + pet.x * zoom - cached.width / 2);
    const bubbleY = Math.round(offsetY + (pet.y - TILE_SIZE) * zoom - cached.height - 1 * zoom);

    ctx.save();
    if (alpha < 1.0) ctx.globalAlpha = alpha;
    ctx.drawImage(cached, bubbleX, bubbleY);
    ctx.restore();
  }
}

/** One translucent preview sprite at a target tile. */
export interface GhostSprite {
  sprite: SpriteData;
  col: number;
  row: number;
  mirrored: boolean;
}

export interface EditorRenderState {
  showGrid: boolean;
  /**
   * Preview sprites, drawn in order with one shared validity tint: the item
   * being placed, or a dragged item followed by everything riding on it — the
   * group previews (and is accepted or refused) as one.
   */
  ghosts: GhostSprite[];
  ghostValid: boolean;
  selectedCol: number;
  selectedRow: number;
  selectedW: number;
  selectedH: number;
  hasSelection: boolean;
  isRotatable: boolean;
  /** Updated each frame by renderSelectionButtons */
  deleteButtonBounds: DeleteButtonBounds | null;
  /** Updated each frame by renderSelectionButtons */
  rotateButtonBounds: RotateButtonBounds | null;
  /** The button under the pointer, and the one held down (drawn lit / sunk). */
  hoveredButton: SelectionButton | null;
  pressedButton: SelectionButton | null;
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
  carpetTiles?: Array<CarpetTile | null>,
  areas?: AreaDefinition[],
  areaTiles?: Array<string | null>,
  showAreas?: boolean,
  activeAreaLabel?: string | null,
  pets?: Pet[],
): { offsetX: number; offsetY: number } {
  // Clear
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Use layout dimensions (fallback to tileMap size)
  const cols = layoutCols ?? (tileMap.length > 0 ? tileMap[0].length : 0);
  const rows = layoutRows ?? tileMap.length;

  // Center map in viewport + pan offset (integer device pixels). Shared with
  // the DOM overlays so a label lands exactly on the sprite it belongs to.
  const { offsetX, offsetY } = mapOffset(canvasWidth, canvasHeight, cols, rows, zoom, panX, panY);

  // Draw tiles (floor + wall base color)
  renderTileGrid(ctx, tileMap, offsetX, offsetY, zoom, tileColors, layoutCols);

  // Carpet layer (above floor, below seat indicators / furniture / characters)
  if (carpetTiles && carpetTiles.length > 0) {
    renderCarpetLayer(ctx, carpetTiles, cols, rows, offsetX, offsetY, zoom);
  }

  // Area overlay (translucent color wash) — above carpets, below seat indicators
  if (showAreas) {
    renderAreaOverlay(ctx, areaTiles, areas, cols, rows, offsetX, offsetY, zoom, activeAreaLabel);
  }

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
  const wallInstances = hasWallSprites() ? getWallInstances(tileMap, tileColors, layoutCols) : [];
  const allFurniture = wallInstances.length > 0 ? [...wallInstances, ...furniture] : furniture;

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
    pets ?? [],
  );

  // Character speech bubbles render in ToolOverlay (DOM, above the labels).
  // Pet heart bubbles (canvas overlay pass)
  if (pets && pets.length > 0) {
    renderPetBubbles(ctx, pets, offsetX, offsetY, zoom);
  }

  // Area labels (above bubbles + characters, below editor overlays)
  if (showAreas) {
    renderAreaLabels(ctx, areaTiles, areas, cols, rows, offsetX, offsetY, zoom);
  }

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
    for (const ghost of editor.ghosts) {
      renderGhostPreview(
        ctx,
        ghost.sprite,
        ghost.col,
        ghost.row,
        editor.ghostValid,
        offsetX,
        offsetY,
        zoom,
        ghost.mirrored,
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
      const buttons = renderSelectionButtons(
        ctx,
        {
          col: editor.selectedCol,
          row: editor.selectedRow,
          w: editor.selectedW,
          h: editor.selectedH,
          offsetX,
          offsetY,
          zoom,
          rotatable: editor.isRotatable,
        },
        editor.hoveredButton,
        editor.pressedButton,
      );
      editor.deleteButtonBounds = buttons.deleteButton;
      editor.rotateButtonBounds = buttons.rotateButton;
    } else {
      editor.deleteButtonBounds = null;
      editor.rotateButtonBounds = null;
    }
  }

  return { offsetX, offsetY };
}
