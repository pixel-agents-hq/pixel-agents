import { useCallback, useEffect, useRef } from 'react';

import { openAnshPanel } from '../../ansh/anshStore.js';
import {
  CAMERA_FOLLOW_LERP,
  CAMERA_FOLLOW_SNAP_THRESHOLD,
  MOUSE_DRAG_PAN_THRESHOLD_PX,
  OFFICE_CANVAS_TEST_ID,
  PAN_MARGIN_FRACTION,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_SCROLL_THRESHOLD,
} from '../../constants.js';
import { unlockAudio } from '../../notificationSound.js';
import { furnitureWithSignals } from '../../signals/officeSignals.js';
import { openTasksBoard } from '../../tasks/tasksStore.js';
import { transport } from '../../transport/index.js';
import { pastDragThreshold, stepZoom } from '../camera.js';
import { furnitureAt } from '../editor/editorActions.js';
import { buildEditorRenderState } from '../editor/editorRenderState.js';
import type { EditorState } from '../editor/editorState.js';
import { renderConfetti } from '../engine/celebrationRender.js';
import { startGameLoop } from '../engine/gameLoop.js';
import type { OfficeState } from '../engine/officeState.js';
import type {
  DeleteButtonBounds,
  EditorRenderState,
  RotateButtonBounds,
  SelectionRenderState,
} from '../engine/renderer.js';
import { renderFrame } from '../engine/renderer.js';
import { EditTool, TILE_SIZE } from '../types.js';
import { computeNormalModeCursor } from './officeCanvasCursor.js';
import { useCanvasTouchGestures } from './useCanvasTouchGestures.js';
import { useKeyboardPan } from './useKeyboardPan.js';

/** A left-button press that may turn into a pan: where it started, the pan
 *  then, and whether it has crossed the drag threshold yet. */
interface PendingDragPan {
  mouseX: number;
  mouseY: number;
  panX: number;
  panY: number;
  active: boolean;
  /** Editor only: the press landed on empty space, which deselects the placed
   *  item — on release, and only if the press stayed a click. */
  deselectOnClick: boolean;
}

/**
 * Cursor for a furniture drag that has started moving: 'copy' — the platform's
 * own duplicate-drag affordance — while Alt makes the drop a copy, 'grabbing'
 * for a move. Set wherever dragDuplicate changes, so the cursor never claims a
 * move the drop would turn into a copy (or the reverse).
 */
function dragMoveCursor(editorState: EditorState): string {
  return editorState.dragDuplicate ? 'copy' : 'grabbing';
}

interface OfficeCanvasProps {
  officeState: OfficeState;
  onClick: (agentId: number) => void;
  isEditMode: boolean;
  editorState: EditorState;
  onEditorTileAction: (col: number, row: number) => void;
  onEditorEraseAction: (col: number, row: number) => void;
  onEditorSelectionChange: () => void;
  onDeleteSelected: () => void;
  onRotateSelected: () => void;
  /** A furniture drag released with the item's top-left over (col,row);
   *  `duplicate` when Alt was held. The handler decides what that commits. */
  onDrop: (uid: string, col: number, row: number, opts: { duplicate: boolean }) => void;
  editorTick: number;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  /** Whether the area overlay + labels should render (settings toggle OR active edit). */
  showAreas: boolean;
  /** Currently-selected area label in the editor (alpha-bumped overlay). null otherwise. */
  activeAreaLabel: string | null;
  /** Mobile two-step tap: the first tap on a character selects it (camera
   *  follow + status label), and only a second tap on the already-selected
   *  character fires onClick (opens its terminal). Desktop keeps single-click
   *  focus with tap-again-to-deselect. */
  tapSelectsFirst?: boolean;
  /** The user panned by hand (any input) — auto-fit stops managing the camera. */
  onManualCamera?: () => void;
}

