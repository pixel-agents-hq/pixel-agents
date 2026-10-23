import { useEffect } from 'react';

/**
 * Keep the screen awake while `on` (the Screen Wake Lock API). A TV or a
 * second monitor showing the board all day must not doze off. Best effort:
 * unsupported browsers, denied requests and background tabs are all silently
 * fine. The lock is dropped by the browser whenever the tab is hidden, so it
 * is asked for again when the tab comes back.
 */
export function useWakeLock(on: boolean): void {
  useEffect(() => {
    if (!on || typeof navigator === 'undefined') return;
    const wakeLock = (navigator as { wakeLock?: WakeLock }).wakeLock;
    if (!wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const request = async () => {
      if (released || document.visibilityState !== 'visible') return;
      try {
        const next = await wakeLock.request('screen');
        if (released) {
          void next.release().catch(() => {});
          return;
        }
        sentinel = next;
      } catch {
        /* denied, low battery, or unsupported: the screen may sleep */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request();
    };

    void request();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [on]);
}
