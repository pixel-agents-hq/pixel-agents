import type { ColorValue } from '../../components/ui/types.js';
import {
  CARPET_DEFAULT_ACCENT_COLOR,
  CARPET_DEFAULT_COLOR,
  DEFAULT_FLOOR_COLOR,
  DEFAULT_WALL_COLOR,
  UNDO_STACK_MAX_SIZE,
} from '../../constants.js';
import type { OfficeLayout, TileType as TileTypeVal } from '../types.js';
import { EditTool, TileType } from '../types.js';

export class EditorState {
  isEditMode = false;
  activeTool: EditTool = EditTool.SELECT;
  selectedTileType: TileTypeVal = TileType.FLOOR_1;
  selectedFurnitureType = ''; // asset ID, set when catalog loads

  // Floor color settings (applied to new tiles when painting)
  floorColor: ColorValue = { ...DEFAULT_FLOOR_COLOR };

  // Wall color settings (applied to new wall tiles when painting)
  wallColor: ColorValue = { ...DEFAULT_WALL_COLOR };

  // Selected wall set index (0-based, indexes into loaded wall sets)
  selectedWallSet = 0;

  // Tracks toggle direction during wall drag (true=adding walls, false=removing, null=undecided)
  wallDragAdding: boolean | null = null;

  /**
   * Palette-wide colour for new furniture: set from the Furniture tab's Color
   * sliders, tints every catalog thumbnail, and applies to whatever is placed.
   */
  pickedFurnitureColor: ColorValue | null = null;

  /**
   * Colour lifted off a placed item by the Copy tool. Deliberately separate
   * from `pickedFurnitureColor`: copying an item styles that copy and nothing
   * else, so the catalog previews and every other new item stay as they were.
   * Dropped as soon as a catalog item, a palette colour, or another tool is
   * chosen.
   */
  copiedFurnitureColor: ColorValue | null = null;

  /** Tool the colour eyedropper returns to once it has taken a colour (or is cancelled). */
  colorPickReturnTool: EditTool = EditTool.SELECT;

  // Ghost preview position
  ghostCol = -1;
  ghostRow = -1;
  ghostValid = false;

  // Selection
  selectedFurnitureUid: string | null = null;

  // Mouse drag state (tile paint)
  isDragging = false;

  /**
   * Layout snapshot taken at the first tile of the current paint/erase stroke.
   * Non-null means a stroke is in progress, so later tiles of the same
   * click-drag must not push another undo entry — one stroke = one undo.
   * Shared by every drag-painting tool (floor, wall, erase, carpet). Cleared on
   * mouse up / mouse leave / tool change / Esc.
   */
  strokeInitialLayout: OfficeLayout | null = null;

  // Undo / Redo stacks
  undoStack: OfficeLayout[] = [];
  redoStack: OfficeLayout[] = [];

  // Dirty flag — true when layout differs from last save
  isDirty = false;

  // Drag-to-move state
  dragUid: string | null = null;
  dragStartCol = 0;
  dragStartRow = 0;
  dragOffsetCol = 0;
  dragOffsetRow = 0;
  isDragMoving = false;
  /**
   * Alt held during the current drag → drop a copy of the item (and everything
   * on its surface) instead of moving it. Tracked live off every mouse event of
   * the drag, so pressing or releasing Alt mid-drag flips the ghost, and the
   * drop always commits whatever the ghost last showed.
   */
  dragDuplicate = false;

  // ── Carpet editor state ──────────────────────────────────────────
  /** Currently selected carpet variant for paint. */
  carpetVariant = 0;
  /** Main color applied by the carpet paint tool. */
  carpetColor: ColorValue = { ...CARPET_DEFAULT_COLOR };
  /** Accent color applied by the carpet paint tool. */
  carpetAccentColor: ColorValue = { ...CARPET_DEFAULT_ACCENT_COLOR };
  /** Stroke direction: true=erase, false=paint, null=stroke not yet started. */
  carpetDragErasing: boolean | null = null;

  // ── Area editor state ────────────────────────────────────────────
  /** Which Area label is the AREA_PAINT tool currently painting. */
  selectedAreaLabel: string | null = null;
  /** First tile of an area drag sets direction: true=erase same label, false=paint. */
  areaDragErasing: boolean | null = null;

