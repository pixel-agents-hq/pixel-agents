import { useSyncExternalStore } from 'react';

function subscribeDpr(onChange: () => void): () => void {
  // A resolution query only matches the ratio it was made for: listen for
  // it to stop matching, then ask again for the new one.
  let query: MediaQueryList | null = null;
  const listen = () => {
    query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    query.addEventListener('change', changed);
  };
  const changed = () => {
    query?.removeEventListener('change', changed);
    listen();
    onChange();
  };
  listen();
  return () => query?.removeEventListener('change', changed);
}

/** `window.devicePixelRatio`, re-rendering when it changes (browser zoom,
 *  the window moving to another display). */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(
    subscribeDpr,
    () => window.devicePixelRatio || 1,
    () => 1,
  );
}
