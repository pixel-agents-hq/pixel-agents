/**
 * The terminal pane's touch gesture, as a pure reducer: scroll (with an
 * iOS-style flick after release), tap (focus, or open the URL under the
 * finger), long-press text selection, and dragging the selection's handles.
 *
 * Why synthesize any of this: xterm handles touch drags natively only while
 * the app has NOT enabled mouse tracking — Claude Code has, so on a phone its
 * transcript can't be scrolled at all — and native iOS selection is
 * deliberately dead on the terminal (every touch default is prevented to keep
 * Safari from claiming gestures). Drags become wheel ticks fed into xterm's
 * own wheel pipeline, selection is rebuilt on xterm's selection model.
 *
 * The machine is ONE phase at a time, so combinations that used to be
 * representable — selecting while scrolling, a handle drag while a scroll is
 * tracked — no longer are. It never touches the DOM: touchInput.ts feeds it
 * events, answers its geometry/buffer questions through a GestureProbe, and
 * executes the effects it returns. That keeps it on the Node test runner.
 */

import {
  TERMINAL_FLICK_DECAY_PER_MS,
  TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS,
  TERMINAL_FLICK_VELOCITY_SMOOTHING,
  TOUCH_TAP_MAX_DURATION_MS,
  TOUCH_TAP_MAX_MOVE_PX,
} from '../constants.js';
import type { TouchListLike, TouchPoint } from '../touch/touchPrimitives.js';
import { findTouch, withinTapSlop } from '../touch/touchPrimitives.js';
import type { CellPos, CellRange, HandleEnd } from './selectionMath.js';
import { cellRange, dragHandle, extendFromAnchor, wordRangeAt } from './selectionMath.js';

/** What a touch's target is: the copy pill (whose own click must survive, so
 *  its touches are left entirely alone), a selection handle, or the
 *  terminal's cell grid. */
export type TouchHit = { kind: 'pill' } | { kind: 'handle'; end: HandleEnd } | { kind: 'cell' };

interface Point {
  x: number;
  y: number;
}

export type TouchGestureState =
  /** No gesture. */
  | { phase: 'idle' }
  /** A finger is down within the tap slop: may still become a tap, a scroll,
   *  or (held still) a long-press selection. */
  | { phase: 'pending'; touchId: number; start: Point & { t: number }; last: Point }
  /** Past the vertical slop: every move scrolls. `remainder` carries the
   *  sub-row drag that hasn't made a whole wheel tick yet. */
  | {
      phase: 'scrolling';
      touchId: number;
      last: Point & { t: number };
      velocity: number;
      remainder: number;
    }
  /** Released with velocity: decaying wheel ticks, one batch per frame, at
   *  the release point. */
  | { phase: 'flicking'; at: Point; lastT: number; velocity: number; remainder: number }
  /** Long-pressed: dragging extends the selection from `anchor` (the pressed
   *  word, or the single pressed cell when it was blank — then `range` stays
   *  null until the finger moves). */
  | { phase: 'selecting'; touchId: number; anchor: CellRange; range: CellRange | null }
  /** A selection is up with its handles (and usually the copy pill). */
  | { phase: 'selected'; range: CellRange }
  /** One handle is being dragged by `touchId`. */
  | { phase: 'handleDrag'; touchId: number; end: HandleEnd; range: CellRange };

export const TOUCH_GESTURE_IDLE: TouchGestureState = { phase: 'idle' };

export type TouchGestureEvent =
  /** touchstart. `touch` is its first changed touch; `active` is every
   *  finger now down (e.touches). */
  | { kind: 'start'; touch: TouchPoint | null; active: TouchListLike; t: number; hit: TouchHit }
  | { kind: 'move'; changed: TouchListLike; t: number; hit: TouchHit }
  | { kind: 'end'; changed: TouchListLike; t: number; hit: TouchHit }
  | { kind: 'cancel'; changed: TouchListLike }
  /** The long-press timer (armLongPress) fired. */
  | { kind: 'longPress' }
  /** An animation frame (scheduleFrame) ran at time `t`. */
  | { kind: 'frame'; t: number }
  /** The copy pill was clicked: the selection is done with. */
  | { kind: 'dismiss' };

