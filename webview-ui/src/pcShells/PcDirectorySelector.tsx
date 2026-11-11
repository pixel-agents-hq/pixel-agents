import { useEffect, useRef } from 'react';

import { Button } from '../components/ui/Button.js';
import { PC_DIRECTORY_SELECTOR_GAP_PX, PC_DIRECTORY_SELECTOR_Z_INDEX } from '../constants.js';
import { useDismiss } from '../hooks/useDismiss.js';
import { useFrameTick } from '../hooks/useFrameTick.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';

/** A piece whose click asks where its new PC shell opens (core's `choosePlace`). */
export interface DirectoryChoice {
  uid: string;
  /** The Directories mapped to the piece's Area, by name. */
  places: string[];
}

interface PcDirectorySelectorProps {
  choice: DirectoryChoice;
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onChoose: (uid: string, directory: string) => void;
  onClose: () => void;
}

/**
 * The Directory selector: a small popover over a PC whose Area has several
 * Directories, one button per Directory; a press opens the PC's new shell there.
 * Anchored where the piece's Furniture label hangs (OfficeState.pieceAnchor), re-read
 * every frame so it follows the camera; Escape or a press outside dismisses it.
 * Gone with the piece.
 */
export function PcDirectorySelector({
  choice,
  officeState,
  containerRef,
  zoom,
  panRef,
  onChoose,
  onClose,
}: PcDirectorySelectorProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, ref, onClose);
  useFrameTick();

  const anchor = officeState.pieces.anchor(choice.uid);
  const gone = anchor === null;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const el = containerRef.current;
  if (!el || !anchor) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Open the shell in"
      data-testid="pc-directory-selector"
      data-piece-uid={choice.uid}
      className="absolute flex flex-col gap-2 p-4 pixel-panel -translate-x-1/2 -translate-y-full pointer-events-auto"
      style={{
        left: project.toScreenX(anchor.x),
        top: project.toScreenY(anchor.y) - PC_DIRECTORY_SELECTOR_GAP_PX,
        zIndex: PC_DIRECTORY_SELECTOR_Z_INDEX,
      }}
    >
      <span className="text-2xs leading-none px-4 text-text-muted whitespace-nowrap">
        Open shell in
      </span>
      {choice.places.map((name) => (
        <Button
          key={name}
          role="menuitem"
          size="sm"
          className="text-left whitespace-nowrap max-w-2xs overflow-hidden text-ellipsis"
          data-testid="pc-directory-option"
          onClick={() => onChoose(choice.uid, name)}
        >
          {name}
        </Button>
      ))}
    </div>
  );
}
