import type { TouchEvent as ReactTouchEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CARD_REORDER_LONG_PRESS_MS,
  CARD_SCROLL_INTO_VIEW_MARGIN_PX,
  MOBILE_CARD_ORDER_STORAGE_KEY,
  TOUCH_TAP_MAX_MOVE_PX,
} from '../constants.js';
import type { AgentAppearance, CardVariant, TabStatus } from './AgentCard.js';
import { AgentCard } from './AgentCard.js';

interface MobileAgentBarProps {
  /** Every top-level office agent (launched and external), in creation order. */
  agentIds: number[];
  /** Agent whose character is selected in the office (bg highlight, no border). */
  focusedAgentId: number | null;
  /** Agent whose terminal pane is showing (accent border — terminal view only). */
  activeTerminalAgentId: number | null;
  view: 'office' | 'terminal';
  onSelectAgent: (agentId: number) => void;
  onCloseAgent: (agentId: number) => void;
  onLaunch: () => void;
  /** False when the server has no working PTY — the + card shows disabled. */
  canLaunch: boolean;
  launchUnavailableReason: string | null;
  getAppearance: (agentId: number) => AgentAppearance | null;
  statusFor: (agentId: number) => TabStatus | null;
}

/** Saved order from localStorage; [] on first run or unparseable junk. */
function loadSavedOrder(): number[] {
  try {
    const raw = localStorage.getItem(MOBILE_CARD_ORDER_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

/** Saved order first (dropping closed agents), then any new agents appended
 *  in creation order — so a reorder survives launches and closes. */
function mergeOrder(saved: number[], live: number[]): number[] {
  const liveSet = new Set(live);
  const ordered = saved.filter((id) => liveSet.has(id));
  const seen = new Set(ordered);
  for (const id of live) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

/** Long-press drag state. 'pending' = timer armed, finger must stay within the
 *  slop; 'dragging' = card lifted, touchmoves reorder instead of scrolling. */
interface DragState {
  phase: 'idle' | 'pending' | 'dragging';
  id: number;
  startX: number;
  startY: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Bottom bar of the mobile shell: every agent as a horizontally scrollable
 * card, plus a launch card pinned on the left. Visible under both the office
 * and the terminal pages, so it doubles as the terminal switcher.
 *
 * Unlike the desktop sidebar (terminal tabs only), this lists ALL agents:
 * externally-detected sessions have characters in the office but no PTY, and
 * on a phone the bar is the only chrome from which to reach them. App decides
 * what a tap means per agent (open terminal vs. select in office).
 *
 * Press-and-hold a card to reorder: the hold arms after
 * CARD_REORDER_LONG_PRESS_MS motionless ms (moving first stays a scroll),
 * the card lifts, and dragging slides it along the bar. The custom order is a
 * per-device preference persisted in localStorage, not synced to the server.
 */
export function MobileAgentBar({
  agentIds,
  focusedAgentId,
  activeTerminalAgentId,
  view,
  onSelectAgent,
  onCloseAgent,
  onLaunch,
  canLaunch,
  launchUnavailableReason,
  getAppearance,
  statusFor,
}: MobileAgentBarProps) {
  const [savedOrder, setSavedOrder] = useState<number[]>(loadSavedOrder);
  const displayIds = useMemo(() => mergeOrder(savedOrder, agentIds), [savedOrder, agentIds]);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const dragRef = useRef<DragState>({ phase: 'idle', id: 0, startX: 0, startY: 0, timer: null });
  // The native touch handlers below are attached once but need the current
  // render's order and select callback.
  const displayIdsRef = useRef(displayIds);
  displayIdsRef.current = displayIds;
  const onSelectAgentRef = useRef(onSelectAgent);
  onSelectAgentRef.current = onSelectAgent;

  const handleCardTouchStart = (id: number) => (e: ReactTouchEvent) => {
    const t = e.touches[0];
    if (!t || e.touches.length !== 1) return;
    const drag = dragRef.current;
    if (drag.timer) clearTimeout(drag.timer);
    drag.phase = 'pending';
    drag.id = id;
    drag.startX = t.clientX;
    drag.startY = t.clientY;
    drag.timer = setTimeout(() => {
      drag.timer = null;
      drag.phase = 'dragging';
      setDraggingId(id);
    }, CARD_REORDER_LONG_PRESS_MS);
  };

  // Native (non-passive) listeners: React registers touch handlers passively,
  // and a drag must preventDefault so the bar doesn't also scroll and the
  // synthesized click doesn't fire a select after the drop.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const disarm = () => {
      const drag = dragRef.current;
      if (drag.timer) {
        clearTimeout(drag.timer);
        drag.timer = null;
      }
      drag.phase = 'idle';
    };

    const onTouchMove = (e: TouchEvent) => {
      const drag = dragRef.current;
      const t = e.touches[0];
      if (!t) return;

      if (drag.phase === 'pending') {
        // Finger moved before the hold armed — it's a scroll (or a sloppy
        // tap), not a reorder.
        if (Math.hypot(t.clientX - drag.startX, t.clientY - drag.startY) > TOUCH_TAP_MAX_MOVE_PX) {
          disarm();
        }
        return;
      }
      if (drag.phase !== 'dragging') return;
      e.preventDefault();

      // Insertion point: before the first card (excluding the dragged one)
      // whose midpoint lies right of the finger. Rects come from the live DOM,
      // so bar scroll position is already accounted for.
      const ids = displayIdsRef.current;
      const others = ids.filter((id) => id !== drag.id);
      let insertAt = others.length;
      for (let i = 0; i < others.length; i++) {
        const el = cardRefs.current.get(others[i]);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (t.clientX < rect.left + rect.width / 2) {
          insertAt = i;
          break;
        }
      }
      const next = [...others.slice(0, insertAt), drag.id, ...others.slice(insertAt)];
      if (next.join(',') !== ids.join(',')) setSavedOrder(next);
    };

    const onTouchEnd = (e: TouchEvent) => {
      const drag = dragRef.current;
      if (drag.phase === 'dragging') {
        // Swallow the synthesized click so the drop doesn't also select.
        e.preventDefault();
        try {
          localStorage.setItem(
            MOBILE_CARD_ORDER_STORAGE_KEY,
            JSON.stringify(displayIdsRef.current),
          );
        } catch {
          // Storage full/blocked — the order still applies for this session.
        }
        setDraggingId(null);
      } else if (drag.phase === 'pending') {
        // A plain tap (under the slop, before the hold armed). If the user is
        // typing in a terminal, the tap's default would blur it and dismiss
        // the iOS keyboard — so swallow the default and select the card
        // ourselves. The old input keeps focus for now; the newly-activated
        // pane steals it on activation (TerminalPane), and focus moving
        // input-to-input keeps the keyboard open. Taps on the card's × close
        // button are left to their normal click path.
        const target = e.target instanceof HTMLElement ? e.target : null;
        const typingInTerminal =
          document.activeElement instanceof HTMLElement &&
          document.activeElement.classList.contains('xterm-helper-textarea');
        if (typingInTerminal && target && !target.closest('button')) {
          e.preventDefault();
          onSelectAgentRef.current(drag.id);
        }
      }
      disarm();
    };

    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    scroller.addEventListener('touchend', onTouchEnd, { passive: false });
    scroller.addEventListener('touchcancel', onTouchEnd);
    return () => {
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('touchend', onTouchEnd);
      scroller.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  // Tapping a character on the canvas focuses an agent whose card may sit
  // outside the scroller — bring it fully into view. Also fires when the
  // focus came from a card tap, where at worst it nudges a half-clipped card
  // the rest of the way in.
  useEffect(() => {
    if (focusedAgentId === null) return;
    const scroller = scrollerRef.current;
    const card = cardRefs.current.get(focusedAgentId);
    if (!scroller || !card) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const leftOverhang = scrollerRect.left + CARD_SCROLL_INTO_VIEW_MARGIN_PX - cardRect.left;
    const rightOverhang = cardRect.right - (scrollerRect.right - CARD_SCROLL_INTO_VIEW_MARGIN_PX);
    if (leftOverhang > 0) {
      scroller.scrollBy({ left: -leftOverhang, behavior: 'smooth' });
    } else if (rightOverhang > 0) {
      scroller.scrollBy({ left: rightOverhang, behavior: 'smooth' });
    }
  }, [focusedAgentId]);

  // The accent border marks the showing terminal tab, so it only exists in
  // terminal view; the focused character keeps the background tint in both.
  const variantFor = (agentId: number): CardVariant => {
    if (view === 'terminal' && agentId === activeTerminalAgentId) return 'active';
    if (agentId === focusedAgentId) return 'focused';
    return 'default';
  };

  return (
    // No safe-area padding: the cards keep the same 6px below as above. The
    // home indicator floats over the bar's bottom edge, but taps still land —
    // iOS only claims the swipe gesture there. touch-pan-x: the bar scrolls
    // horizontally only; a vertical drag must not pan the page (iOS pans the
    // layout viewport while the keyboard is up).
    <div className="shrink-0 bg-bg border-t-2 border-border touch-pan-x">
      <div className="flex items-stretch gap-6 px-8 py-6">
        {/* Launch card pinned on the left; only the agent cards scroll. */}
        <button
          onClick={canLaunch ? onLaunch : undefined}
          disabled={!canLaunch}
          title={canLaunch ? 'Launch agent' : (launchUnavailableReason ?? 'Terminal unavailable')}
          className={`flex items-center justify-center shrink-0 px-14 border-2 rounded-none text-2xl leading-none ${
            canLaunch
              ? 'bg-accent border-accent text-white cursor-pointer active:bg-accent-bright'
              : 'bg-btn-bg border-border text-text-muted cursor-default opacity-(--btn-disabled-opacity)'
          }`}
        >
          +
        </button>
        <div
          ref={scrollerRef}
          className="flex items-stretch gap-6 overflow-x-auto no-scrollbar flex-1 min-w-0"
        >
          {displayIds.map((agentId) => (
            <div
              key={agentId}
              ref={(el) => {
                if (el) cardRefs.current.set(agentId, el);
                else cardRefs.current.delete(agentId);
              }}
              onTouchStart={handleCardTouchStart(agentId)}
              className={`shrink-0 flex items-stretch transition-transform ${
                draggingId === agentId ? 'relative z-10 -translate-y-4 opacity-70' : ''
              }`}
            >
              <AgentCard
                agentId={agentId}
                variant={variantFor(agentId)}
                appearance={getAppearance(agentId) ?? { palette: 0, hueShift: 0 }}
                status={statusFor(agentId)}
                showClose={variantFor(agentId) === 'active'}
                onSelect={onSelectAgent}
                onClose={onCloseAgent}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
