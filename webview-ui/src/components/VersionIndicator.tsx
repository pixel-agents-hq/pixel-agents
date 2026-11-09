import { useCallback, useEffect, useState } from 'react';

import { toMajorMinor } from '../changelogData.ts';
import {
  VERSION_LABEL_BOTTOM_PX,
  VERSION_NOTICE_ABOVE_PX,
  WHATS_NEW_AUTO_CLOSE_MS,
  WHATS_NEW_FADE_MS,
} from '../constants.ts';
import { aboveRadio, RIDE_ABOVE_RADIO } from '../music/radioLift.js';
import { Button } from './ui/Button.js';
import { PixelText } from './ui/PixelText.js';

// Rides above the office radio (music/radioLift.ts).
const LABEL_BOTTOM = aboveRadio(VERSION_LABEL_BOTTOM_PX);
const NOTICE_BOTTOM = aboveRadio(VERSION_LABEL_BOTTOM_PX + VERSION_NOTICE_ABOVE_PX);

interface VersionIndicatorProps {
  currentVersion: string;
  lastSeenVersion: string;
  /** Never show the "Updated to vX" notice -- a read-only office can't record
   *  that it was seen, so it would come back on every load. */
  hideUpdateNotice: boolean;
  onDismiss: () => void;
  onOpenChangelog: () => void;
}

export function VersionIndicator({
  currentVersion,
  lastSeenVersion,
  hideUpdateNotice,
  onDismiss,
  onOpenChangelog,
}: VersionIndicatorProps) {
  const [dismissed, setDismissed] = useState(false);
  const [fading, setFading] = useState(false);
  const [labelHovered, setLabelHovered] = useState(false);

  const currentMajorMinor = toMajorMinor(currentVersion);
  const isUnseen = currentMajorMinor !== lastSeenVersion;
  const showUpdateNotice = isUnseen && !dismissed && !hideUpdateNotice;

  // Start fade-out after auto-close delay, then fully dismiss after the transition
  useEffect(() => {
    if (!showUpdateNotice || fading) return;
    const fadeTimer = setTimeout(() => setFading(true), WHATS_NEW_AUTO_CLOSE_MS);
    return () => clearTimeout(fadeTimer);
  }, [showUpdateNotice, fading]);

  useEffect(() => {
    if (!fading) return;
    const removeTimer = setTimeout(() => {
      setDismissed(true);
      onDismiss();
    }, WHATS_NEW_FADE_MS);
    return () => clearTimeout(removeTimer);
  }, [fading, onDismiss]);

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setDismissed(true);
      onDismiss();
    },
    [onDismiss],
  );

  const handleOpenChangelog = useCallback(() => {
    setDismissed(true);
    onOpenChangelog();
  }, [onOpenChangelog]);

  if (!currentVersion) return null;

  return (
    <>
      {/* Update notice — shown once per version until dismissed or auto-closed */}
      {showUpdateNotice && (
        <div
          onClick={handleOpenChangelog}
          className="absolute right-28 z-20 pixel-panel px-10 pt-8 pb-9 cursor-pointer flex flex-col gap-8 max-w-2xs"
          style={{
            bottom: NOTICE_BOTTOM,
            opacity: fading ? 0 : 1,
            transition: `opacity ${WHATS_NEW_FADE_MS / 1000}s ease-out, ${RIDE_ABOVE_RADIO}`,
          }}
        >
          <div className="flex justify-between items-center gap-10">
            <span className="text-lg text-accent-bright leading-none">
              Updated to v{currentMajorMinor}!
            </span>
            <Button variant="ghost" size="icon" onClick={handleDismiss} className="leading-none">
              x
            </Button>
          </div>
          <span className="text-sm whitespace-nowrap">See what's new</span>
        </div>
      )}
      {/* Hover tooltip — "See what's new" appears on label hover after notice is gone */}
      {!showUpdateNotice && labelHovered && (
        <div
          onClick={handleOpenChangelog}
          className="absolute right-28 z-20 pixel-panel py-6 px-12 cursor-pointer text-sm whitespace-nowrap"
          style={{ bottom: NOTICE_BOTTOM, transition: RIDE_ABOVE_RADIO }}
        >
          See what's new!
        </div>
      )}
      {/* Version label — always visible, riding above the office radio (MusicPlayer) */}
      <div
        onMouseEnter={() => setLabelHovered(true)}
        onMouseLeave={() => setLabelHovered(false)}
        onClick={handleOpenChangelog}
        className="absolute right-28 z-20 text-lg cursor-pointer select-none pr-2"
        style={{
          bottom: LABEL_BOTTOM,
          opacity: labelHovered ? 0.8 : 0.4,
          transition: `opacity 200ms, ${RIDE_ABOVE_RADIO}`,
        }}
      >
        <PixelText text={`v${currentMajorMinor}`} scale={3} />
      </div>
    </>
  );
}
