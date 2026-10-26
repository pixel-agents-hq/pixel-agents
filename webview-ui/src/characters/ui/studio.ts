/**
 * The Characters view's shared state: the cast, what the view shows (tab, open colour
 * picker, pixel editor), and what every pane can do to it (castActions adds the roster's). Provided once by
 * CharactersView; panes read it with useStudio().
 */

import { createContext, useContext } from 'react';

import type { CharacterProfile } from '../../../../core/src/characterProfiles.js';
import type { CastState } from '../castStore.js';
import type { CharacterRenderer } from '../renderer.js';
import type { ColorKey, TabKey } from '../slots.js';

export type EditorTool = 'pencil' | 'eraser' | 'restore' | 'picker';

/** The pixel editor's tool shortcuts (P is the pencil too). */
export const EDITOR_TOOL_KEYS: Record<string, EditorTool> = {
  b: 'pencil',
  p: 'pencil',
  e: 'eraser',
  r: 'restore',
  i: 'picker',
};

export interface EditorState {
  /** The piece being edited (a LAYERS pix). */
  pix: string;
  /** Sheet frame 0 to FRAME_COUNT - 1 (row * 7 + frame). */
  frame: number;
  tool: EditorTool;
  /** The stored (uncoloured) colour the pencil paints, or null for the piece's middle tone. */
  color: string | null;
  fade: boolean;
  front: boolean;
}

/** Phone views: the wardrobe, the export sheet alone, or the tile editor alone. */
export type PhoneMode = 'wardrobe' | 'sheet' | 'tile';

export type StatusKind = 'ok' | 'err' | '';

export interface Studio {
  renderer: CharacterRenderer;
  cast: CastState;
  profile: CharacterProfile;
  dpr: number;
  phone: boolean;
  phoneMode: PhoneMode;
  setPhoneMode: (mode: PhoneMode) => void;
  tab: TabKey;
  setTab: (tab: TabKey) => void;
  /** The colour key whose picker is open (one at a time). */
  pickerOpen: ColorKey | null;
  setPickerOpen: (key: ColorKey | null) => void;
  editor: EditorState | null;
  openEditor: (frame: number, pix?: string) => void;
  setEditor: (patch: Partial<EditorState>) => void;
  /** Step the edited frame by `d`, wrapping round the sheet. */
  stepFrame: (d: number) => void;
  closeEditor: () => void;
  /** Change the current profile (one undo step per press, see castStore). */
  edit: (change: (draft: CharacterProfile) => void) => void;
  undo: () => void;
  redo: () => void;
  status: (message: string, kind?: StatusKind) => void;
  /** Save the draft to the roster. */
  save: () => void;
  /** Close the view (asks first when there are unsaved changes). */
  close: () => void;
}

export const StudioContext = createContext<Studio | null>(null);

export function useStudio(): Studio {
  const studio = useContext(StudioContext);
  if (!studio) throw new Error('useStudio outside CharactersView');
  return studio;
}
