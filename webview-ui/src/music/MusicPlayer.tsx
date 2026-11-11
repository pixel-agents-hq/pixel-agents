import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import {
  MUSIC_PLAYER_BOTTOM_PX,
  MUSIC_PLAYER_WIDTH_PX,
  MUSIC_SHEET_EASE,
  MUSIC_SHEET_SETTLE_MS,
  MUSIC_VERSION_GAP_PX,
  MUSIC_VISUALIZER_BARS,
  MUSIC_VISUALIZER_HEIGHT_PX,
} from '../constants.js';
import { useDismiss } from '../hooks/useDismiss.js';
import { findTouch } from '../touch/touchPrimitives.js';
import { MOODS } from './moods.js';
import { officeRadio } from './musicEngine.js';
import { FULL_PLAYER, playerFit } from './playerFit.js';
import { moveSheetDrag, releaseSheetDrag, type SheetDrag, startSheetDrag } from './playerSheet.js';
import { clearRadioLift, setRadioLift } from './radioLift.js';
import { RadioSettingsPanel } from './RadioSettingsPanel.js';
import { keyLabel, songCode } from './songCode.js';
import { useOfficeRadio } from './useOfficeRadio.js';
import { VolumeControl } from './VolumeControl.js';

/** Bar heights move in whole steps of this many px (pixel look). */
const BAR_STEP_PX = 2;

/** Bars of the mix's loudness, low notes left, redrawn every frame while playing. */
function Visualizer({ playing }: { playing: boolean }) {
  const barsRef = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    const bands = new Array<number>(MUSIC_VISUALIZER_BARS).fill(0);
    let raf = 0;
    const draw = () => {
      officeRadio.readBands(bands);
      bands.forEach((level, i) => {
        const el = barsRef.current[i];
        if (!el) return;
        const px = Math.max(
          BAR_STEP_PX,
          Math.round((level * MUSIC_VISUALIZER_HEIGHT_PX) / BAR_STEP_PX) * BAR_STEP_PX,
        );
        el.style.height = `${px}px`;
      });
      if (playing) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return (
    <div
      className="flex items-end gap-2 shrink-0"
      style={{ height: MUSIC_VISUALIZER_HEIGHT_PX }}
      aria-hidden="true"
    >
      {Array.from({ length: MUSIC_VISUALIZER_BARS }, (_, i) => (
        <div
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="w-4 bg-accent-bright"
          style={{ height: BAR_STEP_PX }}
        />
      ))}
    </div>
  );
}

/**
 * Phone: the player as a sheet that follows one finger (the rules are
 * playerSheet.ts); this adapter keeps the drag and the position React draws.
 */
function usePlayerSheet(shown: boolean, settle: (open: boolean) => void, measure: () => number) {
  const [pos, setPos] = useState<{ offset: number; travel: number } | null>(null);
  const drag = useRef<SheetDrag | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    // Leave the volume slider and text fields their own drags.
    const el = e.target as HTMLElement;
    if (drag.current || el.closest('[role="slider"], input')) return;
    drag.current = startSheetDrag(e.changedTouches[0], e.timeStamp, shown, measure());
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    const t = d && findTouch(e.changedTouches, d.id);
    if (!d || !t) return;
    const moved = moveSheetDrag(d, t, e.timeStamp);
    if (moved) setPos({ offset: moved.offset, travel: d.travel });
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const d = drag.current;
    const t = d && findTouch(e.changedTouches, d.id);
    if (!d || !t) return;
    drag.current = null;
    const out = releaseSheetDrag(d, t, e.timeStamp);
    if (out !== null) settle(out);
    setPos(null);
  };
  const onTouchCancel = () => {
    drag.current = null;
    setPos(null);
  };
  return { pos, handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } };
}

/** The width of the office (the player's containing block), kept up to date
 *  as it resizes; null until measured, or while `active` is off. */
function useOfficeWidth(
  rootRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const office = root?.offsetParent ?? root?.parentElement;
    if (!active || !office) return;
    const check = () => setWidth(office.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(office);
    return () => observer.disconnect();
  }, [rootRef, active]);
  return active ? width : null;
}

/** Where the player stands on both shells: above the office's foot, its width. */
const FRAME = {
  bottom: MUSIC_PLAYER_BOTTOM_PX,
  width: MUSIC_PLAYER_WIDTH_PX,
  maxWidth: 'calc(100% - 20px)',
} as const;

/**
 * The office radio, bottom-right of the office: play/pause, skip, the tune
 * playing with its progress, a bar visualizer, volume (hover for the
 * slider) and a settings panel (mood, song code, hide). On a phone it is
 * centred and tucked below the office's foot behind a muted hint; it follows
 * a finger up from the hint and back down, and a tap elsewhere tucks it away.
 * Never plays on its own — browsers only start audio from a click.
 */
