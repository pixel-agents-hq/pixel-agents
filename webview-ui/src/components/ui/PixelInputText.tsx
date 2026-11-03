import type { ReactNode } from 'react';

import { PixelText } from './PixelText.js';

/**
 * A text field that reads in the pixel font while it is not being edited: the
 * field's own text turns transparent and PixelText draws `text` over it at
 * `insetPx` from the left (the field's border + padding). Focused, the field
 * shows its real text to edit. Styles: `.pixel-veil` in index.css.
 */
export function PixelInputText({
  text,
  insetPx,
  className = '',
  children,
}: {
  text: string;
  insetPx: number;
  className?: string;
  /** The <input> itself. */
  children: ReactNode;
}) {
  return (
    <span className={`pixel-veil relative flex ${className}`}>
      {children}
      <PixelText
        text={text}
        className="pixel-veil-text absolute top-0 bottom-0 pointer-events-none text-text"
        style={{ left: insetPx }}
      />
    </span>
  );
}
