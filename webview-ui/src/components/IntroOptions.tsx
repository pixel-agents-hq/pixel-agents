import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

import { Button } from './ui/Button.js';

/**
 * The Intro's options: what a step lets the user press, as a game's choice
 * menu. One box of a fixed width at the dialog's right edge, the options
 * stacked in it, the one that goes on first and Back last. Whatever else a
 * step shows (a command, the choices' cards, the sign-in code bar) is an
 * IntroPanel above it.
 */
export function IntroOptions({
  children,
  className = '',
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`intro-dialog-box intro-options ${className}`} {...rest}>
      {children}
    </div>
  );
}

interface IntroOptionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary`: the option that goes on. `back`: the way back, quieter. */
  kind?: 'primary' | 'plain' | 'back';
}

/** One option of the stack. */
export function IntroOption({ kind = 'plain', disabled, ...rest }: IntroOptionProps) {
  return (
    <Button
      variant={
        disabled
          ? 'disabled'
          : kind === 'primary'
            ? 'accent'
            : kind === 'back'
              ? 'ghost'
              : 'default'
      }
      size="sm"
      disabled={disabled}
      className="w-full text-left"
      {...rest}
    />
  );
}

/** An option that is a link (it opens a page in a new tab). */
export function IntroOptionLink({
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) {
  return (
    <a
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full text-left border-2 border-transparent rounded-none cursor-pointer bg-btn-bg hover:bg-btn-hover py-1 px-8 text-sm text-text no-underline"
      {...rest}
    >
      {children}
    </a>
  );
}

/** A box of the menu that is not an option: content-wide at the right edge, or the dialog's width. */
export function IntroPanel({
  wide = false,
  className = '',
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { wide?: boolean }) {
  return (
    <div
      className={`intro-dialog-box py-8 px-12 leading-[1.4] ${wide ? 'w-full' : 'max-w-full'} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