export function MusicPlayer({ mobile }: { mobile: boolean }) {
  const radio = useOfficeRadio();
  const [open, setOpen] = useState(false);
  // Phone only: whether the player is out (it starts tucked away each load).
  const [shown, setShown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, rootRef, () => setOpen(false));
  const settle = useCallback((out: boolean) => {
    if (!out) setOpen(false);
    setShown(out);
  }, []);
  const tuckAway = useCallback(() => settle(false), [settle]);
  useDismiss(mobile && shown, rootRef, tuckAway);
  const sheet = usePlayerSheet(
    shown,
    settle,
    () => (rootRef.current?.offsetHeight ?? 0) + MUSIC_PLAYER_BOTTOM_PX,
  );
  // How far out the player is (0 tucked away or hidden, 1 out), shared with
  // the version label (radioLift.ts) so it rides above the player.
  const barRef = useRef<HTMLDivElement>(null);
  const { pos } = sheet;
  const reveal = radio.hidden ? 0 : !mobile ? 1 : pos ? 1 - pos.offset / pos.travel : Number(shown);
  const dragging = pos !== null;
  // Desktop: in an office too narrow for the whole player beside the
  // bottom-left toolbar (a narrow VS Code panel, a wide terminal drawer), it
  // gives up the visualizer, then the tune's name (playerFit).
  const officeWidth = useOfficeWidth(rootRef, !mobile && !radio.hidden);
  const fit = officeWidth === null ? FULL_PLAYER : playerFit(officeWidth);
  useLayoutEffect(() => {
    const h = barRef.current?.offsetHeight ?? 0;
    setRadioLift(Math.round(reveal * (h + MUSIC_VERSION_GAP_PX)), dragging);
  }, [reveal, dragging]);
  useEffect(() => clearRadioLift, []);

  const { song } = radio;
  if (radio.hidden) return null;

  const body = (
    <>
      {open && (
        <div className="self-stretch pointer-events-auto">
          <RadioSettingsPanel mood={radio.mood} code={songCode(song)} />
        </div>
      )}

      <div
        ref={barRef}
        className="pixel-panel relative flex items-center gap-6 px-6 py-4 pointer-events-auto"
        style={mobile ? undefined : { width: fit.width }}
      >
        <Button
          size="icon_lg"
          variant={radio.playing ? 'active' : 'default'}
          className="w-32! h-32! shrink-0"
          onClick={() => void officeRadio.toggle()}
          aria-label={radio.playing ? 'Pause music' : 'Play music'}
          title={radio.playing ? 'Pause music' : 'Play music'}
        >
          <PixelIcon name={radio.playing ? 'pause' : 'next'} />
        </Button>
        <Button
          size="icon_lg"
          className="w-32! h-32! shrink-0"
          onClick={() => officeRadio.skip()}
          aria-label="Next tune"
          title="Next tune"
        >
          <PixelIcon name="skip" />
        </Button>
        {fit.title && (
          <div className="flex-1 min-w-0 flex flex-col gap-2 leading-none ml-2">
            <span className="text-xs text-text truncate" title={song.name}>
              {song.name}
            </span>
            <span className="text-2xs text-text-muted truncate">
              {MOODS[song.moodKey].label} · {keyLabel(song)}
            </span>
          </div>
        )}
        {fit.visualizer && <Visualizer playing={radio.playing} />}
        <VolumeControl volume={radio.volume} />
        <Button
          size="icon_lg"
          variant="ghost"
          className="w-28! h-32! shrink-0"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Music settings"
          title="Mood and song code"
        >
          <PixelIcon name="settings" />
        </Button>
        {/* The tune's progress, along the panel's foot. */}
        <div className="absolute left-0 right-0 bottom-0 h-2 bg-bg-dark" aria-hidden="true">
          <div className="h-full bg-accent" style={{ width: `${radio.progress * 100}%` }} />
        </div>
      </div>
    </>
  );

  if (!mobile) {
    return (
      <div
        ref={rootRef}
        // The box keeps the full width for the settings panel; only the panel
        // and the bar take clicks, so the room a narrower bar leaves is the
        // toolbar's. Cramped (see PlayerFit), the toolbar draws over the bar.
        className={`absolute right-10 flex flex-col items-end gap-4 pointer-events-none ${fit.cramped ? 'z-10' : 'z-30'}`}
        style={FRAME}
      >
        {body}
      </div>
    );
  }

  // Phone: below the office's foot (clipped there) until shown or dragged.
  const y = pos ? `${pos.offset}px` : shown ? '0px' : `calc(100% + ${MUSIC_PLAYER_BOTTOM_PX}px)`;
  const hidden = 1 - reveal;
  const ease = `${MUSIC_SHEET_SETTLE_MS}ms ${MUSIC_SHEET_EASE}`;
  return (
    <div className="absolute inset-0 z-30 overflow-hidden pointer-events-none">
      <button
        type="button"
        {...sheet.handlers}
        onClick={() => settle(true)}
        aria-label="Show music player"
        tabIndex={shown ? -1 : 0}
        className={`absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 px-16 py-6 text-2xs text-text-muted select-none touch-none bg-transparent border-0 ${shown ? '' : 'pointer-events-auto'}`}
        style={{
          bottom: MUSIC_PLAYER_BOTTOM_PX,
          opacity: 0.6 * hidden,
          transition: pos ? 'none' : `opacity ${ease}`,
        }}
      >
        <span className="flex rotate-180">
          <PixelIcon name="down" scale={1} />
        </span>
        <span className="whitespace-nowrap leading-none">Swipe up for music</span>
      </button>
      <div
        ref={rootRef}
        {...sheet.handlers}
        inert={!shown && !pos}
        className="absolute left-1/2 flex flex-col items-stretch gap-4 pointer-events-auto touch-none"
        style={{
          ...FRAME,
          transform: `translate(-50%, ${y})`,
          transition: pos ? 'none' : `transform ${ease}`,
        }}
      >
        {body}
      </div>
    </div>
  );
}
