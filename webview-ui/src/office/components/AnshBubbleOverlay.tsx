import { useEffect, useState } from 'react';

import { clearAnshBubble, getAnshState, useAnshState } from '../../ansh/anshStore.js';
import {
  ANSH_BUBBLE_MS,
  CHARACTER_SITTING_OFFSET_PX,
  OVERLAY_LABEL_Z_INDEX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { CharacterState } from '../types.js';

interface AnshBubbleOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

/**
 * Ansh's latest thought, said out loud: a speech bubble above his head for
 * ANSH_BUBBLE_MS, following him as he walks. Clicking it selects and follows
 * the agent the thought was about (if any) and closes the bubble. Re-renders
 * only when the bubble moves, appears or goes.
 */
export function AnshBubbleOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: AnshBubbleOverlayProps) {
  const { bubble } = useAnshState();
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!bubble) {
      setPos(null);
      return;
    }
    let rafId = 0;
    let last: { left: number; top: number } | null = null;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const current = getAnshState().bubble;
      if (!current || performance.now() - current.shownAt > ANSH_BUBBLE_MS) {
        clearAnshBubble();
        return;
      }
      const ch = officeState.npcs.ansh;
      const el = containerRef.current;
      let next: { left: number; top: number } | null = null;
      if (ch && el) {
        const project = overlayProjection(
          officeState.getLayout(),
          el.getBoundingClientRect(),
          zoom,
          panRef.current,
          window.devicePixelRatio || 1,
        );
        const sitting = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        next = {
          left: Math.round(project.toScreenX(ch.x)),
          top: Math.round(project.toScreenY(ch.y + sitting - TOOL_OVERLAY_VERTICAL_OFFSET)),
        };
      }
      if (next?.left !== last?.left || next?.top !== last?.top) {
        last = next;
        setPos(next);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [bubble, officeState, containerRef, zoom, panRef]);

  if (!bubble || !pos) return null;
  const targetId = bubble.thought.targetId;
  const focusTarget = () => {
    if (targetId !== undefined && officeState.characters.has(targetId)) {
      officeState.selectedAgentId = targetId;
      officeState.cameraFollowId = targetId;
    }
    clearAnshBubble();
  };
  return (
    <button
      type="button"
      className="absolute -translate-x-1/2 -translate-y-full pixel-panel py-2 px-8 text-xs text-left whitespace-normal max-w-[220px] w-max cursor-pointer select-none"
      style={{ left: pos.left, top: pos.top, zIndex: OVERLAY_LABEL_Z_INDEX + 1 }}
      onClick={focusTarget}
      title={targetId !== undefined ? 'Show this agent' : undefined}
      data-testid="ansh-bubble"
    >
      <span className="text-accent-bright">Ansh: </span>
      {bubble.thought.say}
    </button>
  );
}
