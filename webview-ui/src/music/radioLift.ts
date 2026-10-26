/**
 * The office radio's lift, the one owner of a contract between the radio and
 * the UI that rides above it (the version label): MusicPlayer writes how far
 * its bar stands out as CSS variables on the document root, and a rider reads
 * them through aboveRadio / RIDE_ABOVE_RADIO. Unset, a rider sits at its own
 * spot.
 */

import { MUSIC_SHEET_EASE, MUSIC_SHEET_SETTLE_MS } from '../constants.js';

const LIFT = '--music-lift';
const SETTLE = '--music-settle';

/** The radio stands `px` out; `dragging` = a finger moves it (riders follow at once). */
export function setRadioLift(px: number, dragging: boolean): void {
  const root = document.documentElement.style;
  root.setProperty(LIFT, `${px}px`);
  root.setProperty(SETTLE, dragging ? '0ms' : `${MUSIC_SHEET_SETTLE_MS}ms`);
}

/** The radio is gone: riders return to their own spot. */
export function clearRadioLift(): void {
  const root = document.documentElement.style;
  root.removeProperty(LIFT);
  root.removeProperty(SETTLE);
}

/** A `bottom` that rides above the radio: `calc(<px>px + var(--music-lift, 0px))`. */
export const aboveRadio = (px: number): string => `calc(${px}px + var(${LIFT}, 0px))`;

/** The transition that keeps a rider in step with the radio. */
export const RIDE_ABOVE_RADIO = `bottom var(${SETTLE}, 0ms) ${MUSIC_SHEET_EASE}`;
