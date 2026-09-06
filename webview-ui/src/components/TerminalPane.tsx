import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { CSSProperties } from 'react';
import { useEffect, useRef } from 'react';

import {
  TERMINAL_COPY_PILL_GAP_PX,
  TERMINAL_FLICK_DECAY_PER_MS,
  TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_LONG_PRESS_MS,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
  TOUCH_TAP_MAX_DURATION_MS,
  TOUCH_TAP_MAX_MOVE_PX,
} from '../constants.js';
import { flowTerminalCopy } from '../terminal/flowCopy.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import { TerminalConnection } from '../terminal/terminalClient.js';
import { touchDebugCount } from '../terminal/touchDebug.js';

interface TerminalPaneProps {
  agentId: number;
  /** Hidden panes stay mounted so their xterm buffer and socket survive tab
   *  switches — unmounting would drop the scrollback and force a reconnect. */
  isActive: boolean;
  onStatusChange?: (agentId: number, status: TerminalConnectionStatus) => void;
  /** Override the terminal font size (mobile uses a smaller face for columns). */
  fontSizePx?: number;
  /** Focus xterm when the pane opens/activates. Mobile passes false: focusing
   *  raises the software keyboard over half the screen on every view switch —
   *  there, tapping the terminal itself is what summons the keyboard. */
  autoFocus?: boolean;
  /** Hands the caller this pane's input handle (null on teardown) — how the
   *  mobile key bar injects keys the software keyboard doesn't have and
   *  pastes clipboard text. */
  onRegisterInput?: (agentId: number, handle: TerminalInputHandle | null) => void;
}

/** Ways to feed input into a pane's PTY from outside the terminal itself. */
export interface TerminalInputHandle {
  /** Write raw bytes (key sequences) straight to the PTY. */
  send: (data: string) => void;
  /** Paste text through xterm, which wraps it in bracketed-paste markers when
   *  the running app has turned that mode on — Claude Code has, and without
   *  the markers a multiline paste would submit at its first newline. */
  paste: (data: string) => void;
}

/**
 * One xterm.js instance bound to one agent's PTY.
 *
 * xterm is imperative and owns its own DOM, so it lives outside React state and
 * is driven entirely through refs — the same pattern OfficeCanvas uses for the
 * game loop.
 */
