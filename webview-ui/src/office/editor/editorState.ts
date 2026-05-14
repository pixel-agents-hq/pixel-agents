import type { ColorValue } from "../../components/ui/types.js";
import {
  DEFAULT_FLOOR_COLOR,
  DEFAULT_WALL_COLOR,
  UNDO_STACK_MAX_SIZE,
} from "../../constants.js";
import type { OfficeLayout, TileType as TileTypeVal } from "../types.js";
import { EditTool, TileType } from "../types.js";

export class EditorState {
  isEditMode = false;
  activeTool: EditTool = EditTool.SELECT;
  selectedTileType: TileTypeVal = TileType.FLOOR_1;
  selectedFurnitureType = ""; // asset ID, set when catalog loads

  // Floor color settings (applied to new tiles when painting)
  floorColor: ColorValue = { ...DEFAULT_FLOOR_COLOR };

  // Wall color settings (applied to new wall tiles when painting)
  wallColor: ColorValue = { ...DEFAULT_WALL_COLOR };

  // Selected wall set index (0-based, indexes into loaded wall sets)
  selectedWallSet = 0;

  // Tracks toggle direction during wall drag (true=adding walls, false=removing, null=undecided)
  wallDragAdding: boolean | null = null;

  // Picked furniture color (copied by pick tool, applied on placement)
  pickedFurnitureColor: ColorValue | null = null;

  // Ghost preview position
  ghostCol = -1;
  ghostRow = -1;
  ghostValid = false;

  // Selection
  selectedFurnitureUid: string | null = null;

  // Mouse drag state (tile paint)
  isDragging = false;

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
  ): void {
    this.dragUid = uid;
    this.dragStartCol = startCol;
    this.dragStartRow = startRow;
    this.dragOffsetCol = offsetCol;
    this.dragOffsetRow = offsetRow;
    this.isDragMoving = false;
  }

  clearDrag(): void {
    this.dragUid = null;
    this.isDragMoving = false;
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
  }
}
