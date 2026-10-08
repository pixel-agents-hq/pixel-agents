import type { Terminal } from '@xterm/xterm';

import { TERMINAL_LONG_PRESS_MS } from '../constants.js';
import { flowTerminalCopy } from './flowCopy.js';
import { selectionLength } from './selectionMath.js';
import { createSelectionOverlay } from './selectionOverlay.js';
import {
  terminalCellAt,
  terminalCellGrid,
  terminalRowHeightPx,
  terminalScreen,
} from './terminalDom.js';
import { urlAtCell } from './terminalLinks.js';
import type {
  GestureProbe,
  TouchGestureEffect,
  TouchGestureEvent,
  TouchGestureState,
} from './touchGesture.js';
import { reduceTouchGesture, TOUCH_GESTURE_IDLE } from './touchGesture.js';

/** A touchstart target, as a node whose listeners are TouchEvent-typed
 *  (HTMLElement and SVGElement both are; plain Element is not). */
type TouchTarget = GlobalEventHandlers;

/**
 * Wire touch input on a terminal pane: scrolling, flick, tap-to-focus /
 * tap-to-open-URL, long-press selection with handles and a copy pill (the
 * gesture itself is the pure reducer in touchGesture.ts). This is the thin
 * DOM half — it owns the listeners, the long-press timer, the flick's
 * animation frames and the selection chrome, turns TouchEvents into reducer
 * events, and executes the effects that come back.
 *
 * Returns a dispose function that removes everything it added.
 */
