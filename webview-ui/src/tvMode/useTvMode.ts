import { useCallback, useEffect, useRef, useState } from 'react';

import { TV_EXIT_ATTR, TV_IDLE_MS } from './constants.js';
import { resolveInitialTvMode, saveTvPreference, tvKeyAction } from './tvModeState.js';
import { useWakeLock } from './useWakeLock.js';

export interface TvModeController {
  tvMode: boolean;
  /** The viewer moved the mouse, tapped or pressed a key within TV_IDLE_MS:
   *  the Exit button shows and the cursor is back. Always true outside TV mode. */
  active: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
}

interface TvModeOptions {
  /** The browser board only: the VS Code panel can't go fullscreen, and its
   *  chrome is the point of it. */
  enabled: boolean;
  /** The T key — off while the layout editor owns the letter keys (T is its
   *  toggle-state key). Esc, the buttons and the URL param still work. */
  keysEnabled: boolean;
}

const storage = () => window.localStorage;

/**
 * TV mode's browser wiring: `?tv=1` or the remembered choice on load, T /
 * Esc, fullscreen (asked for on entry — and on the next click or key when
 * the page loaded straight into TV mode, since browsers want a gesture),
 * leaving when the browser leaves fullscreen, the idle timer behind the
 * Exit button and the hidden cursor, the screen wake lock, and the per-browser
 * memory in localStorage. The decisions themselves are in tvModeState.ts.
 */
export function useTvMode({ enabled, keysEnabled }: TvModeOptions): TvModeController {
  const [tvMode, setTvMode] = useState(
    () => enabled && resolveInitialTvMode(window.location.search, storage),
  );
  // Fullscreen is wanted but not granted yet: the page opened into TV mode
  // without a gesture, or the request failed. The next click or key retries.
  const pendingFullscreen = useRef(tvMode);
  // Whether we were in browser fullscreen, so that a fullscreenchange that
  // leaves it (Esc, the browser's own UI) also leaves TV mode.
  const wasFullscreen = useRef(false);
  const tvModeRef = useRef(tvMode);
  tvModeRef.current = tvMode;

  const leaveFullscreen = useCallback(() => {
    if (!document.fullscreenElement) return;
    try {
      void Promise.resolve(document.exitFullscreen()).catch(() => {});
    } catch {
      /* not fullscreen after all */
    }
  }, []);

  const requestFullscreen = useCallback(() => {
    if (!document.fullscreenEnabled || document.fullscreenElement) return;
    let result: Promise<void> | undefined;
    try {
      result = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      return;
    }
    // Older WebKit returns nothing; a rejection means no user gesture yet —
    // the next click or key asks again (pendingFullscreen stays set).
    void Promise.resolve(result).then(
      () => {
        pendingFullscreen.current = false;
        // Granted after TV mode was already left (the gesture that asked was
        // the one leaving): don't stay fullscreen over the normal board.
        if (!tvModeRef.current) leaveFullscreen();
      },
      () => {},
    );
  }, [leaveFullscreen]);

  const enter = useCallback(() => {
    if (!enabled) return;
    setTvMode(true);
    pendingFullscreen.current = true;
    // Inside the click or key gesture that asked: fullscreen now.
    requestFullscreen();
  }, [enabled, requestFullscreen]);

  const exit = useCallback(() => {
    setTvMode(false);
    pendingFullscreen.current = false;
    leaveFullscreen();
  }, [leaveFullscreen]);

  const latest = useRef({ tvMode, keysEnabled, enter, exit });
  latest.current = { tvMode, keysEnabled, enter, exit };

  const toggle = useCallback(() => {
    if (latest.current.tvMode) latest.current.exit();
    else latest.current.enter();
  }, []);

  // Remembered per browser, so a reload (or the TV rebooting) comes back the same.
  useEffect(() => {
    if (enabled) saveTvPreference(storage, tvMode);
  }, [enabled, tvMode]);

  useWakeLock(tvMode);

  // Keys: T toggles, Esc leaves (never while typing — tvKeyAction). Also the
  // retry of a pending fullscreen request on the first gesture after a
  // `?tv=1` load — but not on the very key or click that is leaving.
  useEffect(() => {
    if (!enabled) return;
    const target = (e: Event) => (e.target instanceof Element ? e.target : null);
    const onKeyDown = (e: KeyboardEvent) => {
      const { tvMode: inTv, keysEnabled: keys, enter: on, exit: off } = latest.current;
      const action = tvKeyAction(e, target(e), inTv);
      if (action === null) {
        if (inTv && pendingFullscreen.current) requestFullscreen();
        return;
      }
      if (action === 'toggle' && !keys) return;
      e.preventDefault();
      if (action === 'exit' || inTv) off();
      else on();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!latest.current.tvMode || !pendingFullscreen.current) return;
      // A tap on the Exit button is leaving, not the gesture to go fullscreen.
      if (target(e)?.closest(`[${TV_EXIT_ATTR}]`)) return;
      requestFullscreen();
    };
    const onFullscreenChange = () => {
      if (document.fullscreenElement) {
        wasFullscreen.current = true;
        pendingFullscreen.current = false;
      } else if (wasFullscreen.current) {
        // Esc (or the browser) left fullscreen: TV mode goes with it.
        wasFullscreen.current = false;
        latest.current.exit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [enabled, requestFullscreen]);

  // Idle: the Exit button shows (and the cursor is back) for TV_IDLE_MS after
  // a mouse move, a tap or a key; entering shows it once, so the way out is
  // seen. setActive(true) on every move is a no-op re-render once it is true.
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!tvMode) {
      setActive(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sleep = () => setActive(false);
    const wake = () => {
      setActive(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(sleep, TV_IDLE_MS);
    };
    wake();
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [tvMode]);

  return { tvMode, active, enter, exit, toggle };
}

/**
 * Frame the whole office on entering TV mode — after the commit that took
 * the chrome away, so the office region already has its TV size — and again
 * on every window resize while in it (the Fit button's own logic, re-armed:
 * useCameraFit's fit also hands the camera back to auto-fit).
 */
export function useTvAutoFit(tvMode: boolean, fit: () => void): void {
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (!tvMode) return;
    fitRef.current();
    const onResize = () => fitRef.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [tvMode]);
}
