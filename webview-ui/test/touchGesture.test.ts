/**
 * The terminal pane's touch gesture reducer (scroll, flick, tap, long-press
 * selection, handle drags).
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * there is no touch e2e — Playwright's Electron/desktop runs can't reproduce
 * the iOS behaviours this machine was tuned against (palm grazes, stale
 * touch ids, the long-press recognizer) — and every rule pinned here was a
 * real on-device bug. The reducer is pure, so each one is one event script.
 */

import { describe, expect, it } from 'vitest';

import {
  TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS,
  TERMINAL_LONG_PRESS_MS,
  TOUCH_TAP_MAX_DURATION_MS,
  TOUCH_TAP_MAX_MOVE_PX,
} from '../src/constants.js';
import type { CellPos, CellRange } from '../src/terminal/selectionMath.js';
import type {
  GestureProbe,
  TouchGestureEffect,
  TouchGestureEvent,
  TouchGestureState,
  TouchHit,
} from '../src/terminal/touchGesture.js';
import {
  accumulateWheel,
  reduceTouchGesture,
  TOUCH_GESTURE_IDLE,
} from '../src/terminal/touchGesture.js';
import type { TouchPoint } from '../src/touch/touchPrimitives.js';

// A 40-col grid of 10x20 px cells, flush at the client origin, unscrolled.
const CELL_W = 10;
const ROW_H = 20;
const COLS = 40;
const SCREEN = ['hello world', '', 'see https://example.com/x now'];
const URL = 'https://example.com/x';

const probe: GestureProbe = {
  cellAt: (x, y) => ({ col: Math.floor(x / CELL_W), row: Math.floor(y / ROW_H) }),
  isBlank: ({ row, col }: CellPos) => {
    const ch = SCREEN[row]?.[col] ?? '';
    return ch === '' || ch === ' ';
  },
  urlAt: ({ row, col }) => {
    const line = SCREEN[row] ?? '';
    const at = line.indexOf(URL);
    return at >= 0 && col >= at && col < at + URL.length ? URL : null;
  },
  rowHeightPx: () => ROW_H,
  cols: () => COLS,
};

const CELL: TouchHit = { kind: 'cell' };
const PILL: TouchHit = { kind: 'pill' };
const touch = (identifier: number, x: number, y: number): TouchPoint => ({
  identifier,
  clientX: x,
  clientY: y,
});

/** A touchstart of `t`, with `down` the fingers on the glass (t included). */
const start = (
  t: TouchPoint,
  ms: number,
  down: TouchPoint[] = [t],
  hit: TouchHit = CELL,
): TouchGestureEvent => ({
  kind: 'start',
  touch: t,
  active: down,
  t: ms,
  hit,
});
const move = (t: TouchPoint, ms: number, hit: TouchHit = CELL): TouchGestureEvent => ({
  kind: 'move',
  changed: [t],
  t: ms,
  hit,
});
const end = (t: TouchPoint, ms: number, hit: TouchHit = CELL): TouchGestureEvent => ({
  kind: 'end',
  changed: [t],
  t: ms,
  hit,
});