export function TerminalPane({
  agentId,
  isActive,
  onStatusChange,
  fontSizePx = TERMINAL_FONT_SIZE_PX,
  autoFocus = true,
  onRegisterInput,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Keep the latest callback reachable without making it an effect dependency:
  // a caller passing an inline arrow would otherwise tear down the terminal and
  // reconnect the socket on every parent render.
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;
  const registerInputRef = useRef(onRegisterInput);
  registerInputRef.current = onRegisterInput;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: fontSizePx,
      theme: { ...TERMINAL_THEME },
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    const connection = new TerminalConnection(agentId, {
      onOutput: (data) => term.write(data),
      onReplay: (data, cols, rows) => {
        // Reproduce the server's screen exactly: size the terminal to the
        // geometry the snapshot was serialized at, then write it after an
        // in-band full reset (RIS). RIS rather than term.reset() so the clear
        // is ordered within xterm's async write queue and works before open();
        // resize-first so the snapshot lays out at its own geometry. The fit
        // then reconciles with the actual container — if that's a real change,
        // the PTY gets a SIGWINCH and the TUI repaints itself.
        term.resize(cols, rows);
        term.write(`\x1bc${data}`);
        scheduleFit();
      },
      onExit: (exitCode) => {
        term.write(`\r\n\x1b[90m[process exited with code ${String(exitCode)}]\x1b[0m\r\n`);
      },
      onStatusChange: (status) => statusRef.current?.(agentId, status),
    });
    void connection.connect();

    term.onData((data) => connection.write(data));
    registerInputRef.current?.(agentId, {
      send: (data) => connection.write(data),
      paste: (data) => term.paste(data),
    });

    // Touch scrolling. xterm handles touch drags natively only while the app
    // has NOT enabled mouse tracking — Claude Code has, so on a phone its
    // transcript can't be scrolled at all. Translate vertical drags (plus an
    // iOS-style flick after release) into synthetic wheel events dispatched
    // into xterm's own wheel pipeline, which already routes every regime
    // correctly: mouse reports to the TUI when tracking is on (Claude Code
    // scrolls its transcript), viewport scrollback when off, arrow keys on
    // the alt screen. One row-height of drag = one DOM_DELTA_LINE wheel tick,
    // exactly one desktop wheel line in every regime (pixel deltas would ride
    // xterm's measured cell height and its partial-scroll accumulator).
    // Capture-phase stopPropagation starves xterm's native touch path, which
    // would otherwise double-scroll in the tracking-off case.
    // The gesture follows ONE finger by identifier. Scrolling one-handed, the
    // palm heel or a second finger grazing the screen edge registers as an
    // extra contact — a gesture that bailed on touches.length !== 1 died the
    // moment that happened (and the graze's touchend killed it for good),
    // stalling roughly every other scroll depending on grip. Other contacts
    // are ignored entirely; only the tracked finger moves, ends, or cancels
    // the gesture.
    const flick = {
      tracking: false,
      touchId: -1,
      engaged: false,
      startX: 0,
      startY: 0,
      startT: 0,
      lastX: 0,
      lastY: 0,
      lastT: 0,
      velocity: 0,
      remainder: 0,
      frame: null as number | null,
    };
    const findTouch = (list: TouchList, id: number) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].identifier === id) return list[i];
      }
      return null;
    };
    const findTracked = (list: TouchList) => findTouch(list, flick.touchId);
    const rowHeightPx = () =>
      host.clientHeight > 0 && term.rows > 0 ? host.clientHeight / term.rows : fontSizePx;
    const stopFlick = () => {
      if (flick.frame !== null) {
        cancelAnimationFrame(flick.frame);
        flick.frame = null;
      }
    };
    const emitWheelTicks = (dyPx: number) => {
      flick.remainder += dyPx;
      const rowH = rowHeightPx();
      const ticks = Math.trunc(flick.remainder / rowH);
      if (ticks === 0) return;
      flick.remainder -= ticks * rowH;
      const target = term.element?.querySelector('.xterm-screen') ?? host;
      for (let i = 0; i < Math.abs(ticks); i++) {
        touchDebugCount('tk');
        target.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: Math.sign(ticks),
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            clientX: flick.lastX,
            clientY: flick.lastY,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    };
    // Long-press text selection. Native iOS selection is deliberately dead on
    // the terminal (every touch default is prevented to keep Safari from
    // claiming gestures), so selection is rebuilt on xterm's own model: hold
    // a finger within the tap slop for TERMINAL_LONG_PRESS_MS and the word
    // under it is selected via term.select(); dragging on extends the
    // selection cell by cell from that anchor; releasing shows iOS-style
    // handles at both ends (each draggable to move that end) and a floating
    // "Copy" pill that puts term.getSelection() on the clipboard. Any next
    // touch on the terminal dismisses selection, handles, and pill. Cell math
    // divides the .xterm-screen rect by cols/rows rather than reading xterm's
    // private renderer dimensions.
    const sel = {
      mode: false,
      timer: null as ReturnType<typeof setTimeout> | null,
      // Anchor range (absolute buffer cells) a drag extends from — the word
      // first selected, or the single pressed cell.
      startRow: 0,
      startCol: 0,
      endRow: 0,
      endCol: 0,
    };
    let pill: HTMLButtonElement | null = null;
    const hidePill = () => {
      pill?.remove();
      pill = null;
    };
    const isPillTouch = (e: TouchEvent) =>
      pill !== null && e.target instanceof Node && pill.contains(e.target);
    const cancelLongPress = () => {
      if (sel.timer !== null) {
        clearTimeout(sel.timer);
        sel.timer = null;
      }
    };
    const cellAt = (clientX: number, clientY: number) => {
      const rect = (term.element?.querySelector('.xterm-screen') ?? host).getBoundingClientRect();
      const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
      const col = clamp(
        Math.floor(((clientX - rect.left) / rect.width) * term.cols),
        term.cols - 1,
      );
      const vpRow = clamp(
        Math.floor(((clientY - rect.top) / rect.height) * term.rows),
        term.rows - 1,
      );
      return { col, row: term.buffer.active.viewportY + vpRow };
    };
    // The live selection, ordered start ≤ end (absolute buffer cells) — what
    // the drag handles read and adjust.
    const range = { sr: 0, sc: 0, er: 0, ec: 0 };
    const applyRange = (sRow: number, sCol: number, eRow: number, eCol: number) => {
      range.sr = sRow;
      range.sc = sCol;
      range.er = eRow;
      range.ec = eCol;
      // term.select takes a start cell plus a length that wraps across rows.
      term.select(sCol, sRow, (eRow - sRow) * term.cols + (eCol - sCol) + 1);
    };
    const applySelection = (aRow: number, aCol: number, bRow: number, bCol: number) => {
      const forward = bRow > aRow || (bRow === aRow && bCol >= aCol);
      if (forward) applyRange(aRow, aCol, bRow, bCol);
      else applyRange(bRow, bCol, aRow, aCol);
    };
    const enterSelection = () => {
      sel.timer = null;
      if (!flick.tracking || flick.engaged) return;
      // Long-press means held STILL: a slow drag that stayed under the
      // vertical slop (e.g. mostly horizontal) is not a selection.
      if (
        Math.abs(flick.lastX - flick.startX) > TOUCH_TAP_MAX_MOVE_PX ||
        Math.abs(flick.lastY - flick.startY) > TOUCH_TAP_MAX_MOVE_PX
      ) {
        return;
      }
      sel.mode = true;
      const { col, row } = cellAt(flick.lastX, flick.lastY);
      const line = term.buffer.active.getLine(row);
      const blank = (x: number) => {
        const chars = line?.getCell(x)?.getChars() ?? '';
        return chars === '' || chars === ' ';
      };
      sel.startRow = sel.endRow = row;
      sel.startCol = sel.endCol = col;
      if (!blank(col)) {
        while (sel.startCol > 0 && !blank(sel.startCol - 1)) sel.startCol--;
        while (sel.endCol < term.cols - 1 && !blank(sel.endCol + 1)) sel.endCol++;
        applySelection(row, sel.startCol, row, sel.endCol);
      } else {
        // Pressed a blank cell: no initial word, dragging selects from here.
        term.clearSelection();
      }
    };
    const extendSelection = (clientX: number, clientY: number) => {
      const { col, row } = cellAt(clientX, clientY);
      const beforeAnchor = row < sel.startRow || (row === sel.startRow && col < sel.startCol);
      if (beforeAnchor) applySelection(row, col, sel.endRow, sel.endCol);
      else applySelection(sel.startRow, sel.startCol, row, col);
    };
    // Pixel geometry of the cell grid relative to host — shared by the copy
    // pill and the selection handles.
    const cellMetrics = () => {
      const sRect = (term.element?.querySelector('.xterm-screen') ?? host).getBoundingClientRect();
      const hRect = host.getBoundingClientRect();
      const cellH = sRect.height / term.rows;
      return {
        hRect,
        cellH,
        x: (col: number) => sRect.left - hRect.left + (sRect.width / term.cols) * col,
        y: (row: number) => sRect.top - hRect.top + (row - term.buffer.active.viewportY) * cellH,
      };
    };
    const showPill = () => {
      hidePill();
      if (!term.hasSelection()) return;
      const { hRect, x, y } = cellMetrics();
      // Centered above the whole selection so it never covers the selected
      // text (a multi-row selection spans the full width, so center on the
      // pane); when the top row leaves no room, it drops below the end
      // handle instead.
      const cx = range.sr === range.er ? (x(range.sc) + x(range.ec + 1)) / 2 : hRect.width / 2;
      const above = y(range.sr) - TERMINAL_COPY_PILL_GAP_PX;
      const top = above >= 4 ? above : y(range.er + 1) + 16;
      pill = document.createElement('button');
      pill.textContent = 'Copy';
      const s = pill.style;
      s.position = 'absolute';
      s.left = `${String(Math.min(hRect.width - 44, Math.max(44, cx)))}px`;
      s.top = `${String(Math.min(hRect.height - 48, Math.max(4, top)))}px`;
      s.transform = 'translateX(-50%)';
      s.zIndex = '10';
      s.padding = '8px 16px';
      s.fontSize = '17px';
      s.background = 'var(--color-btn-bg)';
      s.color = 'var(--color-text)';
      s.border = '2px solid var(--color-border)';
      s.borderRadius = '0';
      pill.addEventListener('click', () => {
        void navigator.clipboard.writeText(flowTerminalCopy(term.getSelection()));
        term.clearSelection();
        hidePill();
        hideHandles();
      });
      host.appendChild(pill);
    };
    // iOS-style selection handles: a knob-and-bar lollipop at each end of the
    // selection — knob above the start, below the end — draggable to move
    // that end cell by cell (clamped at the other end, so at least one cell
    // stays selected). Square knob and hard edges to match the pixel design
    // language; same grammar as the native handles this replaces.
    let handles: { start: HTMLDivElement; end: HTMLDivElement } | null = null;
    const hdl = { dragging: null as 'start' | 'end' | null, touchId: -1 };
    const handleKind = (t: EventTarget | null): 'start' | 'end' | null => {
      if (!(t instanceof HTMLElement)) return null;
      const kind = t.closest<HTMLElement>('[data-handle]')?.dataset.handle;
      return kind === 'start' || kind === 'end' ? kind : null;
    };
    const hideHandles = () => {
      if (!handles) return;
      handles.start.remove();
      handles.end.remove();
      handles = null;
    };
    const makeHandle = (kind: 'start' | 'end', cellH: number): HTMLDivElement => {
      // A 24px-wide touch target around a 2px bar one cell tall, with a 12px
      // square knob capping it. Children don't hit-test — the wrapper is the
      // grab surface handleKind() recognizes.
      const el = document.createElement('div');
      el.dataset.handle = kind;
      const s = el.style;
      s.position = 'absolute';
      s.width = '24px';
      s.height = `${String(cellH + 12)}px`;
      s.zIndex = '10';
      const bar = document.createElement('div');
      const b = bar.style;
      b.position = 'absolute';
      b.left = '11px';
      b.top = kind === 'start' ? '12px' : '0';
      b.width = '2px';
      b.height = `${String(cellH)}px`;
      b.background = 'var(--color-accent-bright)';
      b.pointerEvents = 'none';
      const knob = document.createElement('div');
      const k = knob.style;
      k.position = 'absolute';
      k.left = '6px';
      k.top = kind === 'start' ? '0' : `${String(cellH)}px`;
      k.width = '12px';
      k.height = '12px';
      k.background = 'var(--color-accent-bright)';
      k.pointerEvents = 'none';
      el.appendChild(bar);
      el.appendChild(knob);
      return el;
    };
    const positionHandles = () => {
      if (!handles) return;
      const { x, y } = cellMetrics();
      // Bars sit flush with the selection's outer edges; the wrapper offsets
      // center its 24px touch strip on that edge (and lift the start knob).
      handles.start.style.left = `${String(x(range.sc) - 12)}px`;
      handles.start.style.top = `${String(y(range.sr) - 12)}px`;
      handles.end.style.left = `${String(x(range.ec + 1) - 12)}px`;
      handles.end.style.top = `${String(y(range.er))}px`;
    };
    const showHandles = () => {
      if (!term.hasSelection()) return;
      if (!handles) {
        const { cellH } = cellMetrics();
        handles = { start: makeHandle('start', cellH), end: makeHandle('end', cellH) };
        host.appendChild(handles.start);
        host.appendChild(handles.end);
      }
      positionHandles();
    };
    const dragHandleTo = (clientX: number, clientY: number) => {
      const { col, row } = cellAt(clientX, clientY);
      if (hdl.dragging === 'start') {
        const past = row > range.er || (row === range.er && col > range.ec);
        applyRange(past ? range.er : row, past ? range.ec : col, range.er, range.ec);
      } else {
        const past = row < range.sr || (row === range.sr && col < range.sc);
        applyRange(range.sr, range.sc, past ? range.sr : row, past ? range.sc : col);
      }
      positionHandles();
    };
    const onTouchStart = (e: TouchEvent) => {
      // A touch on the copy pill belongs to the pill: leave every default in
      // place so its click fires (preventing here would swallow it).
      if (isPillTouch(e)) return;
      // A drag starting on a selection handle adjusts that end of the
      // selection instead of starting a scroll; extra contacts landing while
      // a handle drag is live are swallowed whole. Self-heal first: if the
      // dragging finger is no longer down (its end event was consumed
      // elsewhere or never arrived), the drag is over.
      if (hdl.dragging && !findTouch(e.touches, hdl.touchId)) hdl.dragging = null;
      const grabbed = handleKind(e.target);
      if (grabbed || hdl.dragging) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        const t = e.changedTouches[0];
        if (grabbed && !hdl.dragging && t) {
          hdl.dragging = grabbed;
          hdl.touchId = t.identifier;
          hidePill();
        }
        return;
      }
      e.stopPropagation();
      // Pre-empt iOS's long-press recognizer too: it's a NO-movement gesture,
      // so the touchmove preventDefault below can't stop it — rest a finger
      // for a beat before dragging (half of natural scrolls) and the text
      // loupe on the editable helper textarea claims the touch, fires
      // touchcancel, and the rest of the drag is dead. Nothing native is
      // wanted from terminal touches: taps focus explicitly in touchend, so
      // even the synthesized click this suppresses isn't needed.
      if (e.cancelable) e.preventDefault();
      else touchDebugCount('st-nc');
      stopFlick();
      // Already following a finger that's still down → this is an extra
      // contact (palm, second finger); ignore it. The e.touches check
      // self-heals a stale gesture whose end event never arrived.
      if (flick.tracking && findTracked(e.touches)) {
        touchDebugCount('st-x');
        return;
      }
      touchDebugCount('st');
      const t = e.changedTouches[0];
      if (!t) return;
      flick.tracking = true;
      flick.touchId = t.identifier;
      flick.engaged = false;
      flick.startX = t.clientX;
      flick.startY = t.clientY;
      flick.startT = e.timeStamp;
      flick.lastX = t.clientX;
      flick.lastY = t.clientY;
      flick.lastT = e.timeStamp;
      flick.velocity = 0;
      flick.remainder = 0;
      bindDirect(e.target);
      // Any live selection, handles, or pill die at the next touch, and the
      // long-press timer arms a fresh selection for this gesture.
      term.clearSelection();
      hidePill();
      hideHandles();
      sel.mode = false;
      cancelLongPress();
      sel.timer = setTimeout(enterSelection, TERMINAL_LONG_PRESS_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isPillTouch(e)) return;
      if (hdl.dragging) {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        const t = findTouch(e.changedTouches, hdl.touchId);
        if (t) dragHandleTo(t.clientX, t.clientY);
        return;
      }
      e.stopPropagation();
      // Consume EVERY move from the first: touch-action only rules out
      // panning — iOS can still claim the drag for text selection (the loupe
      // engages on the helper textarea, an editable), which fires touchcancel
      // and kills the gesture a few px in. Nothing on a terminal needs a
      // native touch gesture, so leave Safari no opening.
      if (e.cancelable) e.preventDefault();
      else touchDebugCount('mv-nc');
      touchDebugCount('mv');
      if (!flick.tracking) {
        touchDebugCount('mv-untr');
        return;
      }
      // Only the tracked finger's motion counts; this event may be another
      // contact moving.
      const t = findTracked(e.changedTouches);
      if (!t) {
        touchDebugCount('mv-oth');
        return;
      }
      if (sel.mode) {
        extendSelection(t.clientX, t.clientY);
        flick.lastX = t.clientX;
        flick.lastY = t.clientY;
        return;
      }
      if (!flick.engaged) {
        // Track the press point while unengaged: enterSelection reads these
        // to require a still finger even when no move ever exceeded the slop.
        flick.lastX = t.clientX;
        flick.lastY = t.clientY;
        // Within the tap slop it may still become a tap-to-focus or a
        // long-press selection; scrolling starts (and both are ruled out)
        // only past it.
        if (Math.abs(t.clientY - flick.startY) <= TOUCH_TAP_MAX_MOVE_PX) return;
        cancelLongPress();
        flick.engaged = true;
        flick.lastT = e.timeStamp;
        return;
      }
      const dy = flick.lastY - t.clientY;
      const dt = Math.max(1, e.timeStamp - flick.lastT);
      // Light smoothing: the release velocity comes from the last move event,
      // which is noisy on its own.
      flick.velocity = 0.8 * (dy / dt) + 0.2 * flick.velocity;
      flick.lastX = t.clientX;
      flick.lastY = t.clientY;
      flick.lastT = e.timeStamp;
      emitWheelTicks(dy);
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (isPillTouch(e)) return;
      if (hdl.dragging) {
        e.stopPropagation();
        if (findTouch(e.changedTouches, hdl.touchId)) {
          hdl.dragging = null;
          showPill();
        }
        return;
      }
      e.stopPropagation();
      if (!flick.tracking) return;
      // A palm graze lifting must not end the real drag — only the tracked
      // finger ends the gesture.
      if (!findTracked(e.changedTouches)) {
        touchDebugCount('end-oth');
        return;
      }
      touchDebugCount('end');
      flick.tracking = false;
      unbindDirect();
      cancelLongPress();
      if (sel.mode) {
        sel.mode = false;
        showHandles();
        showPill();
        return;
      }
      if (!flick.engaged) {
        // A tap. Focus explicitly instead of relying on the synthesized
        // click: preventing a wobbly tap's touchmoves above suppresses its
        // click, and losing the tap-to-summon-keyboard path is worse than
        // double-focusing on clean taps.
        if (e.timeStamp - flick.startT <= TOUCH_TAP_MAX_DURATION_MS && term.element) {
          e.preventDefault();
          term.focus();
        }
        return;
      }
      let v = flick.velocity;
      if (Math.abs(v) < TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS) return;
      let last = e.timeStamp;
      const step = (now: number) => {
        flick.frame = null;
        const dt = Math.max(1, now - last);
        last = now;
        emitWheelTicks(v * dt);
        v *= TERMINAL_FLICK_DECAY_PER_MS ** dt;
        if (Math.abs(v) >= TERMINAL_FLICK_MIN_VELOCITY_PX_PER_MS) {
          flick.frame = requestAnimationFrame(step);
        }
      };
      flick.frame = requestAnimationFrame(step);
    };
    const onTouchCancel = (e: TouchEvent) => {
      e.stopPropagation();
      if (hdl.dragging && findTouch(e.changedTouches, hdl.touchId)) {
        hdl.dragging = null;
        return;
      }
      if (!flick.tracking || !findTracked(e.changedTouches)) {
        touchDebugCount('cx-oth');
        return;
      }
      touchDebugCount('cx');
      flick.tracking = false;
      unbindDirect();
      cancelLongPress();
      sel.mode = false;
    };
    // WebKit addresses every event of a touch gesture to the node that was
    // the target of its touchstart — for the gesture's whole life. xterm's
    // DOM renderer rebuilds a row's spans on each repaint of that row
    // (renderRows → replaceChildren), and the first wheel tick of a drag
    // makes the TUI repaint the transcript — so a drag that began on a text
    // span loses its target node a tick or two in. Detached, the events stop
    // propagating, and the capture listeners on host fall permanently
    // silent: no more moves, no touchend, not even a touchcancel (the HUD
    // signature — last:tk, every counter frozen). A drag that begins on a
    // blank cell keeps its target (row divs persist), which is why only some
    // scrolls stalled. Events ARE still dispatched at the detached node, so
    // per-gesture listeners bound directly to the touchstart target keep
    // receiving the stream. While the target is attached these stay idle —
    // the host capture handlers run first and their stopPropagation() ends
    // the dispatch before the target phase; the contains() guard covers the
    // one case propagation doesn't (host itself as target). `det` counts
    // events that arrived only through this rescue path.
    let directTarget: EventTarget | null = null;
    const directMove = (e: Event) => {
      if (e.target instanceof Node && host.contains(e.target)) return;
      touchDebugCount('det');
      onTouchMove(e as TouchEvent);
    };
    const directEnd = (e: Event) => {
      if (e.target instanceof Node && host.contains(e.target)) return;
      touchDebugCount('det');
      onTouchEnd(e as TouchEvent);
    };
    const directCancel = (e: Event) => {
      if (e.target instanceof Node && host.contains(e.target)) return;
      touchDebugCount('det');
      onTouchCancel(e as TouchEvent);
    };
    const unbindDirect = () => {
      if (!directTarget) return;
      directTarget.removeEventListener('touchmove', directMove);
      directTarget.removeEventListener('touchend', directEnd);
      directTarget.removeEventListener('touchcancel', directCancel);
      directTarget = null;
    };
    const bindDirect = (t: EventTarget | null) => {
      unbindDirect();
      if (!t) return;
      directTarget = t;
      t.addEventListener('touchmove', directMove, { passive: false });
      t.addEventListener('touchend', directEnd);
      t.addEventListener('touchcancel', directCancel);
    };
    host.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    host.addEventListener('touchend', onTouchEnd, { capture: true });
    host.addEventListener('touchcancel', onTouchCancel, { capture: true });

    // Debounced: ResizeObserver fires per frame during a drag, and every resize
    // is a syscall on the PTY plus a full TUI repaint.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let verifyFrame: number | null = null;
    const applyFit = () => {
      // A hidden pane has zero dimensions; fit() would compute a nonsense size
      // and resize the PTY to it.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      // Deferred open: xterm measures its cell grid the moment open() runs,
      // and this pane mounts inside a display:none panel (App only flips the
      // drawer open in an effect that runs after ours). Measuring while
      // hidden records garbage cell metrics that poison the first visible
      // fit() — the terminal squeezed into a ~10-column strip until the user
      // jiggles the container. Opening on the first fit that sees real
      // dimensions measures against real layout instead. Output that arrived
      // before open (the scrollback replay) is buffered by xterm and flushed
      // here.
      if (!term.element) {
        term.open(host);
        if (autoFocus) term.focus();
      }
      try {
        fit.fit();
        connection.resize(term.cols, term.rows);
      } catch {
        // fit() throws if the element is mid-teardown; the next tick recovers.
      }
      // Self-heal: one frame later, if the grid no longer matches what the
      // host's dimensions call for (metrics re-measured, layout shifted under
      // us), fit again rather than waiting for a user resize. Converges: fit()
      // applies exactly the proposal, so a stable layout passes this check on
      // the next pass and stops rescheduling.
      if (verifyFrame !== null) cancelAnimationFrame(verifyFrame);
      verifyFrame = requestAnimationFrame(() => {
        verifyFrame = null;
        const proposed = fit.proposeDimensions();
        if (proposed && (proposed.cols !== term.cols || proposed.rows !== term.rows)) {
          applyFit();
        }
      });
    };
    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyFit, TERMINAL_RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    applyFit();

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      if (verifyFrame !== null) cancelAnimationFrame(verifyFrame);
      stopFlick();
      host.removeEventListener('touchstart', onTouchStart, { capture: true });
      host.removeEventListener('touchmove', onTouchMove, { capture: true });
      host.removeEventListener('touchend', onTouchEnd, { capture: true });
      host.removeEventListener('touchcancel', onTouchCancel, { capture: true });
      unbindDirect();
      cancelLongPress();
      hidePill();
      hideHandles();
      observer.disconnect();
      registerInputRef.current?.(agentId, null);
      connection.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId, fontSizePx, autoFocus]);

  // Becoming visible: the pane had no dimensions while hidden, so re-fit and
  // focus now that it does.
  useEffect(() => {
    if (!isActive) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Not laid out yet; the ResizeObserver will catch up.
      }
      // The terminal opens lazily on its first visible fit (see the mount
      // effect), so it may not be attached yet — that first fit also focuses.
      //
      // Beyond autoFocus: if the user was typing in ANOTHER pane's terminal
      // when this one became active (mobile: card tap while the keyboard is
      // up), steal the focus. Moving focus input-to-input keeps the iOS
      // keyboard open, where blur-then-nothing would dismiss it.
      const active = document.activeElement;
      const typingInOtherTerminal =
        active instanceof HTMLElement &&
        active.classList.contains('xterm-helper-textarea') &&
        !hostRef.current?.contains(active);
      if ((autoFocus || typingInOtherTerminal) && termRef.current?.element) {
        termRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [isActive, autoFocus]);

  return (
    // touch-none: no native pan may ever start on the terminal — with the iOS
    // keyboard up a vertical drag pans the whole page (overflow:hidden does
    // not apply to viewport panning), and once Safari claims the gesture the
    // touchmove preventDefault above arrives too late. All touch scrolling
    // here is synthesized into wheel events instead.
    <div
      ref={hostRef}
      className="relative overflow-hidden w-full h-full touch-none"
      style={
        {
          display: isActive ? '' : 'none',
          // Consumed by the `.xterm, .xterm *` rule in index.css to beat the
          // global `* { font-pixel }` base rule. Fed from the same constant
          // xterm measures its cell grid with, so CSS can't drift from metrics.
          '--font-terminal': TERMINAL_FONT_FAMILY,
        } as CSSProperties
      }
    />
  );
}
