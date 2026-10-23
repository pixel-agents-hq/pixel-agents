import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import {
  ZOOM_LEVEL_FADE_DELAY_MS,
  ZOOM_LEVEL_FADE_DURATION_SEC,
  ZOOM_LEVEL_HIDE_DELAY_MS,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../constants.js';
import type { PanDirection } from '../office/camera.js';
import { stepZoom } from '../office/camera.js';
import { pressPan, releaseAllPan, releasePan } from '../office/panInput.js';
import { Button } from './ui/Button.js';

interface ZoomControlsProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** Frame the whole office (largest zoom that fits, centered). */
  onFit: () => void;
  /** More buttons under Fit in the stack (the TV mode button). */
  extra?: ReactNode;
}

/** Four corner brackets — "frame everything". Shared with the phone shell's
 *  Fit button, which has no zoom buttons to sit beside. */
export function FitIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function ZoomControls({ zoom, onZoomChange, onFit, extra }: ZoomControlsProps) {
  const [showLevel, setShowLevel] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevZoomRef = useRef(zoom);

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
          {zoom}x
        </div>
      )}

      {/* Vertically stacked round buttons — top-left */}
      <div className="absolute top-8 left-8 z-10 flex flex-col gap-4">
        <Button
          size="icon_lg"
          onClick={() => onZoomChange(stepZoom(zoom, 1, ZOOM_MIN, ZOOM_MAX))}
          disabled={maxDisabled}
          className="border-border! shadow-pixel disabled:hover:bg-btn-bg disabled:cursor-default disabled:opacity-(--btn-disabled-opacity)"
          title="Zoom in (Ctrl+Scroll)"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <line
              x1="9"
              y1="3"
              x2="9"
              y2="15"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <line
              x1="3"
              y1="9"
              x2="15"
              y2="9"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </Button>
        <Button
          size="icon_lg"
          onClick={() => onZoomChange(stepZoom(zoom, -1, ZOOM_MIN, ZOOM_MAX))}
          disabled={minDisabled}
          className="border-border! shadow-pixel disabled:hover:bg-btn-bg disabled:cursor-default disabled:opacity-(--btn-disabled-opacity)"
          title="Zoom out (Ctrl+Scroll)"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <line
              x1="3"
              y1="9"
              x2="15"
              y2="9"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </Button>
        <Button
          size="icon_lg"
          onClick={onFit}
          className="border-border! shadow-pixel"
          title="Fit the whole office (drag, arrow keys or WASD to move around)"
          aria-label="Fit the whole office"
        >
          <FitIcon />
        </Button>
        {extra}
      </div>
      <PanPad />
    </>
  );
}

const PAD_ARROWS: Array<{ dir: PanDirection; label: string; cell: string; points: string }> = [
  {
    dir: { dx: 0, dy: -1 },
    label: 'Move up',
    cell: 'col-start-2 row-start-1',
    points: '9,4 15,13 3,13',
  },
  {
    dir: { dx: -1, dy: 0 },
    label: 'Move left',
    cell: 'col-start-1 row-start-2',
    points: '4,9 13,3 13,15',
  },
  {
    dir: { dx: 1, dy: 0 },
    label: 'Move right',
    cell: 'col-start-3 row-start-2',
    points: '14,9 5,3 5,15',
  },
  {
    dir: { dx: 0, dy: 1 },
    label: 'Move down',
    cell: 'col-start-2 row-start-3',
    points: '9,14 3,5 15,5',
  },
];

/** Arrow pad beside the zoom buttons: tap to glide a few tiles, hold to keep
 *  moving — the same pan the arrow keys drive (office/panInput). */
function PanPad() {
  return (
    <div
      className="absolute top-8 left-56 z-10 grid grid-cols-3 grid-rows-3 gap-2"
      onPointerLeave={releaseAllPan}
    >
      {PAD_ARROWS.map(({ dir, label, cell, points }) => (
        <Button
          key={label}
          size="icon_lg"
          className={`${cell} w-32! h-32! border-border! shadow-pixel touch-none`}
          title={`${label} (arrow keys / WASD)`}
          aria-label={label}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pressPan(dir);
          }}
          onPointerUp={() => releasePan(dir)}
          onPointerCancel={() => releasePan(dir)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) pressPan(dir);
          }}
          onKeyUp={(e) => {
            if (e.key === 'Enter' || e.key === ' ') releasePan(dir);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18">
            <polygon points={points} fill="currentColor" />
          </svg>
        </Button>
      ))}
    </div>
  );
}
