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
  canPlaceFurniture,
  duplicateFurniture,
  eraseArea,
  eraseCarpet,
  expandLayout,
  freshFurnitureUid,
  getWallPlacementRow,
  moveFurniture,
  paintArea,
  paintCarpet,
  paintTile,
  placeFurniture,
  removeArea,
  removeFurniture,
  removeFurnitureAt,
  renameArea,
  rotateFurniture,
  toggleFurnitureState,
  updateAreaColor,
} from '../office/editor/editorActions.js';
import type { EditorState } from '../office/editor/editorState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import {
  getCatalogEntry,
  getRotatedType,
  getToggledType,
} from '../office/layout/furnitureCatalog.js';
import type {
  EditTool as EditToolType,
  OfficeLayout,
  PlacedFurniture,
  PlacedPet,
  TileType as TileTypeVal,
} from '../office/types.js';
import { EditTool } from '../office/types.js';
import { TileType } from '../office/types.js';
import { transport } from '../transport/index.js';

interface EditorActions {
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
  handleSelectedFurnitureColorChange: (color: ColorValue | null) => void;
  handlePickedFurnitureColorChange: (color: ColorValue | null) => void;
  /** Arm/disarm the colour-only eyedropper offered by the colour sliders. */
  handleColorPickToggle: () => void;
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
  handleDragMove: (uid: string, newCol: number, newRow: number) => void;
  handleDragDuplicate: (uid: string, newCol: number, newRow: number) => void;
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

/** First placed item whose footprint covers (col,row), or undefined. */
function furnitureAt(layout: OfficeLayout, col: number, row: number): PlacedFurniture | undefined {
  return layout.furniture.find((f) => {
    const entry = getCatalogEntry(f.type);
    if (!entry) return false;
    return (
      col >= f.col &&
      col < f.col + entry.footprintW &&
      row >= f.row &&
      row < f.row + entry.footprintH
    );
  });
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

  // Apply a layout edit: push undo, clear redo, rebuild state, save, mark dirty
  const applyEdit = useCallback(
    (newLayout: OfficeLayout) => {
      const os = getOfficeState();
      editorState.pushUndo(os.getLayout());
      editorState.clearRedo();
      editorState.isDirty = true;
      setIsDirty(true);
      os.rebuildFromLayout(newLayout);
      saveLayout(newLayout);
      setEditorTick((n) => n + 1);
    },
    [getOfficeState, editorState, saveLayout],
  );

  /**
   * Apply one tile of a click-drag stroke. The first tile pushes a single undo
   * entry; every later tile of the same stroke mutates without pushing, so the
   * whole stroke collapses to one undo. The stroke is closed on mouse up /
   * mouse leave / tool change / Esc via `editorState.endStroke()`.
   */
  const applyStrokeEdit = useCallback(
    (newLayout: OfficeLayout) => {
      const os = getOfficeState();
      const current = os.getLayout();
      if (editorState.beginStroke(current)) {
        editorState.pushUndo(current);
        editorState.clearRedo();
      }
      editorState.isDirty = true;
      setIsDirty(true);
      os.rebuildFromLayout(newLayout);
      saveLayout(newLayout);
      setEditorTick((n) => n + 1);
    },
    [getOfficeState, editorState, saveLayout],
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
        wallColorEditActiveRef.current = false;
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
      // Switching tools ends the copied item's run (the Copy tool sets its own
      // color after this runs, so a fresh copy is unaffected).
      editorState.copiedFurnitureColor = null;
      colorEditUidRef.current = null;
      wallColorEditActiveRef.current = false;
      // A stroke can never span a tool change — close it so the next click
      // starts a fresh undo entry.
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

  // Track whether we've already pushed undo for the current wall color editing session
  const wallColorEditActiveRef = useRef(false);

  const handleWallColorChange = useCallback(
    (color: ColorValue) => {
      editorState.wallColor = color;

      // Update all existing wall tiles to the new color
      const os = getOfficeState();
      const layout = os.getLayout();
      const existingColors = layout.tileColors || new Array(layout.tiles.length).fill(null);
      const newColors = [...existingColors];
      let changed = false;
      for (let i = 0; i < layout.tiles.length; i++) {
        if (layout.tiles[i] === TileType.WALL) {
          newColors[i] = { ...color };
          changed = true;
        }
      }
      if (changed) {
        // Push undo only once per editing session (first slider touch)
        if (!wallColorEditActiveRef.current) {
          editorState.pushUndo(layout);
          editorState.clearRedo();
          wallColorEditActiveRef.current = true;
        }
        const newLayout = { ...layout, tileColors: newColors };
        editorState.isDirty = true;
        setIsDirty(true);
        os.rebuildFromLayout(newLayout);
        saveLayout(newLayout);
      }
      setEditorTick((n) => n + 1);
    },
    [editorState, getOfficeState, saveLayout],
  );

  const handleWallSetChange = useCallback(
    (setIndex: number) => {
      editorState.selectedWallSet = setIndex;
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  // Track which uid we've already pushed undo for during color editing
  // so dragging sliders doesn't create N undo entries
  const colorEditUidRef = useRef<string | null>(null);

  const handleSelectedFurnitureColorChange = useCallback(
    (color: ColorValue | null) => {
      const uid = editorState.selectedFurnitureUid;
      if (!uid) return;
      const os = getOfficeState();
      const layout = os.getLayout();

      // Push undo only once per selection (first slider touch)
      if (colorEditUidRef.current !== uid) {
        editorState.pushUndo(layout);
        editorState.clearRedo();
        colorEditUidRef.current = uid;
      }

      // Update color on the placed furniture item (null removes color)
      const newFurniture = layout.furniture.map((f) =>
        f.uid === uid ? { ...f, color: color ?? undefined } : f,
      );
      const newLayout = { ...layout, furniture: newFurniture };

      editorState.isDirty = true;
      setIsDirty(true);
      os.rebuildFromLayout(newLayout);
      saveLayout(newLayout);
      setEditorTick((n) => n + 1);
    },
    [getOfficeState, editorState, saveLayout],
  );

  // Color applied to NEWLY placed furniture (and the palette/ghost previews).
  // Stored imperatively on editorState; placement reads it in the click handler.
  const handlePickedFurnitureColorChange = useCallback(
    (color: ColorValue | null) => {
      editorState.pickedFurnitureColor = color;
      // Reaching for the sliders is a deliberate choice of color — it outranks
      // whatever the Copy tool lifted off a placed item.
      editorState.copiedFurnitureColor = null;
      setEditorTick((n) => n + 1);
    },
    [editorState],
  );

  /**
   * Arm (or disarm) the colour-only eyedropper from a set of colour sliders.
   * The next canvas click takes a placed item's colour into those sliders and
   * hands the tool back — see the COLOR_PICK branch in handleEditorTileAction.
   */
  const handleColorPickToggle = useCallback(() => {
    if (editorState.activeTool === EditTool.COLOR_PICK) {
      editorState.endColorPick();
    } else {
      editorState.beginColorPick();
    }
    setEditorTick((n) => n + 1);
  }, [editorState]);

  const handleFurnitureTypeChange = useCallback(
    (type: string) => {
      // Picking from the catalog ends the copied item's run, so its color goes
      // with it — the palette color is what a catalog item is placed in.
      editorState.copiedFurnitureColor = null;
      // Clicking the same item deselects it (no ghost), stays in furniture mode
      if (editorState.selectedFurnitureType === type) {
        editorState.selectedFurnitureType = '';
        editorState.clearGhost();
      } else {
        editorState.selectedFurnitureType = type;
        // Picking from the catalog means "place this", not "edit that" — drop any
        // placed selection so R/T have exactly one target.
        editorState.clearSelection();
        colorEditUidRef.current = null;
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
      colorEditUidRef.current = null;
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
      const rotated = getRotatedType(editorState.selectedFurnitureType, 'cw');
      if (rotated) {
        editorState.selectedFurnitureType = rotated;
        setEditorTick((n) => n + 1);
      }
      return;
    }
    if (!uid) return;
    const os = getOfficeState();
    const newLayout = rotateFurniture(os.getLayout(), uid, 'cw');
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout);
    }
  }, [getOfficeState, editorState, applyEdit]);

  const handleToggleState = useCallback(() => {
    // Same precedence as rotate: a selected placed item wins over the catalog
    // type, so T works with the Furniture tab open.
    const uid = editorState.selectedFurnitureUid;
    if (!uid && editorState.activeTool === EditTool.FURNITURE_PLACE) {
      const toggled = getToggledType(editorState.selectedFurnitureType);
      if (toggled) {
        editorState.selectedFurnitureType = toggled;
        setEditorTick((n) => n + 1);
      }
      return;
    }
    if (!uid) return;
    const os = getOfficeState();
    const newLayout = toggleFurnitureState(os.getLayout(), uid);
    if (newLayout !== os.getLayout()) {
      applyEdit(newLayout);
    }
  }, [getOfficeState, editorState, applyEdit]);

  const handleUndo = useCallback(() => {
    const prev = editorState.popUndo();
    if (!prev) return;
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
  const handleEditorSelectionChange = useCallback(() => {
    colorEditUidRef.current = null;
    setEditorTick((n) => n + 1);
  }, []);

  const handleZoomChange = useCallback((newZoom: number) => {
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom)));
  }, []);

  const handleDragMove = useCallback(
    (uid: string, newCol: number, newRow: number) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      const newLayout = moveFurniture(layout, uid, newCol, newRow);
      if (newLayout !== layout) {
        applyEdit(newLayout);
      }
    },
    [getOfficeState, applyEdit],
  );

