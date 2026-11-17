import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import type { PieceClick } from '../../../../core/src/furniture/pieceRules.js';
import {
  CAMERA_FOLLOW_LERP,
  CAMERA_FOLLOW_SNAP_THRESHOLD,
  FURNITURE_LABEL_SELECTOR,
  GREETER_ID,
  OFFICE_CANVAS_TEST_ID,
  PAN_MARGIN_FRACTION,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_SCROLL_THRESHOLD,
} from '../../constants.js';
import { unlockAudio } from '../../notificationSound.js';
import { transport } from '../../transport/index.js';
import { furnitureAt, furnitureInBox } from '../editor/editorActions.js';
import { buildEditorRenderState } from '../editor/editorRenderState.js';
import type { EditorState, SelectionButton } from '../editor/editorState.js';
import { startGameLoop } from '../engine/gameLoop.js';
import type { OfficeState } from '../engine/officeState.js';
import type { EditorRenderState, SelectionRenderState } from '../engine/renderer.js';
import { renderFrame } from '../engine/renderer.js';
import type { ButtonBounds } from '../engine/selectionButtons.js';
import { selectionButtonAt as buttonAt } from '../engine/selectionButtons.js';
import { EditTool, TILE_SIZE } from '../types.js';
import { computeNormalModeCursor } from './officeCanvasCursor.js';
import { useCanvasTouchGestures } from './useCanvasTouchGestures.js';

/**
 * Cursor for a furniture drag that has started moving: 'copy' — the platform's
 * own duplicate-drag affordance — while Alt makes the drop a copy, 'grabbing'
 * for a move. Set wherever dragDuplicate changes, so the cursor never claims a
 * move the drop would turn into a copy (or the reverse).
 */
function dragMoveCursor(editorState: EditorState): string {
  return editorState.dragDuplicate ? 'copy' : 'grabbing';
}

/** Whether the pointer can hover (a mouse), read once and kept current. Furniture
 *  hover by mouse is off on touch devices: there the first tap hovers a piece
 *  (OfficeState.pieces.tapAt). */
const hoverQuery =
  typeof window !== 'undefined' ? (window.matchMedia?.('(hover: hover)') ?? null) : null;
