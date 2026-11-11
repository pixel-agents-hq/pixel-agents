/**
 * Pixel colour maths for character parts, on raw RGBA buffers.
 *
 * Same ColorValue model as office/colorize.ts (adjust mode shifts the art's own HSL,
 * colorize mode sets an absolute hue/saturation on the art's luminance), plus the
 * optional exact colour swap a CharacterColor can name. RGB → HSL and luminance are the
 * office's; HSL → RGB stays separate because its rounding is what every wardrobe
 * colourway was tuned against (characterRenderer.test.ts pins it pixel for pixel).
 */

import type { CharacterColor } from '../../../core/src/characterProfiles.js';
import { luminance, rgbToHsl as rgbToHslDegrees } from '../office/colorize.js';
import { isOpaque } from './sheet.js';

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex2 = (v: number) => v.toString(16).padStart(2, '0');
export const rgbHex = (r: number, g: number, b: number) => '#' + hex2(r) + hex2(g) + hex2(b);

/** Perceived luminance, 0-1. */
export const lum = luminance;
export const hexLum = (hex: string) => lum(...hexToRgb(hex));

/** RGB 0-255 → HSL, each 0-1. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [h, s, l] = rgbToHslDegrees(r, g, b);
  return [h / 360, s, l];
}

/** HSL, each 0-1 (office/colorize.ts' hslToRgb takes hue in degrees) → RGB 0-255. */
export function hsl01ToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
}

export const ZERO_COLOR: CharacterColor = { h: 0, s: 0, b: 0, c: 0 };

/** True when the colour leaves the art exactly as drawn. */
export const isAsDrawn = (cv: CharacterColor | null | undefined): boolean =>
  !!cv && !cv.palette && !cv.colorize && !cv.h && !cv.s && !cv.b && !cv.c;

/** A hue in degrees brought into [0, 360). */
export const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

/** The same colour in colorize mode (exact on gray art, where adjust and colorize agree). */
export const toColorize = (cv: CharacterColor): CharacterColor => ({
  ...cv,
  h: wrapHue(cv.h),
  s: Math.max(0, cv.s),
  colorize: true,
});

export const colorKey = (cv: CharacterColor) =>
  `${cv.h}|${cv.s}|${cv.b}|${cv.c}|${cv.colorize ? 1 : 0}|${cv.palette ?? ''}`;

/**
 * Recolour every visible pixel of `src`: first the named exact swap (`swaps[cv.palette]`,
 * '#from' → '#to'), then the sliders. Pixels with alpha < 2 stay empty.
 */
export function tintPixels(
  src: Uint8ClampedArray,
  cv: CharacterColor,
  swaps: Record<string, Record<string, string>> | undefined,
): Uint8ClampedArray {
  const swap = cv.palette ? swaps?.[cv.palette] : undefined;
  const swapRgb = swap
    ? new Map(Object.entries(swap).map(([from, to]) => [from, hexToRgb(to)]))
    : null;
  const shifts = cv.colorize || cv.h || cv.s || cv.b || cv.c;
  const out = new Uint8ClampedArray(src.length);
  const factor = (100 + cv.c) / 100;
  for (let i = 0; i < src.length; i += 4) {
    if (!isOpaque(src[i + 3])) continue;
    let r0 = src[i];
    let g0 = src[i + 1];
    let b0 = src[i + 2];
    const swapped = swapRgb?.get(rgbHex(r0, g0, b0));
    if (swapped) [r0, g0, b0] = swapped;
    if (!shifts) {
      out[i] = r0;
      out[i + 1] = g0;
      out[i + 2] = b0;
      out[i + 3] = src[i + 3];
      continue;
    }
    let h: number;
    let s: number;
    let l: number;
    if (cv.colorize) {
      h = cv.h / 360;
      s = cv.s / 100;
      l = lum(r0, g0, b0);
    } else {
      const [oh, os, ol] = rgbToHslDegrees(r0, g0, b0);
      h = wrapHue(oh + cv.h) / 360;
      s = Math.max(0, Math.min(1, os + cv.s / 100));
      l = ol;
    }
    if (cv.c !== 0) l = 0.5 + (l - 0.5) * factor;
    l = Math.max(0, Math.min(1, l + cv.b / 200));
    const [r, g, b] = hsl01ToRgb(h, s, l);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = src[i + 3];
  }
  return out;
}
