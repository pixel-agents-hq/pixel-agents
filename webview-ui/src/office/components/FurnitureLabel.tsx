import { useSyncExternalStore } from 'react';

import { FURNITURE_LABEL_GAP_PX, FURNITURE_LABEL_Z_INDEX } from '../../constants.js';
import { useFrameTick } from '../../hooks/useFrameTick.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';

interface FurnitureLabelProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  readOnly: boolean;
  /** No label shows (the Directory selector stands where it would). */
  hidden: boolean;
}

/**
 * The Furniture label: the small box over the hovered piece (OfficeState.pieces.hovered)
 * naming it and showing the line its rules pick (core's pieceView), the furniture's
 * counterpart of an agent's activity label (ToolOverlay), styled and positioned like
 * it: through the shared world-to-screen projection, re-read every frame so it
 * follows the camera and says what is true now — while a piece is hovered only.
 */
export function FurnitureLabel({
  officeState,
  containerRef,
  zoom,
  panRef,
  readOnly,
  hidden,
}: FurnitureLabelProps) {
  const { pieces } = officeState;
  const hoveredUid = useSyncExternalStore(pieces.subscribeHover, () => pieces.hoveredUid);
  useFrameTick(hoveredUid !== null && !hidden);

  const el = containerRef.current;
  const piece = hidden ? null : pieces.hovered({ readOnly });
  if (!el || !piece?.view.label) return null;
  const { name, line } = piece.view.label;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <div
      className="absolute flex flex-col items-center -translate-x-1/2 -translate-y-full pointer-events-none"
      style={{
        left: project.toScreenX(piece.anchor.x),
        top: project.toScreenY(piece.anchor.y) - FURNITURE_LABEL_GAP_PX,
        zIndex: FURNITURE_LABEL_Z_INDEX,
      }}
      data-testid="furniture-label"
      data-piece-uid={piece.uid}
    >
      <div className="flex flex-col border-border px-8 pt-2 pb-4 pixel-panel whitespace-nowrap max-w-2xs overflow-hidden">
        <span
          data-testid="furniture-label-name"
          className="overflow-hidden text-ellipsis block leading-none text-base"
        >
          {name}
        </span>
        {line !== null && (
          <span
            data-testid="furniture-label-line"
            className="text-2xs leading-none overflow-hidden text-ellipsis block"
          >
            {line}
          </span>
        )}
      </div>
    </div>
  );
}
