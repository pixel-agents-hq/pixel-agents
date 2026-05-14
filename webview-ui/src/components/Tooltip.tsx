import type { ReactNode } from "react";

interface TooltipProps {
  title: string;
  onDismiss: () => void;
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  children: ReactNode;
}

const positionStyles: Record<string, React.CSSProperties> = {
  "top-right": { top: 8, right: 52 },
  "top-left": { top: 8, left: 8 },
  "bottom-right": { bottom: 8, right: 52 },
  "bottom-left": { bottom: 8, left: 8 },
};

export function Tooltip({
  title,
  onDismiss,
  position = "top-right",
  children,
}: TooltipProps) {
  return (
    <div
      className="absolute z-20 pixel-panel whitespace-nowrap p-0"
      style={positionStyles[position]}
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
