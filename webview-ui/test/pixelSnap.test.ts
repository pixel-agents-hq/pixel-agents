import { describe, expect, it } from 'vitest';

import { devicePixelsPerArtPixel } from '../src/components/ui/pixelSnap.js';

describe('devicePixelsPerArtPixel', () => {
  it('keeps whole products as they are', () => {
    expect(devicePixelsPerArtPixel(1, 1)).toBe(1);
    expect(devicePixelsPerArtPixel(1, 2)).toBe(2);
    expect(devicePixelsPerArtPixel(2, 1.5)).toBe(3);
    expect(devicePixelsPerArtPixel(2, 3)).toBe(6);
  });

  it('rounds a fractional product down, never to zero', () => {
    expect(devicePixelsPerArtPixel(1, 1.5)).toBe(1);
    expect(devicePixelsPerArtPixel(2, 1.25)).toBe(2);
    expect(devicePixelsPerArtPixel(1, 0.9)).toBe(1);
    expect(devicePixelsPerArtPixel(2, 0.9)).toBe(1);
  });

  it('does not lose a step to float error', () => {
    expect(devicePixelsPerArtPixel(3, 1.1)).toBe(3);
    expect(devicePixelsPerArtPixel(10, 1.1)).toBe(11);
  });
});
