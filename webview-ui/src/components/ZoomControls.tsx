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
  /** The conversation sidebar's toggle, above the zoom buttons (only where there is a sidebar). */
  sidebar?: { open: boolean; onToggle: () => void };
}

export function ZoomControls({ zoom, onZoomChange, sidebar }: ZoomControlsProps) {
  const [showLevel, setShowLevel] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevZoomRef = useRef(zoom);
  // Bumped per toggle: remounts the icon so its pop plays (never on first paint).
  const [toggles, setToggles] = useState(0);

  const minDisabled = zoom <= ZOOM_MIN;
  const maxDisabled = zoom >= ZOOM_MAX;

  // Show zoom level briefly when zoom changes
  useEffect(() => {
    if (zoom === prevZoomRef.current) return;
    prevZoomRef.current = zoom;

    // Clear existing timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

    setShowLevel(true);
    setFadeOut(false);

    // Start fade after delay
    fadeTimerRef.current = setTimeout(() => {
      setFadeOut(true);
    }, ZOOM_LEVEL_FADE_DELAY_MS);

    // Hide completely after delay
    timerRef.current = setTimeout(() => {
      setShowLevel(false);
      setFadeOut(false);
    }, ZOOM_LEVEL_HIDE_DELAY_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [zoom]);

  return (
    <>
      {/* Zoom level indicator at top-center */}
      {showLevel && (
        <div
          className="absolute top-10 left-1/2 -translate-x-1/2 z-10 pixel-panel pb-4 px-16 text-lg select-none pointer-events-none"
          style={{
            opacity: fadeOut ? 0 : 1,
            transition: `opacity ${ZOOM_LEVEL_FADE_DURATION_SEC}s ease-out`,
          }}
        >
          <PixelText text={`${zoom}x`} scale={3} />
        </div>
      )}

      {/* Vertically stacked round buttons — top-left */}
      <div className="absolute top-8 left-8 z-10 flex flex-col gap-4">
        {sidebar && (
          <Button
            size="icon_lg"
            variant={sidebar.open ? 'active' : 'default'}
            onClick={() => {
              setToggles((n) => n + 1);
              sidebar.onToggle();
            }}
            aria-pressed={sidebar.open}
            className="border-border! shadow-pixel mb-4"
            title={sidebar.open ? 'Hide conversations' : 'Show conversations'}
          >
            <span key={toggles} className={`flex ${toggles > 0 ? 'pixel-pop' : ''}`}>
              <PixelIcon name={sidebar.open ? 'sidebar' : 'sidebarShut'} />
            </span>
          </Button>
        )}
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
      </div>
    </>
  );
}
