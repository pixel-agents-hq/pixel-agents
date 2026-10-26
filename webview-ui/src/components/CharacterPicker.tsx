import type { RefObject, WheelEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { CharacterProfile } from '../../../core/src/characterProfiles.js';
import { MAX_CHARACTER_PROFILES } from '../../../core/src/characterProfiles.js';
import { useCast } from '../characters/castStore.js';
import { characterLabel } from '../characters/profiles.js';
import { rosterOrder } from '../characters/recent.js';
import type { CharacterRenderer } from '../characters/renderer.js';
import { SpriteCanvas } from '../characters/ui/SpriteCanvas.js';
import { CHARACTER_ANIM_MS, CHARACTER_PICKER_SPRITE_SCALE } from '../constants.js';
import { useDevicePixelRatio } from '../hooks/useDevicePixelRatio.js';
import { useLongPress } from '../hooks/useLongPress.js';
import { PixelIcon } from './ui/PixelIcon.js';

/** The sheet's walk cycle, as the Characters view's stage plays it. */
const WALK_FRAMES = [0, 1, 2, 1];

/** The walk frame to show: cycles while `walking`, back to standing when it stops. */
function useWalkFrame(walking: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!walking) return;
    const timer = setInterval(() => setStep((s) => s + 1), CHARACTER_ANIM_MS.walk);
    return () => {
      clearInterval(timer);
      setStep(0);
    };
  }, [walking]);
  return WALK_FRAMES[step % WALK_FRAMES.length];
}

interface CharacterRowProps {
  /** A tap or click: launch an agent wearing this character. */
  onPick: (index: number) => void;
  /** A long press (touch) or the card's pencil (hover): edit this character. */
  onEdit: (index: number) => void;
  /** The leading `+ New` slot: add a character and edit it. */
  onNew: () => void;
  /** Whether the row is showing; the recent order only updates while it shows
   *  (a row that stays mounted must not reshuffle under the closing slide). */
  isOpen?: boolean;
  className?: string;
  /** Draw a scrollbar both above and below the cards, kept in step (the
   *  desktop roster): `rowClassName` goes on the row of cards itself,
   *  `mirrorClassName` on the bar below (`className` styles the one above). */
  edgeScrollbars?: { rowClassName?: string; mirrorClassName?: string };
}

/**
 * The roster as a horizontal carousel: one card per character and, while the
 * roster has room, an empty `+ New` slot at the start. A pick launches as that
 * character (the caller then asks where); editing works like a Directory
 * row's — a long press on touch, a pencil revealed by hovering where hover
 * exists. The characters launched most recently come first, the same on every
 * office (the server keeps the list, recent.ts orders it). A vertical mouse
 * wheel scrolls it sideways.
 */
export function CharacterRow({
  onPick,
  onEdit,
  onNew,
  isOpen = true,
  className = '',
  edgeScrollbars,
}: CharacterRowProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const overflows = useOverflowsX(scrollerRef, !!edgeScrollbars);
  const cast = useCast();
  const dpr = useDevicePixelRatio();
  const [recent, setRecent] = useState(cast.recent);
  useEffect(() => {
    if (isOpen) setRecent(cast.recent);
  }, [isOpen, cast.recent]);
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
  };
  if (edgeScrollbars) {
    // The scroller is flipped upside down, which puts its own scrollbar on
    // top, and the row inside flipped back (with `scale`, not `transform`,
    // so the cards' own transform animations are left alone). Below it, a
    // second bar mirrors that one. Cards that fit get neither bar, nor the
    // room for one.
    return (
      <>
        <div
          ref={scrollerRef}
          className={`overflow-y-hidden overscroll-contain -scale-y-100 ${
            overflows ? `overflow-x-scroll ${className}` : 'overflow-x-hidden'
          }`}
          onWheel={wheel}
        >
          <div
            className={`flex items-stretch gap-6 w-max -scale-y-100 ${edgeScrollbars.rowClassName ?? ''}`}
          >
            <RosterCards recent={recent} dpr={dpr} onPick={onPick} onEdit={onEdit} onNew={onNew} />
          </div>
        </div>
        {overflows && (
          <MirrorScrollbar target={scrollerRef} className={edgeScrollbars.mirrorClassName ?? ''} />
        )}
      </>
    );
  }
  return (
    <div
      className={`flex items-stretch gap-6 overflow-x-auto overscroll-contain ${className}`}
      onWheel={wheel}
    >
      <RosterCards recent={recent} dpr={dpr} onPick={onPick} onEdit={onEdit} onNew={onNew} />
    </div>
  );
}

/** Whether the element's content is wider than it (watched while `active`). */
function useOverflowsX(ref: RefObject<HTMLDivElement | null>, active: boolean): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [ref, active]);
  return overflows;
}

/**
 * A bare horizontal scrollbar that moves in step with `target`'s: an empty
 * scroller as wide as the target, holding a spacer as long as the target's
 * content. Each one's scroll sets the other's. Its caller gives it the
 * target's bar classes, with the target's bottom padding as top padding, so
 * the gap between bar and cards is the same on both sides.
 */
