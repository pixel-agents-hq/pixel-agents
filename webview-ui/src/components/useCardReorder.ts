import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CARD_REORDER_LONG_PRESS_MS } from '../constants.js';
import { findTouch, withinTapSlop } from '../touch/touchPrimitives.js';
import { mergeOrder, reorderByPointer } from './cardBar.js';

/** Which way the cards run: a row (phone) or a column (desktop). */
export type CardAxis = 'x' | 'y';

interface CardReorderOptions {
  /** The cards, in the shared order. */
  ids: number[];
  axis: CardAxis;
  /** False in a read-only office: the server would refuse the save. */
  enabled: boolean;
  /** A finished drag's order. */
  onCommit: (order: number[]) => void;
  /** A touch tap (lifted under the slop, before the hold armed), with its
   *  touchend so the caller may claim it. */
  onTouchTap?: (id: number, e: TouchEvent) => void;
}

/** Press state. 'pending' = pressed, not yet a drag (touch: the hold timer is
 *  armed and the finger must stay within the slop; mouse: the button is down
 *  and has not moved past it). 'dragging' = card lifted, moves reorder. One
 *  finger is tracked by identifier, so a second finger resting on the glass
 *  neither blocks the press nor hijacks it. */
interface Press {
  phase: 'idle' | 'pending' | 'dragging';
  id: number;
  touchId: number;
  startX: number;
  startY: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const IDLE: Press = { phase: 'idle', id: 0, touchId: -1, startX: 0, startY: 0, timer: null };

/**
 * Drag-to-reorder for an agent-card bar, shared by both shells. The order
 * itself is the server's (one order on every client); this only previews a
 * drag and hands the result to `onCommit`.
 *
 * Touch (phone): press and hold a card — the hold arms after
 * CARD_REORDER_LONG_PRESS_MS motionless ms, so moving first stays a scroll —
 * then slide it along the bar. Mouse (desktop): drag a card past the tap slop.
 * Either way the drop swallows the click it ends with, so it doesn't select.
 */
export function useCardReorder({ ids, axis, enabled, onCommit, onTouchTap }: CardReorderOptions) {
  const [preview, setPreview] = useState<number[] | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const displayIds = preview ? mergeOrder(preview, ids) : ids;

  // State, not a ref: the bar renders nothing while it has no cards, and the
  // touch listeners must bind when the scroller appears.
  const [container, containerRef] = useState<HTMLDivElement | null>(null);
  const cardEls = useRef(new Map<number, HTMLDivElement>());
  const press = useRef<Press>({ ...IDLE });
  // The listeners below are bound once but need this render's values.
  const latest = useRef({ displayIds, axis, onCommit, onTouchTap });
  latest.current = { displayIds, axis, onCommit, onTouchTap };

  /** Ref callback registering a card's element, for its live position. */
  const cardRef = useCallback(
    (id: number) => (el: HTMLDivElement | null) => {
      if (el) cardEls.current.set(id, el);
      else cardEls.current.delete(id);
    },
    [],
  );
  const cardElement = useCallback((id: number) => cardEls.current.get(id), []);

  const reset = useCallback(() => {
    const p = press.current;
    if (p.timer) clearTimeout(p.timer);
    press.current = { ...IDLE };
    setDraggingId(null);
    setPreview(null);
  }, []);

  /** Move the lifted card to the pointer. Rects come from the live DOM, so
   *  the bar's scroll position is already accounted for. */
  const moveTo = useCallback((clientX: number, clientY: number) => {
    const { displayIds: order, axis: ax } = latest.current;
    const next = reorderByPointer(
      order,
      press.current.id,
      (id) => {
        const rect = cardEls.current.get(id)?.getBoundingClientRect();
        if (!rect) return null;
        return ax === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      },
      ax === 'x' ? clientX : clientY,
    );
    if (next.join(',') !== order.join(',')) setPreview(next);
  }, []);

  const lift = useCallback((id: number) => {
    press.current.phase = 'dragging';
    setDraggingId(id);
  }, []);

  const drop = useCallback(() => {
    latest.current.onCommit(latest.current.displayIds);
    reset();
  }, [reset]);

  const begin = (id: number, x: number, y: number, touchId: number) => {
    press.current = { phase: 'pending', id, touchId, startX: x, startY: y, timer: null };
  };

  // ── Touch: long press, then slide ──────────────────────────
  const onTouchStart = (id: number) => (e: ReactTouchEvent) => {
    const p = press.current;
    // Self-heal a press whose end was never delivered (its finger is gone).
    if (p.phase !== 'idle' && !findTouch(e.touches, p.touchId)) reset();
    // Already tracking a finger: a second one landing changes nothing.
    if (press.current.phase !== 'idle') return;
    const t = e.changedTouches[0];
    if (!t) return;
    begin(id, t.clientX, t.clientY, t.identifier);
    if (!enabled) return; // still tracked, so a tap reaches onTouchTap
    press.current.timer = setTimeout(() => {
      press.current.timer = null;
      lift(id);
    }, CARD_REORDER_LONG_PRESS_MS);
  };

  // Native (non-passive) listeners: React registers touch handlers passively,
  // and a drag must preventDefault so the bar doesn't also scroll and the
  // synthesized click doesn't fire a select after the drop.
  useEffect(() => {
    if (!container) return;

    const onTouchMove = (e: TouchEvent) => {
      const p = press.current;
      if (p.phase === 'idle') return;
      const t = findTouch(e.touches, p.touchId);
      if (!t) return;
      if (p.phase === 'pending') {
        // Moved before the hold armed: a scroll (or a sloppy tap), not a reorder.
        if (!withinTapSlop(t.clientX - p.startX, t.clientY - p.startY)) reset();
        return;
      }
      e.preventDefault();
      moveTo(t.clientX, t.clientY);
    };

    const onTouchEnd = (e: TouchEvent) => {
      const p = press.current;
      // Only the tracked finger lifting ends the press.
      if (p.phase === 'idle' || !findTouch(e.changedTouches, p.touchId)) return;
      if (p.phase === 'dragging') {
        e.preventDefault(); // swallow the synthesized click
        drop();
        return;
      }
      const id = p.id;
      reset();
      latest.current.onTouchTap?.(id, e);
    };

    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });
    container.addEventListener('touchcancel', onTouchEnd);
    return () => {
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [container, drop, moveTo, reset]);

  // ── Mouse: drag past the slop ──────────────────────────────
  const onMouseDown = (id: number) => (e: ReactMouseEvent) => {
    if (!enabled || e.button !== 0 || press.current.phase !== 'idle') return;
    begin(id, e.clientX, e.clientY, -1);

    const onMove = (ev: MouseEvent) => {
      const p = press.current;
      if (p.phase === 'pending') {
        if (withinTapSlop(ev.clientX - p.startX, ev.clientY - p.startY)) return;
        lift(p.id);
      }
      ev.preventDefault(); // no text selection while dragging
      moveTo(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (press.current.phase !== 'dragging') {
        reset(); // a plain click: let it select
        return;
      }
      // The click this mouseup produces would select the dropped card.
      const swallow = (ev: MouseEvent) => ev.stopPropagation();
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      drop();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // A press left armed when the bar unmounts must not fire later.
  useEffect(
    () => () => {
      if (press.current.timer) clearTimeout(press.current.timer);
    },
    [],
  );

  return {
    displayIds,
    draggingId,
    container,
    containerRef,
    cardRef,
    cardElement,
    onTouchStart,
    onMouseDown,
  };
}
