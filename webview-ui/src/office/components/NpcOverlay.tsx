import { useEffect, useState } from 'react';

import { getAnshState } from '../../ansh/anshStore.js';
import {
  ANSH_NPC_LABEL,
  CHARACTER_SITTING_OFFSET_PX,
  MANAGER_NPC_LABEL,
  OVERLAY_LABEL_Z_INDEX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { NpcKind } from '../engine/npcs.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { CharacterState } from '../types.js';

interface NpcOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

interface LabelPos {
  kind: NpcKind;
  left: number;
  top: number;
}

/**
 * Phase M: the hovered NPC's name ("Ansh", "📋 Manager") above its head.
 * NPCs are not agents, so ToolOverlay never labels them; this does, only on
 * hover. Re-renders only when the label moves or changes.
 */
export function NpcOverlay({ officeState, containerRef, zoom, panRef }: NpcOverlayProps) {
  const [label, setLabel] = useState<LabelPos | null>(null);

  useEffect(() => {
    let rafId = 0;
    let last: LabelPos | null = null;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      // While an NPC is talking (a thought, an errand's line), the bubble is its label.
      const hovered = officeState.npcs.hovered;
      const speaking =
        (hovered === 'ansh' && getAnshState().bubble !== null) ||
        officeState.npcLinesShowing().some((l) => l.who === hovered);
      const kind = speaking ? null : hovered;
      const ch = officeState.npcs.characterOf(kind);
      const el = containerRef.current;
      let next: LabelPos | null = null;
      if (kind && ch && el) {
        const project = overlayProjection(
          officeState.getLayout(),
          el.getBoundingClientRect(),
          zoom,
          panRef.current,
          window.devicePixelRatio || 1,
        );
        const sitting = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        next = {
          kind,
          left: Math.round(project.toScreenX(ch.x)),
          top: Math.round(project.toScreenY(ch.y + sitting - TOOL_OVERLAY_VERTICAL_OFFSET)),
        };
      }
      const same =
        next === last ||
        (next !== null &&
          last !== null &&
          next.kind === last.kind &&
          next.left === last.left &&
          next.top === last.top);
      if (!same) {
        last = next;
        setLabel(next);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [officeState, containerRef, zoom, panRef]);

  if (!label) return null;
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-full pixel-panel py-1 px-6 text-xs whitespace-nowrap pointer-events-none select-none"
      style={{ left: label.left, top: label.top, zIndex: OVERLAY_LABEL_Z_INDEX }}
      data-testid={`npc-label-${label.kind}`}
    >
      {label.kind === 'manager' ? MANAGER_NPC_LABEL : ANSH_NPC_LABEL}
    </div>
  );
}
