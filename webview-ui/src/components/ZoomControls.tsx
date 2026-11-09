import { useEffect, useRef, useState } from 'react';

import {
  ZOOM_LEVEL_FADE_DELAY_MS,
  ZOOM_LEVEL_FADE_DURATION_SEC,
  ZOOM_LEVEL_HIDE_DELAY_MS,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../constants.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';
import { PixelText } from './ui/PixelText.js';

interface ZoomControlsProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

/**
 * The zoom level for a moment after it changes (shown, then faded out).
 * `visible` = drawn at all, `fading` = on its way out.
 */
function useZoomFlash(zoom: number): { visible: boolean; fading: boolean } {
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const prevZoomRef = useRef(zoom);

  useEffect(() => {
    if (zoom === prevZoomRef.current) return;
    prevZoomRef.current = zoom;
    setVisible(true);
    setFading(false);
    const fade = setTimeout(() => setFading(true), ZOOM_LEVEL_FADE_DELAY_MS);
    const hide = setTimeout(() => {
      setVisible(false);
      setFading(false);
    }, ZOOM_LEVEL_HIDE_DELAY_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(hide);
    };
  }, [zoom]);

  return { visible, fading };
}

/** "3x" in the pixel font, no panel behind it (a hard shadow keeps it
 *  readable over the office). */
function ZoomLevelText({
  zoom,
  shown,
  className,
}: {
  zoom: number;
  shown: boolean;
  className: string;
}) {
  return (
    <div
      data-testid="zoom-level"
      aria-hidden={!shown}
      className={`absolute z-20 select-none pointer-events-none ${className}`}
      style={{
        opacity: shown ? 1 : 0,
        transition: `opacity ${ZOOM_LEVEL_FADE_DURATION_SEC}s ease-out`,
      }}
    >
      <PixelText text={`${zoom}x`} scale={3} shadow className="text-text" />
    </div>
  );
}

/** The phone's zoom level (pinch zooms there; no buttons), for a moment after
 *  each change: inline with the top bar, just left of the terminal toggle
 *  (40 px square, 8 px in from the right) and centred on it. */
export function MobileZoomLevel({ zoom }: { zoom: number }) {
  const flash = useZoomFlash(zoom);
  if (!flash.visible) return null;
  return (
    <ZoomLevelText
      zoom={zoom}
      shown={!flash.fading}
      className="mobile-safe-top right-60 h-40 flex items-center"
    />
  );
}

export function ZoomControls({ zoom, onZoomChange }: ZoomControlsProps) {
  const flash = useZoomFlash(zoom);
  const [hovered, setHovered] = useState(false);

  const minDisabled = zoom <= ZOOM_MIN;
  const maxDisabled = zoom >= ZOOM_MAX;
  const levelShown = hovered || (flash.visible && !flash.fading);

  return (
    <>
      {/* Vertically stacked round buttons — top-left */}
      <div className="absolute top-8 left-8 z-10 flex flex-col gap-4">
        {/* + and -, with the level right of them, centred between the two:
            shown while either is hovered and for a moment after a change. */}
        <div
          className="relative flex flex-col gap-4"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <Button
            size="icon_lg"
            onClick={() => onZoomChange(zoom + 1)}
            disabled={maxDisabled}
            className="border-border! shadow-pixel disabled:hover:bg-btn-bg disabled:cursor-default disabled:opacity-(--btn-disabled-opacity)"
            title="Zoom in (Ctrl+Scroll)"
          >
            <PixelIcon name="zoomIn" />
          </Button>
          <Button
            size="icon_lg"
            onClick={() => onZoomChange(zoom - 1)}
            disabled={minDisabled}
            className="border-border! shadow-pixel disabled:hover:bg-btn-bg disabled:cursor-default disabled:opacity-(--btn-disabled-opacity)"
            title="Zoom out (Ctrl+Scroll)"
          >
            <PixelIcon name="zoomOut" />
          </Button>
          <ZoomLevelText
            zoom={zoom}
            shown={levelShown}
            className="left-full top-1/2 -translate-y-1/2 ml-12"
          />
        </div>
      </div>
    </>
  );
}
