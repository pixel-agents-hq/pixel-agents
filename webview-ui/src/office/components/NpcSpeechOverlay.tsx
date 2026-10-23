import { useEffect, useState } from 'react';

import { getAnshState } from '../../ansh/anshStore.js';
import {
  ANSH_NPC_LABEL,
  CHARACTER_SITTING_OFFSET_PX,
  MANAGER_NPC_LABEL,
  OVERLAY_LABEL_Z_INDEX,
  RECEPTIONIST_LABEL,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { NpcSpeaker } from '../engine/anshErrands.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import type { Character } from '../types.js';
import { CharacterState } from '../types.js';

interface NpcSpeechOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

interface Bubble {
  who: NpcSpeaker;
  text: string;
  left: number;
  top: number;
}

const NAMES: Record<NpcSpeaker, string> = {
  ansh: ANSH_NPC_LABEL,
  receptionist: RECEPTIONIST_LABEL,
  manager: MANAGER_NPC_LABEL,
};

function speakerOf(officeState: OfficeState, who: NpcSpeaker): Character | null {
  if (who === 'ansh') return officeState.npcs.ansh;
  if (who === 'manager') return officeState.npcs.manager;
  return officeState.receptionist;
}

/**
 * What is said on Ansh's errands between thoughts (OfficeState.anshWander):
 * his line over his head, and the receptionist's or the Manager's answer over
 * theirs. A thought of his own (AnshBubbleOverlay) outranks his errand line.
 * Not clickable. Re-renders only when a bubble moves, appears or goes.
 */
export function NpcSpeechOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: NpcSpeechOverlayProps) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);

  useEffect(() => {
    let rafId = 0;
    let lastKey = '';
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const el = containerRef.current;
      const lines = officeState.npcLinesShowing();
      const next: Bubble[] = [];
      if (el && lines.length > 0) {
        const project = overlayProjection(
          officeState.getLayout(),
          el.getBoundingClientRect(),
          zoom,
          panRef.current,
          window.devicePixelRatio || 1,
        );
        const thinking = getAnshState().bubble !== null;
        for (const line of lines) {
          if (line.who === 'ansh' && thinking) continue;
          const ch = speakerOf(officeState, line.who);
          if (!ch) continue;
          const sitting = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
          next.push({
            who: line.who,
            text: line.text,
            left: Math.round(project.toScreenX(ch.x)),
            top: Math.round(project.toScreenY(ch.y + sitting - TOOL_OVERLAY_VERTICAL_OFFSET)),
          });
        }
      }
      const key = next.map((b) => `${b.who}|${b.text}|${b.left}|${b.top}`).join('\n');
      if (key !== lastKey) {
        lastKey = key;
        setBubbles(next);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [officeState, containerRef, zoom, panRef]);

  return (
    <>
      {bubbles.map((b) => (
        <div
          key={b.who}
          className="absolute -translate-x-1/2 -translate-y-full pixel-panel py-2 px-8 text-xs text-left whitespace-normal max-w-[220px] w-max pointer-events-none select-none"
          style={{ left: b.left, top: b.top, zIndex: OVERLAY_LABEL_Z_INDEX + 1 }}
          data-testid={`npc-speech-${b.who}`}
        >
          <span className="text-accent-bright">{NAMES[b.who]}: </span>
          {b.text}
        </div>
      ))}
    </>
  );
}
