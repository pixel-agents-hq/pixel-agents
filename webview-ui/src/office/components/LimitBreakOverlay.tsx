import { useEffect, useState } from 'react';

import { getAnshState } from '../../ansh/anshStore.js';
import {
  ANSH_NPC_LABEL,
  CHARACTER_SITTING_OFFSET_PX,
  MANAGER_NPC_LABEL,
  OVERLAY_LABEL_Z_INDEX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { CharacterState, TILE_SIZE } from '../types.js';

interface LimitBreakOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

interface Bubble {
  key: string;
  name: string | null;
  text: string;
  left: number;
  top: number;
}

interface Sign {
  text: string;
  left: number;
  top: number;
}

const NAMES = { ansh: ANSH_NPC_LABEL, manager: MANAGER_NPC_LABEL } as const;

/**
 * The limit break (fun/limitBreak.ts): the "Back at 6:30 pm" sign over the
 * Lounge, and what the agents, the Manager and Ansh say there while they wait
 * for the reset. A thought of Ansh's own (AnshBubbleOverlay) outranks his
 * line. Not clickable. Re-renders only when something moves, appears or goes.
 */
export function LimitBreakOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
}: LimitBreakOverlayProps) {
  const [sign, setSign] = useState<Sign | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);

  useEffect(() => {
    let rafId = 0;
    let lastKey = '';
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const el = containerRef.current;
      const breakSign = officeState.fun.breakSign();
      let nextSign: Sign | null = null;
      const next: Bubble[] = [];
      if (el && breakSign) {
        const project = overlayProjection(
          officeState.getLayout(),
          el.getBoundingClientRect(),
          zoom,
          panRef.current,
          window.devicePixelRatio || 1,
        );
        nextSign = {
          text: breakSign.text,
          left: Math.round(project.toScreenX(breakSign.col * TILE_SIZE)),
          top: Math.round(project.toScreenY(breakSign.row * TILE_SIZE)),
        };
        const thinking = getAnshState().bubble !== null;
        for (const line of officeState.breakSpeechShowing()) {
          if (line.npc === 'ansh' && thinking) continue;
          const sitting = line.ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
          next.push({
            key: line.key,
            name: line.npc ? NAMES[line.npc] : null,
            text: line.text,
            left: Math.round(project.toScreenX(line.ch.x)),
            top: Math.round(project.toScreenY(line.ch.y + sitting - TOOL_OVERLAY_VERTICAL_OFFSET)),
          });
        }
      }
      const key = [
        nextSign ? `${nextSign.text}|${nextSign.left}|${nextSign.top}` : '',
        ...next.map((b) => `${b.key}|${b.text}|${b.left}|${b.top}`),
      ].join('\n');
      if (key !== lastKey) {
        lastKey = key;
        setSign(nextSign);
        setBubbles(next);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [officeState, containerRef, zoom, panRef]);

  return (
    <>
      {sign && (
        <div
          className="absolute -translate-x-1/2 pixel-panel py-2 px-10 text-sm whitespace-nowrap pointer-events-none select-none"
          style={{ left: sign.left, top: sign.top, zIndex: OVERLAY_LABEL_Z_INDEX }}
          data-testid="limit-break-sign"
        >
          {sign.text}
        </div>
      )}
      {bubbles.map((b) => (
        <div
          key={b.key}
          className="absolute -translate-x-1/2 -translate-y-full pixel-panel py-2 px-8 text-xs text-left whitespace-normal max-w-[220px] w-max pointer-events-none select-none"
          style={{ left: b.left, top: b.top, zIndex: OVERLAY_LABEL_Z_INDEX + 1 }}
          data-testid={`limit-break-speech-${b.key}`}
        >
          {b.name && <span className="text-accent-bright">{b.name}: </span>}
          {b.text}
        </div>
      ))}
    </>
  );
}
