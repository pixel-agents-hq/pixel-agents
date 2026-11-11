import { GHOST_BORDER_NO_HOVER_TILE } from '../../constants.js';
import { getColorizedSprite } from '../colorize.js';
import type { EditorRenderState, GhostSprite } from '../engine/renderer.js';
import { getCatalogEntry, isRotatable } from '../layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture, SpriteData } from '../types.js';
import { EditTool } from '../types.js';
import {
  canPlaceFurniture,
  furnitureInBox,
  getWallPlacementRow,
  planFurnitureMove,
} from './editorActions.js';
import type { EditorState } from './editorState.js';
import { sectionAt, sectionKindAt } from './tileSections.js';

/** The hovered section, kept while neither the layout nor the hovered tile changes (it's asked every frame). */
let hoverSection: { layout: OfficeLayout; idx: number; tiles: number[] } | null = null;

function hoveredSection(layout: OfficeLayout, col: number, row: number): number[] {
  const idx = row * layout.cols + col;
  if (hoverSection?.layout !== layout || hoverSection.idx !== idx) {
    hoverSection = { layout, idx, tiles: sectionAt(layout, col, row) };
  }
  return hoverSection.tiles;
}

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
  now: number = performance.now(),
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
    hoveredButton: editorState.selectionButtonHover,
    pressedButton: editorState.selectionButtonPressed,
    showGhostBorder,
    ghostBorderHoverCol: showGhostBorder ? editorState.ghostCol : GHOST_BORDER_NO_HOVER_TILE,
    ghostBorderHoverRow: showGhostBorder ? editorState.ghostRow : GHOST_BORDER_NO_HOVER_TILE,
    sectionTiles: [],
    sectionHoverTiles: [],
    extraSelections: [],
    selectionBox: null,
    marquee: null,
  };

  const hovering = editorState.ghostCol >= 0;

  // Sections: the picked ones, and the one a click would pick next
  // (Both hidden while a restyle is in progress, so the new colour reads clean.)
  if (
    (tool === EditTool.FLOOR_SECTION || tool === EditTool.WALL_SECTION) &&
    now >= editorState.outlineHiddenUntil
  ) {
    const kind = tool === EditTool.FLOOR_SECTION ? 'floor' : 'wall';
    const picked = editorState.section?.kind === kind ? editorState.section.tiles : [];
    render.sectionTiles = picked;
    const { ghostCol: col, ghostRow: row } = editorState;
    const idx = row * layout.cols + col;
    if (
      hovering &&
      col < layout.cols &&
      row < layout.rows &&
      sectionKindAt(layout, idx) === kind &&
      !picked.includes(idx)
    ) {
      render.sectionHoverTiles = hoveredSection(layout, col, row);
    }
  }

  // Ghost preview for furniture placement
  const placingType = editorState.placingType;
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
      { duplicate: editorState.dragDuplicate, with: editorState.dragCompanions() },
    );
    // A group whose anchor lands left of the map isn't previewed at all.
    if (plan && plan.items[0].col >= 0) {
      // Dragged item first, riders after — they draw on top of the surface
      // they're being carried on.
      render.ghosts = plan.items.flatMap((item) => ghostOf(item) ?? []);
      render.ghostValid = plan.valid;
    }
  }

  // Box selection: the box, and what letting go would leave selected
  // (highlighted, no buttons until it's a selection).
  const marquee = editorState.marquee;
  if (marquee) {
    const col = Math.min(marquee.startCol, marquee.endCol);
    const row = Math.min(marquee.startRow, marquee.endRow);
    render.marquee = {
      col,
      row,
      w: Math.abs(marquee.endCol - marquee.startCol) + 1,
      h: Math.abs(marquee.endRow - marquee.startRow) + 1,
    };
    const caught = furnitureInBox(
      layout,
      marquee.startCol,
      marquee.startRow,
      marquee.endCol,
      marquee.endRow,
    );
    const uids = marquee.additive ? [...new Set([...editorState.selectedUids, ...caught])] : caught;
    for (const uid of uids) {
      const f = layout.furniture.find((x) => x.uid === uid);
      const entry = f ? getCatalogEntry(f.type) : undefined;
      if (f && entry) {
        render.extraSelections.push({
          col: f.col,
          row: f.row,
          w: entry.footprintW,
          h: entry.footprintH,
        });
      }
    }
    return render;
  }

  // Selection highlight (hidden while its colour is being edited)
  if (
    editorState.selectedFurnitureUid &&
    !editorState.isDragMoving &&
    now >= editorState.outlineHiddenUntil
  ) {
    const item = layout.furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
    const entry = item ? getCatalogEntry(item.type) : undefined;
    if (item && entry) {
      render.hasSelection = true;
      render.selectedCol = item.col;
      render.selectedRow = item.row;
      render.selectedW = entry.footprintW;
      render.selectedH = entry.footprintH;
    }
    // The rest of a Shift+click selection: outlined, no buttons of their own
    // (the leading item's act on all of them).
    for (const uid of editorState.extraSelectedUids) {
      const extra = layout.furniture.find((f) => f.uid === uid);
      const extraEntry = extra ? getCatalogEntry(extra.type) : undefined;
      if (!extra || !extraEntry) continue;
      render.extraSelections.push({
        col: extra.col,
        row: extra.row,
        w: extraEntry.footprintW,
        h: extraEntry.footprintH,
      });
    }
    // Several items: the buttons go over the box round them all.
    if (render.hasSelection && render.extraSelections.length > 0) {
      const boxes = [
        {
          col: render.selectedCol,
          row: render.selectedRow,
          w: render.selectedW,
          h: render.selectedH,
        },
        ...render.extraSelections,
      ];
      const col = Math.min(...boxes.map((b) => b.col));
      const row = Math.min(...boxes.map((b) => b.row));
      render.selectionBox = {
        col,
        row,
        w: Math.max(...boxes.map((b) => b.col + b.w)) - col,
        h: Math.max(...boxes.map((b) => b.row + b.h)) - row,
      };
    }
    render.isRotatable = editorState.selectedUids.some((uid) => {
      const f = layout.furniture.find((x) => x.uid === uid);
      return !!f && isRotatable(f.type);
    });
  }

  return render;
}
