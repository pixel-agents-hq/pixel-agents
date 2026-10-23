/**
 * Tap-for-timeline (docs/office/DESIGN.md, phase D): selecting a character
 * (click, or the first tap on a phone) opens a compact card with its last
 * actions, today's PRs and pushes and its time worked. Desktop: a popover beside
 * the character, following it. Phone: a bottom sheet. The data comes from the
 * server (requestTimeline -> agentTimeline), refreshed while the card is open.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import {
  SIGNAL_POPUP_Z_INDEX,
  TIMELINE_CARD_GAP_PX,
  TIMELINE_CARD_ROWS,
  TIMELINE_CARD_WIDTH_PX,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { safePrUrl } from '../progress/progressFormat.js';
import { requestTimeline } from './feed.js';
import {
  formatClock,
  formatWorked,
  timelineCardPosition,
  timelineIcon,
  timelineRows,
} from './signalFormat.js';
import { useSignals } from './useSignals.js';

/** How often an open card asks for fresh actions. */
const REFRESH_MS = 5_000;

interface TimelineCardProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** Phone layout: a bottom sheet instead of a popover. */
  sheet: boolean;
  /** Hidden while the layout editor is open. */
  hidden: boolean;
}

export function TimelineCard({
  officeState,
  containerRef,
  zoom,
  panRef,
  sheet,
  hidden,
}: TimelineCardProps) {
  const { timelines } = useSignals();
  // The selected top-level agent, sampled every frame (selection lives in the
  // imperative OfficeState), plus the frame tick that moves the popover.
  const [selected, setSelected] = useState<number | null>(null);
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const id = officeState.selectedAgentId;
      const ch = id !== null ? officeState.characters.get(id) : undefined;
      const open = ch !== undefined && !ch.isSubagent;
      setSelected(open ? id : null);
      // The popover follows its character; nothing to move while closed.
      if (open && !sheet) setFrame((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [officeState, sheet]);

  // Ask on open, then keep it fresh while open.
  useEffect(() => {
    if (selected === null || hidden) return;
    requestTimeline(selected);
    const timer = setInterval(() => requestTimeline(selected), REFRESH_MS);
    return () => clearInterval(timer);
  }, [selected, hidden]);

  // The card's height, measured after each render and used by the next frame's
  // placement (the popover re-renders every frame while it follows its character).
  const cardRef = useRef<HTMLDivElement>(null);
  const cardHRef = useRef(0);
  useLayoutEffect(() => {
    cardHRef.current = cardRef.current?.offsetHeight ?? 0;
  });

  if (hidden || selected === null) return null;
  const ch = officeState.characters.get(selected);
  const el = containerRef.current;
  if (!ch || !el) return null;
  const timeline = timelines.get(selected);

  const close = () => {
    officeState.selectedAgentId = null;
    officeState.cameraFollowId = null;
  };

  let style: React.CSSProperties;
  if (sheet) {
    style = { left: 0, right: 0, bottom: 0, maxHeight: '55%', zIndex: SIGNAL_POPUP_Z_INDEX };
  } else {
    const rect = el.getBoundingClientRect();
    const project = overlayProjection(
      officeState.getLayout(),
      rect,
      zoom,
      panRef.current,
      window.devicePixelRatio || 1,
    );
    const { left, top } = timelineCardPosition({
      charX: project.toScreenX(ch.x),
      charY: project.toScreenY(ch.y),
      containerW: rect.width,
      containerH: rect.height,
      cardW: TIMELINE_CARD_WIDTH_PX,
      cardH: cardHRef.current,
      gap: TIMELINE_CARD_GAP_PX,
    });
    style = {
      left,
      top,
      width: TIMELINE_CARD_WIDTH_PX,
      maxHeight: '70%',
      zIndex: SIGNAL_POPUP_Z_INDEX,
    };
  }

  const rows = timeline ? timelineRows(timeline.entries, TIMELINE_CARD_ROWS) : [];
  const name = ch.directoryName || `Agent ${selected}`;
  return (
    <div
      ref={cardRef}
      className="absolute pixel-panel flex flex-col gap-4 py-6 px-10 text-sm overflow-y-auto select-none"
      style={style}
      data-testid="timeline-card"
      data-agent-id={selected}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-8">
        <span className="font-bold overflow-hidden text-ellipsis whitespace-nowrap flex-1">
          🕒 {name}
        </span>
        <Button variant="ghost" size="icon" onClick={close} title="Close timeline">
          ×
        </Button>
      </div>
      {timeline ? (
        <>
          <div
            className="text-xs text-text-muted flex flex-wrap gap-x-10"
            data-testid="timeline-summary"
          >
            <span>⏱️ worked {formatWorked(timeline.activeMs)}</span>
            <span>
              🏆 {timeline.prs.length} PR{timeline.prs.length === 1 ? '' : 's'}
            </span>
            <span>
              📦 {timeline.pushes} push{timeline.pushes === 1 ? '' : 'es'}
            </span>
          </div>
          {timeline.prs.map((pr) => {
            const url = safePrUrl(pr.url);
            return url ? (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-text no-underline hover:text-accent-bright overflow-hidden text-ellipsis whitespace-nowrap"
                title={`${pr.title} · ${pr.repo}`}
              >
                🏆 {pr.title} · {pr.repo}
              </a>
            ) : (
              <span
                key={`${pr.repo}:${pr.at}`}
                className="text-xs overflow-hidden text-ellipsis whitespace-nowrap"
              >
                🏆 {pr.title} · {pr.repo}
              </span>
            );
          })}
          {rows.length === 0 ? (
            <span className="text-xs text-text-muted">Nothing yet today.</span>
          ) : (
            <ol className="flex flex-col gap-2 m-0 p-0 list-none" data-testid="timeline-rows">
              {rows.map((entry, i) => (
                <li
                  key={`${entry.at}:${i}`}
                  className={`flex gap-6 text-xs leading-tight ${entry.kind === 'status' ? 'text-text-muted' : ''}`}
                >
                  <span className="shrink-0 text-text-muted">{formatClock(entry.at)}</span>
                  <span className="shrink-0">{timelineIcon(entry)}</span>
                  <span
                    className="overflow-hidden text-ellipsis whitespace-nowrap"
                    title={entry.text}
                  >
                    {entry.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <span className="text-xs text-text-muted">Loading…</span>
      )}
    </div>
  );
}
