import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

import { IntroOptionsSlot } from './introOptionsSlot.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

/** Options drawn inline, in the dialog box (IntroOptions `inline`). */
const InlineOptions = createContext(false);

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
            <InlineOptions.Provider value>{children}</InlineOptions.Provider>
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
  /** `primary`: the option that goes on (first in the stack; drawn like the rest). */
  kind?: 'primary' | 'plain';
  /** In the dialog box, the way on: its label then an arrow, Back's mirrored
   *  (Back's at the box's left foot, this one as far in from its right). */
  forward?: boolean;
}

/** One option: in the stack, the menu's plain row (none in the accent), 36 px
 *  tall with its label's letters centred (the pixel font's ink rides 1.5 px
 *  low in its line, so 3 px under it); in the dialog box, a ghost in the
 *  dialog's white. */
export function IntroOption({
  kind = 'plain',
  forward = false,
  disabled,
  children,
  ...rest
}: IntroOptionProps) {
  const inline = useContext(InlineOptions);
  const ahead = inline && forward;
  return (
    <Button
      variant={disabled ? 'disabled' : inline ? 'ghost' : 'default'}
      size="sm"
      disabled={disabled}
      data-kind={kind}
      className={`intro-option ${inline ? 'h-40! py-0! text-text-on-accent! hover:bg-btn-hover' : 'flex! items-center h-36 py-0! pb-[3px]! leading-none bg-bg! hover:bg-btn-hover!'} ${ahead ? 'intro-option-forward pr-0!' : ''}`}
      {...rest}
    >
      {ahead ? (
        <span className="inline-flex items-center gap-8 align-middle">
          {children}
          <PixelIcon name="next" scale={1} style={{ translate: '0 1px' }} />
        </span>
      ) : (
        children
      )}
    </Button>
  );
}

/** The Discord invite as an option, in the accent: the website's pixel mark after the words. */
export function IntroDiscordOption({ href }: { href: string }) {
  return (
    <IntroOptionLink href={href} accent>
      Join our Discord
      {/* Centred on the letters' ink, which sits 1.5 px low in the pixel font's line. */}
      <PixelIcon name="discord" scale={2} style={{ translate: '0 1px' }} />
    </IntroOptionLink>
  );
}

/** An option that is a link (it opens a page in a new tab). */
export function IntroOptionLink({
  accent = false,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { accent?: boolean; children: ReactNode }) {
  return (
    <a
      target="_blank"
      rel="noopener noreferrer"
      // An option's box exactly (36 px), its contents centred in it the way
      // the options' are (IntroOption: the 3 px under them lifts the pixel
      // font's low-riding letters to the middle).
      className={`intro-option flex! items-center gap-8 h-36 border-2 border-transparent rounded-none cursor-pointer pt-0 pb-[3px] px-8 text-sm leading-none no-underline ${accent ? 'bg-accent hover:bg-accent-bright text-text-on-accent' : 'bg-bg hover:bg-btn-hover text-text'}`}
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
      className={`intro-dialog-box intro-panel py-8 px-12 leading-[1.4] ${wide ? 'w-full' : 'max-w-full'} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
