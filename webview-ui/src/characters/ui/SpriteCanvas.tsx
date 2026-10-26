import { useLayoutEffect, useRef } from 'react';

import { drawView, sizeCanvas, type SpriteView } from './pixelCanvas.js';

interface SpriteCanvasProps {
  sheet: Uint8ClampedArray | null;
  view: SpriteView;
  /** CSS pixels per sprite pixel (rounded to whole device pixels). */
  scale: number;
  dpr: number;
  className?: string;
  label?: string;
}

/** A frame, face or whole sheet of a character, redrawn when its sheet changes. */
export function SpriteCanvas({ sheet, view, scale, dpr, className, label }: SpriteCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const viewKey = JSON.stringify(view);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    sizeCanvas(canvas, view, scale, dpr);
    if (sheet) drawView(canvas, sheet, view);
    // view is compared by value through viewKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, viewKey, scale, dpr]);
  return (
    <canvas
      ref={ref}
      className={className}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
