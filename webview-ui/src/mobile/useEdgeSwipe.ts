import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { MOBILE_VIEW_TRANSITION_MS } from '../constants.js';
import { findTouch } from '../touch/touchPrimitives.js';
import type { EdgeSwipeEffect, EdgeSwipeEvent, EdgeSwipeState, SwipeTarget } from './edgeSwipe.js';
import { initialEdgeSwipeState, reduceEdgeSwipe } from './edgeSwipe.js';

/** The track's resting transform for the page currently showing. */
export function trackTransform(view: 'office' | 'terminal'): string {
  return view === 'terminal' ? 'translateX(-50%)' : 'translateX(0)';
}

export const TRACK_TRANSITION = `transform ${String(MOBILE_VIEW_TRANSITION_MS)}ms ease-out`;

/**
 * Wires the edge-swipe state machine (edgeSwipe.ts) to the mobile shell.
 * `target` is the page a swipe would go to (null = no swipe, e.g. no
 * terminal to go to); a commit calls `onCommit`, the same handler as the
 * view toggle button.
 *
 * Capture listeners on the shell run before the terminal's and canvas's own
 * capture handlers. The toggle button, copy pill, and selection handles
 * opt out (`button, [data-handle]`).
 */
export function useEdgeSwipe(
  shellRef: RefObject<HTMLDivElement | null>,
  trackRef: RefObject<HTMLDivElement | null>,
  target: SwipeTarget | null,
  onCommit: () => void,
): void {
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  useEffect(() => {
    const shell = shellRef.current;
    const track = trackRef.current;
    if (!shell || !track || target === null) return;
    const restingTransform = trackTransform(target === 'terminal' ? 'office' : 'terminal');

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
      const step = reduceEdgeSwipe(state, event, target);
      state = step.state;
      for (const effect of step.effects) apply(e, effect);
    };

    const apply = (e: TouchEvent, effect: EdgeSwipeEffect) => {
      switch (effect.type) {
        case 'arm':
          if (e.cancelable) e.preventDefault();
          if (e.target instanceof HTMLElement) bindRescue(e.target);
          break;
        case 'release':
          unbindRescue();
          break;
        case 'claim': {
          track.style.transition = 'none';
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
          track.style.transform = `translateX(${String(effect.translatePx)}px)`;
          break;
        case 'commit':
          // Restore the transition, then let the view flip patch the
          // transform — the browser animates from the dragged position.
          track.style.transition = TRACK_TRANSITION;
          onCommitRef.current();
          break;
        case 'settle':
          track.style.transition = TRACK_TRANSITION;
          track.style.transform = restingTransform;
          break;
      }
    };

    const onStart = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      const rect = shell.getBoundingClientRect();
      run(e, {
        type: 'start',
        touch,
        touches: Array.from(e.touches),
        t: e.timeStamp,
        shell: { left: rect.left, right: rect.right, width: rect.width },
        optOut: e.target instanceof Element && e.target.closest('button, [data-handle]') !== null,
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
  }, [shellRef, trackRef, target]);
}