function MirrorScrollbar({
  target,
  className,
}: {
  target: RefObject<HTMLDivElement | null>;
  className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    const main = target.current;
    const mirror = ref.current;
    if (!main || !mirror) return;
    const measure = () => setContentWidth(main.scrollWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    if (main.firstElementChild) observer.observe(main.firstElementChild);
    const fromMain = () => {
      if (mirror.scrollLeft !== main.scrollLeft) mirror.scrollLeft = main.scrollLeft;
    };
    const fromMirror = () => {
      if (main.scrollLeft !== mirror.scrollLeft) main.scrollLeft = mirror.scrollLeft;
    };
    main.addEventListener('scroll', fromMain);
    mirror.addEventListener('scroll', fromMirror);
    return () => {
      observer.disconnect();
      main.removeEventListener('scroll', fromMain);
      mirror.removeEventListener('scroll', fromMirror);
    };
  }, [target]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`overflow-x-scroll overflow-y-hidden ${className}`}
    >
      <div style={{ width: contentWidth, height: 1 }} />
    </div>
  );
}

/** The `+ New` slot while there is room, then the roster's cards, most recent first. */
function RosterCards({
  recent,
  dpr,
  onPick,
  onEdit,
  onNew,
}: Pick<CharacterRowProps, 'onPick' | 'onEdit' | 'onNew'> & {
  recent: readonly number[];
  dpr: number;
}) {
  const cast = useCast();
  return (
    <>
      {cast.profiles.length < MAX_CHARACTER_PROFILES && (
        <button
          type="button"
          onClick={onNew}
          title="Add a new character"
          className="shrink-0 w-56 flex flex-col items-center justify-center gap-2 py-4 bg-transparent border-2 border-dashed border-border rounded-none cursor-pointer text-sm text-text-muted hover:text-text active:text-text select-none"
        >
          <span className="text-2xl leading-none">+</span>
          New
        </button>
      )}
      {rosterOrder(cast.profiles.length, recent).map((index) => (
        <CharacterCard
          key={index}
          index={index}
          profile={cast.profiles[index]}
          renderer={cast.renderer}
          dpr={dpr}
          onPick={onPick}
          onEdit={onEdit}
        />
      ))}
    </>
  );
}

interface PhoneCharacterPickerProps extends Omit<CharacterRowProps, 'className'> {
  isOpen: boolean;
  /** The strip's root, for the caller's outside-press check. */
  containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * The phone's roster: the carousel across the whole screen, pinned to the
 * top edge of the card bar. Always mounted, so it can slide down as well as
 * up: the clip box sits on the bar's top border (mb-2: the bar's own border
 * stays visible) and the strip slides out of it, behind the bar. Closed, it
 * is inert and lets presses through to the office.
 */
export function PhoneCharacterPicker({ isOpen, containerRef, ...row }: PhoneCharacterPickerProps) {
  return (
    <div
      className={`absolute left-0 right-0 bottom-full mb-2 z-20 overflow-hidden ${
        isOpen ? '' : 'pointer-events-none'
      }`}
    >
      <div
        ref={containerRef}
        data-testid="character-picker"
        aria-hidden={!isOpen}
        inert={!isOpen}
        className={`bg-bg border-t-2 border-border transition-transform duration-200 ease-out motion-reduce:transition-none ${
          isOpen ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        {/* The phone layout also serves narrow desktop windows, which keep a
            scrollbar; touch screens hide it. The cards fade in one after
            another as on desktop: the class comes back on every open, which
            restarts the animation of a strip that stays mounted. */}
        <CharacterRow
          {...row}
          isOpen={isOpen}
          className={`px-8 py-6 pixel-scrollbar touch-no-scrollbar ${isOpen ? 'fade-stagger' : ''}`}
        />
      </div>
    </div>
  );
}

interface CharacterCardProps {
  index: number;
  profile: CharacterProfile;
  renderer: CharacterRenderer | null;
  dpr: number;
  onPick: (index: number) => void;
  onEdit: (index: number) => void;
}

function CharacterCard({ index, profile, renderer, dpr, onPick, onEdit }: CharacterCardProps) {
  const longPress = useLongPress(() => onEdit(index));
  const label = characterLabel(profile, index);
  // A mouse over the card walks the character in place. Mouse only: a tap's
  // emulated hover would leave it walking until the next tap elsewhere.
  const [hovered, setHovered] = useState(false);
  const frame = useWalkFrame(hovered);
  return (
    <div
      className="group relative shrink-0 flex"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* select-none + no touch callout keep the long press from starting
          iOS text selection or the image callout on the canvas. */}
      <button
        type="button"
        aria-label={`Launch as ${label}`}
        {...longPress.handlers}
        onClick={() => {
          if (!longPress.consumeClick()) onPick(index);
        }}
        onContextMenu={(e) => e.preventDefault()}
        className="w-56 flex flex-col items-center justify-end gap-2 py-4 px-2 bg-bg-thumb border-2 border-transparent rounded-none cursor-pointer hover:border-border active:border-accent-bright select-none [-webkit-touch-callout:none]"
      >
        <SpriteCanvas
          sheet={renderer?.sheet(profile) ?? null}
          view={{ kind: 'frame', facing: 'down', frame }}
          scale={CHARACTER_PICKER_SPRITE_SCALE}
          dpr={dpr}
        />
        <span className="max-w-[7ch] overflow-hidden text-ellipsis whitespace-nowrap text-sm text-text-muted">
          {label}
        </span>
      </button>
      {/* Hidden until the card is hovered (hover: only exists on devices
          that have it) or the pencil is keyboard-focused; gone on coarse
          pointers, where the long press is the edit affordance. */}
      <button
        type="button"
        onClick={() => onEdit(index)}
        aria-label={`Edit ${label}`}
        title="Edit character"
        className="absolute top-2 right-2 flex items-center justify-center p-2 bg-bg border-none rounded-none cursor-pointer leading-none text-text-muted hover:text-text opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden"
      >
        <PixelIcon name="pencil" />
      </button>
    </div>
  );
}
