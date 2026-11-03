import type { ReactNode } from 'react';

interface CheckboxProps {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  className?: string;
  /** `row` (default): a full-width settings row, box on the right. `inline`: box then
   *  label, in the surrounding text's size and colour. */
  variant?: 'row' | 'inline';
  /** Extra classes for the box (inline variant). */
  boxClassName?: string;
  title?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  className = '',
  variant = 'row',
  boxClassName = '',
  title,
}: CheckboxProps) {
  if (variant === 'inline') {
    return (
      <button
        type="button"
        aria-pressed={checked}
        title={title}
        onClick={onChange}
        className={`inline-flex items-center gap-8 p-0 bg-transparent border-0 rounded-none cursor-pointer ${className}`}
      >
        <span
          aria-hidden
          className={`inline-block w-16 h-16 shrink-0 border-2 border-border rounded-none ${checked ? 'bg-accent shadow-[inset_0_0_0_2px_var(--color-bg-dark)]' : 'bg-bg-dark'} ${boxClassName}`}
        />
        {label}
      </button>
    );
  }
  return (
    <button
      onClick={onChange}
      title={title}
      className={`flex items-center justify-between w-full py-6 px-10 bg-transparent border-none rounded-none cursor-pointer text-left hover:bg-btn-bg ${className}`}
    >
      <span>{label}</span>
      <span
        className={`w-14 h-14 border-2 border-white/50 rounded-none shrink-0 flex items-center justify-center text-2xs pl-1.5 pb-4 leading-none text-white ${checked ? 'bg-accent' : 'bg-transparent'}`}
      >
        {checked ? 'x' : ''}
      </span>
    </button>
  );
}
