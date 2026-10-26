import { useEffect, useState } from 'react';

export interface BoxSize {
  width: number;
  height: number;
}

/**
 * An element's content box (inside its padding), kept current by one ResizeObserver.
 * Returns a callback ref to put on the element and its size (null until measured).
 */
export function useBoxSize<T extends Element>(): [(el: T | null) => void, BoxSize | null] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState<BoxSize | null>(null);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, size];
}
