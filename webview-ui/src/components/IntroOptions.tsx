import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { useContext } from 'react';
import { createPortal } from 'react-dom';

import { IntroOptionsSlot } from './introOptionsSlot.js';
import { Button } from './ui/Button.js';

/**
 * The Intro's options: what a step lets the user press. A step that shows
 * nothing else stacks them as a game's choice menu, in one box of a fixed
 * width at the dialog's right edge, the one that goes on first. A step with
 * something over the dialog (a command, the choices' cards, the sign-in code
 * bar: each an IntroPanel) puts them `inline`, in the dialog box under the
 * greeter's words. There is no Back among them: the dialog box has its own.
 */
export function IntroOptions({
  inline = false,
  children,
  className = '',
  ...rest
}: HTMLAttributes<HTMLDivElement> & { inline?: boolean }) {
  const slot = useContext(IntroOptionsSlot);
  if (inline) {
    return slot
      ? createPortal(
          <div className="contents" {...rest}>
            {children}
          </div>,
          slot,
        )
      : null;
  }
  return (
    <div className={`intro-dialog-box intro-options ${className}`} {...rest}>
      {children}
    </div>
  );
}

interface IntroOptionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary`: the option that goes on. */
  kind?: 'primary' | 'plain';
}

/** One option of the stack. */
export function IntroOption({ kind = 'plain', disabled, ...rest }: IntroOptionProps) {
  return (
    <Button
      variant={disabled ? 'disabled' : kind === 'primary' ? 'accent' : 'default'}
      size="sm"
      disabled={disabled}
      className="intro-option"
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
      className="intro-option inline-block border-2 border-transparent rounded-none cursor-pointer bg-btn-bg hover:bg-btn-hover py-1 px-8 text-sm text-text no-underline"
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
