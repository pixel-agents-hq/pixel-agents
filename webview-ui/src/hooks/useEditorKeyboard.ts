import { useEffect } from 'react';

import type { EditorState } from '../office/editor/editorState.js';
import { EditTool } from '../office/types.js';

export function useEditorKeyboard(
  isEditMode: boolean,
  editorState: EditorState,
  onDeleteSelected: () => void,
  onRotateSelected: () => void,
  onToggleState: () => void,
  onUndo: () => void,
  onRedo: () => void,
  onEditorTick: () => void,
  onCloseEditMode: () => void,
): void {
  useEffect(() => {
    if (!isEditMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Multi-stage Esc: deselect item → close tool → deselect placed → close editor
        if (editorState.activeTool === EditTool.FURNITURE_PICK) {
          editorState.activeTool = EditTool.FURNITURE_PLACE;
          editorState.clearGhost();
        } else if (
          editorState.activeTool === EditTool.FURNITURE_PLACE &&
          editorState.selectedFurnitureType !== ''
        ) {
          editorState.selectedFurnitureType = '';
          editorState.clearPickedItem();
          editorState.clearGhost();
        } else if (editorState.activeTool !== EditTool.SELECT) {
          editorState.activeTool = EditTool.SELECT;
          editorState.clearGhost();
        } else if (editorState.selectedFurnitureUid) {
          editorState.clearSelection();
        } else {
          onCloseEditMode();
          return;
        }
        editorState.clearDrag();
        onEditorTick();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editorState.selectedFurnitureUid) {
          onDeleteSelected();
        }
      } else if (e.key === 'r' || e.key === 'R') {
        onRotateSelected();
      } else if (e.key === 't' || e.key === 'T') {
        onToggleState();
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        onUndo();
      } else if (
        (e.key === 'y' && (e.ctrlKey || e.metaKey)) ||
        (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)
      ) {
        e.preventDefault();
        onRedo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    isEditMode,
    editorState,
    onDeleteSelected,
    onRotateSelected,
    onToggleState,
    onUndo,
    onRedo,
    onEditorTick,
    onCloseEditMode,
  ]);
}
