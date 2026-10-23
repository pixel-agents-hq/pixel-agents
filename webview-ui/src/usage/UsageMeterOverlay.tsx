/**
 * The server room's usage meter: a wall display above the racks with two bars,
 * the Claude subscription's 5-hour session window and its weekly cap, each with
 * the % used and the reset time. Fed by the usage meter's status line
 * (Settings › Usage Meter); says so when that is off or refused. A DOM overlay
 * over the canvas (like the notice board), following pan and zoom.
 */

import { useEffect, useState } from 'react';

import {
  USAGE_METER_BG,
  USAGE_METER_DIM_TEXT,
  USAGE_METER_FRAME,
  USAGE_METER_HIGH,
  USAGE_METER_OK,
  USAGE_METER_TEXT,
  USAGE_METER_TRACK,
  USAGE_METER_WARN,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { ZoneLabel } from '../office/zones.js';
import type { UsageLevel } from './usageModel.js';
import { usageMeterRect, usagePlaceholder, usageRows, usageTooltip } from './usageModel.js';
import { setUsageMeterEnabled, useUsageMeter } from './usageStore.js';

const LEVEL_COLORS: Record<UsageLevel, string> = {
  ok: USAGE_METER_OK,
  warn: USAGE_METER_WARN,
  high: USAGE_METER_HIGH,
};

/** Geometry inside the display, in sprite px. */
const FRAME_PX = 1;
const LABEL_W_PX = 9;
const BAR_H_PX = 4;
const GAP_PX = 2;
const FONT_PX = 7;

interface UsageMeterOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** Hidden while the layout editor is open. */
  hidden: boolean;
  /** Read-only board: an "off" display can't be clicked on. */
  readOnly: boolean;
}

export function UsageMeterOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
  hidden,
  readOnly,
}: UsageMeterOverlayProps) {
  const usage = useUsageMeter();
  // Follow pan and zoom (and the reset countdown): re-render every frame while
  // the layout has a Server room. The clock is read here, not during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (officeState.zones.zones.has(ZoneLabel.SERVER)) {
        setNow(Date.now());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [officeState]);

  const el = containerRef.current;
  // A server too old to have the meter never sends its status: no display.
  if (hidden || !el || usage.meter === null) return null;
  const server = officeState.zones.zones.get(ZoneLabel.SERVER);
  const rect = usageMeterRect(server?.tiles ?? [], officeState.zones.rackTiles);
  if (!rect) return null;

  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );
  const px = zoom / dpr; // CSS px per sprite px
  const placeholder = usagePlaceholder(usage, readOnly);
  // Off on a board that may change settings: the display is the switch (the
  // same request as Settings › Usage Meter; the server re-reports the truth).
  const clickToTurnOn = usage.meter === 'off' && !readOnly;
  const rowH = (rect.h - FRAME_PX * 2) / 2;

  return (
    <div
      className="absolute overflow-hidden whitespace-nowrap leading-none"
      style={{
        left: project.toScreenX(rect.x),
        top: project.toScreenY(rect.y),
        width: rect.w * px,
        height: rect.h * px,
        background: USAGE_METER_BG,
        border: `${FRAME_PX * px}px solid ${USAGE_METER_FRAME}`,
        boxSizing: 'border-box',
        fontSize: FONT_PX * px,
        color: USAGE_METER_TEXT,
        cursor: clickToTurnOn ? 'pointer' : undefined,
      }}
      onClick={clickToTurnOn ? () => setUsageMeterEnabled(true) : undefined}
      role={clickToTurnOn ? 'button' : undefined}
      title={placeholder ?? usageTooltip(usage, now)}
      aria-label={placeholder ?? usageTooltip(usage, now)}
      data-testid="usage-meter"
    >
      {placeholder ? (
        <div
          className="flex items-center justify-center h-full overflow-hidden text-ellipsis"
          style={{ color: USAGE_METER_DIM_TEXT, paddingInline: GAP_PX * px }}
        >
          {placeholder}
        </div>
      ) : (
        usageRows(usage, now).map((row) => (
          <div
            key={row.label}
            className="flex items-center"
            style={{ height: rowH * px, gap: GAP_PX * px, paddingInline: GAP_PX * px }}
          >
            <span style={{ width: LABEL_W_PX * px, flexShrink: 0 }}>{row.label}</span>
            <span
              className="relative flex-1"
              style={{ height: BAR_H_PX * px, background: USAGE_METER_TRACK, minWidth: px }}
            >
              <span
                className="absolute left-0 top-0 h-full"
                style={{ width: `${row.percent}%`, background: LEVEL_COLORS[row.level] }}
              />
            </span>
            <span
              className="shrink-0"
              style={{ color: row.text === '—' ? USAGE_METER_DIM_TEXT : USAGE_METER_TEXT }}
            >
              {row.text}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