export function OfficeCanvas({
  officeState,
  onClick,
  isEditMode,
  editorState,
  onEditorTileAction,
  onEditorEraseAction,
  onEditorSelectionChange,
  onDeleteSelected,
  onRotateSelected,
  onDrop,
  editorTick: _editorTick,
  zoom,
  onZoomChange,
  panRef,
  showAreas,
  activeAreaLabel,
  tapSelectsFirst = false,
  onManualCamera,
}: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  // Middle-mouse pan state (imperative, no re-renders)
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  // Left-button drag-to-pan: armed on press, live past the threshold. A drag
  // that panned swallows the click the browser fires on release.
  const dragPanRef = useRef<PendingDragPan | null>(null);
  const suppressClickRef = useRef(false);
  // Delete/rotate button bounds (updated each frame by renderer)
  const deleteButtonBoundsRef = useRef<DeleteButtonBounds | null>(null);
  const rotateButtonBoundsRef = useRef<RotateButtonBounds | null>(null);
  // Right-click erase dragging
  const isEraseDraggingRef = useRef(false);
  // Zoom scroll accumulator for trackpad pinch sensitivity
  const zoomAccumulatorRef = useRef(0);
  // Clamp pan so the map edge can't go past a margin inside the viewport
  const clampPan = useCallback(
    (px: number, py: number): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: px, y: py };
      const layout = officeState.getLayout();
      const mapW = layout.cols * TILE_SIZE * zoom;
      const mapH = layout.rows * TILE_SIZE * zoom;
      const marginX = canvas.width * PAN_MARGIN_FRACTION;
      const marginY = canvas.height * PAN_MARGIN_FRACTION;
      const maxPanX = mapW / 2 + canvas.width / 2 - marginX;
      const maxPanY = mapH / 2 + canvas.height / 2 - marginY;
      return {
        x: Math.max(-maxPanX, Math.min(maxPanX, px)),
        y: Math.max(-maxPanY, Math.min(maxPanY, py)),
      };
    },
    [officeState, zoom],
  );

  // Every manual pan — middle or left drag, wheel, keys, touch — takes the
  // camera back from character follow and the greeter, and from auto-fit.
  const beginManualPan = useCallback(() => {
    officeState.breakCameraFollow();
    onManualCamera?.();
  }, [officeState, onManualCamera]);

  // Resize canvas backing store to device pixels (no DPR transform on ctx)
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    // No ctx.scale(dpr) — we render directly in device pixels
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    resizeCanvas();

    const observer = new ResizeObserver(() => resizeCanvas());
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    const stop = startGameLoop(canvas, {
      update: (dt) => {
        officeState.update(dt);
      },
      render: (ctx) => {
        // Canvas dimensions are in device pixels
        const w = canvas.width;
        const h = canvas.height;

        const editorRender: EditorRenderState | undefined = isEditMode
          ? buildEditorRenderState(editorState, officeState.getLayout())
          : undefined;

        // Camera: smoothly center on the followed agent, or — while the greeter
        // is speaking the Intro — on the character+bubble center the IntroBubble
        // overlay feeds via greeterCameraTarget. An explicit follow (clicking an
        // agent) outranks the greeter target; a manual pan cancels both.
        const followCh =
          officeState.cameraFollowId !== null
            ? officeState.characters.get(officeState.cameraFollowId)
            : undefined;
        const cameraFocus = followCh ?? officeState.greeterCameraTarget;
        if (cameraFocus) {
          const layout = officeState.getLayout();
          const mapW = layout.cols * TILE_SIZE * zoom;
          const mapH = layout.rows * TILE_SIZE * zoom;
          const targetX = mapW / 2 - cameraFocus.x * zoom;
          const targetY = mapH / 2 - cameraFocus.y * zoom;
          const dx = targetX - panRef.current.x;
          const dy = targetY - panRef.current.y;
          if (
            Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD &&
            Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD
          ) {
            panRef.current = { x: targetX, y: targetY };
          } else {
            panRef.current = {
              x: panRef.current.x + dx * CAMERA_FOLLOW_LERP,
              y: panRef.current.y + dy * CAMERA_FOLLOW_LERP,
            };
          }
        }

        // Build selection render state
        const selectionRender: SelectionRenderState = {
          selectedAgentId: officeState.selectedAgentId,
          // A hovered NPC gets the same outline as a hovered agent.
          hoveredAgentId:
            officeState.hoveredAgentId ??
            officeState.npcs.characterOf(officeState.npcs.hovered)?.id ??
            null,
          hoveredTile: officeState.hoveredTile,
          seats: officeState.seats,
          characters: officeState.characters,
        };

        const layout = officeState.getLayout();
        const { offsetX, offsetY } = renderFrame(
          ctx,
          w,
          h,
          officeState.tileMap,
          // Runtime-only trouble icons (desk fire / alarm lamp); never while editing.
          isEditMode
            ? officeState.furniture
            : furnitureWithSignals(officeState, officeState.furniture),
          officeState.getCharacters(),
          zoom,
          panRef.current.x,
          panRef.current.y,
          selectionRender,
          editorRender,
          layout.tileColors,
          layout.cols,
          layout.rows,
          layout.carpetTiles,
          layout.areas,
          layout.areaTiles,
          showAreas,
          activeAreaLabel,
          officeState.pets,
        );
        offsetRef.current = { x: offsetX, y: offsetY };
        renderConfetti(ctx, officeState.celebrations.bursts, offsetX, offsetY, zoom); // phase B

        // Store delete/rotate button bounds for hit-testing
        deleteButtonBoundsRef.current = editorRender?.deleteButtonBounds ?? null;
        rotateButtonBoundsRef.current = editorRender?.rotateButtonBounds ?? null;
      },
    });

    return () => {
      stop();
      observer.disconnect();
    };
  }, [
    officeState,
    resizeCanvas,
    isEditMode,
    editorState,
    _editorTick,
    zoom,
    panRef,
    showAreas,
    activeAreaLabel,
  ]);

  // Convert CSS mouse coords to world (sprite pixel) coords
  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // CSS coords relative to canvas
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      // Convert to device pixels
      const deviceX = cssX * dpr;
      const deviceY = cssY * dpr;
      // Convert to world (sprite pixel) coords
      const worldX = (deviceX - offsetRef.current.x) / zoom;
      const worldY = (deviceY - offsetRef.current.y) / zoom;
      return { worldX, worldY, screenX: cssX, screenY: cssY, deviceX, deviceY };
    },
    [zoom],
  );

  const screenToTile = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const pos = screenToWorld(clientX, clientY);
      if (!pos) return null;
      const col = Math.floor(pos.worldX / TILE_SIZE);
      const row = Math.floor(pos.worldY / TILE_SIZE);
      const layout = officeState.getLayout();
      // In edit mode with floor/wall/erase tool, extend valid range by 1 for ghost border
      if (
        isEditMode &&
        (editorState.activeTool === EditTool.TILE_PAINT ||
          editorState.activeTool === EditTool.WALL_PAINT ||
          editorState.activeTool === EditTool.ERASE)
      ) {
        if (col < -1 || col > layout.cols || row < -1 || row > layout.rows) return null;
        return { col, row };
      }
      if (col < 0 || col >= layout.cols || row < 0 || row >= layout.rows) return null;
      return { col, row };
    },
    [screenToWorld, officeState, isEditMode, editorState],
  );

  // Check if device-pixel coords hit the delete button
  const hitTestDeleteButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = deleteButtonBoundsRef.current;
    if (!bounds) return false;
    const dx = deviceX - bounds.cx;
    const dy = deviceY - bounds.cy;
    return dx * dx + dy * dy <= (bounds.radius + 2) * (bounds.radius + 2); // small padding
  }, []);

  // Check if device-pixel coords hit the rotate button
  const hitTestRotateButton = useCallback((deviceX: number, deviceY: number): boolean => {
    const bounds = rotateButtonBoundsRef.current;
    if (!bounds) return false;
    const dx = deviceX - bounds.cx;
    const dy = deviceY - bounds.cy;
    return dx * dx + dy * dy <= (bounds.radius + 2) * (bounds.radius + 2);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle middle-mouse panning
      if (isPanningRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const dx = (e.clientX - panStartRef.current.mouseX) * dpr;
        const dy = (e.clientY - panStartRef.current.mouseY) * dpr;
        panRef.current = clampPan(panStartRef.current.panX + dx, panStartRef.current.panY + dy);
        return;
      }

      // Left-button drag: a pan once past the threshold, until then the
      // press is still a click (hover and the editor ghost carry on below).
      const drag = dragPanRef.current;
      if (drag) {
        const cssDX = e.clientX - drag.mouseX;
        const cssDY = e.clientY - drag.mouseY;
        if (!drag.active && pastDragThreshold(cssDX, cssDY, MOUSE_DRAG_PAN_THRESHOLD_PX)) {
          drag.active = true;
          beginManualPan();
          const canvas = canvasRef.current;
          if (canvas) canvas.style.cursor = 'grabbing';
        }
        if (drag.active) {
          const dpr = window.devicePixelRatio || 1;
          panRef.current = clampPan(drag.panX + cssDX * dpr, drag.panY + cssDY * dpr);
          return;
        }
      }

      if (isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (tile) {
          editorState.ghostCol = tile.col;
          editorState.ghostRow = tile.row;

          // Drag-to-move: check if cursor moved to different tile
          if (editorState.dragUid) {
            // Alt is sampled every move, so it can be pressed or released
            // part-way through a drag and the ghost follows.
            editorState.dragDuplicate = e.altKey;
            if (
              !editorState.isDragMoving &&
              (tile.col !== editorState.dragStartCol || tile.row !== editorState.dragStartRow)
            ) {
              editorState.isDragMoving = true;
            }
          }

          // Paint on drag (paint-style tools only, not during furniture drag).
          // Carpet + Area paint join the drag set so a single click-drag stamps
          // every tile under the cursor — stroke-based undo (one undo per
          // click-drag) lives in useEditorActions for floor/wall/erase/carpet;
          // area paint stays per-tile.
          if (
            editorState.isDragging &&
            (editorState.activeTool === EditTool.TILE_PAINT ||
              editorState.activeTool === EditTool.WALL_PAINT ||
              editorState.activeTool === EditTool.ERASE ||
              editorState.activeTool === EditTool.CARPET_PAINT ||
              editorState.activeTool === EditTool.AREA_PAINT) &&
            !editorState.dragUid
          ) {
            onEditorTileAction(tile.col, tile.row);
          }
          // Right-click erase drag — also extends over carpets/areas so right-
          // drag wipes them just like floor/wall.
          if (
            isEraseDraggingRef.current &&
            (editorState.activeTool === EditTool.TILE_PAINT ||
              editorState.activeTool === EditTool.WALL_PAINT ||
              editorState.activeTool === EditTool.ERASE ||
              editorState.activeTool === EditTool.CARPET_PAINT ||
              editorState.activeTool === EditTool.AREA_PAINT)
          ) {
            const layout = officeState.getLayout();
            if (
              tile.col >= 0 &&
              tile.col < layout.cols &&
              tile.row >= 0 &&
              tile.row < layout.rows
            ) {
              onEditorEraseAction(tile.col, tile.row);
            }
          }
        } else {
          editorState.ghostCol = -1;
          editorState.ghostRow = -1;
        }

        // Cursor: show grab during drag, pointer over delete button, crosshair otherwise
        const canvas = canvasRef.current;
        if (canvas) {
          if (editorState.isDragMoving) {
            canvas.style.cursor = dragMoveCursor(editorState);
          } else {
            const pos = screenToWorld(e.clientX, e.clientY);
            if (
              pos &&
              (hitTestDeleteButton(pos.deviceX, pos.deviceY) ||
                hitTestRotateButton(pos.deviceX, pos.deviceY))
            ) {
              canvas.style.cursor = 'pointer';
            } else if (
              (editorState.activeTool === EditTool.FURNITURE_PICK ||
                editorState.activeTool === EditTool.COLOR_PICK) &&
              tile
            ) {
              // Copy modes (type or colour): pointer over furniture, crosshair elsewhere
              const hit = furnitureAt(officeState.getLayout(), tile.col, tile.row);
              canvas.style.cursor = hit ? 'pointer' : 'crosshair';
            } else if (
              (editorState.activeTool === EditTool.SELECT ||
                (editorState.activeTool === EditTool.FURNITURE_PLACE &&
                  editorState.placing === null)) &&
              tile
            ) {
              // Check if hovering over furniture
              const hit = furnitureAt(officeState.getLayout(), tile.col, tile.row);
              canvas.style.cursor = hit ? 'grab' : 'crosshair';
            } else {
              canvas.style.cursor = 'crosshair';
            }
          }
        }
        return;
      }

      const pos = screenToWorld(e.clientX, e.clientY);
      if (!pos) return;
      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
      // Only run pet hit-test if no character was hit (avoids redundant work).
      const petId = hitId === null ? officeState.getPetAt(pos.worldX, pos.worldY) : null;
      const tile = screenToTile(e.clientX, e.clientY);
      officeState.hoveredTile = tile;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = computeNormalModeCursor({
          hitId,
          petId,
          selectedAgentId: officeState.selectedAgentId,
          tile,
          getSeatAtTile: (col, row) => officeState.getSeatAtTile(col, row),
          getSeat: (seatId) => officeState.seats.get(seatId),
          getCharacter: (id) => officeState.characters.get(id),
        });
      }
      officeState.hoveredAgentId = hitId;
      // Phase M NPCs: a name label on hover; the Manager is clickable.
      const npc =
        hitId === null && petId === null ? officeState.getNpcAt(pos.worldX, pos.worldY) : null;
      officeState.npcs.hovered = npc;
      if (npc === 'manager' && canvas) canvas.style.cursor = 'pointer';
    },
    [
      officeState,
      screenToWorld,
      screenToTile,
      isEditMode,
      editorState,
      onEditorTileAction,
      onEditorEraseAction,
      panRef,
      hitTestDeleteButton,
      hitTestRotateButton,
      clampPan,
      beginManualPan,
    ],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      unlockAudio();
      // A fresh press: whatever the last one swallowed, this one's click counts.
      suppressClickRef.current = false;
      dragPanRef.current = null;
      const armDragPan = (deselectOnClick: boolean) => {
        dragPanRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
          active: false,
          deselectOnClick,
        };
      };
      // Middle mouse button (button 1) starts panning
      if (e.button === 1) {
        e.preventDefault();
        // Break camera follow + greeter centering on manual pan
        beginManualPan();
        isPanningRef.current = true;
        panStartRef.current = {
          mouseX: e.clientX,
          mouseY: e.clientY,
          panX: panRef.current.x,
          panY: panRef.current.y,
        };
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'grabbing';
        return;
      }

      // Right-click in edit mode for erasing
      if (e.button === 2 && isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (
          tile &&
          (editorState.activeTool === EditTool.TILE_PAINT ||
            editorState.activeTool === EditTool.WALL_PAINT ||
            editorState.activeTool === EditTool.ERASE ||
            editorState.activeTool === EditTool.CARPET_PAINT ||
            editorState.activeTool === EditTool.AREA_PAINT)
        ) {
          const layout = officeState.getLayout();
          if (tile.col >= 0 && tile.col < layout.cols && tile.row >= 0 && tile.row < layout.rows) {
            isEraseDraggingRef.current = true;
            onEditorEraseAction(tile.col, tile.row);
          }
        }
        return;
      }

      if (!isEditMode) {
        // Left press off any character may become a drag-pan; on a character
        // it stays a click (select / focus).
        if (e.button !== 0) return;
        const pos = screenToWorld(e.clientX, e.clientY);
        if (pos && officeState.getCharacterAt(pos.worldX, pos.worldY) !== null) return;
        armDragPan(false);
        return;
      }

      // Check rotate/delete button hit first
      const pos = screenToWorld(e.clientX, e.clientY);
      if (pos && hitTestRotateButton(pos.deviceX, pos.deviceY)) {
        onRotateSelected();
        return;
      }
      if (pos && hitTestDeleteButton(pos.deviceX, pos.deviceY)) {
        onDeleteSelected();
        return;
      }

      const tile = screenToTile(e.clientX, e.clientY);

      // SELECT tool (or furniture tool with nothing selected): check for furniture hit to start drag
      const actAsSelect =
        editorState.activeTool === EditTool.SELECT ||
        (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.placing === null);
      if (actAsSelect) {
        const hitFurniture = tile ? furnitureAt(officeState.getLayout(), tile.col, tile.row) : null;
        if (tile && hitFurniture) {
          // Start drag — record offset from furniture's top-left. Alt at press
          // time means "drag out a copy"; mousemove keeps it in sync after that.
          editorState.startDrag(
            hitFurniture.uid,
            tile.col,
            tile.row,
            tile.col - hitFurniture.col,
            tile.row - hitFurniture.row,
            e.altKey,
          );
          return;
        }
        // Empty space (or off the grid): a drag here pans. A click on an empty
        // tile deselects the placed item — on release, so a pan keeps it.
        armDragPan(tile !== null);
        return;
      }

      // Non-select tools: start paint drag
      editorState.isDragging = true;
      if (tile) {
        onEditorTileAction(tile.col, tile.row);
      }
    },
    [
      officeState,
      isEditMode,
      editorState,
      screenToTile,
      screenToWorld,
      onEditorTileAction,
      onEditorEraseAction,
      onDeleteSelected,
      onRotateSelected,
      hitTestDeleteButton,
      hitTestRotateButton,
      panRef,
      beginManualPan,
    ],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1) {
        isPanningRef.current = false;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = isEditMode ? 'crosshair' : 'default';
        return;
      }
      if (e.button === 2) {
        isEraseDraggingRef.current = false;
        // Close the in-progress stroke so the next stroke starts a fresh undo
        // entry instead of bundling into this one.
        editorState.endStroke();
        return;
      }

      // Left-drag pan (or the click it never became)
      const drag = dragPanRef.current;
      dragPanRef.current = null;
      if (drag?.active) {
        suppressClickRef.current = true;
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = isEditMode ? 'crosshair' : 'default';
        return;
      }
      if (drag?.deselectOnClick) {
        editorState.clearSelection();
        onEditorSelectionChange();
      }

      // Handle drag-to-move completion
      if (editorState.dragUid) {
        if (editorState.isDragMoving) {
          onDrop(
            editorState.dragUid,
            editorState.ghostCol - editorState.dragOffsetCol,
            editorState.ghostRow - editorState.dragOffsetRow,
            { duplicate: editorState.dragDuplicate },
          );
        } else {
          // Click (no movement) — toggle selection. Selecting also collapses
          // the open tool tab, so the toolbar shows the item's own controls.
          if (editorState.selectedFurnitureUid === editorState.dragUid) {
            editorState.clearSelection();
          } else {
            editorState.selectPlacedFurniture(editorState.dragUid);
          }
        }
        editorState.clearDrag();
        onEditorSelectionChange();
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'crosshair';
        return;
      }

      editorState.isDragging = false;
      // Releasing the mouse ends the stroke, so the next click starts a fresh
      // undo entry — one click-drag collapses to a single undo.
      editorState.endStroke();
    },
    [editorState, isEditMode, onDrop, onEditorSelectionChange],
  );

  // Shared by mouse click and touch tap — both resolve a viewport point to a
  // character / pet / seat interaction.
  const performTap = useCallback(
    (clientX: number, clientY: number) => {
      const pos = screenToWorld(clientX, clientY);
      if (!pos) return;

      const hitId = officeState.getCharacterAt(pos.worldX, pos.worldY);
      if (hitId !== null) {
        // Dismiss any active bubble on click
        officeState.dismissBubble(hitId);
        // Two-step (mobile): first tap selects + follows so the status label
        // shows; only a repeat tap on the same character opens its terminal.
        // Deselection is tapping empty floor, as ever.
        if (tapSelectsFirst) {
          if (officeState.selectedAgentId === hitId) {
            onClick(hitId);
          } else {
            officeState.selectedAgentId = hitId;
            officeState.cameraFollowId = hitId;
          }
          return;
        }
        // Toggle selection: click same agent deselects, different agent selects
        if (officeState.selectedAgentId === hitId) {
          officeState.selectedAgentId = null;
          officeState.cameraFollowId = null;
        } else {
          officeState.selectedAgentId = hitId;
          officeState.cameraFollowId = hitId;
        }
        onClick(hitId); // still focus terminal
        return;
      }

      // The Manager opens the Tasks board (phase M), Ansh his thoughts. Not
      // selectable: NPCs aren't agents.
      const npc = officeState.getNpcAt(pos.worldX, pos.worldY);
      if (npc === 'manager') {
        openTasksBoard('board');
        return;
      }
      if (npc === 'ansh') {
        openAnshPanel();
        return;
      }

      // Pet hit: toggle the heart bubble.
      const petId = officeState.getPetAt(pos.worldX, pos.worldY);
      if (petId !== null) {
        const pet = officeState.pets.find((p) => p.id === petId);
        if (pet?.bubbleType) {
          officeState.dismissPetBubble(petId);
        } else {
          officeState.showPetBubble(petId);
        }
        return;
      }

      // Fun: the Lounge radio toggles its lo-fi loop.
      if (officeState.fun.handleTap(pos.worldX, pos.worldY)) return;

      // No agent hit — check seat click while agent is selected
      if (officeState.selectedAgentId !== null) {
        const selectedCh = officeState.characters.get(officeState.selectedAgentId);
        // Skip seat reassignment for sub-agents
        if (selectedCh && !selectedCh.isSubagent) {
          const tile = screenToTile(clientX, clientY);
          if (tile) {
            const seatId = officeState.getSeatAtTile(tile.col, tile.row);
            if (seatId) {
              const seat = officeState.seats.get(seatId);
              if (seat && selectedCh) {
                if (selectedCh.seatId === seatId) {
                  // Clicked own seat — send agent back to it
                  officeState.sendToSeat(officeState.selectedAgentId);
                  officeState.selectedAgentId = null;
                  officeState.cameraFollowId = null;
                  return;
                } else if (!seat.assigned) {
                  // Clicked available seat — reassign
                  officeState.reassignSeat(officeState.selectedAgentId, seatId);
                  officeState.selectedAgentId = null;
                  officeState.cameraFollowId = null;
                  transport.send({
                    type: 'saveAgentSeats',
                    seats: officeState.getPersistableSeats(),
                  });
                  return;
                }
              }
            }
          }
        }
        // Clicked empty space — deselect
        officeState.selectedAgentId = null;
        officeState.cameraFollowId = null;
      }
    },
    [officeState, onClick, screenToWorld, screenToTile, tapSelectsFirst],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // The release of a drag-pan is not a click on whatever it ended over.
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (isEditMode) return; // handled by mouseDown/mouseUp
      performTap(e.clientX, e.clientY);
    },
    [isEditMode, performTap],
  );

  const handleMouseLeave = useCallback(() => {
    isPanningRef.current = false;
    // A drag-pan that wandered off and back must not end in a click either
    // (mousedown clears this again).
    if (dragPanRef.current?.active) suppressClickRef.current = true;
    dragPanRef.current = null;
    isEraseDraggingRef.current = false;
    editorState.isDragging = false;
    editorState.endStroke();
    editorState.clearDrag();
    editorState.ghostCol = -1;
    editorState.ghostRow = -1;
    officeState.hoveredAgentId = null;
    officeState.npcs.hovered = null;
    officeState.hoveredTile = null;

    // Reset cursor in non-edit mode so pointer doesn't get stuck after hovering a pet.
    if (!isEditMode) {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = 'default';
      }
    }
  }, [officeState, editorState, isEditMode]);

  // Alt tapped or released with the mouse already down flips the in-flight drag
  // between move and copy without waiting for the next mouse move — the rAF
  // loop redraws the ghost from editorState every frame, so no re-render here.
  // The cursor flips with it: a stationary pointer gets no mouse move to do it.
  useEffect(() => {
    if (!isEditMode) return;
    const syncAlt = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !editorState.dragUid) return;
      editorState.dragDuplicate = e.type === 'keydown';
      const canvas = canvasRef.current;
      if (canvas && editorState.isDragMoving) canvas.style.cursor = dragMoveCursor(editorState);
    };
    window.addEventListener('keydown', syncAlt);
    window.addEventListener('keyup', syncAlt);
    return () => {
      window.removeEventListener('keydown', syncAlt);
      window.removeEventListener('keyup', syncAlt);
    };
  }, [isEditMode, editorState]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (isEditMode) return;
      // Right-click to walk selected agent to tile
      if (officeState.selectedAgentId !== null) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (tile) {
          officeState.walkToTile(officeState.selectedAgentId, tile.col, tile.row);
        }
      }
    },
    [isEditMode, officeState, screenToTile],
  );

  // Wheel: Ctrl+wheel to zoom, plain wheel/trackpad to pan
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Accumulate scroll delta, step zoom when threshold crossed
        zoomAccumulatorRef.current += e.deltaY;
        if (Math.abs(zoomAccumulatorRef.current) >= ZOOM_SCROLL_THRESHOLD) {
          const delta = zoomAccumulatorRef.current < 0 ? 1 : -1;
          zoomAccumulatorRef.current = 0;
          const newZoom = stepZoom(zoom, delta, ZOOM_MIN, ZOOM_MAX);
          if (newZoom !== zoom) {
            onZoomChange(newZoom);
          }
        }
      } else {
        // Pan via trackpad two-finger scroll or mouse wheel
        const dpr = window.devicePixelRatio || 1;
        beginManualPan();
        panRef.current = clampPan(
          panRef.current.x - e.deltaX * dpr,
          panRef.current.y - e.deltaY * dpr,
        );
      }
    },
    [zoom, onZoomChange, panRef, clampPan, beginManualPan],
  );

  // Attach wheel listener with { passive: false } so preventDefault() works.
  // React's onWheel is passive by default in modern browsers.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Touch: one-finger pan, two-finger pinch zoom, short tap = click.
  useCanvasTouchGestures({
    canvasRef,
    enabled: !isEditMode,
    zoom,
    onZoomChange,
    panRef,
    clampPan,
    onManualPan: beginManualPan,
    onTap: performTap,
  });

  // Arrow keys everywhere; WASD too outside the editor (letters are its keys).
  useKeyboardPan({
    zoom,
    panRef,
    clampPan,
    letters: !isEditMode,
    onManualPan: beginManualPan,
  });

  // Prevent default middle-click browser behavior (auto-scroll)
  const handleAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden bg-bg">
      <canvas
        ref={canvasRef}
        data-testid={OFFICE_CANVAS_TEST_ID}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        onAuxClick={handleAuxClick}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        className="block touch-none"
      />
    </div>
  );
}
