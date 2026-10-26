import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { MOBILE_VIEW_TRANSITION_MS } from '../constants.js';
import { findTouch } from '../touch/touchPrimitives.js';
import type {
  EdgeSwipeEffect,
  EdgeSwipeEvent,
  EdgeSwipeState,
  SwipeEdge,
  SwipeEdges,
} from './edgeSwipe.js';
import { initialEdgeSwipeState, reduceEdgeSwipe } from './edgeSwipe.js';

/** The track's resting transform for the page currently showing. */
export function trackTransform(view: 'office' | 'terminal'): string {
  return view === 'terminal' ? 'translateX(-50%)' : 'translateX(0)';
}

export const TRACK_TRANSITION = `transform ${String(MOBILE_VIEW_TRANSITION_MS)}ms ease-out`;

/** What an edge swipe pulls in: the shell's track, or the menu. */
export interface SwipePanel {
  /** How far it travels (px): a full swipe pulls it all the way in. */
  travel(): number;
  /** Follow the finger, pulled `px` in (0 to its travel), without animating. */
  drag(px: number): void;
  /** Released far or fast enough: animate the rest of the way in. */
  commit(): void;
  /** Released short: animate back out. */
  settle(): void;
}

export type SwipePanels = Partial<Record<SwipeEdge, SwipePanel>>;

export interface EdgeSwipeOptions {
  /** A swipe may start anywhere on the element, not only at an edge (an open
   *  panel swiped shut); taps on it still click. */
  anywhere?: boolean;
  /** Elements a swipe never starts on. */
  optOut?: string;
}

/** By default buttons (the view toggle, the copy pill) and the selection
 *  handles keep their touches. */
const DEFAULT_OPT_OUT = 'button, [data-handle]';

/**
 * Wires the edge-swipe state machine (edgeSwipe.ts) to the mobile shell: a
 * swipe from an edge in `panels` pulls that panel in with the finger.
 *
 * Capture listeners on the shell run before the terminal's and canvas's own
 * capture handlers.
 */
