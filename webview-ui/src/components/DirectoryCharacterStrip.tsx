import { useEffect, useMemo, useRef, useState } from 'react';

import { CHAR_FRAME_W } from '../../../core/src/assets/constants.js';
import { useCast } from '../characters/castStore.js';
import { characterLabel, newProfile } from '../characters/profiles.js';
import { isOpaque, SHEET_W } from '../characters/sheet.js';
import {
  DIRECTORY_SILHOUETTE_COLOR,
  DIRECTORY_SILHOUETTE_DOT_PX,
  DIRECTORY_SILHOUETTE_DOT_XS,
  DIRECTORY_SILHOUETTE_DOT_Y,
  DIRECTORY_SILHOUETTE_DOTS_COLOR,
  DIRECTORY_STRIP_PER_LINE,
  DIRECTORY_STRIP_TRAILING_EMPTY_PX,
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
} from '../constants.js';
import type { Directory } from '../hooks/useExtensionMessages.js';
import { getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { directoryStrip } from './directoryStrip.js';

interface DirectoryCharacterStripProps {
  directory: Directory;
  /** A mug shot pressed: launch into this Directory as that character. */
  onPick: (palette: number) => void;
}

/**
 * A Directory's default characters as 1x mug shots side by side in its
 * launch-drawer row, the highest priority first (or a random few, in random
 * order), plus a dark silhouette with "..." when there are more than fit.
 * Each mug shot is its own button: pressing it launches as that character.
 * Pressing the silhouette shows every default instead, DIRECTORY_STRIP_PER_LINE
 * to a line, until the drawer closes. The gaps are the row's to handle (a
 * launch in the Directory's own order). Nothing when the Directory has no
 * defaults.
 */
export function DirectoryCharacterStrip({ directory, onPick }: DirectoryCharacterStripProps) {
  const [expanded, setExpanded] = useState(false);
  // Subscribed so a character added or deleted re-renders (and re-reads the count).
  const cast = useCast();
  const paletteCount = getLoadedCharacterCount();
  // Random order reshuffles each time the row mounts (each drawer opening),
  // not on every render.
  const { shown, all } = useMemo(
    () => directoryStrip(directory.characters, directory.characterOrder, paletteCount),
    [directory.characters, directory.characterOrder, paletteCount],
  );
  const more = shown.length < all.length;
  if (shown.length === 0) return null;
  const tiles = expanded ? all : shown;
  return (
    <span
      data-testid="directory-characters"
      className="shrink-0 flex flex-wrap items-center justify-end"
      // An explicit width, not a max-width: a wrapping box's intrinsic width
      // is one mug shot (min-content) or every one in a line (max-content),
      // and the drawer sizes itself from it.
      style={{
        marginRight: -DIRECTORY_STRIP_TRAILING_EMPTY_PX,
        width:
          Math.min(tiles.length + (more && !expanded ? 1 : 0), DIRECTORY_STRIP_PER_LINE) *
          MUGSHOT_CROP_SIDE_PX,
      }}
    >
      {tiles.map((palette) => {
        const label = characterLabel(cast.profiles[palette], palette);
        return (
          <button
            key={palette}
            type="button"
            onClick={(e) => {
              // The row's own press launches in order; this one is specific.
              e.stopPropagation();
              onPick(palette);
            }}
            aria-label={`Launch as ${label} in ${directory.name}`}
            title={`Launch as ${label}`}
            className="flex p-0 bg-transparent border-none rounded-none cursor-pointer hover:-translate-y-1 focus-visible:-translate-y-1"
          >
            <CharacterMugShot palette={palette} repeat={0} zoom={1} />
          </button>
        );
      })}
      {more && !expanded && (
        <button
          type="button"
          onClick={(e) => {
            // Shows the rest; launches nothing.
            e.stopPropagation();
            setExpanded(true);
          }}
          aria-label={`Show all ${all.length} characters of ${directory.name}`}
          title="Show all"
          className="flex p-0 bg-transparent border-none rounded-none cursor-pointer hover:-translate-y-1 focus-visible:-translate-y-1"
        >
          <SilhouetteMugShot />
        </button>
      )}
    </span>
  );
}

/** The overflow tile: a blank character's head in a dark tone, "..." over it. */
function SilhouetteMugShot() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { renderer } = useCast();

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const side = MUGSHOT_CROP_SIDE_PX;
    ctx.clearRect(0, 0, side, side);
    // The blank doll from the wardrobe (frame 0 facing down): only its shape.
    const sheet = renderer?.sheet(newProfile());
    ctx.fillStyle = DIRECTORY_SILHOUETTE_COLOR;
    if (sheet) {
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const sx = x + MUGSHOT_CROP_LEFT_COL;
          const sy = y + MUGSHOT_CROP_TOP_ROW;
          if (sx < 0 || sx >= CHAR_FRAME_W) continue;
          if (isOpaque(sheet[(sy * SHEET_W + sx) * 4 + 3])) ctx.fillRect(x, y, 1, 1);
        }
      }
    } else {
      ctx.fillRect(0, 0, side, side);
    }
    // "..." across the face: three 2x2 dots.
    ctx.fillStyle = DIRECTORY_SILHOUETTE_DOTS_COLOR;
    for (const x of DIRECTORY_SILHOUETTE_DOT_XS) {
      ctx.fillRect(
        x,
        DIRECTORY_SILHOUETTE_DOT_Y,
        DIRECTORY_SILHOUETTE_DOT_PX,
        DIRECTORY_SILHOUETTE_DOT_PX,
      );
    }
  }, [renderer]);

  return (
    <canvas
      ref={canvasRef}
      width={MUGSHOT_CROP_SIDE_PX}
      height={MUGSHOT_CROP_SIDE_PX}
      style={{
        width: MUGSHOT_CROP_SIDE_PX,
        height: MUGSHOT_CROP_SIDE_PX,
        imageRendering: 'pixelated',
      }}
    />
  );
}
