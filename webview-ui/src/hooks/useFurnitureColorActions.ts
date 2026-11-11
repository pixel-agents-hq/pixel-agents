import { useCallback } from 'react';

import type { ColorValue } from '../components/ui/types.js';
import { EDIT_OUTLINE_HIDE_MS } from '../constants.js';
import { furnitureAt, setFurnitureColors } from '../office/editor/editorActions.js';
import type { EditorState } from '../office/editor/editorState.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { OfficeLayout } from '../office/types.js';
import { EditTool } from '../office/types.js';

/**
 * Commit a layout edit under an undo session key (see EditorState.beginEdit):
 * edits sharing a key collapse into one undo entry, `null` is a discrete edit.
 */
export type CommitLayout = (layout: OfficeLayout, session: string | null) => void;

export interface FurnitureColorActions {
  /** Colour sliders of the selected placed item (null removes its colour). */
  handleSelectedFurnitureColorChange: (color: ColorValue | null) => void;
  /** Palette colour for NEW furniture (catalog thumbnails, ghost, placement). */
  handlePickedFurnitureColorChange: (color: ColorValue | null) => void;
  /** Arm/disarm the colour-only eyedropper offered by the colour sliders. */
  handleColorPickToggle: () => void;
  /** The armed eyedropper's click on (col, row). */
  pickColorAt: (col: number, row: number) => void;
}

/**
 * The furniture colour controls: a selected item's sliders, the palette
 * sliders for new furniture, and the colour-only eyedropper (COLOR_PICK) both
 * sets of sliders can arm.
 */
export function useFurnitureColorActions(
  getOfficeState: () => OfficeState,
  editorState: EditorState,
  commitLayout: CommitLayout,
  bumpTick: () => void,
): FurnitureColorActions {
  // A slider drag is one undo entry per selection: every change in the run
  // shares the `color:<uids>` session, and colours every selected item.
  const handleSelectedFurnitureColorChange = useCallback(
    (color: ColorValue | null) => {
      const uids = editorState.selectedUids;
      if (uids.length === 0) return;
      const layout = getOfficeState().getLayout();
      // Highlights out of the way while the colour changes; back once it settles.
      editorState.outlineHiddenUntil = performance.now() + EDIT_OUTLINE_HIDE_MS;
      commitLayout(setFurnitureColors(layout, uids, color), `color:${uids.join(',')}`);
    },
    [getOfficeState, editorState, commitLayout],
  );

  // Not a layout edit — stored imperatively on editorState, read at placement.
  const handlePickedFurnitureColorChange = useCallback(
    (color: ColorValue | null) => {
      editorState.setPaletteColor(color);
      bumpTick();
    },
    [editorState, bumpTick],
  );

  const handleColorPickToggle = useCallback(() => {
    if (editorState.activeTool === EditTool.COLOR_PICK) {
      editorState.endColorPick();
    } else {
      editorState.beginColorPick();
    }
    bumpTick();
  }, [editorState, bumpTick]);

  /**
   * Take the clicked item's colour into whichever sliders armed the eyedropper
   * — a selected item's own colour, or the palette colour for new furniture —
   * and leave types alone. An item with no colour of its own copies as "no
   * colour", the same as Reset. Any click ends the mode, so clicking bare floor
   * is how you back out.
   */
  const pickColorAt = useCallback(
    (col: number, row: number) => {
      const layout = getOfficeState().getLayout();
      const hit = furnitureAt(layout, col, row);
      if (hit) {
        const color = hit.color ? { ...hit.color } : null;
        const uids = editorState.selectedUids;
        if (uids.length) {
          // Its own undo entry: an eyedrop never folds into an earlier slider run.
          commitLayout(setFurnitureColors(layout, uids, color), null);
        } else {
          editorState.setPaletteColor(color);
        }
      }
      editorState.endColorPick();
      bumpTick();
    },
    [getOfficeState, editorState, commitLayout, bumpTick],
  );

  return {
    handleSelectedFurnitureColorChange,
    handlePickedFurnitureColorChange,
    handleColorPickToggle,
    pickColorAt,
  };
}
