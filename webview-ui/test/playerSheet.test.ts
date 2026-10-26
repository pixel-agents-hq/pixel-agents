import { describe, expect, it } from 'vitest';

import {
  MUSIC_FLICK_MAX_AGE_MS,
  MUSIC_FLICK_PX_PER_MS,
  TOUCH_TAP_MAX_MOVE_PX,
} from '../src/constants.js';
import { moveSheetDrag, releaseSheetDrag, startSheetDrag } from '../src/music/playerSheet.js';

const TRAVEL = 100;
const touch = (clientY: number, clientX = 50, identifier = 7) => ({
  identifier,
  clientX,
  clientY,
});

describe('player sheet gesture', () => {
  it('starts where the player stands: out at 0, tucked away at its travel', () => {
    expect(startSheetDrag(touch(300), 0, true, TRAVEL)).toMatchObject({
      id: 7,
      base: 0,
      vertical: null,
    });
    expect(startSheetDrag(touch(300), 0, false, TRAVEL).base).toBe(TRAVEL);
  });

  it('holds still inside the tap slop, then follows the finger, clamped to the travel', () => {
    const d = startSheetDrag(touch(300), 0, false, TRAVEL);
    expect(moveSheetDrag(d, touch(300 - TOUCH_TAP_MAX_MOVE_PX), 10)).toBeNull();
    expect(d.vertical).toBeNull();
    expect(moveSheetDrag(d, touch(260), 20)).toEqual({ offset: 60 });
    expect(d.vertical).toBe(true);
    expect(moveSheetDrag(d, touch(100), 30)).toEqual({ offset: 0 });
    expect(moveSheetDrag(d, touch(500), 40)).toEqual({ offset: TRAVEL });
  });

  it('locks sideways when the finger leaves the slop sideways, and then never moves or settles', () => {
    const d = startSheetDrag(touch(300, 50), 0, true, TRAVEL);
    expect(moveSheetDrag(d, touch(310, 90), 10)).toBeNull();
    expect(d.vertical).toBe(false);
    expect(moveSheetDrag(d, touch(380, 90), 20)).toBeNull();
    expect(releaseSheetDrag(d, touch(380, 90), 30)).toBeNull();
  });

  it('settles nothing for a tap', () => {
    const d = startSheetDrag(touch(300), 0, false, TRAVEL);
    expect(releaseSheetDrag(d, touch(301), 50)).toBeNull();
  });

  it('opens on a flick up and shuts on a flick down, whichever half it is in', () => {
    const v = MUSIC_FLICK_PX_PER_MS * 1.5;
    // Tucked away, barely raised, thrown up: opens.
    const up = startSheetDrag(touch(300), 0, false, TRAVEL);
    moveSheetDrag(up, touch(285), 100);
    moveSheetDrag(up, touch(285 - v * 10), 110);
    expect(releaseSheetDrag(up, touch(285 - v * 10), 120)).toBe(true);
    // Out, barely lowered, thrown down: shuts.
    const down = startSheetDrag(touch(300), 0, true, TRAVEL);
    moveSheetDrag(down, touch(315), 100);
    moveSheetDrag(down, touch(315 + v * 10), 110);
    expect(releaseSheetDrag(down, touch(315 + v * 10), 120)).toBe(false);
  });

  it('settles a slow drag by the half it was let go in', () => {
    const slow = MUSIC_FLICK_PX_PER_MS / 2;
    const open = startSheetDrag(touch(300), 0, false, TRAVEL);
    moveSheetDrag(open, touch(280), 100);
    moveSheetDrag(open, touch(280 - slow * 100), 200);
    expect(releaseSheetDrag(open, touch(240), 210)).toBe(true); // offset 40: the open half
    const shut = startSheetDrag(touch(300), 0, false, TRAVEL);
    moveSheetDrag(shut, touch(280), 100);
    moveSheetDrag(shut, touch(280 - slow * 40), 140);
    expect(releaseSheetDrag(shut, touch(260), 150)).toBe(false); // offset 60: the shut half
  });

  it('counts a flick that rested before lifting as no flick', () => {
    const d = startSheetDrag(touch(300), 0, false, TRAVEL);
    moveSheetDrag(d, touch(285), 100);
    moveSheetDrag(d, touch(265), 110); // 2 px/ms up
    expect(releaseSheetDrag(d, touch(265), 110 + MUSIC_FLICK_MAX_AGE_MS)).toBe(true); // still fresh
    expect(releaseSheetDrag(d, touch(265), 111 + MUSIC_FLICK_MAX_AGE_MS)).toBe(false); // offset 65
  });

  it('keeps the last speed when two moves land at the same time', () => {
    const d = startSheetDrag(touch(300), 0, false, TRAVEL);
    moveSheetDrag(d, touch(280), 10); // 2 px/ms up
    moveSheetDrag(d, touch(290), 10); // dt = 0: speed unchanged
    expect(d.vy).toBe(-2);
  });
});