/** Feed events in order; collect every effect. */
function run(
  events: TouchGestureEvent[],
  from: TouchGestureState = TOUCH_GESTURE_IDLE,
): { state: TouchGestureState; effects: TouchGestureEffect[] } {
  let state = from;
  const effects: TouchGestureEffect[] = [];
  for (const event of events) {
    const r = reduceTouchGesture(state, event, probe);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const kinds = (effects: TouchGestureEffect[]) => effects.map((e) => e.kind);
const wheelLines = (effects: TouchGestureEffect[]) =>
  effects.reduce((n, e) => (e.kind === 'wheel' ? n + e.lines : n), 0);

describe('one finger, tracked by id', () => {
  it('ignores a palm graze: a second finger neither restarts, scrolls nor ends the gesture', () => {
    const a = touch(1, 100, 200);
    const palm = touch(2, 5, 400);
    let r = run([start(a, 0)]);
    expect(r.state).toMatchObject({ phase: 'pending', touchId: 1 });

    // The graze lands: swallowed (no restart, no fresh long-press timer).
    r = run([start(palm, 10, [a, palm])], r.state);
    expect(r.state).toMatchObject({ phase: 'pending', touchId: 1 });
    expect(kinds(r.effects)).toEqual(['stopPropagation', 'preventDefault']);

    // The real finger scrolls; the palm's own motion is ignored.
    r = run([move(a, 20), move(touch(1, 100, 150), 30), move(touch(2, 5, 100), 40)], r.state);
    expect(r.state.phase).toBe('scrolling');
    r = run([move(touch(1, 100, 110), 50)], r.state);
    expect(wheelLines(r.effects)).toBe(2); // 40px of drag = 2 rows

    // The graze lifting does not end the drag.
    r = run([end(palm, 60)], r.state);
    expect(r.state.phase).toBe('scrolling');
    r = run([move(touch(1, 100, 90), 70)], r.state);
    expect(wheelLines(r.effects)).toBe(1);
  });

  it('self-heals a stale touch id: the next start begins a fresh gesture', () => {
    // Finger 1's end never arrived (consumed elsewhere), so the gesture is
    // stuck tracking it — but it is no longer among the fingers down.
    const stuck = run([start(touch(1, 100, 100), 0), move(touch(1, 100, 160), 10)]).state;
    expect(stuck).toMatchObject({ phase: 'scrolling', touchId: 1 });
    const r = run([start(touch(7, 50, 50), 1000)], stuck);
    expect(r.state).toMatchObject({ phase: 'pending', touchId: 7 });
    expect(kinds(r.effects)).toContain('bindRescue');
    expect(kinds(r.effects)).toContain('armLongPress');
  });

  it('self-heals a handle drag whose finger is gone', () => {
    const range: CellRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 4 };
    const r = run([start(touch(3, 300, 30), 0)], {
      phase: 'handleDrag',
      touchId: 9,
      end: 'end',
      range,
    });
    expect(r.state).toMatchObject({ phase: 'pending', touchId: 3 });
    expect(kinds(r.effects)).toContain('clearSelection');
    expect(kinds(r.effects)).toContain('hideHandles');
  });
});

describe('slop vs long-press', () => {
  it('a finger held still long-presses into a word selection', () => {
    const r = run([
      start(touch(1, 12, 5), 0),
      move(touch(1, 14, 8), 100), // jitter inside the slop
      { kind: 'longPress' },
    ]);
    const hello = { startRow: 0, startCol: 0, endRow: 0, endCol: 4 };
    expect(r.state).toMatchObject({ phase: 'selecting', anchor: hello, range: hello });
    expect(r.effects).toContainEqual({ kind: 'select', range: hello });
  });

  it('a long-press on a blank cell selects nothing until the finger drags', () => {
    let r = run([start(touch(1, 55, 5), 0), { kind: 'longPress' }]);
    expect(r.state).toMatchObject({ phase: 'selecting', range: null });
    expect(kinds(r.effects)).toContain('clearSelection');
    // Releasing without dragging: no handles, no pill.
    r = run([end(touch(1, 55, 5), TERMINAL_LONG_PRESS_MS + 50)], r.state);
    expect(r.state.phase).toBe('idle');
    expect(kinds(r.effects)).not.toContain('showPill');
  });

  it('a slow sideways drag (under the vertical slop) is not a long-press', () => {
    const r = run([
      start(touch(1, 12, 5), 0),
      move(touch(1, 12 + TOUCH_TAP_MAX_MOVE_PX + 5, 5), 200),
      { kind: 'longPress' },
    ]);
    expect(r.state.phase).toBe('pending');
    expect(kinds(r.effects)).not.toContain('select');
  });

  it('moving past the vertical slop starts a scroll and disarms the long-press', () => {
    let r = run([start(touch(1, 12, 100), 0), move(touch(1, 12, 100 + TOUCH_TAP_MAX_MOVE_PX), 50)]);
    expect(r.state.phase).toBe('pending'); // exactly at the slop is still a tap
    r = run([move(touch(1, 12, 100 + TOUCH_TAP_MAX_MOVE_PX + 1), 60)], r.state);
    expect(r.state.phase).toBe('scrolling');
    expect(kinds(r.effects)).toContain('cancelLongPress');
    // The slop distance itself never scrolls.
    expect(wheelLines(r.effects)).toBe(0);
    r = run([{ kind: 'longPress' }], r.state);
    expect(r.state.phase).toBe('scrolling');
    expect(r.effects).toEqual([]);
  });

  it('dragging after a long-press extends the selection and release shows handles + pill', () => {
    const r = run([
      start(touch(1, 12, 5), 0),
      { kind: 'longPress' },
      move(touch(1, 72, 45), 600), // row 2, col 7
      end(touch(1, 72, 45), 700),
    ]);
    const range = { startRow: 0, startCol: 0, endRow: 2, endCol: 7 };
    expect(r.effects).toContainEqual({ kind: 'select', range });
    expect(r.state).toEqual({ phase: 'selected', range });
    expect(kinds(r.effects).slice(-2)).toEqual(['showHandles', 'showPill']);
  });
});

describe('tap', () => {
  it('a quick tap focuses the terminal', () => {
    const r = run([start(touch(1, 12, 5), 0), end(touch(1, 12, 5), 100)]);
    expect(r.state.phase).toBe('idle');
    expect(kinds(r.effects)).toContain('focus');
    expect(kinds(r.effects)).toContain('preventDefault');
    expect(kinds(r.effects)).not.toContain('openUrl');
  });

  it('a tap on a URL opens it instead of focusing', () => {
    // "see https://..." — col 10 of row 2 is inside the URL.
    const r = run([start(touch(1, 105, 45), 0), end(touch(1, 105, 45), 80)]);
    expect(r.effects).toContainEqual({ kind: 'openUrl', url: URL });
    expect(kinds(r.effects)).not.toContain('focus');
  });

  it('a press held past the tap duration does neither', () => {
    const r = run([
      start(touch(1, 105, 45), 0),
      end(touch(1, 105, 45), TOUCH_TAP_MAX_DURATION_MS + 1),
    ]);
    expect(kinds(r.effects)).not.toContain('focus');
    expect(kinds(r.effects)).not.toContain('openUrl');
  });

  it('leaves copy-pill touches entirely alone (its click must fire)', () => {
    const r = run([start(touch(1, 12, 5), 0, undefined, PILL), end(touch(1, 12, 5), 50, PILL)]);
    expect(r.state).toBe(TOUCH_GESTURE_IDLE);
    expect(r.effects).toEqual([]);
  });
});

describe('scroll and flick', () => {
  /** Engage a scroll, then one more move of `dy` px over `dt` ms, then release. */
  const flickScript = (dy: number, dt: number) => [
    start(touch(1, 100, 300), 0),
    move(touch(1, 100, 300 - TOUCH_TAP_MAX_MOVE_PX - 1), 10),
    move(touch(1, 100, 300 - TOUCH_TAP_MAX_MOVE_PX - 1 - dy), 10 + dt),
    end(touch(1, 100, 300 - TOUCH_TAP_MAX_MOVE_PX - 1 - dy), 10 + dt),
  ];

  it('a slow release does not flick', () => {
    // 0.8 * (dy / dt) must stay under the threshold.
    const dy = 2;
    const dt = Math.ceil((0.8 * dy) / TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS) + 10;
    const r = run(flickScript(dy, dt));
    expect(r.state.phase).toBe('idle');
    expect(kinds(r.effects)).not.toContain('scheduleFrame');
  });

  it('a fast release flicks, decaying frame by frame back to idle', () => {
    let r = run(flickScript(60, 30));
    expect(r.state).toMatchObject({ phase: 'flicking' });
    expect(kinds(r.effects)).toContain('scheduleFrame');
    let t = 30;
    let lines = 0;
    for (let frame = 0; frame < 10_000 && r.state.phase === 'flicking'; frame++) {
      t += 16;
      r = run([{ kind: 'frame', t }], r.state);
      lines += wheelLines(r.effects);
    }
    expect(r.state.phase).toBe('idle');
    expect(lines).toBeGreaterThan(0); // dragging up scrolls down: positive deltaY
  });

  it('a new touch stops a running flick', () => {
    const flicking = run(flickScript(60, 30)).state;
    const r = run([start(touch(2, 10, 10), 100)], flicking);
    expect(kinds(r.effects)).toContain('cancelFrame');
    expect(r.state).toMatchObject({ phase: 'pending', touchId: 2 });
  });

  it('carries the sub-row remainder between moves', () => {
    expect(accumulateWheel(0, 15, 20)).toEqual({ lines: 0, remainder: 15 });
    expect(accumulateWheel(15, 15, 20)).toEqual({ lines: 1, remainder: 10 });
    expect(accumulateWheel(0, -45, 20)).toEqual({ lines: -2, remainder: -5 });
  });
});

describe('selection handles', () => {
  const range: CellRange = { startRow: 0, startCol: 2, endRow: 0, endCol: 8 };
  const selected: TouchGestureState = { phase: 'selected', range };
  const START_HANDLE: TouchHit = { kind: 'handle', end: 'start' };

  it('dragging the start handle past the end clamps at the end', () => {
    let r = run([start(touch(4, 20, 0), 0, undefined, START_HANDLE)], selected);
    expect(r.state).toMatchObject({ phase: 'handleDrag', end: 'start', touchId: 4 });
    expect(kinds(r.effects)).toContain('hidePill');
    expect(kinds(r.effects)).not.toContain('clearSelection');

    r = run([move(touch(4, 300, 45), 50, START_HANDLE)], r.state); // row 2: past the end
    const clamped = { startRow: 0, startCol: 8, endRow: 0, endCol: 8 };
    expect(r.effects).toContainEqual({ kind: 'select', range: clamped });
    expect(r.effects).toContainEqual({ kind: 'showHandles', range: clamped });

    r = run([end(touch(4, 300, 45), 80, START_HANDLE)], r.state);
    expect(r.state).toEqual({ phase: 'selected', range: clamped });
    expect(r.effects).toContainEqual({ kind: 'showPill', range: clamped });
  });

  it('swallows extra contacts during a handle drag', () => {
    const drag = run([start(touch(4, 20, 0), 0, undefined, START_HANDLE)], selected).state;
    const r = run([start(touch(5, 200, 200), 10, [touch(4, 20, 0), touch(5, 200, 200)])], drag);
    expect(r.state).toBe(drag);
    expect(kinds(r.effects)).toEqual(['stopPropagation', 'preventDefault']);
  });

  it('a touch anywhere else dismisses the selection and starts a new gesture', () => {
    const r = run([start(touch(1, 200, 200), 0)], selected);
    expect(r.state.phase).toBe('pending');
    expect(kinds(r.effects)).toEqual(
      expect.arrayContaining(['clearSelection', 'hidePill', 'hideHandles']),
    );
  });

  it('the copy pill dismisses the selection', () => {
    const r = run([{ kind: 'dismiss' }], selected);
    expect(r.state.phase).toBe('idle');
    expect(kinds(r.effects)).toEqual(['clearSelection', 'hidePill', 'hideHandles']);
  });
});
