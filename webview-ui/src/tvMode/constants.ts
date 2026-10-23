/** TV mode's numbers (kept beside the feature, like inbox/constants.ts). */

/** localStorage key for the remembered TV-mode choice (per browser, '1' / '0'). */
export const TV_MODE_STORAGE_KEY = 'pixelAgents.tvMode';
/** The Exit button fades out — and the cursor hides — this long after the
 *  last mouse move, tap or key. */
export const TV_IDLE_MS = 3000;
export const TV_EXIT_FADE_SEC = 0.3;
/** Marks the Exit button: a click there is leaving, never the gesture that
 *  retries a pending fullscreen request (useTvMode). */
export const TV_EXIT_ATTR = 'data-tv-exit';
/** TV mode pads the whole board by the safe-area insets, so with the phone
 *  card bar gone the TODAY strip clears the home indicator and the Exit
 *  button the notch. env() is 0 on desktop and in browser tabs. */
export const TV_SAFE_AREA_PADDING = {
  paddingTop: 'env(safe-area-inset-top, 0px)',
  paddingRight: 'env(safe-area-inset-right, 0px)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  paddingLeft: 'env(safe-area-inset-left, 0px)',
} as const;
/** Fit margins in TV mode: nothing above or beside the office, only the
 *  TODAY strip below it. */
export const FIT_MARGINS_TV = { top: 16, right: 16, bottom: 56, left: 16 } as const;
