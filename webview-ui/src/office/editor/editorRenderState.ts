import { GHOST_BORDER_NO_HOVER_TILE } from '../../constants.js';
import { getColorizedSprite } from '../colorize.js';
import type { EditorRenderState, GhostSprite } from '../engine/renderer.js';
import { getCatalogEntry, isRotatable } from '../layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../types.js';
import { EditTool } from '../types.js';
import { canPlaceFurniture, getWallPlacementRow, planFurnitureMove } from './editorActions.js';
import type { EditorState } from './editorState.js';

/** One ghost sprite for an item at its (target) position; null for unknown types. */
function ghostOf(item: Pick<PlacedFurniture, 'type' | 'col' | 'row'>, sprite?: SpriteData) {
  const entry = getCatalogEntry(item.type);
  if (!entry) return null;
  const ghost: GhostSprite = {
    sprite: sprite ?? entry.sprite,
    col: item.col,
    row: item.row,
    mirrored: !!entry.mirrorSide && item.type.endsWith(':left'),
  };
  return ghost;
}

/**
 * What the renderer should draw for the editor this frame, derived from the
 * imperative editor state and the current layout. Pure: called from the rAF
 * loop, it reads and never writes.
 *
 * Ghosts: the catalog item being placed (in its placement colour), or — while a
 * placed item is being dragged — the item plus whatever rides on it, previewed
 * as the one group that will be dropped. With Alt held the group previews as a
 * copy, so the originals still block it and the ghost turns red over them.
 */
export function buildEditorRenderState(
  editorState: EditorState,
  layout: OfficeLayout,
): EditorRenderState {
  const tool = editorState.activeTool;
  const showGhostBorder =
    tool === EditTool.TILE_PAINT || tool === EditTool.WALL_PAINT || tool === EditTool.ERASE;
  const render: EditorRenderState = {
    showGrid: true,
    ghosts: [],
    ghostValid: editorState.ghostValid,
    selectedCol: 0,
    selectedRow: 0,
    selectedW: 0,
    selectedH: 0,
    hasSelection: false,
    isRotatable: false,
    deleteButtonBounds: null,
    rotateButtonBounds: null,
    showGhostBorder,
    ghostBorderHoverCol: showGhostBorder ? editorState.ghostCol : GHOST_BORDER_NO_HOVER_TILE,
    ghostBorderHoverRow: showGhostBorder ? editorState.ghostRow : GHOST_BORDER_NO_HOVER_TILE,
  };

  const hovering = editorState.ghostCol >= 0;

  // Ghost preview for furniture placement
  const placingType = editorState.selectedFurnitureType;
  if (tool === EditTool.FURNITURE_PLACE && hovering && placingType) {
    const row = getWallPlacementRow(placingType, editorState.ghostRow);
    const entry = getCatalogEntry(placingType);
    const color = editorState.placementColor();
    const sprite =
      entry && color
        ? getColorizedSprite(
            `ghost-${placingType}-${color.h}-${color.s}-${color.b}-${color.c}-${color.colorize ?? ''}`,
            entry.sprite,
            color,
          )
        : undefined;
    const ghost = ghostOf({ type: placingType, col: editorState.ghostCol, row }, sprite);
    if (ghost) {
      render.ghosts = [ghost];
      render.ghostValid = canPlaceFurniture(layout, placingType, ghost.col, row);
    }
  }

  // Ghost preview for drag-to-move / Alt-drag copy
  if (editorState.isDragMoving && editorState.dragUid && hovering) {
    const plan = planFurnitureMove(
      layout,
      editorState.dragUid,
      editorState.ghostCol - editorState.dragOffsetCol,
      editorState.ghostRow - editorState.dragOffsetRow,
      { duplicate: editorState.dragDuplicate },
    );
    // A group whose anchor lands left of the map isn't previewed at all.
    if (plan && plan.items[0].col >= 0) {
      // Dragged item first, riders after — they draw on top of the surface
      // they're being carried on.
      render.ghosts = plan.items.flatMap((item) => ghostOf(item) ?? []);
      render.ghostValid = plan.valid;
    }
  }

  // Selection highlight
  if (editorState.selectedFurnitureUid && !editorState.isDragMoving) {
    const item = layout.furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
    const entry = item ? getCatalogEntry(item.type) : undefined;
    if (item && entry) {
      render.hasSelection = true;
      render.selectedCol = item.col;
      render.selectedRow = item.row;
      render.selectedW = entry.footprintW;
      render.selectedH = entry.footprintH;
      render.isRotatable = isRotatable(item.type);
    }
  }

  return render;
}