export type TouchGestureEffect =
  | { kind: 'stopPropagation' }
  /** preventDefault, where the event is cancelable. */
  | { kind: 'preventDefault' }
  /** Bind the detached-target rescue listeners to this touchstart's target. */
  | { kind: 'bindRescue' }
  | { kind: 'unbindRescue' }
  /** (Re)start the long-press timer; it reports back as `longPress`. */
  | { kind: 'armLongPress' }
  | { kind: 'cancelLongPress' }
  /** Dispatch |lines| DOM_DELTA_LINE wheel ticks of sign(lines) at (x, y). */
  | { kind: 'wheel'; lines: number; x: number; y: number }
  /** Request an animation frame; it reports back as `frame`. */
  | { kind: 'scheduleFrame' }
  | { kind: 'cancelFrame' }
  | { kind: 'select'; range: CellRange }
  | { kind: 'clearSelection' }
  /** Show (creating if needed) and position the handles. */
  | { kind: 'showHandles'; range: CellRange }
  | { kind: 'hideHandles' }
  | { kind: 'showPill'; range: CellRange }
  | { kind: 'hidePill' }
  | { kind: 'focus' }
  | { kind: 'openUrl'; url: string };

/** The geometry and buffer questions the reducer asks the adapter. Asked
 *  lazily — each costs a layout read or a buffer scan. */
export interface GestureProbe {
  /** Absolute buffer cell under client point (x, y). */
  cellAt(x: number, y: number): CellPos;
  isBlank(cell: CellPos): boolean;
  urlAt(cell: CellPos): string | null;
  /** Pixel height of one terminal row: one row of drag = one wheel tick. */
  rowHeightPx(): number;
  cols(): number;
}

export interface TouchGestureResult {
  state: TouchGestureState;
  effects: TouchGestureEffect[];
}

const STOP: TouchGestureEffect = { kind: 'stopPropagation' };
const PREVENT: TouchGestureEffect = { kind: 'preventDefault' };

/** Phases that follow one finger by id. */
type TrackingState = Extract<TouchGestureState, { phase: 'pending' | 'scrolling' | 'selecting' }>;
const isTracking = (s: TouchGestureState): s is TrackingState =>
  s.phase === 'pending' || s.phase === 'scrolling' || s.phase === 'selecting';

/**
 * One row-height of drag = one DOM_DELTA_LINE wheel tick: exactly one desktop
 * wheel line in every regime (pixel deltas would ride xterm's measured cell
 * height and its partial-scroll accumulator). Returns the whole ticks in
 * `remainder + dyPx` and what is left over.
 */
export function accumulateWheel(
  remainder: number,
  dyPx: number,
  rowHeightPx: number,
): { lines: number; remainder: number } {
  const total = remainder + dyPx;
  const lines = Math.trunc(total / rowHeightPx);
  return { lines, remainder: total - lines * rowHeightPx };
}

function wheel(
  remainder: number,
  dyPx: number,
  at: Point,
  probe: GestureProbe,
): { remainder: number; effects: TouchGestureEffect[] } {
  const { lines, remainder: left } = accumulateWheel(remainder, dyPx, probe.rowHeightPx());
  return { remainder: left, effects: lines === 0 ? [] : [{ kind: 'wheel', lines, ...at }] };
}

export function reduceTouchGesture(
  state: TouchGestureState,
  event: TouchGestureEvent,
  probe: GestureProbe,
): TouchGestureResult {
  const none = { state, effects: [] };
  switch (event.kind) {
    case 'start':
      return event.hit.kind === 'pill' ? none : onStart(state, event, event.hit);
    case 'move':
      return event.hit.kind === 'pill' ? none : onMove(state, event, probe);
    case 'end':
      return event.hit.kind === 'pill' ? none : onEnd(state, event, probe);
    case 'cancel':
      return onCancel(state, event);
    case 'longPress':
      return onLongPress(state, probe);
    case 'frame':
      return onFrame(state, event.t, probe);
    case 'dismiss':
      return {
        state:
          state.phase === 'selected' || state.phase === 'handleDrag' ? TOUCH_GESTURE_IDLE : state,
        effects: [{ kind: 'clearSelection' }, { kind: 'hidePill' }, { kind: 'hideHandles' }],
      };
  }
}

