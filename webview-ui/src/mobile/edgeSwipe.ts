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
 * The mobile shell's edge swipes, as a pure state machine (DOM-free, tested
 * on the Node runner); useEdgeSwipe feeds it touch events and carries out the
 * effects. Each edge pulls in a panel: in the office the right edge pulls the
 * terminal and the left edge the menu; in the terminal the left edge pulls
 * the office back.
 *
 * A touch in the edge strip is ARMED — only preventDefault runs, which keeps
 * iOS's own history edge-swipe away — and is CLAIMED as a swipe only once its
 * movement is clearly horizontal. Until then everything else sees the touch
 * normally, so edge taps still select characters or focus the terminal;
 * vertical intent hands it back for good. A claimed drag moves the panel 1:1
 * with the finger, and the release either commits (distance or flick
 * velocity) or settles back.
 */

/** The edge a swipe starts from: from the left edge it runs right, from the
 *  right edge left. */
export type SwipeEdge = 'left' | 'right';

/** The edges a swipe may start from now, each with how far its panel
 *  travels (px). */
export type SwipeEdges = Partial<Record<SwipeEdge, number>>;

interface Tracking {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  /** px/ms, smoothed. */
  velocity: number;
  edge: SwipeEdge;
  travel: number;
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
      shell: { left: number; right: number };
      edges: SwipeEdges;
      /** Any touch inside `shell` may start the swipe, not only one in an
       *  edge strip (an open panel swiped shut). Such an arm leaves the
       *  touchstart alone: there is no OS edge gesture to keep away, and a
       *  tap must still click. */
      anywhere?: boolean;
      /** The touch began on something that opts out (a button, a selection handle). */
      optOut: boolean;
    }
  | { type: 'move'; changed: readonly TouchPoint[]; t: number }
  | { type: 'end'; changed: readonly TouchPoint[] }
  | { type: 'cancel'; changed: readonly TouchPoint[] };

export type EdgeSwipeEffect =
  /** Armed: keep listening on its target, and (`blockNative`) preventDefault
   *  the touchstart so the OS's own edge swipe stays away. */
  | { type: 'arm'; blockNative: boolean }
  /** Stop listening on the armed target. */
  | { type: 'release' }
  /** Claimed: tell whatever was underneath that this touch is over; drag 1:1. */
  | { type: 'claim'; touchId: number }
  /** The event belongs to the swipe — stop it reaching anything else. */
  | { type: 'consume' }
  /** Pull the edge's panel this far in (px, 0 to its travel). */
  | { type: 'drag'; edge: SwipeEdge; px: number }
  | { type: 'commit'; edge: SwipeEdge }
  | { type: 'settle'; edge: SwipeEdge };

export interface EdgeSwipeStep {
  state: EdgeSwipeState;
  effects: EdgeSwipeEffect[];
}

const IDLE: EdgeSwipeState = { phase: 'idle' };

/** +1 for a swipe that runs right (from the left edge), -1 for one running left. */
const direction = (edge: SwipeEdge) => (edge === 'left' ? 1 : -1);

export const initialEdgeSwipeState: EdgeSwipeState = IDLE;

export function reduceEdgeSwipe(state: EdgeSwipeState, event: EdgeSwipeEvent): EdgeSwipeStep {
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
      const { touch, shell, edges, anywhere = false } = event;
      const zone = anywhere ? Infinity : MOBILE_EDGE_SWIPE_ZONE_PX;
      const edge: SwipeEdge | null =
        edges.left !== undefined && touch.clientX <= shell.left + zone
          ? 'left'
          : edges.right !== undefined && touch.clientX >= shell.right - zone
            ? 'right'
            : null;
      if (!edge || event.optOut) return { state: current, effects };
      effects.push({ type: 'arm', blockNative: !anywhere });
      return {
        state: {
          phase: 'armed',
          id: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastT: event.t,
          velocity: 0,
          edge,
          travel: edges[edge]!,
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
      const px = Math.min(state.travel, Math.max(0, dx * direction(state.edge)));
      effects.push({ type: 'consume' }, { type: 'drag', edge: state.edge, px });
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
      const dir = direction(state.edge);
      const dx = state.lastX - state.startX;
      const commit =
        dx * dir > state.travel * MOBILE_EDGE_SWIPE_COMMIT_RATIO ||
        state.velocity * dir > MOBILE_EDGE_SWIPE_COMMIT_VELOCITY;
      return {
        state: IDLE,
        effects: [
          { type: 'release' },
          { type: 'consume' },
          { type: commit ? 'commit' : 'settle', edge: state.edge },
        ],
      };
    }

    case 'cancel': {
      if (state.phase === 'idle' || !findTouch(event.changed, state.id)) {
        return { state, effects: [] };
      }
      const effects: EdgeSwipeEffect[] = [{ type: 'release' }];
      if (state.phase === 'claimed') effects.push({ type: 'settle', edge: state.edge });
      return { state: IDLE, effects };
    }
  }
}
