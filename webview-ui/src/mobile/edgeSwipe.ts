import {
  MOBILE_EDGE_SWIPE_COMMIT_RATIO,
  MOBILE_EDGE_SWIPE_COMMIT_VELOCITY,
  MOBILE_EDGE_SWIPE_SLOP_PX,
  MOBILE_EDGE_SWIPE_VELOCITY_WEIGHT,
  MOBILE_EDGE_SWIPE_ZONE_PX,
} from '../constants.js';
import type { TouchPoint } from '../touch/touchPrimitives.js';
import { findTouch } from '../touch/touchPrimitives.js';

/**
 * The edge swipe between the mobile shell's two pages, as a pure state
 * machine (DOM-free, tested on the Node runner); useEdgeSwipe feeds it touch
 * events and carries out the effects.
 *
 * A touch in the edge strip is ARMED — only preventDefault runs, which keeps
 * iOS's own history edge-swipe away — and is CLAIMED as a swipe only once its
 * movement is clearly horizontal. Until then everything else sees the touch
 * normally, so edge taps still select characters or focus the terminal;
 * vertical intent hands it back for good. A claimed drag moves the track 1:1
 * with the finger, and the release either commits (distance or flick
 * velocity) or settles back.
 */

/** Which page the swipe heads for: from the office (right edge, swipe left)
 *  to the terminal, or from the terminal (left edge, swipe right) back. */
export type SwipeTarget = 'terminal' | 'office';

interface Tracking {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  /** px/ms, smoothed. */
  velocity: number;
  width: number;
}

export type EdgeSwipeState =
  { phase: 'idle' } | ({ phase: 'armed' } & Tracking) | ({ phase: 'claimed' } & Tracking);

export type EdgeSwipeEvent =
  | {
      type: 'start';
      touch: TouchPoint;
      /** Fingers currently down — to drop a stale arm whose end never came. */
      touches: readonly TouchPoint[];
      t: number;
      shell: { left: number; right: number; width: number };
      /** The touch began on something that opts out (a button, a selection handle). */
      optOut: boolean;
    }
  | { type: 'move'; changed: readonly TouchPoint[]; t: number }
  | { type: 'end'; changed: readonly TouchPoint[] }
  | { type: 'cancel'; changed: readonly TouchPoint[] };

export type EdgeSwipeEffect =
  /** Armed: preventDefault the touchstart and keep listening on its target. */
  | { type: 'arm' }
  /** Stop listening on the armed target. */
  | { type: 'release' }
  /** Claimed: tell whatever was underneath that this touch is over; drag 1:1. */
  | { type: 'claim'; touchId: number }
  /** The event belongs to the swipe — stop it reaching anything else. */
  | { type: 'consume' }
  /** Move the track to this translateX (px). */
  | { type: 'drag'; translatePx: number }
  | { type: 'commit' }
  | { type: 'settle' };

export interface EdgeSwipeStep {
  state: EdgeSwipeState;
  effects: EdgeSwipeEffect[];
}

const IDLE: EdgeSwipeState = { phase: 'idle' };

export const initialEdgeSwipeState: EdgeSwipeState = IDLE;

export function reduceEdgeSwipe(
  state: EdgeSwipeState,
  event: EdgeSwipeEvent,
  target: SwipeTarget,
): EdgeSwipeStep {
  const toTerminal = target === 'terminal';
  switch (event.type) {
    case 'start': {
      const effects: EdgeSwipeEffect[] = [];
      let current = state;
      // Self-heal an arm whose end was never delivered (its target detached
      // before the finger lifted, so the events stopped reaching us).
      if (current.phase !== 'idle' && !findTouch(event.touches, current.id)) {
        current = IDLE;
        effects.push({ type: 'release' });
      }
      if (current.phase !== 'idle') return { state: current, effects };
      const { touch, shell } = event;
      const inZone = toTerminal
        ? touch.clientX >= shell.right - MOBILE_EDGE_SWIPE_ZONE_PX
        : touch.clientX <= shell.left + MOBILE_EDGE_SWIPE_ZONE_PX;
      if (!inZone || event.optOut) return { state: current, effects };
      effects.push({ type: 'arm' });
      return {
        state: {
          phase: 'armed',
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastT: event.t,
          velocity: 0,
          width: shell.width,
        },
        effects,
      };
    }

    case 'move': {
      if (state.phase === 'idle') return { state, effects: [] };
      const t = findTouch(event.changed, state.id);
      if (!t) return { state, effects: [] };
      const dx = t.clientX - state.startX;
      const dy = t.clientY - state.startY;
      const effects: EdgeSwipeEffect[] = [];
      if (state.phase === 'armed') {
        if (Math.abs(dy) > MOBILE_EDGE_SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) {
          // Vertical intent — hand the touch back for good.
          return { state: IDLE, effects: [{ type: 'release' }] };
        }
        if (Math.abs(dx) < MOBILE_EDGE_SWIPE_SLOP_PX || Math.abs(dx) <= Math.abs(dy)) {
          return { state, effects: [] };
        }
        effects.push({ type: 'claim', touchId: state.id });
      }
      const dt = Math.max(1, event.t - state.lastT);
      const velocity =
        MOBILE_EDGE_SWIPE_VELOCITY_WEIGHT * ((t.clientX - state.lastX) / dt) +
        (1 - MOBILE_EDGE_SWIPE_VELOCITY_WEIGHT) * state.velocity;
      const offset = toTerminal
        ? Math.min(0, Math.max(-state.width, dx))
        : Math.min(state.width, Math.max(0, dx));
      const base = toTerminal ? 0 : -state.width;
      effects.push({ type: 'consume' }, { type: 'drag', translatePx: base + offset });
      return {
        state: { ...state, phase: 'claimed', lastX: t.clientX, lastT: event.t, velocity },
        effects,
      };
    }

    case 'end': {
      if (state.phase === 'idle' || !findTouch(event.changed, state.id)) {
        return { state, effects: [] };
      }
      if (state.phase === 'armed') return { state: IDLE, effects: [{ type: 'release' }] };
      const dir = toTerminal ? -1 : 1;
      const dx = state.lastX - state.startX;
      const commit =
        dx * dir > state.width * MOBILE_EDGE_SWIPE_COMMIT_RATIO ||
        state.velocity * dir > MOBILE_EDGE_SWIPE_COMMIT_VELOCITY;
      return {
        state: IDLE,
        effects: [{ type: 'release' }, { type: 'consume' }, { type: commit ? 'commit' : 'settle' }],
      };
    }

    case 'cancel': {
      if (state.phase === 'idle' || !findTouch(event.changed, state.id)) {
        return { state, effects: [] };
      }
      const effects: EdgeSwipeEffect[] = [{ type: 'release' }];
      if (state.phase === 'claimed') effects.push({ type: 'settle' });
      return { state: IDLE, effects };
    }
  }
}
