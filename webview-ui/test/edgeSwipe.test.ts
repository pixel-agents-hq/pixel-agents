import { describe, expect, it } from 'vitest';

import { MOBILE_EDGE_SWIPE_SLOP_PX, MOBILE_EDGE_SWIPE_ZONE_PX } from '../src/constants.js';
import type { EdgeSwipeEffect, EdgeSwipeEvent, EdgeSwipeState } from '../src/mobile/edgeSwipe.js';
import { initialEdgeSwipeState, reduceEdgeSwipe } from '../src/mobile/edgeSwipe.js';

const SHELL = { left: 0, right: 400, width: 400 };
const touch = (identifier: number, clientX: number, clientY = 300) => ({
  identifier,
  clientX,
  clientY,
});

/** Feed events through the reducer, collecting every effect type in order. */
function run(target: 'terminal' | 'office', events: EdgeSwipeEvent[]) {
  let state: EdgeSwipeState = initialEdgeSwipeState;
  const effects: EdgeSwipeEffect[] = [];
  for (const e of events) {
    const step = reduceEdgeSwipe(state, e, target);
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

  it('arms only inside the edge strip for the target direction', () => {
    expect(run('terminal', [start(edgeX)]).types).toEqual(['arm']);
    expect(run('terminal', [start(100)]).types).toEqual([]);
    // Back to the office arms on the LEFT edge.
    expect(run('office', [start(edgeX)]).types).toEqual([]);
    expect(run('office', [start(4)]).types).toEqual(['arm']);
  });

  it('never arms on an opted-out target (buttons, selection handles)', () => {
    expect(run('terminal', [start(edgeX, 1, { optOut: true })]).types).toEqual([]);
  });

  it('claims a clearly horizontal drag and drags the track with the finger', () => {
    const { types, effects } = run('terminal', [start(edgeX), move(edgeX - 50)]);
    expect(types).toEqual(['arm', 'claim', 'consume', 'drag']);
    expect(effects.at(-1)).toEqual({ type: 'drag', translatePx: -50 });
  });

  it('hands a vertical drag back for good', () => {
    const r = run('terminal', [
      start(edgeX),
      move(edgeX, 300 + MOBILE_EDGE_SWIPE_SLOP_PX + 5),
      move(edgeX - 100),
    ]);
    expect(r.types).toEqual(['arm', 'release']);
    expect(r.state.phase).toBe('idle');
  });

  it('commits past the distance ratio, settles back short of it', () => {
    const far = run('terminal', [
      start(edgeX),
      move(edgeX - 50, 300, 1000),
      move(edgeX - 200, 300, 2000),
      end(),
    ]);
    expect(far.types.at(-1)).toBe('commit');
    const near = run('terminal', [
      start(edgeX),
      move(edgeX - 20, 300, 1000),
      move(edgeX - 30, 300, 2000),
      end(),
    ]);
    expect(near.types.at(-1)).toBe('settle');
  });

  it('commits a short fast flick on velocity', () => {
    const r = run('terminal', [
      start(edgeX),
      move(edgeX - 20, 300, 10),
      move(edgeX - 60, 300, 20),
      end(),
    ]);
    expect(r.types.at(-1)).toBe('commit');
  });

  it('ignores a second finger: only the tracked touch moves or ends the swipe', () => {
    const r = run('terminal', [start(edgeX, 1), move(edgeX - 80, 300, 16, 2), end(2)]);
    expect(r.types).toEqual(['arm']);
    expect(r.state.phase).toBe('armed');
  });

  it('self-heals an arm whose end never arrived', () => {
    // Finger 1 armed, its end was lost; a new touch with finger 1 gone resets it.
    const r = run('terminal', [start(edgeX, 1), start(edgeX, 2, { touches: [touch(2, edgeX)] })]);
    expect(r.types).toEqual(['arm', 'release', 'arm']);
    expect(r.state.phase === 'armed' && r.state.id).toBe(2);
  });

  it('a cancelled claimed drag settles back', () => {
    const r = run('terminal', [
      start(edgeX),
      move(edgeX - 50),
      { type: 'cancel', changed: [touch(1, 0)] },
    ]);
    expect(r.types.slice(-2)).toEqual(['release', 'settle']);
  });
});
