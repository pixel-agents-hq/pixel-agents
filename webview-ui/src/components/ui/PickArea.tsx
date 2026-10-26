import type { HTMLAttributes, PointerEvent as ReactPointerEvent } from 'react';
import { useRef } from 'react';

interface PickAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onPointerDown'> {
  /** On press and on every move until release: the pointer's position as fractions of the box (0-1, clamped). */
  onPick: (fx: number, fy: number) => void;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The drag surface of a colour picker's saturation x brightness square or hue bar.
 * Follows one pointer from press to release with pointer capture, so the drag keeps
 * tracking when it leaves the box (and works for touch). Children draw the area.
 */
export function PickArea({ onPick, style, ...props }: PickAreaProps) {
  const latest = useRef(onPick);
  latest.current = onPick;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    const go = (ev: PointerEvent | ReactPointerEvent) => {
      const r = el.getBoundingClientRect();
      latest.current(
        clamp01((ev.clientX - r.left) / r.width),
        clamp01((ev.clientY - r.top) / r.height),
      );
    };
    const end = () => {
      el.removeEventListener('pointermove', go);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
    el.addEventListener('pointermove', go);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    go(e);
  };

  return <div {...props} style={{ touchAction: 'none', ...style }} onPointerDown={onPointerDown} />;
}
