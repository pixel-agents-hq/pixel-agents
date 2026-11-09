/**
 * How much of the desktop player fits beside the bottom-left toolbar (pure).
 * As the office narrows the player gives up the visualizer first, then the
 * tune's name and mood, and never moves: lifted above the toolbar's row it
 * covered the layout editor's tools instead.
 */

import {
  MUSIC_PLAYER_BARE_WIDTH_PX,
  MUSIC_PLAYER_NO_VISUALIZER_WIDTH_PX,
  MUSIC_PLAYER_TITLE_MIN_WIDTH_PX,
  MUSIC_PLAYER_TOOLBAR_ROOM_PX,
  MUSIC_PLAYER_WIDTH_PX,
} from '../constants.js';

export interface PlayerFit {
  visualizer: boolean;
  /** The tune's name and mood. */
  title: boolean;
  /** The bar's width, in CSS px. */
  width: number;
  /** Narrower than OFFICE_MIN_WIDTH_PX (a host we can't stop from shrinking):
   *  even the bare player overlaps the toolbar, which then wins the clicks. */
  cramped: boolean;
}

export const FULL_PLAYER: PlayerFit = {
  visualizer: true,
  title: true,
  width: MUSIC_PLAYER_WIDTH_PX,
  cramped: false,
};

/** The player for an office `officePx` wide. */
export function playerFit(officePx: number): PlayerFit {
  const room = officePx - MUSIC_PLAYER_TOOLBAR_ROOM_PX;
  if (room >= MUSIC_PLAYER_WIDTH_PX) return FULL_PLAYER;
  if (room >= MUSIC_PLAYER_TITLE_MIN_WIDTH_PX) {
    return {
      visualizer: false,
      title: true,
      width: Math.min(MUSIC_PLAYER_NO_VISUALIZER_WIDTH_PX, room),
      cramped: false,
    };
  }
  return {
    visualizer: false,
    title: false,
    width: MUSIC_PLAYER_BARE_WIDTH_PX,
    cramped: room < MUSIC_PLAYER_BARE_WIDTH_PX,
  };
}
