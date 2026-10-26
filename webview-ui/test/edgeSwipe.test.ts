import { describe, expect, it } from 'vitest';

import { MOBILE_EDGE_SWIPE_SLOP_PX, MOBILE_EDGE_SWIPE_ZONE_PX } from '../src/constants.js';
import type {
  EdgeSwipeEffect,
  EdgeSwipeEvent,
  EdgeSwipeState,
  SwipeEdges,
} from '../src/mobile/edgeSwipe.js';
import { initialEdgeSwipeState, reduceEdgeSwipe } from '../src/mobile/edgeSwipe.js';

const SHELL = { left: 0, right: 400 };
/** The office with a terminal: the right edge pulls the terminal (the shell's
 *  width), the left edge the menu (narrower). */
const OFFICE: SwipeEdges = { left: 300, right: 400 };
/** The terminal: the left edge pulls the office back. */
const TERMINAL: SwipeEdges = { left: 400 };
const touch = (identifier: number, clientX: number, clientY = 300) => ({
  identifier,
  clientX,
  clientY,
});

/** Feed events through the reducer, collecting every effect type in order. */
function run(edges: SwipeEdges, events: EdgeSwipeEvent[]) {
  let state: EdgeSwipeState = initialEdgeSwipeState;
  const effects: EdgeSwipeEffect[] = [];
  for (const e of events) {
    const step = reduceEdgeSwipe(state, e.type === 'start' ? { ...e, edges } : e);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, types: effects.map((e) => e.type), effects };
}

const start = (x: number, id = 1, extra: Partial<EdgeSwipeEvent & { type: 'start' }> = {}) =>
  ({
    type: 'start',
    touch: touch(id, x),
    touches: [touch(id, x)],
    t: 0,
    shell: SHELL,
    edges: {},
    optOut: false,
    ...extra,
  }) as EdgeSwipeEvent;
const move = (x: number, y = 300, t = 16, id = 1): EdgeSwipeEvent => ({
  type: 'move',
  changed: [touch(id, x, y)],
  t,
});
const end = (id = 1): EdgeSwipeEvent => ({ type: 'end', changed: [touch(id, 0)] });

describe('edge swipe', () => {
  const edgeX = SHELL.right - MOBILE_EDGE_SWIPE_ZONE_PX / 2;

  it('arms only inside the strip of an edge that pulls something', () => {
    expect(run(OFFICE, [start(edgeX)]).types).toEqual(['arm']);
    expect(run(OFFICE, [start(100)]).types).toEqual([]);
    expect(run(OFFICE, [start(4)]).types).toEqual(['arm']);
    // In the terminal only the left edge pulls (the office back).
    expect(run(TERMINAL, [start(edgeX)]).types).toEqual([]);
    expect(run(TERMINAL, [start(4)]).types).toEqual(['arm']);
  });

  it('an edge arm keeps the OS edge swipe away; an anywhere arm leaves taps alone', () => {
    expect(run(OFFICE, [start(4)]).effects).toEqual([{ type: 'arm', blockNative: true }]);
    // The open menu swiped shut: mid-screen arms, without blocking the click.
    const open = run({ right: 300 }, [start(150, 1, { anywhere: true })]);
    expect(open.effects).toEqual([{ type: 'arm', blockNative: false }]);
    const r = run({ right: 300 }, [start(150, 1, { anywhere: true }), move(30)]);
    expect(r.effects.at(-1)).toEqual({ type: 'drag', edge: 'right', px: 120 });
  });

  it('never arms on an opted-out target (buttons, selection handles)', () => {
    expect(run(OFFICE, [start(edgeX, 1, { optOut: true })]).types).toEqual([]);
  });

  it('claims a clearly horizontal drag and drags the track with the finger', () => {
    const { types, effects } = run(OFFICE, [start(edgeX), move(edgeX - 50)]);
    expect(types).toEqual(['arm', 'claim', 'consume', 'drag']);
    expect(effects.at(-1)).toEqual({ type: 'drag', edge: 'right', px: 50 });
  });

  it('a left-edge swipe pulls its own panel, no further than it travels', () => {
    const { effects } = run(OFFICE, [start(4), move(54), move(504, 300, 32)]);
    expect(effects.filter((e) => e.type === 'drag')).toEqual([
      { type: 'drag', edge: 'left', px: 50 },
      { type: 'drag', edge: 'left', px: 300 },
    ]);
  });

  it("commits against the pulled panel's travel, not the shell's width", () => {
    // 120 px is 40% of the menu's 300 but only 30% of the shell's 400.
    const r = run(OFFICE, [start(4), move(64, 300, 1000), move(124, 300, 2000), end()]);
    expect(r.effects.at(-1)).toEqual({ type: 'commit', edge: 'left' });
  });

  it('hands a vertical drag back for good', () => {
    const r = run(OFFICE, [
      start(edgeX),
      move(edgeX, 300 + MOBILE_EDGE_SWIPE_SLOP_PX + 5),
      move(edgeX - 100),
    ]);
    expect(r.types).toEqual(['arm', 'release']);
    expect(r.state.phase).toBe('idle');
  });

  it('commits past the distance ratio, settles back short of it', () => {
    const far = run(OFFICE, [
      start(edgeX),
      move(edgeX - 50, 300, 1000),
      move(edgeX - 200, 300, 2000),
      end(),
    ]);
    expect(far.types.at(-1)).toBe('commit');
    const near = run(OFFICE, [
      start(edgeX),
      move(edgeX - 20, 300, 1000),
      move(edgeX - 30, 300, 2000),
      end(),
    ]);
    expect(near.types.at(-1)).toBe('settle');
  });

  it('commits a short fast flick on velocity', () => {
    const r = run(OFFICE, [
      start(edgeX),
      move(edgeX - 20, 300, 10),
      move(edgeX - 60, 300, 20),
      end(),
    ]);
    expect(r.types.at(-1)).toBe('commit');
  });

  it('ignores a second finger: only the tracked touch moves or ends the swipe', () => {
    const r = run(OFFICE, [start(edgeX, 1), move(edgeX - 80, 300, 16, 2), end(2)]);
    expect(r.types).toEqual(['arm']);
    expect(r.state.phase).toBe('armed');
  });

  it('self-heals an arm whose end never arrived', () => {
    // Finger 1 armed, its end was lost; a new touch with finger 1 gone resets it.
    const r = run(OFFICE, [start(edgeX, 1), start(edgeX, 2, { touches: [touch(2, edgeX)] })]);
    expect(r.types).toEqual(['arm', 'release', 'arm']);
    expect(r.state.phase === 'armed' && r.state.id).toBe(2);
  });

  it('a cancelled claimed drag settles back', () => {
    const r = run(OFFICE, [
      start(edgeX),
      move(edgeX - 50),
      { type: 'cancel', changed: [touch(1, 0)] },
    ]);
    expect(r.types.slice(-2)).toEqual(['release', 'settle']);
  });
});
