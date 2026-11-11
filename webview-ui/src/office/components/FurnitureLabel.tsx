import { useEffect, useState } from 'react';

import { FURNITURE_LABEL_GAP_PX, FURNITURE_LABEL_Z_INDEX } from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';

interface FurnitureLabelProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  readOnly: boolean;
  /** The layout editor is open: furniture is the editor's, no label shows. */
  editing: boolean;
}

/**
 * The Furniture label: the small box over the hovered piece (OfficeState.hoveredPiece)
 * naming it and showing the lines its rules pick (core's pieceView), the furniture's
 * counterpart of an agent's activity label (ToolOverlay), styled and positioned like
 * it: through the shared world-to-screen projection, re-read every frame so it
 * follows the camera and says what is true now.
 */
export function FurnitureLabel({
  officeState,
  containerRef,
  zoom,
  panRef,
  readOnly,
  editing,
}: FurnitureLabelProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  const piece = officeState.hoveredPiece({ readOnly, editing });
  if (!el || !piece?.view.label) return null;
  const { name, lines } = piece.view.label;
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
        {lines.map((line, i) => (
          <span
            key={i}
            data-testid="furniture-label-line"
            className="text-2xs leading-none overflow-hidden text-ellipsis block"
          >
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}
