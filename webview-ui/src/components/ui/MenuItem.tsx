import type { ReactNode } from "react";

interface MenuItemProps {
  onClick: () => void;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function MenuItem({
  onClick,
  children,
  right,
  className = "",
}: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center justify-between w-full py-6 px-10 bg-transparent border-none rounded-none cursor-pointer text-left hover:bg-btn-bg ${className}`}
    >
      <span>{children}</span>
      {right}
    </button>
  );
}
