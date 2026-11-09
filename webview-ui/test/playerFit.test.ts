import { describe, expect, it } from 'vitest';

import {
  MUSIC_PLAYER_BARE_WIDTH_PX,
  MUSIC_PLAYER_NO_VISUALIZER_WIDTH_PX,
  MUSIC_PLAYER_TITLE_MIN_WIDTH_PX,
  MUSIC_PLAYER_TOOLBAR_ROOM_PX,
  MUSIC_PLAYER_WIDTH_PX,
  OFFICE_MIN_WIDTH_PX,
  TERMINAL_DRAWER_MIN_WIDTH_PX,
} from '../src/constants.js';
import { clampDrawerWidth } from '../src/hooks/drawerWidth.js';
import { playerFit } from '../src/music/playerFit.js';

/** The office width that leaves the player exactly `room` px beside the toolbar. */
const officeWith = (room: number) => MUSIC_PLAYER_TOOLBAR_ROOM_PX + room;

describe('playerFit', () => {
  it('shows the whole player while it fits beside the toolbar', () => {
    expect(playerFit(1300)).toEqual({
      visualizer: true,
      title: true,
      width: MUSIC_PLAYER_WIDTH_PX,
      cramped: false,
    });
    expect(playerFit(officeWith(MUSIC_PLAYER_WIDTH_PX)).visualizer).toBe(true);
  });

  it('gives up the visualizer first, then narrows with the room', () => {
    expect(playerFit(officeWith(MUSIC_PLAYER_WIDTH_PX - 1))).toEqual({
      visualizer: false,
      title: true,
      width: MUSIC_PLAYER_NO_VISUALIZER_WIDTH_PX,
      cramped: false,
    });
    expect(playerFit(officeWith(250))).toMatchObject({ title: true, width: 250 });
    expect(playerFit(officeWith(MUSIC_PLAYER_TITLE_MIN_WIDTH_PX)).title).toBe(true);
  });

  it('gives up the name and mood next, down to its buttons', () => {
    expect(playerFit(officeWith(MUSIC_PLAYER_TITLE_MIN_WIDTH_PX - 1))).toEqual({
      visualizer: false,
      title: false,
      width: MUSIC_PLAYER_BARE_WIDTH_PX,
      cramped: false,
    });
    expect(playerFit(OFFICE_MIN_WIDTH_PX).cramped).toBe(false);
  });

  it('never narrows past its buttons: a smaller office is cramped', () => {
    expect(playerFit(OFFICE_MIN_WIDTH_PX - 1)).toMatchObject({
      width: MUSIC_PLAYER_BARE_WIDTH_PX,
      cramped: true,
    });
  });

  it('never overlaps the toolbar from the minimum office up', () => {
    for (let office = OFFICE_MIN_WIDTH_PX; office <= 1400; office++) {
      expect(playerFit(office).width).toBeLessThanOrEqual(office - MUSIC_PLAYER_TOOLBAR_ROOM_PX);
    }
  });
});

describe('clampDrawerWidth and the office minimum', () => {
  it('stops a drag where the office would get narrower than its minimum', () => {
    expect(clampDrawerWidth(5000, 1440)).toBe(1440 - OFFICE_MIN_WIDTH_PX);
    // the open conversation sidebar takes its width from the same row
    expect(clampDrawerWidth(5000, 1440, 260)).toBe(1440 - 260 - OFFICE_MIN_WIDTH_PX);
  });

  it('leaves a narrower drawer alone', () => {
    expect(clampDrawerWidth(520, 1440, 260)).toBe(520);
  });

  it('keeps the drawer its own minimum on a window too small for both', () => {
    expect(clampDrawerWidth(5000, 800)).toBe(TERMINAL_DRAWER_MIN_WIDTH_PX);
    expect(clampDrawerWidth(100, 800, 260)).toBe(TERMINAL_DRAWER_MIN_WIDTH_PX);
  });
});
