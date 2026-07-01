import { useEffect, useState } from 'react';

import { PROJECT_LABEL_BELOW_OFFSET_PX } from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import type { OfficeState } from '../engine/officeState.js';
import { characterToScreen, computeOverlayTransform } from './overlayPositioning.js';

interface ProjectLabelsProps {
  officeState: OfficeState;
  agents: number[];
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

/**
 * Renders a small project (workspace folder) label just below each character.
 * Shares the exact world→screen transform used by ToolOverlay so the labels
 * stay pinned to the sprites as the camera pans/zooms. Only characters with a
 * `folderName` (multi-root workspaces) get a label.
 */
export function ProjectLabels({
  officeState,
  agents,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
}: ProjectLabelsProps) {
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
  if (!el) return null;
  const transform = computeOverlayTransform(el, officeState, zoom, panRef);

  const ids = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {ids.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch || !ch.folderName) return null;
        const { screenX, screenY } = characterToScreen(
          ch,
          transform,
          PROJECT_LABEL_BELOW_OFFSET_PX,
        );
        return (
          <div
            key={id}
            data-testid="project-label"
            data-agent-id={id}
            className="absolute -translate-x-1/2 pointer-events-none whitespace-nowrap font-pixel leading-none text-text-muted"
            style={{ left: screenX, top: screenY, fontSize: 9 }}
          >
            {ch.folderName}
          </div>
        );
      })}
    </>
  );
}