export function useEdgeSwipe(
  shellRef: RefObject<HTMLElement | null>,
  panels: SwipePanels,
  { anywhere = false, optOut = DEFAULT_OPT_OUT }: EdgeSwipeOptions = {},
): void {
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const hasLeft = panels.left !== undefined;
  const hasRight = panels.right !== undefined;

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || (!hasLeft && !hasRight)) return;
    const panel = (edge: SwipeEdge) => panelsRef.current[edge];

    let state: EdgeSwipeState = initialEdgeSwipeState;
    let armedTarget: HTMLElement | null = null;
    // Set while we dispatch our own touchcancel, so onCancel ignores it.
    let dispatchingCancel = false;

    // Terminal rows are rebuilt on every repaint, and WebKit keeps addressing
    // a gesture's events to its touchstart node — detached, they stop
    // propagating through the shell, which both froze a claimed swipe and
    // left the arm stuck (blocking every later swipe). Same cure as the
    // terminal's own gestures: rescue listeners bound to the armed target
    // keep the stream, and only act when the shell can no longer see it.
    const rescued = (handler: (e: TouchEvent) => void) => (e: TouchEvent) => {
      if (e.target instanceof Node && shell.contains(e.target)) return;
      handler(e);
    };
    const rescueMove = rescued((e) => onMove(e));
    const rescueEnd = rescued((e) => onEnd(e));
    const rescueCancel = rescued((e) => onCancel(e));
    const bindRescue = (el: HTMLElement) => {
      armedTarget = el;
      el.addEventListener('touchmove', rescueMove, { passive: false });
      el.addEventListener('touchend', rescueEnd);
      el.addEventListener('touchcancel', rescueCancel);
    };
    const unbindRescue = () => {
      if (!armedTarget) return;
      armedTarget.removeEventListener('touchmove', rescueMove);
      armedTarget.removeEventListener('touchend', rescueEnd);
      armedTarget.removeEventListener('touchcancel', rescueCancel);
      armedTarget = null;
    };

    const run = (e: TouchEvent, event: EdgeSwipeEvent) => {
      const step = reduceEdgeSwipe(state, event);
      state = step.state;
      for (const effect of step.effects) apply(e, effect);
    };

    const apply = (e: TouchEvent, effect: EdgeSwipeEffect) => {
      switch (effect.type) {
        case 'arm':
          if (effect.blockNative && e.cancelable) e.preventDefault();
          if (e.target instanceof HTMLElement) bindRescue(e.target);
          break;
        case 'release':
          unbindRescue();
          break;
        case 'claim': {
          // Tell whatever was underneath (the terminal's scroll/long-press,
          // the canvas pan) that its touch is over — a real bubbling
          // touchcancel cleans their state through the same paths a system
          // cancel would, attached or detached.
          const touch = findTouch(e.changedTouches, effect.touchId);
          const underneath = armedTarget ?? e.target;
          if (!touch || !underneath) break;
          dispatchingCancel = true;
          try {
            underneath.dispatchEvent(
              new TouchEvent('touchcancel', {
                bubbles: true,
                changedTouches: [touch],
                touches: [],
                targetTouches: [],
              }),
            );
          } catch {
            // No TouchEvent constructor: underlying gestures self-heal on
            // their next touch instead.
          }
          dispatchingCancel = false;
          break;
        }
        case 'consume':
          e.stopPropagation();
          // The armed target may carry the terminal's own rescue listeners;
          // stopPropagation can't silence same-node listeners, this can.
          e.stopImmediatePropagation();
          if (e.type === 'touchmove' && e.cancelable) e.preventDefault();
          break;
        case 'drag':
          panel(effect.edge)?.drag(effect.px);
          break;
        case 'commit':
          panel(effect.edge)?.commit();
          break;
        case 'settle':
          panel(effect.edge)?.settle();
          break;
      }
    };

    const onStart = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      const rect = shell.getBoundingClientRect();
      const edges: SwipeEdges = {};
      for (const edge of ['left', 'right'] as const) {
        const travel = panel(edge)?.travel();
        if (travel) edges[edge] = travel;
      }
      run(e, {
        type: 'start',
        touch,
        touches: Array.from(e.touches),
        t: e.timeStamp,
        shell: { left: rect.left, right: rect.right },
        edges,
        anywhere,
        optOut: optOut !== '' && e.target instanceof Element && e.target.closest(optOut) !== null,
      });
    };
    const onMove = (e: TouchEvent) =>
      run(e, { type: 'move', changed: Array.from(e.changedTouches), t: e.timeStamp });
    const onEnd = (e: TouchEvent) => run(e, { type: 'end', changed: Array.from(e.changedTouches) });
    const onCancel = (e: TouchEvent) => {
      if (dispatchingCancel) return;
      run(e, { type: 'cancel', changed: Array.from(e.changedTouches) });
    };

    shell.addEventListener('touchstart', onStart, { capture: true, passive: false });
    shell.addEventListener('touchmove', onMove, { capture: true, passive: false });
    shell.addEventListener('touchend', onEnd, { capture: true });
    shell.addEventListener('touchcancel', onCancel, { capture: true });
    return () => {
      unbindRescue();
      shell.removeEventListener('touchstart', onStart, { capture: true });
      shell.removeEventListener('touchmove', onMove, { capture: true });
      shell.removeEventListener('touchend', onEnd, { capture: true });
      shell.removeEventListener('touchcancel', onCancel, { capture: true });
    };
  }, [shellRef, hasLeft, hasRight, anywhere, optOut]);
}

/**
 * The shell's sliding track as a swipe panel: pulled from the page `from`
 * towards the other one; a commit calls `onCommit` (the view toggle), whose
 * re-render patches the transform, and the browser animates from the dragged
 * position.
 */
export function trackPanel(
  trackRef: RefObject<HTMLDivElement | null>,
  shellRef: RefObject<HTMLDivElement | null>,
  from: 'office' | 'terminal',
  onCommit: () => void,
): SwipePanel {
  const width = () => shellRef.current?.clientWidth ?? 0;
  return {
    travel: width,
    drag(px) {
      const track = trackRef.current;
      if (!track) return;
      track.style.transition = 'none';
      const x = from === 'office' ? -px : px - width();
      track.style.transform = `translateX(${String(x)}px)`;
    },
    commit() {
      if (trackRef.current) trackRef.current.style.transition = TRACK_TRANSITION;
      onCommit();
    },
    settle() {
      const track = trackRef.current;
      if (!track) return;
      track.style.transition = TRACK_TRANSITION;
      track.style.transform = trackTransform(from);
    },
  };
}

/** A panel that lives behind a ref (one mounted elsewhere, like the menu);
 *  offered only while the ref is set. */
export function refPanel(ref: RefObject<SwipePanel | null>): SwipePanel {
  return {
    travel: () => ref.current?.travel() ?? 0,
    drag: (px) => ref.current?.drag(px),
    commit: () => ref.current?.commit(),
    settle: () => ref.current?.settle(),
  };
}