export function attachTouchInput(
  term: Terminal,
  host: HTMLElement,
  opts: {
    /** Opens a tapped URL (terminalLinkOpener). */
    openLink: (event: unknown, uri: string) => void;
    /** Row height to scroll by before the terminal has a cell grid. */
    fallbackRowHeightPx: number;
  },
): () => void {
  let state: TouchGestureState = TOUCH_GESTURE_IDLE;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;

  const probe: GestureProbe = {
    cellAt: (x, y) => terminalCellAt(term, host, x, y),
    isBlank: ({ row, col }) => {
      const chars = term.buffer.active.getLine(row)?.getCell(col)?.getChars() ?? '';
      return chars === '' || chars === ' ';
    },
    urlAt: ({ row, col }) => urlAtCell(term.buffer.active, row, col),
    rowHeightPx: () => terminalRowHeightPx(term, host, opts.fallbackRowHeightPx),
    cols: () => term.cols,
  };

  const overlay = createSelectionOverlay(host, {
    grid: () => terminalCellGrid(term, host),
    hasSelection: () => term.hasSelection(),
    onCopy: () => {
      if (state.phase === 'selected') {
        const text = flowTerminalCopy(term.getSelection(), term.cols, state.range.startCol);
        void navigator.clipboard.writeText(text);
      }
      dispatch({ kind: 'dismiss' });
    },
  });

  const cancelLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };
  const cancelFrame = () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };

  // WebKit addresses every event of a touch gesture to the node that was the
  // target of its touchstart — for the gesture's whole life. xterm's DOM
  // renderer rebuilds a row's spans on each repaint of that row (renderRows →
  // replaceChildren), and the first wheel tick of a drag makes the TUI
  // repaint the transcript — so a drag that began on a text span loses its
  // target node a tick or two in. Detached, the events stop propagating, and
  // the capture listeners on host fall permanently silent: no more moves, no
  // touchend, not even a touchcancel. A drag that begins on a blank cell
  // keeps its target (row divs persist), which is why only some scrolls
  // stalled. Events ARE still dispatched at the detached node, so per-gesture
  // "rescue" listeners bound directly to the touchstart target keep receiving
  // the stream. While the target is attached these stay idle — the host
  // capture handlers run first and their stopPropagation() ends the dispatch
  // before the target phase; the contains() guard covers the one case
  // propagation doesn't (host itself as target).
  let rescueTarget: TouchTarget | null = null;
  const attached = (e: TouchEvent) => e.target instanceof Node && host.contains(e.target);
  const rescueMove = (e: TouchEvent) => {
    if (!attached(e)) onTouchMove(e);
  };
  const rescueEnd = (e: TouchEvent) => {
    if (!attached(e)) onTouchEnd(e);
  };
  const rescueCancel = (e: TouchEvent) => {
    if (!attached(e)) onTouchCancel(e);
  };
  const unbindRescue = () => {
    if (!rescueTarget) return;
    rescueTarget.removeEventListener('touchmove', rescueMove);
    rescueTarget.removeEventListener('touchend', rescueEnd);
    rescueTarget.removeEventListener('touchcancel', rescueCancel);
    rescueTarget = null;
  };
  const bindRescue = (target: EventTarget | null) => {
    unbindRescue();
    if (!(target instanceof HTMLElement || target instanceof SVGElement)) return;
    const t: TouchTarget = target;
    rescueTarget = t;
    t.addEventListener('touchmove', rescueMove, { passive: false });
    t.addEventListener('touchend', rescueEnd);
    t.addEventListener('touchcancel', rescueCancel);
  };

  // Synthetic wheel events dispatched into xterm's own wheel pipeline, which
  // already routes every regime correctly: mouse reports to the TUI when
  // tracking is on (Claude Code scrolls its transcript), viewport scrollback
  // when off, arrow keys on the alt screen.
  const emitWheel = (lines: number, x: number, y: number) => {
    const target = terminalScreen(term, host);
    for (let i = 0; i < Math.abs(lines); i++) {
      target.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: Math.sign(lines),
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };

  const execute = (fx: TouchGestureEffect, e: TouchEvent | null) => {
    switch (fx.kind) {
      case 'stopPropagation':
        e?.stopPropagation();
        return;
      case 'preventDefault':
        if (e?.cancelable) e.preventDefault();
        return;
      case 'bindRescue':
        bindRescue(e?.target ?? null);
        return;
      case 'unbindRescue':
        unbindRescue();
        return;
      case 'armLongPress':
        cancelLongPress();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          dispatch({ kind: 'longPress' });
        }, TERMINAL_LONG_PRESS_MS);
        return;
      case 'cancelLongPress':
        cancelLongPress();
        return;
      case 'wheel':
        emitWheel(fx.lines, fx.x, fx.y);
        return;
      case 'scheduleFrame':
        cancelFrame();
        frame = requestAnimationFrame((now) => {
          frame = null;
          dispatch({ kind: 'frame', t: now });
        });
        return;
      case 'cancelFrame':
        cancelFrame();
        return;
      case 'select':
        term.select(fx.range.startCol, fx.range.startRow, selectionLength(fx.range, term.cols));
        return;
      case 'clearSelection':
        term.clearSelection();
        return;
      case 'showHandles':
        overlay.showHandles(fx.range);
        return;
      case 'hideHandles':
        overlay.hideHandles();
        return;
      case 'showPill':
        overlay.showPill(fx.range);
        return;
      case 'hidePill':
        overlay.hidePill();
        return;
      case 'focus':
        term.focus();
        return;
      case 'openUrl':
        opts.openLink(e, fx.url);
        return;
    }
  };

  function dispatch(event: TouchGestureEvent, e: TouchEvent | null = null) {
    const result = reduceTouchGesture(state, event, probe);
    state = result.state;
    for (const fx of result.effects) execute(fx, e);
  }

  function onTouchStart(e: TouchEvent) {
    dispatch(
      {
        kind: 'start',
        touch: e.changedTouches.item(0),
        active: e.touches,
        t: e.timeStamp,
        hit: overlay.hitTest(e.target),
      },
      e,
    );
  }
  function onTouchMove(e: TouchEvent) {
    const hit = overlay.hitTest(e.target);
    dispatch({ kind: 'move', changed: e.changedTouches, t: e.timeStamp, hit }, e);
  }
  function onTouchEnd(e: TouchEvent) {
    const hit = overlay.hitTest(e.target);
    dispatch({ kind: 'end', changed: e.changedTouches, t: e.timeStamp, hit }, e);
  }
  function onTouchCancel(e: TouchEvent) {
    dispatch({ kind: 'cancel', changed: e.changedTouches }, e);
  }

  // Capture phase, with stopPropagation in the reducer, starves xterm's
  // native touch path, which would otherwise double-scroll in the
  // tracking-off case.
  host.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  host.addEventListener('touchend', onTouchEnd, { capture: true });
  host.addEventListener('touchcancel', onTouchCancel, { capture: true });

  return () => {
    host.removeEventListener('touchstart', onTouchStart, { capture: true });
    host.removeEventListener('touchmove', onTouchMove, { capture: true });
    host.removeEventListener('touchend', onTouchEnd, { capture: true });
    host.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    unbindRescue();
    cancelLongPress();
    cancelFrame();
    overlay.dispose();
  };
}