function onStart(
  state: TouchGestureState,
  event: Extract<TouchGestureEvent, { kind: 'start' }>,
  hit: Exclude<TouchHit, { kind: 'pill' }>,
): TouchGestureResult {
  let s = state;
  // Self-heal: if the dragging finger is no longer down (its end event was
  // consumed elsewhere or never arrived), the handle drag is over.
  if (s.phase === 'handleDrag' && !findTouch(event.active, s.touchId)) {
    s = { phase: 'selected', range: s.range };
  }
  // Extra contacts landing while a handle drag is live are swallowed whole.
  if (s.phase === 'handleDrag') return { state: s, effects: [STOP, PREVENT] };
  // A drag starting on a selection handle adjusts that end of the selection
  // instead of starting a scroll.
  if (hit.kind === 'handle' && s.phase === 'selected') {
    if (!event.touch) return { state: s, effects: [STOP, PREVENT] };
    return {
      state: { phase: 'handleDrag', touchId: event.touch.identifier, end: hit.end, range: s.range },
      effects: [STOP, PREVENT, { kind: 'hidePill' }],
    };
  }
  // Pre-empt iOS's long-press recognizer too: it's a NO-movement gesture, so
  // the touchmove preventDefault can't stop it — rest a finger for a beat
  // before dragging (half of natural scrolls) and the text loupe on the
  // editable helper textarea claims the touch, fires touchcancel, and the
  // rest of the drag is dead. Nothing native is wanted from terminal
  // touches: taps focus explicitly on end, so even the synthesized click
  // this suppresses isn't needed.
  const effects: TouchGestureEffect[] = [STOP, PREVENT];
  if (s.phase === 'flicking') effects.push({ kind: 'cancelFrame' });
  // The gesture follows ONE finger by identifier. Scrolling one-handed, the
  // palm heel or a second finger grazing the screen edge registers as an
  // extra contact — a gesture that bailed on touches.length !== 1 died the
  // moment that happened (and the graze's touchend killed it for good),
  // stalling roughly every other scroll depending on grip. So: already
  // following a finger that's still down → this is an extra contact; ignore
  // it. The `active` check self-heals a stale gesture whose end never came.
  if (isTracking(s) && findTouch(event.active, s.touchId)) return { state: s, effects };
  if (!event.touch) {
    return { state: s.phase === 'flicking' ? TOUCH_GESTURE_IDLE : s, effects };
  }
  const { identifier, clientX: x, clientY: y } = event.touch;
  // Any live selection, handles, or pill die at the next touch, and the
  // long-press timer arms a fresh selection for this gesture.
  effects.push(
    { kind: 'bindRescue' },
    { kind: 'clearSelection' },
    { kind: 'hidePill' },
    { kind: 'hideHandles' },
    { kind: 'cancelLongPress' },
    { kind: 'armLongPress' },
  );
  return {
    state: { phase: 'pending', touchId: identifier, start: { x, y, t: event.t }, last: { x, y } },
    effects,
  };
}

function onMove(
  state: TouchGestureState,
  event: Extract<TouchGestureEvent, { kind: 'move' }>,
  probe: GestureProbe,
): TouchGestureResult {
  // Consume EVERY move from the first: touch-action only rules out panning —
  // iOS can still claim the drag for text selection (the loupe engages on the
  // helper textarea, an editable), which fires touchcancel and kills the
  // gesture a few px in. Nothing on a terminal needs a native touch gesture,
  // so leave Safari no opening.
  const effects: TouchGestureEffect[] = [STOP, PREVENT];
  if (state.phase === 'handleDrag') {
    const t = findTouch(event.changed, state.touchId);
    if (!t) return { state, effects };
    const range = dragHandle(state.range, state.end, probe.cellAt(t.clientX, t.clientY));
    effects.push({ kind: 'select', range }, { kind: 'showHandles', range });
    return { state: { ...state, range }, effects };
  }
  if (!isTracking(state)) return { state, effects };
  // Only the tracked finger's motion counts; this event may be another
  // contact moving.
  const t = findTouch(event.changed, state.touchId);
  if (!t) return { state, effects };
  const at = { x: t.clientX, y: t.clientY };

  switch (state.phase) {
    case 'selecting': {
      const range = extendFromAnchor(state.anchor, probe.cellAt(at.x, at.y));
      effects.push({ kind: 'select', range });
      return { state: { ...state, range }, effects };
    }
    case 'pending':
      // Within the (vertical) tap slop it may still become a tap or a
      // long-press selection; scrolling starts — and rules both out — only
      // past it. The press point is tracked meanwhile: the long-press reads
      // it to require a still finger even when no move exceeded the slop.
      if (Math.abs(at.y - state.start.y) <= TOUCH_TAP_MAX_MOVE_PX) {
        return { state: { ...state, last: at }, effects };
      }
      effects.push({ kind: 'cancelLongPress' });
      return {
        state: {
          phase: 'scrolling',
          touchId: state.touchId,
          last: { ...at, t: event.t },
          velocity: 0,
          remainder: 0,
        },
        effects,
      };
    case 'scrolling': {
      const dy = state.last.y - at.y;
      const dt = Math.max(1, event.t - state.last.t);
      const velocity =
        TERMINAL_FLICK_VELOCITY_SMOOTHING * (dy / dt) +
        (1 - TERMINAL_FLICK_VELOCITY_SMOOTHING) * state.velocity;
      const ticks = wheel(state.remainder, dy, at, probe);
      effects.push(...ticks.effects);
      return {
        state: { ...state, last: { ...at, t: event.t }, velocity, remainder: ticks.remainder },
        effects,
      };
    }
  }
}

