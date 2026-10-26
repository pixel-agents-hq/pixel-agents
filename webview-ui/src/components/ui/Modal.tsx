import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import { usePresence } from '../../hooks/usePresence.js';
import { Button } from './Button.js';
import { PixelIcon } from './PixelIcon.js';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** z-index for backdrop (modal gets +1). Default 49 */
  zIndex?: number;
  className?: string;
}

/** The open modals, oldest first: Escape closes only the newest. */
const openModals: Array<{ current: () => void }> = [];

/** While a modal is open, Escape closes it. Caught on the way down (capture)
 *  and stopped there, so the office's own Escape handling (the layout
 *  editor's steps, the Intro) never also sees it. */
function useEscapeCloses(isOpen: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const entry = { current: () => close.current() };
    openModals.push(entry);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openModals[openModals.length - 1] !== entry) return;
      e.stopPropagation();
      entry.current();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      openModals.splice(openModals.indexOf(entry), 1);
    };
  }, [isOpen]);
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  zIndex = 50,
  className = '',
}: ModalProps) {
  // Kept on screen while it drops away.
  const { mounted, closing } = usePresence(isOpen);
  useEscapeCloses(isOpen, onClose);
  if (!mounted) return null;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 ${closing ? 'backdrop-out' : 'backdrop-in'}`}
        style={{ zIndex }}
        onClick={onClose}
      />
      {/* Sizing wrapper: a full-viewport flex box (inset-0, no viewport
          units — dvw/dvh support varies across iOS) whose padding is the
          modal's screen margin. The panel can never exceed it: max-w/h-full
          caps it, min-width yields via min() (min-width beats max-width in
          CSS, so an unconditional minimum would overflow narrow phones), and
          overflow scrolls. Clicks on the margin fall through to the
          backdrop. */}
      <div
        className="fixed inset-0 flex items-center justify-center p-8 pointer-events-none"
        style={{ zIndex: zIndex + 1 }}
      >
        <div
          className={`pointer-events-auto bg-bg border-2 border-border rounded-none shadow-pixel p-4 min-w-[min(320px,100%)] max-w-full max-h-full overflow-y-auto overflow-x-hidden ${closing ? 'modal-pop-out' : 'modal-pop-in'} ${className}`}
        >
          {/* Sticky so the close button stays reachable while long content
              (changelog, settings) scrolls under it. */}
          <div className="sticky top-0 z-10 bg-bg flex items-center justify-between py-4 px-10 border-b border-border mb-4">
            <span className="text-accent-bright text-2xl">{title}</span>
            <Button variant="ghost" size="icon" onClick={onClose} title="Close">
              <PixelIcon name="close" />
            </Button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}
