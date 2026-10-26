import type { RefObject } from 'react';
import { useEffect, useImperativeHandle, useRef } from 'react';

import type { TabStatus } from '../components/AgentCard.js';
import { Button } from '../components/ui/Button.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import { MOBILE_CONVERSATIONS_WIDTH } from '../constants.js';
import { ConversationList } from '../conversations/ConversationList.js';
import type { SwipePanel } from './useEdgeSwipe.js';
import { useEdgeSwipe } from './useEdgeSwipe.js';

interface MobileMenuProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Filled with the menu as a swipe panel: the office's left-edge swipe
   *  pulls it in with the finger (MobileShell). */
  swipeRef: RefObject<SwipePanel | null>;
  /** Settings, at the menu's foot (closes the menu). */
  onOpenSettings: () => void;
  /** Whether to list conversations (resuming needs a terminal). */
  showConversations: boolean;
  /** A conversation pressed: resume it (the shell then slides to its terminal). */
  onResume: (sessionId: string, directoryPath: string) => void;
  /** A running conversation pressed: go to its agent's terminal. */
  onOpenAgent: (agentId: number) => void;
  statusFor: (agentId: number) => TabStatus | null;
}

/**
 * The phone's menu: a panel that slides in from the left over the office,
 * opened by the menu button top-left. It holds the recent conversations
 * (ConversationList) and, at its foot, Settings. A tap on the dimmed office
 * beside it, its x, or Escape closes it; pressing a conversation (or
 * Settings) acts and closes it. A swipe from the office's left edge pulls
 * it in with the finger, like the terminal from the right, and a leftward
 * swipe on it pushes it back out. Always mounted, so the slide runs
 * both ways; the list is only fetched while it is open. Mounted at App's top
 * level: inside the shell's transformed track, `fixed` would size to the
 * track.
 */
export function MobileMenu({
  open,
  onOpen,
  onClose,
  swipeRef,
  onOpenSettings,
  showConversations,
  onResume,
  onOpenAgent,
  statusFor,
}: MobileMenuProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const panelRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(swipeRef, () => menuPanel({ panelRef, backdropRef }, 'shut', onOpen), [
    onOpen,
  ]);

  // Open, a leftward swipe anywhere on it (or the dimmed office beside it)
  // pushes it back out with the finger. Rows are buttons, so none opt out:
  // a tap still clicks, only a clearly sideways drag becomes the swipe.
  const rootRef = useRef<HTMLDivElement>(null);
  useEdgeSwipe(
    rootRef,
    open ? { right: menuPanel({ panelRef, backdropRef }, 'open', onClose) } : {},
    {
      anywhere: true,
      optOut: '',
    },
  );

  return (
    // touch-pan-y: the list scrolls natively, sideways drags are the swipe's.
    <div
      ref={rootRef}
      className={`fixed inset-0 z-40 touch-pan-y ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      <div
        ref={backdropRef}
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <aside
        ref={panelRef}
        aria-label="Menu"
        data-testid="mobile-menu"
        className={`absolute top-0 bottom-0 left-0 flex flex-col bg-bg border-r-2 border-border shadow-pixel transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ width: MOBILE_CONVERSATIONS_WIDTH, paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="flex items-center justify-between pl-10 pr-4 py-6 border-b-2 border-border">
          <span className="text-base">{showConversations ? 'Conversations' : 'Menu'}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="flex items-center justify-center w-32 h-32 bg-transparent border-none rounded-none cursor-pointer text-text-muted"
          >
            <PixelIcon name="close" />
          </button>
        </div>
        {showConversations ? (
          <ConversationList
            open={open}
            roomy
            onResume={(sessionId, directoryPath) => {
              onResume(sessionId, directoryPath);
              onClose();
            }}
            onOpenAgent={(agentId) => {
              onOpenAgent(agentId);
              onClose();
            }}
            statusFor={statusFor}
          />
        ) : (
          <div className="flex-1" />
        )}
        <div className="p-8 border-t-2 border-border">
          <Button
            size="md"
            icon="settings"
            className="w-full"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            Settings
          </Button>
        </div>
      </aside>
    </div>
  );
}

interface MenuRefs {
  panelRef: RefObject<HTMLElement | null>;
  backdropRef: RefObject<HTMLDivElement | null>;
}

/** The menu following the finger: pulled in from shut, or pushed out from
 *  open (like MobileShell's trackPanel for the terminal page). */
function menuPanel(
  { panelRef, backdropRef }: MenuRefs,
  from: 'shut' | 'open',
  onCommit: () => void,
): SwipePanel {
  // A swipe styles the panel inline while it drags; the classes take over
  // again once it ends (in either direction), so the release animates from
  // where the finger let go.
  const clearSwipe = () => {
    for (const el of [panelRef.current, backdropRef.current]) {
      el?.style.removeProperty('transition');
      el?.style.removeProperty('translate');
      el?.style.removeProperty('opacity');
    }
  };
  return {
    travel: () => panelRef.current?.offsetWidth ?? 0,
    drag(px) {
      const panel = panelRef.current;
      const backdrop = backdropRef.current;
      if (!panel || !backdrop) return;
      const width = panel.offsetWidth;
      // How far open it is under the finger, 0 to 1.
      const shown = from === 'shut' ? (width ? px / width : 0) : width ? 1 - px / width : 1;
      panel.style.transition = 'none';
      panel.style.translate = `${String(from === 'shut' ? px - width : -px)}px 0`;
      backdrop.style.transition = 'none';
      backdrop.style.opacity = String(shown);
    },
    commit() {
      clearSwipe();
      onCommit();
    },
    settle: clearSwipe,
  };
}

/** The phone's menu button, floating top-left over the office. */
export function MobileMenuButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <div className="absolute mobile-safe-top left-8 z-20 flex gap-6">
      <Button
        size="icon_lg"
        variant={active ? 'active' : 'default'}
        className="border-border! shadow-pixel"
        onClick={onClick}
        aria-label="Menu"
        title="Menu"
      >
        <PixelIcon name="menu" />
      </Button>
    </div>
  );
}
