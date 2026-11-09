import type { ReactNode } from 'react';

interface TooltipProps {
  title: string;
  onDismiss: () => void;
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  children: ReactNode;
}

// Top positions take their offset from .mobile-safe-top (index.css), which
// rides the safe-area inset: in a Home-Screen PWA the page starts under the
// iOS status bar (env is 0 in browser tabs and on desktop).
const positionStyles: Record<string, { className: string; style: React.CSSProperties }> = {
  'top-right': { className: 'mobile-safe-top', style: { right: 52 } },
  'top-left': { className: 'mobile-safe-top', style: { left: 8 } },
  'bottom-right': { className: '', style: { bottom: 8, right: 52 } },
  'bottom-left': { className: '', style: { bottom: 8, left: 8 } },
};

export function Tooltip({ title, onDismiss, position = 'top-right', children }: TooltipProps) {
  return (
    <div
      className={`absolute z-20 pixel-panel whitespace-nowrap p-0 ${positionStyles[position].className}`}
      style={positionStyles[position].style}
    >
      <div className="flex items-center justify-between py-4 px-8 border-b border-border">
        <span className="text-base text-accent font-bold">{title}</span>
        <button
          onClick={onDismiss}
          className="bg-transparent border-none text-text-muted cursor-pointer text-sm px-2 leading-none"
        >
          x
        </button>
      </div>
      <div className="py-6 px-8">{children}</div>
    </div>
  );
}
