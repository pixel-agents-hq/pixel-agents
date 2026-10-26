import { type ComponentType, type ReactNode, useEffect, useState } from 'react';

import { CHARACTERS_ARM_MS } from '../../constants.js';

/**
 * A destructive button that asks for a second press within CHARACTERS_ARM_MS before
 * acting; while armed it turns red and shows `confirmLabel`.
 */
export function ArmedButton(props: {
  label: ReactNode;
  confirmLabel: ReactNode;
  disabled?: boolean;
  onConfirm: () => void;
  className?: string;
  /** What to render (a plain button by default). */
  as?: ComponentType<React.ButtonHTMLAttributes<HTMLButtonElement>> | 'button';
}) {
  const Tag = props.as ?? 'button';
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CHARACTERS_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  return (
    <Tag
      type="button"
      className={armed ? `${props.className ?? ''} chv-danger-armed` : props.className}
      disabled={props.disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        props.onConfirm();
      }}
    >
      {armed ? props.confirmLabel : props.label}
    </Tag>
  );
}
