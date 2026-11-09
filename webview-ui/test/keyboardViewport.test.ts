/**
 * The software-keyboard decision behind the mobile key bar and the shell
 * clamp, across both viewport resize policies (iOS: only the visual viewport
 * shrinks; Android `interactive-widget=resizes-content`: both shrink).
 */

import { describe, expect, it } from 'vitest';

import { KEYBOARD_MIN_HEIGHT_PX } from '../src/constants.js';
import type { ViewportBaselines, ViewportSample } from '../src/mobile/keyboardViewport.js';
import { readKeyboardViewport } from '../src/mobile/keyboardViewport.js';

const PORTRAIT = 390;
const LANDSCAPE = 844;

const sample = (
  innerHeight: number,
  visualHeight: number,
  editableFocused = true,
  width = PORTRAIT,
): ViewportSample => ({ width, innerHeight, visualHeight, editableFocused });

/** Feed samples in order; return the last reading. */
function run(samples: ViewportSample[]) {
  let baselines: ViewportBaselines = new Map();
  let viewport = { keyboardOpen: false, clampHeight: null as number | null };
  for (const s of samples) {
    const r = readKeyboardViewport(baselines, s);
    baselines = r.baselines;
    viewport = r.viewport;
  }
  return viewport;
}

describe('keyboard viewport', () => {
  it('full height with nothing focused: closed, no clamp', () => {
    expect(run([sample(844, 844, false)])).toEqual({ keyboardOpen: false, clampHeight: null });
  });

  it('iOS: only the visual viewport shrinks — open, and the shell clamps to it', () => {
    expect(run([sample(844, 844), sample(844, 500)])).toEqual({
      keyboardOpen: true,
      clampHeight: 500,
    });
  });

  it('Android resizes-content: both shrink — open, nothing to clamp', () => {
    expect(run([sample(844, 844, false), sample(500, 500)])).toEqual({
      keyboardOpen: true,
      clampHeight: null,
    });
  });

  it('an address bar collapsing or expanding is not a keyboard', () => {
    expect(run([sample(844, 844), sample(788, 788)]).keyboardOpen).toBe(false);
    expect(
      run([sample(788, 788), sample(844, 844), sample(844 - KEYBOARD_MIN_HEIGHT_PX + 1, 700)])
        .keyboardOpen,
    ).toBe(false);
  });

  it('without an editable focused it is not a keyboard (no input to serve)', () => {
    expect(run([sample(844, 844), sample(500, 500, false)]).keyboardOpen).toBe(false);
  });

  it('keyboard dismissed: back to full height reads closed', () => {
    expect(run([sample(844, 844), sample(500, 500), sample(844, 844)]).keyboardOpen).toBe(false);
  });

  it('each orientation keeps its own baseline', () => {
    // Portrait seen tall; landscape is shorter, but that is its full height.
    expect(run([sample(844, 844), sample(390, 390, true, LANDSCAPE)]).keyboardOpen).toBe(false);
    // Landscape keyboard against the landscape baseline.
    expect(
      run([sample(844, 844), sample(390, 390, false, LANDSCAPE), sample(200, 200, true, LANDSCAPE)])
        .keyboardOpen,
    ).toBe(true);
  });

  it('returns the same baselines map when nothing grew', () => {
    const first = readKeyboardViewport(new Map(), sample(844, 844));
    const again = readKeyboardViewport(first.baselines, sample(500, 500));
    expect(again.baselines).toBe(first.baselines);
  });
});
