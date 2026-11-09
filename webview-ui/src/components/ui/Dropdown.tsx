import type { ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import { DROPDOWN_VIEWPORT_MARGIN_PX } from '../../constants.js';

interface DropdownProps {
  isOpen: boolean;
  children: ReactNode;
  className?: string;
  /**
   * Cap the panel's height at the room between its anchor and the top of the
   * viewport. The panel opens upward and the app hides overflow, so content
   * taller than that room would otherwise be cut off above the screen. The
   * panel becomes a flex column: give the child that should scroll
   * `min-h-0 overflow-y-auto` and pin the rest with `shrink-0`.
   */
  fitViewport?: boolean;
}

export function Dropdown({ isOpen, children, className = '', fitViewport = false }: DropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  // Measured rather than expressed in CSS: the anchor sits at a different
  // height on every shell (desktop toolbar, phone card bar above a software
  // keyboard, a short VS Code panel), and only its live position says how
  // much room is left. The panel's bottom edge is pinned to the anchor, so
  // its own bottom is that room whatever height it currently has.
  useLayoutEffect(() => {
    if (!isOpen || !fitViewport) return;
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const room = panel.getBoundingClientRect().bottom - DROPDOWN_VIEWPORT_MARGIN_PX;
      setMaxHeight(Math.max(0, Math.floor(room)));
    };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [isOpen, fitViewport]);

  if (!isOpen) return null;

  return (
    <div className="absolute bottom-full left-0 pb-10 z-10">
      <div
        ref={panelRef}
        style={fitViewport ? { maxHeight } : undefined}
        className={`bg-bg border-2 border-border rounded-none shadow-pixel p-4 ${
          fitViewport ? 'flex flex-col' : ''
        } ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

interface DropdownItemProps {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}

export function DropdownItem({ onClick, children, className = '' }: DropdownItemProps) {
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left py-2 px-12 bg-transparent border-none rounded-none cursor-pointer whitespace-nowrap hover:bg-btn-bg ${className}`}
    >
      {children}
    </button>
  );
}
