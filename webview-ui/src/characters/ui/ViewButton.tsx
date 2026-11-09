import type { ButtonHTMLAttributes } from 'react';

import { Button } from '../../components/ui/Button.js';
import type { PixelIconName } from '../../components/ui/PixelIcon.js';

export interface ViewButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  primary?: boolean;
  /** A pixel icon left of the label (the app Button's). */
  icon?: PixelIconName;
}

/**
 * The app's Button as the Characters view wears it: shadowed, sized by the
 * surrounding text, with a visible border (`.chv-btn`, unlayered so it beats the
 * variants' transparent one and still yields to `.chv-danger-armed`).
 */
export function ViewButton({
  primary = false,
  className = '',
  disabled,
  ...props
}: ViewButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant={disabled ? 'disabled' : primary ? 'accent' : 'default'}
      disabled={disabled}
      className={`chv-btn shadow-pixel ${primary ? 'chv-btn-primary' : ''} ${className}`}
      {...props}
    />
  );
}
