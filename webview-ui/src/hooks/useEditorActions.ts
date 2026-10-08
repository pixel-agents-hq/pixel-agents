import { useCallback, useRef, useState } from 'react';

import type { ColorValue } from '../components/ui/types.js';
import {
  CARPET_DEFAULT_ACCENT_COLOR,
  CARPET_DEFAULT_COLOR,
  LAYOUT_SAVE_DEBOUNCE_MS,
  ZOOM_DEFAULT_DPR_FACTOR,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../constants.js';
import type { ExpandDirection } from '../office/editor/editorActions.js';
import {
  addArea,
  areaStrokeErases,
  dropFurniture,
  eraseArea,
  eraseCarpet,
  eraseTile,
  expandLayout,
  furnitureAt,
  isFloorTile,
  paintArea,
  paintCarpet,
  paintTile,
  placeNewFurniture,
  recolorWalls,
  removeArea,
  removeFurniture,
  renameArea,
  rotateFurniture,
  toggleFurnitureState,
  updateAreaColor,
  wallStrokeAdds,
  wallStrokeTile,
} from '../office/editor/editorActions.js';
import type { EditorState } from '../office/editor/editorState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getRotatedType, getToggledType } from '../office/layout/furnitureCatalog.js';
import type {
  EditTool as EditToolType,
  OfficeLayout,
  PlacedPet,
  TileType as TileTypeVal,
} from '../office/types.js';
import { EditTool } from '../office/types.js';
import { TileType } from '../office/types.js';
import { transport } from '../transport/index.js';
import type { FurnitureColorActions } from './useFurnitureColorActions.js';
import { useFurnitureColorActions } from './useFurnitureColorActions.js';

interface EditorActions extends Omit<FurnitureColorActions, 'pickColorAt'> {
  isEditMode: boolean;
  editorTick: number;
  isDirty: boolean;
  zoom: number;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  saveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  setLastSavedLayout: (layout: OfficeLayout) => void;
  /** Clear the dirty flag (used after a browser import applies a new saved baseline). */
  markClean: () => void;
  handleOpenClaude: () => void;
  handleToggleEditMode: () => void;
  handleToolChange: (tool: EditToolType) => void;
  handleTileTypeChange: (type: TileTypeVal) => void;
  handleFloorColorChange: (color: ColorValue) => void;
  handleWallColorChange: (color: ColorValue) => void;
  handleWallSetChange: (setIndex: number) => void;
  handleFurnitureTypeChange: (type: string) => void; // FurnitureType enum or asset ID
  handleDeleteSelected: () => void;
  handleRotateSelected: () => void;
  handleToggleState: () => void;
  handleUndo: () => void;
  handleRedo: () => void;
  handleReset: () => void;
  handleSave: () => void;
  handleZoomChange: (zoom: number) => void;
  handleEditorTileAction: (col: number, row: number) => void;
  handleEditorEraseAction: (col: number, row: number) => void;
  handleEditorSelectionChange: () => void;
  /** A furniture drag released at (col,row): move it there, or drop a copy with `duplicate`. */
  handleDrop: (uid: string, col: number, row: number, opts: { duplicate: boolean }) => void;
  handlePetToggle: (petType: number, active: boolean) => void;
  // Carpet state + handlers
  carpetVariant: number;
  carpetColor: ColorValue;
  carpetAccentColor: ColorValue;
  handleCarpetVariantChange: (variant: number) => void;
  handleCarpetColorChange: (color: ColorValue) => void;
  handleCarpetAccentColorChange: (color: ColorValue) => void;
  handleResetCarpetColor: () => void;
  handleResetCarpetAccentColor: () => void;
  // Area state + handlers (selection lives on editorState for imperative access)
  selectedAreaLabel: string | null;
  handleSelectArea: (label: string | null) => void;
  handleAddArea: (label: string, color: string) => void;
  handleRemoveArea: (label: string) => void;
  handleRenameArea: (oldLabel: string, newLabel: string) => void;
  handleAreaColorChange: (label: string, color: string) => void;
}

/** Default integer zoom (device pixels per sprite pixel) for a fresh session.
 *  Lives here, with the zoom state it seeds, rather than in the office modules:
 *  it reads `devicePixelRatio`, and a viewport concern in a state module drags
 *  the DOM into every graph that imports it (OfficeState's included). */
function defaultZoom(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(ZOOM_MIN, Math.round(ZOOM_DEFAULT_DPR_FACTOR * dpr));
}

export function useEditorActions(
  getOfficeState: () => OfficeState,
  editorState: EditorState,
): EditorActions {
  const [isEditMode, setIsEditMode] = useState(false);
  const [editorTick, setEditorTick] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [zoom, setZoom] = useState(defaultZoom);
  const [carpetVariant, setCarpetVariantState] = useState<number>(editorState.carpetVariant);
  const [carpetColor, setCarpetColorState] = useState<ColorValue>(editorState.carpetColor);
  const [carpetAccentColor, setCarpetAccentColorState] = useState<ColorValue>(
    editorState.carpetAccentColor,
  );
  const [selectedAreaLabel, setSelectedAreaLabelState] = useState<string | null>(
    editorState.selectedAreaLabel,
  );
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const lastSavedLayoutRef = useRef<OfficeLayout | null>(null);

  // Called by useExtensionMessages on layoutLoaded to set the initial checkpoint
  const setLastSavedLayout = useCallback((layout: OfficeLayout) => {
    lastSavedLayoutRef.current = structuredClone(layout);
  }, []);

  // Clear the dirty flag after a browser layout import: the imported layout is the
  // new saved baseline (already persisted via saveLayout). setIsDirty also forces a
  // re-render so dirty-gated UI (EditActionBar, areasAvailable) reflects the import.
  const markClean = useCallback(() => {
    editorState.isDirty = false;
    setIsDirty(false);
  }, [editorState]);

  // Debounced layout save
  const saveLayout = useCallback((layout: OfficeLayout) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      transport.send({ type: 'saveLayout', layout: layout as unknown as Record<string, unknown> });
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }, []);

  const bumpTick = useCallback(() => setEditorTick((n) => n + 1), []);

  /**
   * Apply a layout edit: rebuild state, save, mark dirty — and push undo
   * unless the edit continues the undo session the newest entry already
   * covers (a stroke, a slider run; see EditorState.beginEdit). An edit that
   * returns the current layout unchanged is a no-op.
   */
  const commitLayout = useCallback(
    (newLayout: OfficeLayout, session: string | null) => {
      const os = getOfficeState();
      if (newLayout === os.getLayout()) return; // the edit changed nothing
      if (editorState.beginEdit(session)) {
        editorState.pushUndo(os.getLayout());
        editorState.clearRedo();
      }
      editorState.isDirty = true;
      setIsDirty(true);
      os.rebuildFromLayout(newLayout);
      saveLayout(newLayout);
      bumpTick();
    },
    [getOfficeState, editorState, saveLayout, bumpTick],
  );

  /** A discrete edit: always its own undo entry. */
  const applyEdit = useCallback(
    (newLayout: OfficeLayout) => commitLayout(newLayout, null),
    [commitLayout],
  );

  /**
   * One tile of a click-drag stroke (floor, wall, erase, carpet): the whole
   * stroke shares one undo entry. The stroke is closed on mouse up / mouse
   * leave / tool change / Esc via `editorState.endStroke()`.
   */
  const applyStrokeEdit = useCallback(
    (newLayout: OfficeLayout) => commitLayout(newLayout, 'stroke'),
    [commitLayout],
  );

  const colorActions = useFurnitureColorActions(
    getOfficeState,
    editorState,
    commitLayout,
    bumpTick,
  );

  const handleOpenClaude = useCallback(() => {
    transport.send({ type: 'launchAgent' });
  }, []);

  const handleToggleEditMode = useCallback(() => {
    setIsEditMode((prev) => {
      const next = !prev;
      editorState.isEditMode = next;
      if (next) {
        // Initialize wallColor from existing wall tiles so new walls match
        const os = getOfficeState();
        const layout = os.getLayout();
        if (layout.tileColors) {
          for (let i = 0; i < layout.tiles.length; i++) {
            if (layout.tiles[i] === TileType.WALL && layout.tileColors[i]) {
              editorState.wallColor = { ...layout.tileColors[i]! };
              break;
            }
          }
        }
      } else {
        editorState.clearSelection();
        editorState.clearGhost();
        editorState.clearDrag();
        editorState.endStroke();
      }
      return next;
    });
  }, [editorState, getOfficeState]);

  // Tool toggle: clicking already-active tool deselects it (returns to SELECT)
  const handleToolChange = useCallback(
    (tool: EditToolType) => {
      const next = editorState.activeTool === tool ? EditTool.SELECT : tool;
      editorState.activeTool = next;
      editorState.clearSelection();
      editorState.clearGhost();
      editorState.clearDrag();
      // A stroke (or slider run) never spans a tool change — close it so the
      // next edit starts a fresh undo entry.
      editorState.endStroke();
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  // ── Carpet handlers ──────────────────────────────────────────────
  const handleCarpetVariantChange = useCallback(
    (variant: number) => {
      editorState.carpetVariant = variant;
      setCarpetVariantState(variant);
    },
    [editorState],
  );

  const handleCarpetColorChange = useCallback(
    (color: ColorValue) => {
      editorState.carpetColor = color;
      setCarpetColorState(color);
    },
    [editorState],
  );

  const handleCarpetAccentColorChange = useCallback(
    (color: ColorValue) => {
      editorState.carpetAccentColor = color;
      setCarpetAccentColorState(color);
    },
    [editorState],
  );

  const handleResetCarpetColor = useCallback(() => {
    const next: ColorValue = { ...CARPET_DEFAULT_COLOR };
    editorState.carpetColor = next;
    setCarpetColorState(next);
  }, [editorState]);

  const handleResetCarpetAccentColor = useCallback(() => {
    const next: ColorValue = { ...CARPET_DEFAULT_ACCENT_COLOR };
    editorState.carpetAccentColor = next;
    setCarpetAccentColorState(next);
  }, [editorState]);

  // ── Area handlers ──────────────────────────────────────────────
  const handleSelectArea = useCallback(
    (label: string | null) => {
      editorState.selectedAreaLabel = label;
      setSelectedAreaLabelState(label);
      // Reset stroke direction so the next drag re-decides paint vs erase.
      editorState.areaDragErasing = null;
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  const handleAddArea = useCallback(
    (label: string, color: string) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      const next = addArea(layout, label, color);
      if (next !== layout) {
        applyEdit(next);
      }
    },
    [getOfficeState, applyEdit],
  );

  const handleRemoveArea = useCallback(
    (label: string) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      const next = removeArea(layout, label);
      if (next !== layout) {
        if (editorState.selectedAreaLabel === label) {
          editorState.selectedAreaLabel = null;
          setSelectedAreaLabelState(null);
        }
        applyEdit(next);
      }
    },
    [getOfficeState, editorState, applyEdit],
  );

  const handleRenameArea = useCallback(
    (oldLabel: string, newLabel: string) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      const next = renameArea(layout, oldLabel, newLabel);
      if (next !== layout) {
        const trimmed = newLabel.trim();
        if (editorState.selectedAreaLabel === oldLabel) {
          editorState.selectedAreaLabel = trimmed;
          setSelectedAreaLabelState(trimmed);
        }
        applyEdit(next);
      }
    },
    [getOfficeState, editorState, applyEdit],
  );

  const handleAreaColorChange = useCallback(
    (label: string, color: string) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      const next = updateAreaColor(layout, label, color);
      if (next !== layout) {
        applyEdit(next);
      }
    },
    [getOfficeState, applyEdit],
  );

  const handleTileTypeChange = useCallback(
    (type: TileTypeVal) => {
      editorState.selectedTileType = type;
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  const handleFloorColorChange = useCallback(
    (color: ColorValue) => {
      editorState.floorColor = color;
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  // Recolours every existing wall; a slider run is one undo entry.
  const handleWallColorChange = useCallback(
    (color: ColorValue) => {
      editorState.wallColor = color;
      const layout = getOfficeState().getLayout();
      const newLayout = recolorWalls(layout, color);
      if (newLayout !== layout) {
        commitLayout(newLayout, 'wallColor');
      } else {
        bumpTick();
      }
    },
    [editorState, getOfficeState, commitLayout, bumpTick],
  );

  const handleWallSetChange = useCallback(
    (setIndex: number) => {
      editorState.selectedWallSet = setIndex;
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  const handleFurnitureTypeChange = useCallback(
    (type: string) => {
      // Clicking the same item deselects it (no ghost), stays in furniture mode.
      // A catalog item is placed in the palette colour — any colour the Copy
      // tool lifted leaves with the item it was lifted for.
      if (editorState.placingType === type) {
        editorState.placing = null;
        editorState.clearGhost();
      } else {
        editorState.placing = { type };
        // Picking from the catalog means "place this", not "edit that" — drop any
        // placed selection so R/T have exactly one target.
        editorState.clearSelection();
      }
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  const handleDeleteSelected = useCallback(() => {
    const uid = editorState.selectedFurnitureUid;
    if (!uid) return;
    const os = getOfficeState();
    const newLayout = removeFurniture(os.getLayout(), uid);
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout);
      editorState.clearSelection();
    }
  }, [getOfficeState, editorState, applyEdit]);

  const handleRotateSelected = useCallback(() => {
    // A placed item is only ever selected when no catalog item is (picking one
    // clears the selection), so selection wins: rotating with the Furniture tab
    // open must still turn the item the rotate button is pointing at.
    const uid = editorState.selectedFurnitureUid;
    // In furniture placement mode with nothing selected, cycle the catalog type
    // through its rotation group instead (rotates the ghost preview).
    if (!uid && editorState.activeTool === EditTool.FURNITURE_PLACE) {
      const rotated = editorState.placing && getRotatedType(editorState.placing.type, 'cw');
      if (editorState.placing && rotated) {
        editorState.placing = { ...editorState.placing, type: rotated };
        bumpTick();
      }
      return;
    }
    if (!uid) return;
    const os = getOfficeState();
    const newLayout = rotateFurniture(os.getLayout(), uid, 'cw');
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout);
    }
  }, [getOfficeState, editorState, applyEdit, bumpTick]);

  const handleToggleState = useCallback(() => {
    // Same precedence as rotate: a selected placed item wins over the catalog
    // type, so T works with the Furniture tab open.
    const uid = editorState.selectedFurnitureUid;
    if (!uid && editorState.activeTool === EditTool.FURNITURE_PLACE) {
      const toggled = editorState.placing && getToggledType(editorState.placing.type);
      if (editorState.placing && toggled) {
        editorState.placing = { ...editorState.placing, type: toggled };
        bumpTick();
      }
      return;
    }
    if (!uid) return;
    const os = getOfficeState();
    const newLayout = toggleFurnitureState(os.getLayout(), uid);
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout);
    }
  }, [getOfficeState, editorState, applyEdit, bumpTick]);

  const handleUndo = useCallback(() => {
    const prev = editorState.popUndo();
    if (!prev) return;
    editorState.endStroke(); // the next edit can't extend an entry that's been undone
    const os = getOfficeState();
    // Push current layout to redo stack before restoring
    editorState.pushRedo(os.getLayout());
    os.rebuildFromLayout(prev);
    saveLayout(prev);
    editorState.isDirty = true;
    setIsDirty(true);
    setEditorTick((n) => n + 1);
  }, [getOfficeState, editorState, saveLayout]);

  const handleRedo = useCallback(() => {
    const next = editorState.popRedo();
    if (!next) return;
    editorState.endStroke();
    const os = getOfficeState();
    // Push current layout to undo stack before restoring
    editorState.pushUndo(os.getLayout());
    os.rebuildFromLayout(next);
    saveLayout(next);
    editorState.isDirty = true;
    setIsDirty(true);
    setEditorTick((n) => n + 1);
  }, [getOfficeState, editorState, saveLayout]);

  const handleReset = useCallback(() => {
    if (!lastSavedLayoutRef.current) return;
    const saved = structuredClone(lastSavedLayoutRef.current);
    applyEdit(saved);
    editorState.reset();
    setIsDirty(false);
  }, [editorState, applyEdit]);

  const handleSave = useCallback(() => {
    // Flush any pending debounced save immediately
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const os = getOfficeState();
    const layout = os.getLayout();
    lastSavedLayoutRef.current = structuredClone(layout);
    transport.send({ type: 'saveLayout', layout: layout as unknown as Record<string, unknown> });
    editorState.isDirty = false;
    setIsDirty(false);
  }, [getOfficeState, editorState]);

  // Notify React that imperative editor selection changed (e.g., from OfficeCanvas mouseUp)
  const handleEditorSelectionChange = bumpTick;

  const handleZoomChange = useCallback((newZoom: number) => {
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom)));
  }, []);

  /**
   * A furniture drag released at (col,row): validate, commit, and settle the
   * selection in one place — a copy is left selected so R / T / the colour
   * sliders act on what was just dropped; a move (or a refused drop) leaves
   * nothing selected.
   */
  const handleDrop = useCallback(
    (uid: string, col: number, row: number, opts: { duplicate: boolean }) => {
      const result = dropFurniture(getOfficeState().getLayout(), uid, col, row, opts);
      if (result) applyEdit(result.layout);
      editorState.setSelection(result?.selectedUid ?? null);
      bumpTick();
    },
    [getOfficeState, editorState, applyEdit, bumpTick],
  );

  /**
   * Expand layout if click is on a ghost border tile (outside current bounds).
   * Returns the expanded layout and adjusted col/row, or null if no expansion needed.
   */
  const maybeExpand = useCallback(
    (
      layout: OfficeLayout,
      col: number,
      row: number,
    ): {
      layout: OfficeLayout;
      col: number;
      row: number;
      shift: { col: number; row: number };
    } | null => {
      if (col >= 0 && col < layout.cols && row >= 0 && row < layout.rows) return null;

      // Determine which directions to expand
      const directions: ExpandDirection[] = [];
      if (col < 0) directions.push('left');
      if (col >= layout.cols) directions.push('right');
      if (row < 0) directions.push('up');
      if (row >= layout.rows) directions.push('down');

      let current = layout;
      let totalShiftCol = 0;
      let totalShiftRow = 0;
      for (const dir of directions) {
        const result = expandLayout(current, dir);
        if (!result) return null; // exceeded max
        current = result.layout;
        totalShiftCol += result.shift.col;
        totalShiftRow += result.shift.row;
      }

      return {
        layout: current,
        col: col + totalShiftCol,
        row: row + totalShiftRow,
        shift: { col: totalShiftCol, row: totalShiftRow },
      };
    },
    [],
  );

  const handlePetToggle = useCallback(
    (petType: number, active: boolean) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      const currentPets: PlacedPet[] = layout.pets ?? [];

      let newPets: PlacedPet[];
      if (active) {
        // Idempotent: if this pet type is already placed, no-op (prevent double-write).
        if (currentPets.some((p) => p.petType === petType)) {
          return;
        }
        newPets = [...currentPets, { id: crypto.randomUUID(), petType }];
      } else {
        newPets = currentPets.filter((p) => p.petType !== petType);
        // Idempotent: nothing to remove → no-op.
        if (newPets.length === currentPets.length) {
          return;
        }
      }

      const newLayout: OfficeLayout = { ...layout, pets: newPets };
      applyEdit(newLayout);
    },
    [getOfficeState, applyEdit],
  );

  /**
   * The active tool acting on (col,row): a click, or a tile crossed while
   * dragging. Selecting and dragging placed items never get here — the canvas
   * resolves those itself — so each case is a tool applying its edit.
   */
  const handleEditorTileAction = useCallback(
    (col: number, row: number) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      switch (editorState.activeTool) {
        case EditTool.TILE_PAINT:
        case EditTool.WALL_PAINT: {
          // Floor and wall tools grow the grid when they hit the ghost border;
          // rebuild from the expanded layout first, shifting characters along.
          const expansion = maybeExpand(layout, col, row);
          if (expansion) os.rebuildFromLayout(expansion.layout, expansion.shift);
          const base = expansion?.layout ?? layout;
          const c = expansion?.col ?? col;
          const r = expansion?.row ?? row;
          const floor = { type: editorState.selectedTileType, color: editorState.floorColor };
          if (editorState.activeTool === EditTool.TILE_PAINT) {
            applyStrokeEdit(paintTile(base, c, r, floor.type, floor.color));
          } else {
            // The stroke's first tile decides whether it adds or removes walls.
            editorState.wallDragAdding ??= wallStrokeAdds(base, c, r);
            const adding = editorState.wallDragAdding;
            applyStrokeEdit(wallStrokeTile(base, c, r, adding, editorState.wallColor, floor));
          }
          return;
        }
        case EditTool.ERASE:
          applyStrokeEdit(eraseTile(layout, col, row));
          return;
        case EditTool.CARPET_PAINT:
          applyStrokeEdit(
            paintCarpet(
              layout,
              col,
              row,
              editorState.carpetVariant,
              editorState.carpetColor,
              editorState.carpetAccentColor,
            ),
          );
          return;
        case EditTool.FURNITURE_PLACE: {
          const placing = editorState.placing;
          if (!placing) return;
          applyEdit(
            placeNewFurniture(layout, placing.type, col, row, editorState.placementColor()),
          );
          return;
        }
        case EditTool.FURNITURE_PICK: {
          // Copy a placed item: its type, plus its colour for this copy only —
          // writing the palette-wide colour would restyle every catalog preview.
          const hit = furnitureAt(layout, col, row);
          if (hit) {
            editorState.placing = { type: hit.type, ...(hit.color && { color: { ...hit.color } }) };
            editorState.activeTool = EditTool.FURNITURE_PLACE;
          }
          bumpTick();
          return;
        }
        case EditTool.COLOR_PICK:
          colorActions.pickColorAt(col, row);
          return;
        case EditTool.EYEDROPPER: {
          const idx = row * layout.cols + col;
          const tile = layout.tiles[idx];
          const color = layout.tileColors?.[idx];
          if (tile === TileType.WALL) {
            // Pick wall color and switch to wall tool
            if (color) editorState.wallColor = { ...color };
            editorState.activeTool = EditTool.WALL_PAINT;
          } else if (tile !== undefined && tile !== TileType.VOID) {
            editorState.selectedTileType = tile;
            if (color) editorState.floorColor = { ...color };
            editorState.activeTool = EditTool.TILE_PAINT;
          }
          bumpTick();
          return;
        }
        case EditTool.AREA_PAINT: {
          // The first tile of a drag decides whether the stroke paints (default)
          // or erases (when that tile already had this label). Each tile is its
          // own undo entry — area painting is deliberate and low-velocity.
          const label = editorState.selectedAreaLabel;
          if (!label || !isFloorTile(layout, col, row)) return;
          editorState.areaDragErasing ??= areaStrokeErases(layout, col, row, label);
          applyEdit(
            editorState.areaDragErasing
              ? eraseArea(layout, col, row)
              : paintArea(layout, col, row, label),
          );
          return;
        }
        case EditTool.CARPET_PICK: {
          const tile = isFloorTile(layout, col, row)
            ? layout.carpetTiles?.[row * layout.cols + col]
            : null;
          if (!tile) return;
          editorState.carpetVariant = tile.variant;
          setCarpetVariantState(tile.variant);
          if (tile.color) {
            const next = { ...tile.color };
            editorState.carpetColor = next;
            setCarpetColorState(next);
          }
          if (tile.accentColor) {
            const next = { ...tile.accentColor };
            editorState.carpetAccentColor = next;
            setCarpetAccentColorState(next);
          }
          editorState.activeTool = EditTool.CARPET_PAINT;
          bumpTick();
          return;
        }
      }
    },
    [getOfficeState, editorState, applyEdit, applyStrokeEdit, maybeExpand, colorActions, bumpTick],
  );

  /**
   * Right-click / right-drag on (col,row): erase with the active tool's own
   * meaning — area and carpet tools clear their layer, everything else erases
   * the tile and the furniture it crosses.
   */
  const handleEditorEraseAction = useCallback(
    (col: number, row: number) => {
      const layout = getOfficeState().getLayout();
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return;
      switch (editorState.activeTool) {
        case EditTool.AREA_PAINT:
          // Clears whatever area is on the tile, regardless of the selected label.
          // Per-tile undo, matching left-click area paint.
          applyEdit(eraseArea(layout, col, row));
          return;
        case EditTool.CARPET_PAINT:
          applyStrokeEdit(eraseCarpet(layout, col, row));
          return;
        default:
          applyStrokeEdit(eraseTile(layout, col, row));
      }
    },
    [getOfficeState, editorState, applyEdit, applyStrokeEdit],
  );

  return {
    isEditMode,
    editorTick,
    isDirty,
    zoom,
    panRef,
    saveTimerRef,
    setLastSavedLayout,
    markClean,
    handleOpenClaude,
    handleToggleEditMode,
    handleToolChange,
    handleTileTypeChange,
    handleFloorColorChange,
    handleWallColorChange,
    handleWallSetChange,
    handleSelectedFurnitureColorChange: colorActions.handleSelectedFurnitureColorChange,
    handlePickedFurnitureColorChange: colorActions.handlePickedFurnitureColorChange,
    handleColorPickToggle: colorActions.handleColorPickToggle,
    handleFurnitureTypeChange,
    handleDeleteSelected,
    handleRotateSelected,
    handleToggleState,
    handleUndo,
    handleRedo,
    handleReset,
    handleSave,
    handleZoomChange,
    handleEditorTileAction,
    handleEditorEraseAction,
    handleEditorSelectionChange,
    handleDrop,
    handlePetToggle,
    carpetVariant,
    carpetColor,
    carpetAccentColor,
    handleCarpetVariantChange,
    handleCarpetColorChange,
    handleCarpetAccentColorChange,
    handleResetCarpetColor,
    handleResetCarpetAccentColor,
    selectedAreaLabel,
    handleSelectArea,
    handleAddArea,
    handleRemoveArea,
    handleRenameArea,
    handleAreaColorChange,
  };
}
