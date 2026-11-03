import type { TouchEvent as ReactTouchEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import {
  MOBILE_KEY_BAR,
  MOBILE_TRACKPAD,
  MOBILE_TRACKPAD_NUDGE_MS,
  PIXEL_ICON_SCALE,
  TERMINAL_ARROW_SEQUENCES,
} from '../constants.js';
import { findTouch, withinTapSlop } from '../touch/touchPrimitives.js';
import type { TrackpadArrow, TrackpadConfig, TrackpadState } from '../touch/trackpad.js';
import { TRACKPAD_IDLE, trackpadMove } from '../touch/trackpad.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface MobileKeyBarProps {
  /** Writes the key's byte sequence to the active terminal's PTY. */
  onKey: (sequence: string) => void;
  /** Columns in the shown terminal's line: a trackpad drag from the press
   *  point to a screen edge sends that many arrows. */
  lineCols?: () => number;
}

/** The pad's icon shifts one icon pixel toward each arrow it sends. */
const NUDGE: Record<TrackpadArrow, string> = {
  up: `translateY(-${PIXEL_ICON_SCALE}px)`,
  down: `translateY(${PIXEL_ICON_SCALE}px)`,
  left: `translateX(-${PIXEL_ICON_SCALE}px)`,
  right: `translateX(${PIXEL_ICON_SCALE}px)`,
};

/**
 * Accessory key row shown above the software keyboard in terminal view. The
 * iOS form-assistant bar (prev/next arrows + Done) is WebKit chrome that web
 * content cannot alter or remove, so this row sits directly above it and
 * supplies the keys a Claude Code TUI actually needs — slash menu, tab
 * completion, shift+tab mode cycle, esc interrupt, an arrow trackpad, line
 * break — none of which exist on the iOS keyboard. Paste is a long press on
 * the terminal's input area (touchGesture.ts), not a key.
 */