let canHover = hoverQuery?.matches ?? true;
hoverQuery?.addEventListener?.('change', (e) => {
  canHover = e.matches;
});
function mouseHovers(): boolean {
  return canHover;
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
  /** A read-only office: furniture shows its label but offers no click (no pointer). */
  readOnly?: boolean;
  /** A click on a piece of interactive furniture, resolved by core's pieceView
   *  (on touch, the second tap on the hovered piece). Unset: the click does nothing. */
  onPieceClick?: (click: PieceClick, uid: string) => void;
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
  readOnly = false,
  onPieceClick,
}: OfficeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  // Middle-mouse pan state (imperative, no re-renders)
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, panX: 0, panY: 0 });
  // Delete/rotate button bounds (updated each frame by renderer)
  const deleteButtonBoundsRef = useRef<ButtonBounds | null>(null);
  const rotateButtonBoundsRef = useRef<ButtonBounds | null>(null);
  // Right-click erase dragging
  const isEraseDraggingRef = useRef(false);
  // Zoom scroll accumulator for trackpad pinch sensitivity
  const zoomAccumulatorRef = useRef(0);
  // While the Intro's greeter stands, the furniture opens nothing (its labels
  // still show): the Intro is not to be left for a terminal half-way.
  const piecesReadOnly = useCallback(
    () => readOnly || officeState.greeter !== null,
    [readOnly, officeState],
  );
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

    const loop = startGameLoop(canvas, {
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
        // is speaking the Intro — on the point the IntroDialog
        // overlay feeds via greeterCameraTarget. An explicit follow (clicking an
        // agent) outranks the greeter target; a manual pan cancels both. A
        // clicked piece of interactive furniture is centred on the same way.
        const followCh =
          officeState.cameraFollowId !== null
            ? officeState.characters.get(officeState.cameraFollowId)
            : undefined;
        const followPiece =
          officeState.cameraPieceUid !== null
            ? officeState.pieces.center(officeState.cameraPieceUid)
            : null;
        const cameraFocus = followCh ?? followPiece ?? officeState.greeterCameraTarget;
        if (cameraFocus) {
          const layout = officeState.getLayout();
          const mapW = layout.cols * TILE_SIZE * zoom;
          const mapH = layout.rows * TILE_SIZE * zoom;
          const targetX = mapW / 2 - cameraFocus.x * zoom;
          const targetY = mapH / 2 - cameraFocus.y * zoom;
          const dx = targetX - panRef.current.x;
          const dy = targetY - panRef.current.y;
          // The Intro's camera starts on its target (no drift across the office).
          const jump =
            cameraFocus === officeState.greeterCameraTarget && officeState.takeGreeterCameraSnap();
          if (
            jump ||
            (Math.abs(dx) < CAMERA_FOLLOW_SNAP_THRESHOLD &&
              Math.abs(dy) < CAMERA_FOLLOW_SNAP_THRESHOLD)
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
          hoveredAgentId: officeState.hoveredAgentId,
          hoveredTile: officeState.hoveredTile,
          hoveredPieceUid: officeState.pieces.hoveredUid,
          seats: officeState.seats,
          characters: officeState.characters,
        };

        // What the office shows: during a Buildout, the layout as built so far.
        const layout = officeState.shownLayout();
        const { offsetX, offsetY } = renderFrame(ctx, {
          canvasWidth: w,
          canvasHeight: h,
          zoom,
          panX: panRef.current.x,
          panY: panRef.current.y,
          layout,
          tileMap: officeState.shownTileMap(),
          furniture: officeState.furniture,
          characters: officeState.getCharacters(),
          pets: officeState.pets,
          selection: selectionRender,
          editor: editorRender,
          showAreas,
          activeAreaLabel,
          buildout: officeState.buildout.render(),
        });
        offsetRef.current = { x: offsetX, y: offsetY };

        // Store delete/rotate button bounds for hit-testing
        deleteButtonBoundsRef.current = editorRender?.deleteButtonBounds ?? null;
        rotateButtonBoundsRef.current = editorRender?.rotateButtonBounds ?? null;
      },
    });

    // Resizing clears the canvas after this frame's render ran, so draw again
    // at once: a container that grows or shrinks every frame (the sidebar
    // sliding) would otherwise flash blank.
    const observer = new ResizeObserver(() => {
      resizeCanvas();
      loop.redraw();
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      loop.stop();
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

  /** Which of the selected item's buttons is under these device-pixel coords. */
  const selectionButtonAt = useCallback(
    (deviceX: number, deviceY: number): SelectionButton | null =>
      buttonAt(
        { delete: deleteButtonBoundsRef.current, rotate: rotateButtonBoundsRef.current },
        deviceX,
        deviceY,
      ),
    [],
  );

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

      if (isEditMode) {
        const tile = screenToTile(e.clientX, e.clientY);
        if (tile) {
          editorState.ghostCol = tile.col;
          editorState.ghostRow = tile.row;
          if (editorState.marquee) {
            editorState.marquee.endCol = tile.col;
            editorState.marquee.endRow = tile.row;
          }

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
            editorState.selectionButtonHover = null;
            canvas.style.cursor = dragMoveCursor(editorState);
          } else {
            const pos = screenToWorld(e.clientX, e.clientY);
            // The renderer lights the hovered button up.
            editorState.selectionButtonHover = pos
              ? selectionButtonAt(pos.deviceX, pos.deviceY)
              : null;
            if (editorState.selectionButtonHover) {
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
      // The Intro's greeter takes the hover outline too, and nothing else: no
      // click, no pointer (it is no agent).
      const greeterHit = hitId === null && officeState.greeterAt(pos.worldX, pos.worldY);
      // Only run pet hit-test if no character was hit (avoids redundant work).
      const petId =
        hitId === null && !greeterHit ? officeState.getPetAt(pos.worldX, pos.worldY) : null;
      const tile = screenToTile(e.clientX, e.clientY);
      officeState.hoveredTile = tile;
      // The piece of furniture under the mouse (none under a character or a pet).
      const piece =
        mouseHovers() && !greeterHit
          ? officeState.pieces.hoverAt(pos.worldX, pos.worldY, {
              readOnly: piecesReadOnly(),
            })
          : null;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.cursor = computeNormalModeCursor({
          pieceClickable: !!piece?.click,
          hitId,
          petId,
          selectedAgentId: officeState.selectedAgentId,
          tile,
          getSeatAtTile: (col, row) => officeState.getSeatAtTile(col, row),
          getSeat: (seatId) => officeState.seats.get(seatId),
          getCharacter: (id) => officeState.characters.get(id),
        });
      }
      officeState.hoveredAgentId = greeterHit ? GREETER_ID : hitId;
    },
    [
      officeState,
      screenToWorld,
      screenToTile,
      piecesReadOnly,
      isEditMode,
      editorState,
      onEditorTileAction,
      onEditorEraseAction,
      panRef,
      selectionButtonAt,
      clampPan,
    ],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      unlockAudio();
      // Middle mouse button (button 1) starts panning
      if (e.button === 1) {
        e.preventDefault();
        // Break camera follow + greeter centering on manual pan
        officeState.breakCameraFollow();
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

      if (!isEditMode) return;

      // Rotate / delete buttons first. A press only sinks the button; it acts
      // on release over the same button (handleMouseUp), so sliding off cancels.
      const pos = screenToWorld(e.clientX, e.clientY);
      const button = pos ? selectionButtonAt(pos.deviceX, pos.deviceY) : null;
      if (button) {
        editorState.selectionButtonPressed = button;
        return;
      }

      const tile = screenToTile(e.clientX, e.clientY);

      // SELECT tool (or furniture tool with nothing selected): check for furniture hit to start drag
      const actAsSelect =
        editorState.activeTool === EditTool.SELECT ||
        (editorState.activeTool === EditTool.FURNITURE_PLACE && editorState.placing === null);
      if (actAsSelect && tile) {
        const hitFurniture = furnitureAt(officeState.getLayout(), tile.col, tile.row);
        if (hitFurniture && e.shiftKey) {
          // Shift+click: add the item to the selection, or take it out.
          editorState.toggleFurnitureInSelection(hitFurniture.uid);
          onEditorSelectionChange();
          return;
        }
        if (hitFurniture) {
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
        } else {
          // Empty floor: start a box selection (Shift adds to the current one).
          // A click without a drag catches nothing, so it deselects as before.
          editorState.marquee = {
            startCol: tile.col,
            startRow: tile.row,
            endCol: tile.col,
            endRow: tile.row,
            additive: e.shiftKey,
          };
          return;
        }
      }

      // Non-select tools: start paint drag
      editorState.isDragging = true;
      editorState.sectionAdditive = e.shiftKey;
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
      onEditorSelectionChange,
      selectionButtonAt,
      panRef,
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

      // A rotate / delete press ends: act if released over the same button.
      if (editorState.selectionButtonPressed) {
        const pressed = editorState.selectionButtonPressed;
        editorState.selectionButtonPressed = null;
        const pos = screenToWorld(e.clientX, e.clientY);
        if (pos && selectionButtonAt(pos.deviceX, pos.deviceY) === pressed) {
          if (pressed === 'rotate') onRotateSelected();
          else onDeleteSelected();
        }
        return;
      }

      // A box selection ends: select what it caught.
      const marquee = editorState.marquee;
      if (marquee) {
        editorState.marquee = null;
        const caught = furnitureInBox(
          officeState.getLayout(),
          marquee.startCol,
          marquee.startRow,
          marquee.endCol,
          marquee.endRow,
        );
        editorState.selectPlacedGroup(
          marquee.additive ? [...new Set([...editorState.selectedUids, ...caught])] : caught,
        );
        onEditorSelectionChange();
        return;
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
          // A plain click in a selection of several narrows it to that item.
          if (
            editorState.selectedFurnitureUid === editorState.dragUid &&
            editorState.extraSelectedUids.length === 0
          ) {
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
    [
      editorState,
      officeState,
      isEditMode,
      onDrop,
      onEditorSelectionChange,
      onRotateSelected,
      onDeleteSelected,
      screenToWorld,
      selectionButtonAt,
    ],
  );

  // Shared by mouse click and touch tap — both resolve a viewport point to a
  // piece of furniture / character / pet / seat interaction.
  const performTap = useCallback(
    (clientX: number, clientY: number, touch: boolean) => {
      const pos = screenToWorld(clientX, clientY);
      if (!pos) return;
      // Whatever this tap lands on, the camera lets go of the piece it was on.
      officeState.cameraPieceUid = null;

      // A piece of interactive furniture (never under a character or a pet: they
      // win). On touch the first tap only shows its outline and label; a tap
      // anywhere else clears them.
      // The Intro's greeter answers no click (and hides what stands behind it).
      if (officeState.greeterAt(pos.worldX, pos.worldY)) return;

      /** The selected agent (never a sub-agent) sent to a seat: its own (back to it)
       *  or a free one (it moves there). False when the seat is someone else's. */
      const seatSelected = (seatId: string): boolean => {
        const id = officeState.selectedAgentId;
        const ch = id !== null ? officeState.characters.get(id) : undefined;
        const seat = officeState.seats.get(seatId);
        if (id === null || !ch || ch.isSubagent || !seat) return false;
        if (ch.seatId === seatId) {
          officeState.sendToSeat(id);
        } else if (!seat.assigned) {
          officeState.reassignSeat(id, seatId);
          transport.send({ type: 'saveAgentSeats', seats: officeState.getPersistableSeats() });
        } else {
          return false;
        }
        officeState.selectedAgentId = null;
        officeState.cameraFollowId = null;
        return true;
      };

      // An agent selected, then a workstation (a PC): the agent goes to the seat in
      // front of it, as a click on that chair would (the PC often hides it).
      if (officeState.selectedAgentId !== null && officeState.greeter === null) {
        const pieceUid = officeState.pieces.at(pos.worldX, pos.worldY, {
          readOnly: piecesReadOnly(),
        });
        const seatId = pieceUid !== null ? officeState.seatOfPiece(pieceUid) : null;
        if (seatId !== null && seatSelected(seatId)) {
          officeState.pieces.clearHover();
          return;
        }
      }

      const piece = officeState.pieces.tapAt(pos.worldX, pos.worldY, {
        readOnly: piecesReadOnly(),
        twoStep: touch,
      });
      if (piece) {
        // During the Intro a piece answers nothing, the camera included (it stays on the greeter).
        if (officeState.greeter !== null) return;
        if (piece.click) onPieceClick?.(piece.click, piece.uid);
        officeState.selectedAgentId = null;
        officeState.cameraFollowId = null;
        // The camera centres on it, as it does on a clicked character.
        officeState.cameraPieceUid = piece.uid;
        return;
      }

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

      // No agent hit — check seat click while agent is selected
      if (officeState.selectedAgentId !== null) {
        const tile = screenToTile(clientX, clientY);
        const seatId = tile ? officeState.getSeatAtTile(tile.col, tile.row) : null;
        if (seatId !== null && seatSelected(seatId)) return;
        // Clicked empty space — deselect
        officeState.selectedAgentId = null;
        officeState.cameraFollowId = null;
      }
    },
    [
      officeState,
      onClick,
      onPieceClick,
      piecesReadOnly,
      screenToWorld,
      screenToTile,
      tapSelectsFirst,
    ],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditMode) return; // handled by mouseDown/mouseUp
      performTap(e.clientX, e.clientY, false);
    },
    [isEditMode, performTap],
  );

  const handleMouseLeave = useCallback(
    (e?: React.MouseEvent) => {
      // Onto the hovered piece's own Furniture label (its ×): still that piece.
      const onto = e?.relatedTarget;
      const ontoLabel = onto instanceof Element && onto.closest(FURNITURE_LABEL_SELECTOR) !== null;
      isPanningRef.current = false;
      editorState.selectionButtonHover = null;
      editorState.selectionButtonPressed = null;
      isEraseDraggingRef.current = false;
      editorState.isDragging = false;
      editorState.endStroke();
      editorState.clearDrag();
      editorState.marquee = null;
      editorState.ghostCol = -1;
      editorState.ghostRow = -1;
      officeState.hoveredAgentId = null;
      officeState.hoveredTile = null;
      // A touch-picked piece stays until a tap elsewhere: only a mouse leaves.
      if (mouseHovers() && !ontoLabel) officeState.pieces.clearHover();

      // Reset cursor in non-edit mode so pointer doesn't get stuck after hovering a pet.
      if (!isEditMode) {
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.style.cursor = 'default';
        }
      }
    },
    [officeState, editorState, isEditMode],
  );

  // The layout editor keeps hover and click on furniture for itself: the one
  // place that says so. Opening it clears the hover before the next frame draws
  // (a layout effect), and while it is open the pointer never reaches the
  // pieces, so no outline or Furniture label shows over the editor.
  useLayoutEffect(() => {
    if (isEditMode) officeState.pieces.clearHover();
  }, [isEditMode, officeState]);

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
          const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom + delta));
          if (newZoom !== zoom) {
            onZoomChange(newZoom);
          }
        }
      } else {
        // Pan via trackpad two-finger scroll or mouse wheel
        const dpr = window.devicePixelRatio || 1;
        officeState.breakCameraFollow();
        panRef.current = clampPan(
          panRef.current.x - e.deltaX * dpr,
          panRef.current.y - e.deltaY * dpr,
        );
      }
    },
    [zoom, onZoomChange, officeState, panRef, clampPan],
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
    onManualPan: () => officeState.breakCameraFollow(),
    onTap: (clientX, clientY) => performTap(clientX, clientY, true),
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