  /**
   * Open a stroke. Returns true only for the first tile of a click-drag — the
   * caller pushes undo then. Later tiles return false and ride the same entry.
   */
  beginStroke(layout: OfficeLayout): boolean {
    if (this.strokeInitialLayout !== null) return false;
    this.strokeInitialLayout = layout;
    return true;
  }

  /** Close the current stroke so the next one starts a fresh undo entry. */
  endStroke(): void {
    this.strokeInitialLayout = null;
    this.carpetDragErasing = null;
    this.areaDragErasing = null;
    this.wallDragAdding = null;
  }

  pushUndo(layout: OfficeLayout): void {
    this.undoStack.push(layout);
    // Limit undo stack size
    if (this.undoStack.length > UNDO_STACK_MAX_SIZE) {
      this.undoStack.shift();
    }
  }

  popUndo(): OfficeLayout | null {
    return this.undoStack.pop() || null;
  }

  pushRedo(layout: OfficeLayout): void {
    this.redoStack.push(layout);
    if (this.redoStack.length > UNDO_STACK_MAX_SIZE) {
      this.redoStack.shift();
    }
  }

  popRedo(): OfficeLayout | null {
    return this.redoStack.pop() || null;
  }

  clearRedo(): void {
    this.redoStack = [];
  }

  clearSelection(): void {
    this.selectedFurnitureUid = null;
  }

  /**
   * Select a placed item the way a click on it does, collapsing whatever tool
   * tab is open: picking something out of the office means "work on this one",
   * so the Furniture / Floor / Walls panel gets out of the way and the toolbar
   * is left showing the item's own controls. The picked catalog type survives —
   * reopening the Furniture tab resumes placing what was being placed.
   */
  selectPlacedFurniture(uid: string): void {
    this.selectedFurnitureUid = uid;
    this.activeTool = EditTool.SELECT;
    this.clearGhost();
  }

  /**
   * Colour the next placed item gets, and the colour its ghost previews: a
   * colour copied off an existing item wins over the palette-wide one, for as
   * long as that copy is what's being placed.
   */
  placementColor(): ColorValue | null {
    return this.copiedFurnitureColor ?? this.pickedFurnitureColor;
  }

  /**
   * Arm the colour-only eyedropper, remembering the tool to come back to — it
   * can be armed from the palette sliders (Furniture tab) or from a selected
   * item's sliders, and each has to return to its own tool.
   */
  beginColorPick(): void {
    if (this.activeTool === EditTool.COLOR_PICK) return;
    this.colorPickReturnTool = this.activeTool;
    this.activeTool = EditTool.COLOR_PICK;
    this.clearGhost();
  }

  /** Leave the colour eyedropper, armed or spent, for the tool it came from. */
  endColorPick(): void {
    this.activeTool = this.colorPickReturnTool;
  }

  clearGhost(): void {
    this.ghostCol = -1;
    this.ghostRow = -1;
    this.ghostValid = false;
  }

  startDrag(
    uid: string,
    startCol: number,
    startRow: number,
    offsetCol: number,
    offsetRow: number,
    duplicate = false,
  ): void {
    this.dragUid = uid;
    this.dragStartCol = startCol;
    this.dragStartRow = startRow;
    this.dragOffsetCol = offsetCol;
    this.dragOffsetRow = offsetRow;
    this.isDragMoving = false;
    this.dragDuplicate = duplicate;
  }

  clearDrag(): void {
    this.dragUid = null;
    this.isDragMoving = false;
    this.dragDuplicate = false;
  }

  reset(): void {
    this.activeTool = EditTool.SELECT;
    this.selectedFurnitureUid = null;
    this.ghostCol = -1;
    this.ghostRow = -1;
    this.ghostValid = false;
    this.isDragging = false;
    this.wallDragAdding = null;
    this.undoStack = [];
    this.redoStack = [];
    this.isDirty = false;
    this.dragUid = null;
    this.isDragMoving = false;
    this.dragDuplicate = false;
    this.copiedFurnitureColor = null;
    this.carpetVariant = 0;
    this.carpetColor = { ...CARPET_DEFAULT_COLOR };
    this.carpetAccentColor = { ...CARPET_DEFAULT_ACCENT_COLOR };
    this.carpetDragErasing = null;
    this.strokeInitialLayout = null;
    this.selectedAreaLabel = null;
    this.areaDragErasing = null;
  }
}
