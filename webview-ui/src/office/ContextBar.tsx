/**
 * An agent's context gauge, drawn as a health bar: the fill is the context
 * LEFT (full when empty, draining as it fills), the colour warns by the share
 * used (contextGauge.ts). The one drawing behind the label over each
 * character (ToolOverlay) and the bar along the foot of each agent card.
 */

import type { CSSProperties } from 'react';

import { CONTEXT_GAUGE_BG } from '../constants.js';
import { contextColor, contextLeft } from './contextGauge.js';

interface ContextBarProps {
  /** Share of the context used, 0-1. */
  used: number;
  /** Omitted: the box's own layout sets it (the card's bar spans by left/right). */
  width?: CSSProperties['width'];
  height: CSSProperties['height'];
  title: string;
  testId?: string;
  /** `data-context-pct`: the share USED, in whole percent (e2e reads it). */
  pct?: number;
  className?: string;
  style?: CSSProperties;
}

export function ContextBar({
  used,
  width,
  height,
  title,
  testId,
  pct,
  className,
  style,
}: ContextBarProps) {
  return (
    <div
      className={className}
      style={{ width, height, background: CONTEXT_GAUGE_BG, ...style }}
      title={title}
      data-testid={testId}
      data-context-pct={pct}
    >
      <div
        style={{
          width: `${contextLeft(used) * 100}%`,
          height: '100%',
          background: contextColor(used),
        }}
      />
    </div>
  );
}
