/**
 * Pixel art stays crisp only when each art pixel covers a whole number of
 * device pixels. CSS doesn't guarantee it: a browser zoom or a scaled display
 * (1.25x, 1.5x) makes 1 CSS px a fraction of a device pixel, and an 8x8 icon
 * meant as 8 CSS px then draws some rows and columns one device pixel thicker
 * than the rest. Where it sits is not a concern: the browser already paints
 * each box from a whole device pixel. DOM-free (Node-tested); the ratio itself
 * comes from useDevicePixelRatio.
 */

/** Device pixels per art pixel for an art pixel meant to be `scale` CSS px:
 *  the whole number at or below it (never zero), so art only ever shrinks. */
export function devicePixelsPerArtPixel(scale: number, dpr: number): number {
  // The epsilon absorbs float error in a product that should be whole.
  return Math.max(1, Math.floor(scale * dpr + 1e-6));
}

/** One device pixel less per art pixel than `scale` gives: the crisp size
 *  just below it. A 1x screen has nothing between 1 and 2 CSS px, so there
 *  (and wherever it would drop under half of `scale`) `scale` stays. */
export function devicePixelsOneStepSmaller(scale: number, dpr: number): number {
  const full = devicePixelsPerArtPixel(scale, dpr);
  return full - 1 >= full / 2 && dpr >= 2 ? full - 1 : full;
}
