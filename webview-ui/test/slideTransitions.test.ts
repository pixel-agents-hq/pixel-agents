import { describe, expect, it } from 'vitest';

import { SIDE_PANEL_CONTENT_DELAY_MS } from '../src/constants.js';
import { slideTransitions } from '../src/hooks/slideTransitions.js';

describe('slideTransitions', () => {
  it('keeps the contents sliding after the width has settled', () => {
    // The width's transitionend clears `animating`, but the contents run
    // SIDE_PANEL_CONTENT_DELAY_MS behind it: switching theirs off then made
    // them jump to the end of their slide.
    const settled = slideTransitions({ shown: true, animating: false, instant: false });
    expect(settled.panelTransition).toBe('none');
    expect(settled.contentTransition).toContain(`${SIDE_PANEL_CONTENT_DELAY_MS}ms`);
    expect(settled.contentTransition).toBe(
      slideTransitions({ shown: true, animating: true, instant: false }).contentTransition,
    );
  });

  it('transitions the width only while opening or closing', () => {
    expect(
      slideTransitions({ shown: true, animating: true, instant: false }).panelTransition,
    ).toMatch(/^width /);
    expect(
      slideTransitions({ shown: false, animating: true, instant: false }).panelTransition,
    ).toMatch(/^width /);
    expect(
      slideTransitions({ shown: false, animating: false, instant: false }).panelTransition,
    ).toBe('none');
  });

  it('never names the width in the contents, so a resize is not eased', () => {
    for (const shown of [true, false]) {
      expect(
        slideTransitions({ shown, animating: false, instant: false }).contentTransition,
      ).not.toMatch(/width/);
    }
  });

  it('goes at once under reduced motion', () => {
    for (const shown of [true, false]) {
      for (const animating of [true, false]) {
        expect(slideTransitions({ shown, animating, instant: true })).toEqual({
          panelTransition: 'none',
          contentTransition: 'none',
        });
      }
    }
  });
});