  /**
   * Alt-drag drop: stamp a copy of the dragged item plus everything on its
   * surface at the target, leaving the originals alone. The copy becomes the
   * selection so R / T / the colour sliders act on what was just dropped.
   */
  const handleDragDuplicate = useCallback(
    (uid: string, newCol: number, newRow: number) => {
      const os = getOfficeState();
      const result = duplicateFurniture(os.getLayout(), uid, newCol, newRow);
      if (!result) return;
      applyEdit(result.layout);
      editorState.selectedFurnitureUid = result.uid;
      colorEditUidRef.current = null;
    },
    [getOfficeState, editorState, applyEdit],
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

  const handleEditorTileAction = useCallback(
    (col: number, row: number) => {
      const os = getOfficeState();
      let layout = os.getLayout();
      let effectiveCol = col;
      let effectiveRow = row;

      // Handle ghost border expansion for floor/wall tools
      if (
        editorState.activeTool === EditTool.TILE_PAINT ||
        editorState.activeTool === EditTool.WALL_PAINT
      ) {
        const expansion = maybeExpand(layout, col, row);
        if (expansion) {
          layout = expansion.layout;
          effectiveCol = expansion.col;
          effectiveRow = expansion.row;
          // Rebuild from expanded layout first, shifting character positions
          os.rebuildFromLayout(layout, expansion.shift);
        }
      }

      if (editorState.activeTool === EditTool.TILE_PAINT) {
        const newLayout = paintTile(
          layout,
          effectiveCol,
          effectiveRow,
          editorState.selectedTileType,
          editorState.floorColor,
        );
        if (newLayout !== layout) {
          applyStrokeEdit(newLayout);
        }
      } else if (editorState.activeTool === EditTool.WALL_PAINT) {
        const idx = effectiveRow * layout.cols + effectiveCol;
        const isWall = layout.tiles[idx] === TileType.WALL;

        // First tile of drag sets direction
        if (editorState.wallDragAdding === null) {
          editorState.wallDragAdding = !isWall;
        }

        if (editorState.wallDragAdding) {
          // Add wall with color
          const newLayout = paintTile(
            layout,
            effectiveCol,
            effectiveRow,
            TileType.WALL,
            editorState.wallColor,
          );
          if (newLayout !== layout) {
            applyStrokeEdit(newLayout);
          }
        } else {
          // Remove wall → paint floor with current floor settings
          if (isWall) {
            const newLayout = paintTile(
              layout,
              effectiveCol,
              effectiveRow,
              editorState.selectedTileType,
              editorState.floorColor,
            );
            if (newLayout !== layout) {
              applyStrokeEdit(newLayout);
            }
          }
        }
      } else if (editorState.activeTool === EditTool.ERASE) {
        if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return;
        const idx = row * layout.cols + col;
        // Erase clears the tile to VOID and deletes any furniture it passes through.
        let newLayout = layout;
        if (newLayout.tiles[idx] !== TileType.VOID) {
          newLayout = paintTile(newLayout, col, row, TileType.VOID);
        }
        newLayout = removeFurnitureAt(newLayout, col, row);
        if (newLayout !== layout) {
          applyStrokeEdit(newLayout);
        }
      } else if (editorState.activeTool === EditTool.FURNITURE_PLACE) {
        const type = editorState.selectedFurnitureType;
        if (type === '') {
          // No item selected — act like SELECT (find furniture hit). Hitting one
          // closes this panel; hitting bare floor just drops the selection and
          // leaves the catalog open.
          const hit = furnitureAt(layout, col, row);
          if (hit) {
            editorState.selectPlacedFurniture(hit.uid);
          } else {
            editorState.clearSelection();
          }
          setEditorTick((n) => n + 1);
        } else {
          const placementRow = getWallPlacementRow(type, row);
          if (!canPlaceFurniture(layout, type, col, placementRow)) return;
          const uid = freshFurnitureUid(new Set(layout.furniture.map((f) => f.uid)));
          const placed: PlacedFurniture = { uid, type, col, row: placementRow };
          const color = editorState.placementColor();
          if (color) {
            placed.color = { ...color };
          }
          const newLayout = placeFurniture(layout, placed);
          if (newLayout !== layout) {
            applyEdit(newLayout);
          }
        }
      } else if (editorState.activeTool === EditTool.FURNITURE_PICK) {
        // Find furniture at clicked tile, copy its type and color for placement
        const hit = furnitureAt(layout, col, row);
        if (hit) {
          editorState.selectedFurnitureType = hit.type;
          // Scoped to this copy — writing the palette-wide color here would
          // restyle every catalog preview and every other new item.
          editorState.copiedFurnitureColor = hit.color ? { ...hit.color } : null;
          editorState.activeTool = EditTool.FURNITURE_PLACE;
        }
        setEditorTick((n) => n + 1);
      } else if (editorState.activeTool === EditTool.COLOR_PICK) {
        // Colour-only eyedropper, armed from a set of sliders: take the clicked
        // item's colour into whichever sliders armed it — a selected item's own
        // colour, or the palette colour for new furniture — and leave types
        // alone. An item with no colour of its own copies as "no colour", the
        // same as Reset. Any click ends the mode, so clicking bare floor is how
        // you back out.
        const hit = furnitureAt(layout, col, row);
        if (hit) {
          const color = hit.color ? { ...hit.color } : null;
          if (editorState.selectedFurnitureUid) {
            handleSelectedFurnitureColorChange(color);
          } else {
            handlePickedFurnitureColorChange(color);
          }
        }
        editorState.endColorPick();
        setEditorTick((n) => n + 1);
      } else if (editorState.activeTool === EditTool.EYEDROPPER) {
        const idx = row * layout.cols + col;
        const tile = layout.tiles[idx];
        if (tile !== undefined && tile !== TileType.WALL && tile !== TileType.VOID) {
          editorState.selectedTileType = tile;
          const color = layout.tileColors?.[idx];
          if (color) {
            editorState.floorColor = { ...color };
          }
          editorState.activeTool = EditTool.TILE_PAINT;
        } else if (tile === TileType.WALL) {
          // Pick wall color and switch to wall tool
          const color = layout.tileColors?.[idx];
          if (color) {
            editorState.wallColor = { ...color };
          }
          editorState.activeTool = EditTool.WALL_PAINT;
        }
        setEditorTick((n) => n + 1);
      } else if (editorState.activeTool === EditTool.AREA_PAINT) {
        // Area paint/erase is direction-aware: the first tile of a drag decides
        // whether the rest of the stroke paints (default) or erases (when the
        // first tile already had this label). Each tile pushes its own undo
        // entry — area painting is deliberate and low-velocity, unlike carpet.
        if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return;
        const label = editorState.selectedAreaLabel;
        if (!label) return;
        const idx = row * layout.cols + col;
        const tileVal = layout.tiles[idx];
        if (tileVal === TileType.VOID || tileVal === TileType.WALL) return;

        if (editorState.areaDragErasing === null) {
          const existing = layout.areaTiles?.[idx] ?? null;
          editorState.areaDragErasing = existing === label;
        }
        const newLayout = editorState.areaDragErasing
          ? eraseArea(layout, col, row)
          : paintArea(layout, col, row, label);
        if (newLayout !== layout) {
          applyEdit(newLayout);
        }
      } else if (editorState.activeTool === EditTool.CARPET_PAINT) {
        if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return;
        const idx = row * layout.cols + col;
        const tileVal = layout.tiles[idx];
        if (tileVal === TileType.VOID || tileVal === TileType.WALL) return;

        const newLayout = paintCarpet(
          layout,
          col,
          row,
          editorState.carpetVariant,
          editorState.carpetColor,
          editorState.carpetAccentColor,
        );
        if (newLayout !== layout) {
          applyStrokeEdit(newLayout);
        }
      } else if (editorState.activeTool === EditTool.CARPET_PICK) {
        if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return;
        const idx = row * layout.cols + col;
        const tile = layout.carpetTiles?.[idx];
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
        setEditorTick((n) => n + 1);
      } else if (editorState.activeTool === EditTool.SELECT) {
        const hit = furnitureAt(layout, col, row);
        if (hit) {
          editorState.selectPlacedFurniture(hit.uid);
        } else {
          editorState.clearSelection();
        }
        setEditorTick((n) => n + 1);
      }
    },
    [
      getOfficeState,
      editorState,
      applyEdit,
      applyStrokeEdit,
      maybeExpand,
      handleSelectedFurnitureColorChange,
      handlePickedFurnitureColorChange,
    ],
  );

  const handleEditorEraseAction = useCallback(
    (col: number, row: number) => {
      const os = getOfficeState();
      const layout = os.getLayout();
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return;

      // Right-click while in AREA_PAINT unconditionally clears the area on the
      // dragged tile (regardless of which label is selected). Per-tile undo
      // matches the left-click area paint semantics.
      if (editorState.activeTool === EditTool.AREA_PAINT) {
        if (!layout.areaTiles || layout.areaTiles[row * layout.cols + col] == null) return;
        const newLayout = eraseArea(layout, col, row);
        if (newLayout !== layout) {
          applyEdit(newLayout);
        }
        return;
      }

      // Right-click while in CARPET_PAINT removes carpets from the dragged path.
      // Reuses the same stroke-based undo machinery as left-click painting so a
      // single click-drag-release becomes one undo entry, not many.
      if (editorState.activeTool === EditTool.CARPET_PAINT) {
        if (!layout.carpetTiles || layout.carpetTiles[row * layout.cols + col] == null) return;
        const newLayout = eraseCarpet(layout, col, row);
        if (newLayout !== layout) {
          applyStrokeEdit(newLayout);
        }
        return;
      }

      const idx = row * layout.cols + col;
      // Clear the tile to VOID and delete any furniture the stroke passes through.
      let newLayout = layout;
      if (newLayout.tiles[idx] !== TileType.VOID) {
        newLayout = paintTile(newLayout, col, row, TileType.VOID);
      }
      newLayout = removeFurnitureAt(newLayout, col, row);
      if (newLayout !== layout) {
        applyStrokeEdit(newLayout);
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
    handleSelectedFurnitureColorChange,
    handlePickedFurnitureColorChange,
    handleColorPickToggle,
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
    handleDragMove,
    handleDragDuplicate,
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
