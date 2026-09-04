import type { TouchEvent as ReactTouchEvent } from 'react';
import { useRef } from 'react';

import {
  MOBILE_KEY_BAR_KEYS,
  MOBILE_TRACKPAD_STEP_PX,
  TERMINAL_SEQ_ARROW_DOWN,
  TERMINAL_SEQ_ARROW_LEFT,
  TERMINAL_SEQ_ARROW_RIGHT,
  TERMINAL_SEQ_ARROW_UP,
  TOUCH_TAP_MAX_MOVE_PX,
} from '../constants.js';

interface MobileKeyBarProps {
  /** Writes the key's byte sequence to the active terminal's PTY. */
  onKey: (sequence: string) => void;
  /** Reads the clipboard and pastes it into the active terminal. */
  onPaste: () => void;
}

/**
 * Accessory key row shown above the software keyboard in terminal view. The
 * iOS form-assistant bar (prev/next arrows + Done) is WebKit chrome that web
 * content cannot alter or remove, so this row sits directly above it and
 * supplies the keys a Claude Code TUI actually needs — slash menu, shift+tab
 * mode cycle, esc interrupt, an arrow trackpad, line break — none of which
 * exist on the iOS keyboard.
 */
export function MobileKeyBar({ onKey, onPaste }: MobileKeyBarProps) {
  // The bar scrolls horizontally when the keys outgrow a narrow screen, so a
  // touch only counts as a key press if it didn't travel — otherwise the
  // release of a scroll-drag would fire whatever key it happened to end on.
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const onKeyTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    touchStartRef.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const endedAsTap = (e: ReactTouchEvent) => {
    const s = touchStartRef.current;
    const t = e.changedTouches[0];
    return (
      s !== null &&
      t !== undefined &&
      Math.abs(t.clientX - s.x) <= TOUCH_TAP_MAX_MOVE_PX &&
      Math.abs(t.clientY - s.y) <= TOUCH_TAP_MAX_MOVE_PX
    );
  };
  // The trackpad key echoes the iOS space-bar gesture in four directions:
  // press, hold, and slide anywhere — every MOBILE_TRACKPAD_STEP_PX of
  // travel emits the matching arrow, each axis independent, retracing when
  // the finger backs up. One drag walks a /resume menu or the input-line
  // cursor. A plain tap deliberately does nothing (the step threshold
  // doubles as drift tolerance). No preventDefault on touchstart/move —
  // React registers those passively, so it would be a no-op; touch-none/
  // select-none keep iOS gestures off the held key, and touchend's
  // preventDefault (non-passive) keeps the keyboard up.
  const padRef = useRef<{ startX: number; startY: number; sentX: number; sentY: number } | null>(
    null,
  );
  const onPadTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    padRef.current = { startX: t.clientX, startY: t.clientY, sentX: 0, sentY: 0 };
  };
  const onPadTouchMove = (e: ReactTouchEvent) => {
    const s = padRef.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const stepsX = Math.trunc((t.clientX - s.startX) / MOBILE_TRACKPAD_STEP_PX);
    const stepsY = Math.trunc((t.clientY - s.startY) / MOBILE_TRACKPAD_STEP_PX);
    while (s.sentY < stepsY) {
      onKey(TERMINAL_SEQ_ARROW_DOWN);
      s.sentY++;
    }
    while (s.sentY > stepsY) {
      onKey(TERMINAL_SEQ_ARROW_UP);
      s.sentY--;
    }
    while (s.sentX < stepsX) {
      onKey(TERMINAL_SEQ_ARROW_RIGHT);
      s.sentX++;
    }
    while (s.sentX > stepsX) {
      onKey(TERMINAL_SEQ_ARROW_LEFT);
      s.sentX--;
    }
  };
  const onPadTouchEnd = (e: ReactTouchEvent) => {
    padRef.current = null;
    // Keep the keyboard: swallow the synthesized mousedown that would blur
    // the terminal's textarea.
    e.preventDefault();
  };
  // min-w-fit keeps labels from squishing; flex-1 stretches the keys to fill
  // when there is room.
  const keyClass =
    'flex-1 min-w-fit whitespace-nowrap bg-btn-bg border-2 border-border rounded-none text-text text-sm leading-none py-8 px-10 cursor-pointer active:bg-btn-hover';
  return (
    // touch-pan-x: keys are tap-only but the ROW may pan horizontally on
    // screens too narrow for all keys; vertical drags still must not pan the
    // page (iOS pans the layout viewport while the keyboard is up), which
    // pan-x alone already rules out.
    <div className="shrink-0 flex items-stretch gap-6 px-8 py-6 bg-bg border-t-2 border-border overflow-x-auto touch-pan-x">
      {MOBILE_KEY_BAR_KEYS.map(({ label, sequence, trackpad }) => (
        <button
          key={label}
          onTouchStart={trackpad ? onPadTouchStart : onKeyTouchStart}
          onTouchMove={trackpad ? onPadTouchMove : undefined}
          onTouchCancel={
            trackpad
              ? () => {
                  padRef.current = null;
                }
              : undefined
          }
          // preventDefault on touchend swallows the synthesized mousedown that
          // would blur the terminal's textarea and dismiss the keyboard — the
          // key is sent here and the suppressed click never fires.
          onTouchEnd={
            trackpad
              ? onPadTouchEnd
              : (e) => {
                  e.preventDefault();
                  if (endedAsTap(e) && sequence !== undefined) onKey(sequence);
                }
          }
          // Mouse path (desktop emulation): block the focus steal on
          // mousedown, send on click. The trackpad key has no click action —
          // desktop has real arrow keys.
          onMouseDown={(e) => e.preventDefault()}
          onClick={sequence !== undefined ? () => onKey(sequence) : undefined}
          className={`${keyClass}${trackpad ? ' touch-none select-none' : ''}`}
        >
          {label}
        </button>
      ))}
      <button
        onTouchStart={onKeyTouchStart}
        // Same two-path pattern as the keys. Reading the clipboard inside the
        // touchend handler keeps the user activation iOS requires; Safari may
        // still surface its paste-permission callout the first time.
        onTouchEnd={(e) => {
          e.preventDefault();
          if (endedAsTap(e)) onPaste();
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPaste()}
        className={keyClass}
      >
        paste
      </button>
    </div>
  );
}
