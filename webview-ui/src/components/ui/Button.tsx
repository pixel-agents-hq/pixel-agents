import type { ButtonHTMLAttributes, Ref } from 'react';

import { PixelIcon, type PixelIconName } from './PixelIcon.js';

const base = 'border-2 rounded-none cursor-pointer';

const sizes = {
  sm: 'py-1 px-8 text-sm',
  md: 'py-2 px-12',
  lg: 'py-3 px-14 text-lg',
  xl: 'py-6 px-24 text-xl',
  icon: 'p-0 w-16 h-16 flex items-center justify-center',
  icon_lg: 'p-0 w-40 h-40 flex items-center justify-center',
} as const;

const variants = {
  default: `${base} bg-btn-bg border-transparent hover:bg-btn-hover`,
  active: `${base} bg-active-bg border-accent`,
  disabled: `${base} bg-btn-bg border-transparent cursor-default opacity-[var(--btn-disabled-opacity)]`,
  accent: `${base} bg-accent! hover:bg-accent-bright! border-accent hover:border-accent-bright`,
  ghost: `${base} bg-transparent text-text-muted border-transparent hover:text-text`,
} as const;

type ButtonVariant = keyof typeof variants;
type ButtonSize = keyof typeof sizes;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** React 19 passes refs to function components as a prop. */
  ref?: Ref<HTMLButtonElement>;
  /** A pixel icon drawn left of the label, centred on it. */
  icon?: PixelIconName;
}

export function Button({
  variant = 'default',
  size = 'lg',
  className = '',
  icon,
  children,
  ...props
}: ButtonProps) {
  return (
    <button className={`${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {icon ? (
        <span className="inline-flex items-center gap-8 align-middle">
          <PixelIcon name={icon} />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
