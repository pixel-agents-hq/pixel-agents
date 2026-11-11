import { useSyncExternalStore } from 'react';

import { Button } from '../../components/ui/Button.js';
import { PixelIcon } from '../../components/ui/PixelIcon.js';
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
  /** Close a piece's live PC shell (the label's ×, like an agent's label);
   *  absent where this office can't (read-only, no terminals). */
  onCloseShell?: (shellId: number) => void;
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
  onCloseShell,
}: FurnitureLabelProps) {
  const { pieces } = officeState;
  const hoveredUid = useSyncExternalStore(pieces.subscribeHover, () => pieces.hoveredUid);
  useFrameTick(hoveredUid !== null && !hidden);

  const el = containerRef.current;
  const piece = hidden ? null : pieces.hovered({ readOnly });
  if (!el || !piece?.view.label) return null;
  const { name, line } = piece.view.label;
  // A piece with a live shell gets the × an agent's label has. The label then
  // takes the pointer (and reaches down to the piece, so the mouse can cross
  // to it without leaving the piece); a plain label lets everything through.
  const shell = onCloseShell ? pieces.shellOf(piece.uid) : null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <div
      className={`absolute flex flex-col items-center -translate-x-1/2 -translate-y-full ${
        shell ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      style={{
        left: project.toScreenX(piece.anchor.x),
        top: project.toScreenY(piece.anchor.y),
        paddingBottom: FURNITURE_LABEL_GAP_PX,
        zIndex: FURNITURE_LABEL_Z_INDEX,
      }}
      onMouseLeave={(e) => {
        // Back onto the canvas: its next move decides. Anywhere else: gone.
        if (!(e.relatedTarget instanceof HTMLCanvasElement)) pieces.clearHover();
      }}
      data-testid="furniture-label"
      data-piece-uid={piece.uid}
    >
      <div className="flex items-start border-border px-8 pt-2 pb-4 pixel-panel whitespace-nowrap max-w-2xs overflow-hidden">
        <div className="flex flex-col overflow-hidden">
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
        {shell && (
          <Button
            variant="ghost"
            size="icon"
            data-testid="furniture-label-close"
            onClick={(e) => {
              e.stopPropagation();
              onCloseShell?.(shell.id);
            }}
            title="Close shell"
            className="ml-2 shrink-0"
          >
            <PixelIcon name="close" className="translate-y-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
