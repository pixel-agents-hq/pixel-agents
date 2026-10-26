import { useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import { PixelText } from '../components/ui/PixelText.js';
import { MUSIC_VOLUME_SLIDER_HEIGHT_PX } from '../constants.js';
import { useDismiss } from '../hooks/useDismiss.js';
import { officeRadio } from './musicEngine.js';

/** The speaker button: a press mutes; hovering (or a tap, on touch) shows a
 *  vertical volume slider above it. */
export function VolumeControl({ volume }: { volume: number }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<string>('mouse');
  useDismiss(pinned, rootRef, () => setPinned(false));
  const pct = Math.round(volume * 100);

  const setFromY = (clientY: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return;
    officeRadio.setVolume(Math.min(1, Math.max(0, (r.bottom - clientY) / r.height)));
  };

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {(hovered || pinned) && (
        // Padding below the panel bridges the gap, so the pointer can travel up to it.
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 pb-6">
          <div className="pixel-panel px-8 py-8 flex flex-col items-center gap-8">
            <PixelText text={`${pct}`} className="text-2xs text-text-muted" />
            <div
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="Music volume"
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="relative w-12 border-2 border-border bg-bg-dark cursor-pointer touch-none"
              style={{ height: MUSIC_VOLUME_SLIDER_HEIGHT_PX }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setFromY(e.clientY);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromY(e.clientY);
              }}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowDown' ? -0.05 : 0;
                if (!step) return;
                e.preventDefault();
                officeRadio.setVolume(volume + step);
              }}
            >
              <div
                className="absolute left-0 right-0 bottom-0 bg-accent"
                style={{ height: `${pct}%` }}
              />
              <div
                className="absolute -left-4 -right-4 h-6 bg-text border-2 border-border shadow-pixel"
                style={{ bottom: `calc(${pct}% - 3px)` }}
              />
            </div>
          </div>
        </div>
      )}
      <Button
        size="icon_lg"
        variant="ghost"
        className="w-28! h-32!"
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType;
        }}
        onClick={() => {
          // Touch has no hover: a tap shows the slider instead of muting.
          if (lastPointer.current === 'touch') setPinned((v) => !v);
          else officeRadio.toggleMute();
        }}
        aria-label={volume > 0 ? 'Mute music' : 'Unmute music'}
        title={volume > 0 ? 'Mute' : 'Unmute'}
      >
        <PixelIcon name={volume > 0 ? 'speaker' : 'speakerMuted'} />
      </Button>
    </div>
  );
}
