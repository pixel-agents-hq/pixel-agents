import type { ReactNode } from 'react';

import { Button } from './Button.js';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** z-index for backdrop (modal gets +1). Default 49 */
  zIndex?: number;
  className?: string;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  zIndex = 50,
  className = '',
}: ModalProps) {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50" style={{ zIndex }} onClick={onClose} />
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
          className={`pointer-events-auto bg-bg border-2 border-border rounded-none shadow-pixel p-4 min-w-[min(320px,100%)] max-w-full max-h-full overflow-y-auto overflow-x-hidden ${className}`}
        >
          {/* Sticky so the close button stays reachable while long content
              (changelog, settings) scrolls under it. */}
          <div className="sticky top-0 z-10 bg-bg flex items-center justify-between py-4 px-10 border-b border-border mb-4">
            <span className="text-accent-bright text-2xl">{title}</span>
            <Button variant="ghost" size="icon" onClick={onClose}>
              x
            </Button>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}