export function MobileKeyBar({ onKey, lineCols }: MobileKeyBarProps) {
  // The bar scrolls horizontally when the keys outgrow a narrow screen, so a
  // touch only counts as a key press if it didn't travel — otherwise the
  // release of a scroll-drag would fire whatever key it happened to end on.
  const touchStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const onKeyTouchStart = (e: ReactTouchEvent) => {
    const t = e.changedTouches[0];
    touchStartRef.current = t ? { id: t.identifier, x: t.clientX, y: t.clientY } : null;
  };
  const endedAsTap = (e: ReactTouchEvent) => {
    const s = touchStartRef.current;
    const t = s ? findTouch(e.changedTouches, s.id) : null;
    return s !== null && t !== null && withinTapSlop(t.clientX - s.x, t.clientY - s.y);
  };
  // The trackpad key echoes the iOS space-bar gesture: press, hold, and
  // slide — each step of travel emits the matching arrow (left/right twice
  // as fast as up/down, and faster still toward the screen edges: a drag
  // from the press point to an edge sweeps a full line), retracing when the finger backs up, along one axis
  // (touch/trackpad.ts): a sideways slide that drifts up never jumps a line,
  // but resting the finger lets the next stretch pick the other axis. One
  // drag walks a /resume menu or the input-line cursor. A plain tap
  // deliberately does nothing (the axis decision doubles as drift
  // tolerance). No preventDefault on touchstart/move —
  // React registers those passively, so it would be a no-op; touch-none/
  // select-none keep iOS gestures off the held key, and touchend's
  // preventDefault (non-passive) keeps the keyboard up.
  // The pad follows the finger that pressed it, by identifier: with another
  // finger resting on the glass, touches[0] may be that one.
  const padRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    pad: TrackpadState;
    config: TrackpadConfig;
  } | null>(null);
  // Feedback: the pad lights up while held, and its arrows nudge toward
  // each arrow it sends, so a slide shows which way the cursor is going.
  const [padHeld, setPadHeld] = useState(false);
  const [nudge, setNudge] = useState<TrackpadArrow | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    },
    [],
  );
  const showNudge = (arrow: TrackpadArrow) => {
    setNudge(arrow);
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    nudgeTimerRef.current = setTimeout(() => setNudge(null), MOBILE_TRACKPAD_NUDGE_MS);
  };
  const releasePad = () => {
    padRef.current = null;
    setPadHeld(false);
  };
  const onPadTouchStart = (e: ReactTouchEvent) => {
    // A second finger landing on the pad doesn't restart a live slide.
    if (padRef.current && findTouch(e.touches, padRef.current.id)) return;
    const t = e.changedTouches[0];
    if (!t) return;
    // Fitted per press: the reach to each screen edge from where it landed.
    const width = window.visualViewport?.width ?? window.innerWidth;
    padRef.current = {
      id: t.identifier,
      startX: t.clientX,
      startY: t.clientY,
      pad: TRACKPAD_IDLE,
      config: {
        ...MOBILE_TRACKPAD,
        reach: { left: t.clientX, right: width - t.clientX },
        lineCols: lineCols?.(),
      },
    };
    setPadHeld(true);
  };
  const onPadTouchMove = (e: ReactTouchEvent) => {
    const s = padRef.current;
    const t = s ? findTouch(e.touches, s.id) : null;
    if (!s || !t) return;
    const { state, keys } = trackpadMove(
      s.pad,
      t.clientX - s.startX,
      t.clientY - s.startY,
      e.timeStamp,
      s.config,
    );
    s.pad = state;
    for (const key of keys) onKey(TERMINAL_ARROW_SEQUENCES[key]);
    const last = keys[keys.length - 1];
    if (last) showNudge(last);
  };
  const onPadTouchEnd = (e: ReactTouchEvent) => {
    const s = padRef.current;
    if (s && findTouch(e.changedTouches, s.id)) releasePad();
    // Keep the keyboard: swallow the synthesized mousedown that would blur
    // the terminal's textarea.
    e.preventDefault();
  };
  // min-w-fit keeps labels from squishing; flex-1 stretches the keys to fill
  // when there is room. Every key is one height, so the pad can be a square
  // of it.
  const keyClass =
    'flex-1 min-w-fit h-36 flex items-center justify-center whitespace-nowrap bg-btn-bg border-2 border-border rounded-none text-text text-sm leading-none px-6 cursor-pointer active:bg-btn-hover';
  const renderKey = ({ label, sequence }: (typeof MOBILE_KEY_BAR.left)[number]) => (
    <button
      key={label}
      onTouchStart={onKeyTouchStart}
      // preventDefault on touchend swallows the synthesized mousedown that
      // would blur the terminal's textarea and dismiss the keyboard — the
      // key is sent here and the suppressed click never fires.
      onTouchEnd={(e) => {
        e.preventDefault();
        if (endedAsTap(e)) onKey(sequence);
      }}
      // Mouse path (desktop emulation): block the focus steal on mousedown,
      // send on click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onKey(sequence)}
      className={keyClass}
    >
      {label}
    </button>
  );
  return (
    // touch-pan-x: keys are tap-only but the ROW may pan horizontally on
    // screens too narrow for all keys; vertical drags still must not pan the
    // page (iOS pans the layout viewport while the keyboard is up), which
    // pan-x alone already rules out. The two halves share the width equally,
    // which keeps the pad in the middle of the bar.
    <div className="shrink-0 flex items-center gap-6 px-8 py-6 bg-bg border-t-2 border-border overflow-x-auto touch-pan-x">
      <div className="flex-1 min-w-fit flex gap-6">{MOBILE_KEY_BAR.left.map(renderKey)}</div>
      <button
        aria-label={MOBILE_KEY_BAR.pad.label}
        onTouchStart={onPadTouchStart}
        onTouchMove={onPadTouchMove}
        onTouchEnd={onPadTouchEnd}
        onTouchCancel={releasePad}
        // No click action: desktop has real arrow keys.
        onMouseDown={(e) => e.preventDefault()}
        className={`shrink-0 w-36 h-36 p-0 flex items-center justify-center border-2 rounded-none touch-none select-none cursor-pointer ${
          padHeld
            ? 'bg-accent border-accent-bright text-text-on-accent'
            : 'bg-btn-bg border-border text-text'
        }`}
      >
        <PixelIcon
          name="arrows"
          className="pointer-events-none"
          style={{ transform: nudge ? NUDGE[nudge] : undefined }}
        />
      </button>
      <div className="flex-1 min-w-fit flex gap-6">{MOBILE_KEY_BAR.right.map(renderKey)}</div>
    </div>
  );
}
