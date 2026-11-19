import { useEffect, useSyncExternalStore } from 'react';

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
  /** Always Show Labels: the pieces whose panel is in use (a PC with a live
   *  shell) keep their label up with nobody hovering them. */
  alwaysShow: boolean;
  /** Close a piece's live PC shell (the label's ×, like an agent's label);
   *  absent where this office can't (read-only, no terminals). */
  onCloseShell?: (shellId: number) => void;
}

/**
 * The Furniture labels: the small box over the hovered piece (OfficeState.pieces.hovered)
 * showing the line its rules pick (core's pieceView; its name only where no line holds), the furniture's
 * counterpart of an agent's activity label (ToolOverlay), styled and positioned like
 * it: through the shared world-to-screen projection, re-read every frame so it
 * follows the camera and says what is true now. Under Always Show Labels every
 * piece whose panel is in use (a PC with a live shell) keeps its label up too,
 * as the agents' labels stay up.
 */
export function FurnitureLabel({
  officeState,
  containerRef,
  zoom,
  panRef,
  readOnly,
  hidden,
  alwaysShow,
  onCloseShell,
}: FurnitureLabelProps) {
  const { pieces } = officeState;
  const hoveredUid = useSyncExternalStore(pieces.subscribeHover, () => pieces.hoveredUid);
  // Every frame while a label may show: the in-use pieces reach the office outside
  // React, so under Always Show Labels the tick is also what notices them.
  useFrameTick(!hidden && (hoveredUid !== null || alwaysShow));

  // A hover that lingers after the mouse left the piece (pieces.hoverAt) ends
  // here: looked at after every frame's render while a piece is hovered.
  useEffect(() => pieces.expireHover());
  const el = containerRef.current;
  if (!el || hidden) return null;
  const hovered = pieces.hovered({ readOnly });
  const shown = [
    ...(hovered?.view.label ? [hovered] : []),
    ...(alwaysShow ? pieces.inUse({ readOnly }).filter((p) => p.uid !== hovered?.uid) : []),
  ];
  if (shown.length === 0) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <>
      {shown.map((piece) => {
        const { name, line } = piece.view.label!;
        // A piece with a live shell gets the × an agent's label has. The label then
        // takes the pointer (and reaches down to the piece, so the mouse can cross
        // to it without leaving the piece); a plain label lets everything through.
        const shell = onCloseShell ? pieces.shellOf(piece.uid) : null;
        const isHovered = piece.uid === hovered?.uid;
        return (
          <div
            key={piece.uid}
            className={`absolute flex flex-col items-center -translate-x-1/2 -translate-y-full ${
              shell ? 'pointer-events-auto' : 'pointer-events-none'
            }`}
            style={{
              left: project.toScreenX(piece.anchor.x),
              top: project.toScreenY(piece.anchor.y),
              paddingBottom: FURNITURE_LABEL_GAP_PX,
              zIndex: FURNITURE_LABEL_Z_INDEX,
            }}
            // Only the hovered piece's label holds the hover: one that is up
            // anyway has none to keep.
            onMouseEnter={isHovered ? () => pieces.holdHover() : undefined}
            onMouseLeave={
              isHovered
                ? (e) => {
                    // Back onto the canvas: it lingers until the pointer is on the
                    // piece again or the grace runs out. Anywhere else: gone.
                    if (e.relatedTarget instanceof HTMLCanvasElement) pieces.releaseHover();
                    else pieces.clearHover();
                  }
                : undefined
            }
            data-testid="furniture-label"
            data-piece-uid={piece.uid}
          >
            <div className="flex items-start border-border px-8 pt-2 pb-4 pixel-panel whitespace-nowrap max-w-2xs overflow-hidden">
              <div className="flex flex-col overflow-hidden">
                {/* What the piece is doing says enough: its name shows only
                    where no line holds (a label that declares none). */}
                {line !== null ? (
                  <span
                    data-testid="furniture-label-line"
                    className="text-2xs leading-none overflow-hidden text-ellipsis block"
                  >
                    {line}
                  </span>
                ) : (
                  <span
                    data-testid="furniture-label-name"
                    className="text-2xs leading-none overflow-hidden text-ellipsis block"
                  >
                    {name}
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
      })}
    </>
  );
}
