import { describe, expect, it } from 'vitest';

import {
  GLYPH_HEIGHT,
  glyphRects,
  GLYPHS,
  MONTHS,
  splitLabel,
} from '../src/components/ui/pixelFont.js';
import { timeAgo } from '../src/conversations/timeAgo.js';

describe('splitLabel', () => {
  it('draws number words in glyphs and leaves the other words as text', () => {
    expect(splitLabel('resets in 3d 11h')).toEqual([
      { glyphs: false, text: 'resets in ' },
      { glyphs: true, text: '3d 11h' },
    ]);
    expect(splitLabel('resets in <1m')).toEqual([
      { glyphs: false, text: 'resets in ' },
      { glyphs: true, text: '<1m' },
    ]);
    expect(splitLabel('no data yet')).toEqual([{ glyphs: false, text: 'no data yet' }]);
  });

  it('reads signed numbers, zoom levels, versions and fractions', () => {
    for (const t of ['-40', '3x', 'v1.5', '1 / 21', '12.5%', '#' + 'C0FFEE']) {
      expect(splitLabel(t)).toEqual([{ glyphs: true, text: t }]);
    }
    expect(splitLabel('OCT 13')).toEqual([{ glyphs: true, text: 'OCT 13' }]);
    expect(splitLabel('now')).toEqual([{ glyphs: false, text: 'now' }]);
    // a bar's name stays in the UI font, like "Weekly"
    expect(splitLabel('5-hour')).toEqual([{ glyphs: false, text: '5-hour' }]);
    expect(splitLabel('73%')).toEqual([{ glyphs: true, text: '73%' }]);
    expect(splitLabel('--')).toEqual([{ glyphs: true, text: '--' }]);
  });
});

describe('glyphRects', () => {
  it('lays glyphs side by side one column apart', () => {
    expect(glyphRects('11').width).toBe(3 + 1 + 3);
    expect(glyphRects('7%').width).toBe(3 + 1 + 5);
  });

  it('every glyph is the same height and its rows the same width', () => {
    for (const glyph of Object.values(GLYPHS)) {
      expect(glyph).toHaveLength(GLYPH_HEIGHT);
      expect(new Set(glyph.map((r) => r.length)).size).toBe(1);
    }
  });
});

describe('timeAgo', () => {
  it('writes an older date with the pixel font month names', () => {
    const at = new Date(2026, 9, 13, 12).getTime();
    expect(timeAgo(at, at + 30 * 86_400_000)).toBe('OCT 13');
  });

  it('has a glyph for every letter of every month', () => {
    for (const month of MONTHS) {
      for (const ch of month) expect(GLYPHS[ch]).toBeDefined();
    }
  });
});
