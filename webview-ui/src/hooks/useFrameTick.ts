import { useEffect, useState } from 'react';

/**
 * Re-render on every animation frame while `active`: for DOM overlays that
 * follow the canvas (camera, characters, furniture) and read imperative office
 * state as they draw. Stops when `active` turns false.
 */
export function useFrameTick(active = true): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active]);
}
