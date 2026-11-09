import type { CSSProperties } from 'react';

import { PIXEL_ICON_SCALE } from '../../constants.js';
import { useDevicePixelRatio } from '../../hooks/useDevicePixelRatio.js';
import { GLYPH_HEIGHT, glyphRects, splitLabel } from './pixelFont.js';
import { devicePixelsPerArtPixel } from './pixelSnap.js';
import { PixelSvg } from './PixelSvg.js';

/**
 * Text whose numbers are drawn in the 3×5 pixel font (pixelFont.ts) and whose
 * words stay in the UI font at the inherited size, all in the text colour.
 * Each glyph pixel covers a whole number of device pixels, like PixelIcon.
 */
export function PixelText({
  text,
  scale = PIXEL_ICON_SCALE,
  className = '',
  style,
}: {
  text: string;
  /** CSS pixels per glyph pixel. Whole numbers only. */
  scale?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const dpr = useDevicePixelRatio();
  const unit = devicePixelsPerArtPixel(scale, dpr) / dpr;
  return (
    <span className={`inline-flex items-center whitespace-nowrap ${className}`} style={style}>
      {splitLabel(text).map((part, i) => {
        if (!part.glyphs) {
          return (
            <span key={i} className="leading-none whitespace-pre" aria-hidden="true">
              {part.text}
            </span>
          );
        }
        const { rects, width } = glyphRects(part.text);
        return <PixelSvg key={i} rects={rects} width={width} height={GLYPH_HEIGHT} unit={unit} />;
      })}
      <span className="sr-only">{text}</span>
    </span>
  );
}