function onEnd(
  state: TouchGestureState,
  event: Extract<TouchGestureEvent, { kind: 'end' }>,
  probe: GestureProbe,
): TouchGestureResult {
  const effects: TouchGestureEffect[] = [STOP];
  if (state.phase === 'handleDrag') {
    if (!findTouch(event.changed, state.touchId)) return { state, effects };
    effects.push({ kind: 'showPill', range: state.range });
    return { state: { phase: 'selected', range: state.range }, effects };
  }
  // A palm graze lifting must not end the real drag — only the tracked
  // finger ends the gesture.
  if (!isTracking(state) || !findTouch(event.changed, state.touchId)) return { state, effects };
  effects.push({ kind: 'unbindRescue' }, { kind: 'cancelLongPress' });

  switch (state.phase) {
    case 'selecting':
      // A press on a blank cell that never moved selected nothing.
      if (!state.range) return { state: TOUCH_GESTURE_IDLE, effects };
      effects.push(
        { kind: 'showHandles', range: state.range },
        { kind: 'showPill', range: state.range },
      );
      return { state: { phase: 'selected', range: state.range }, effects };
    case 'pending':
      // A tap. Handled explicitly instead of relying on the synthesized
      // click: the preventDefaults suppress it, and losing the
      // tap-to-summon-keyboard path is worse than double-focusing on clean
      // taps. The same suppression starves xterm's link providers, so a tap
      // on a URL opens it here instead of focusing.
      if (event.t - state.start.t <= TOUCH_TAP_MAX_DURATION_MS) {
        const url = probe.urlAt(probe.cellAt(state.start.x, state.start.y));
        effects.push(PREVENT, url ? { kind: 'openUrl', url } : { kind: 'focus' });
      }
      return { state: TOUCH_GESTURE_IDLE, effects };
    case 'scrolling':
      if (Math.abs(state.velocity) < TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS) {
        return { state: TOUCH_GESTURE_IDLE, effects };
      }
      effects.push({ kind: 'scheduleFrame' });
      return {
        state: {
          phase: 'flicking',
          at: { x: state.last.x, y: state.last.y },
          lastT: event.t,
          velocity: state.velocity,
          remainder: state.remainder,
        },
        effects,
      };
  }
}

function onCancel(
  state: TouchGestureState,
  event: Extract<TouchGestureEvent, { kind: 'cancel' }>,
): TouchGestureResult {
  const effects: TouchGestureEffect[] = [STOP];
  if (state.phase === 'handleDrag') {
    // The handles stay; only a clean release brings the pill back.
    return findTouch(event.changed, state.touchId)
      ? { state: { phase: 'selected', range: state.range }, effects }
      : { state, effects };
  }
  if (!isTracking(state) || !findTouch(event.changed, state.touchId)) return { state, effects };
  // Whatever was selected mid-gesture stays highlighted, without handles.
  effects.push({ kind: 'unbindRescue' }, { kind: 'cancelLongPress' });
  return { state: TOUCH_GESTURE_IDLE, effects };
}

/**
 * Long-press text selection: a finger held within the tap slop for
 * TERMINAL_LONG_PRESS_MS selects the word under it; dragging on extends the
 * selection cell by cell from that anchor; releasing shows handles at both
 * ends and the copy pill. Long-press means held STILL: a slow drag that
 * stayed under the vertical scroll slop (e.g. mostly horizontal) is not a
 * selection — it stays pending (a tap or a scroll).
 */
function onLongPress(state: TouchGestureState, probe: GestureProbe): TouchGestureResult {
  if (state.phase !== 'pending') return { state, effects: [] };
  if (!withinTapSlop(state.last.x - state.start.x, state.last.y - state.start.y)) {
    return { state, effects: [] };
  }
  const cell = probe.cellAt(state.last.x, state.last.y);
  const word = wordRangeAt(cell, probe.cols(), (c) => probe.isBlank(c));
  const touchId = state.touchId;
  if (word) {
    return {
      state: { phase: 'selecting', touchId, anchor: word, range: word },
      effects: [{ kind: 'select', range: word }],
    };
  }
  // Pressed a blank cell: no initial word, dragging selects from here.
  return {
    state: { phase: 'selecting', touchId, anchor: cellRange(cell), range: null },
    effects: [{ kind: 'clearSelection' }],
  };
}

function onFrame(state: TouchGestureState, t: number, probe: GestureProbe): TouchGestureResult {
  if (state.phase !== 'flicking') return { state, effects: [] };
  const dt = Math.max(1, t - state.lastT);
  const ticks = wheel(state.remainder, state.velocity * dt, state.at, probe);
  const velocity = state.velocity * TERMINAL_FLICK_DECAY_PER_MS ** dt;
  if (Math.abs(velocity) < TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS) {
    return { state: TOUCH_GESTURE_IDLE, effects: ticks.effects };
  }
  return {
    state: { ...state, lastT: t, velocity, remainder: ticks.remainder },
    effects: [...ticks.effects, { kind: 'scheduleFrame' }],
  };
}
