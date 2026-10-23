import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { BackgroundAgents } from '../hooks/agentKindState.js';
import type { AgentProgressState } from '../hooks/useExtensionMessages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import type { ToolActivity } from '../office/types.js';
import { formatWait, waitLevel } from '../progress/progressFormat.js';
import { AgentLinkAction } from './AgentLinkAction.js';
import {
  INBOX_CLOCK_MS,
  INBOX_PANEL_GAP_PX,
  INBOX_PANEL_MAX_HEIGHT_RATIO,
  INBOX_PANEL_MOBILE_MARGIN_PX,
  INBOX_PANEL_WIDTH_PX,
  INBOX_PANEL_Z_INDEX,
} from './constants.js';
import type { InboxAgent, InboxRow, PausedRow } from './inboxModel.js';
import { buildInbox, pausedSummary, resumeText, WAIT_REASON_LABELS } from './inboxModel.js';
import { useInboxState } from './inboxStore.js';

export interface InboxInputs {
  /** Every top-level agent id (characters and background workers). */
  agentIds: number[];
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  agentProgress: Record<number, AgentProgressState>;
  agentTitles: Record<number, string>;
  backgroundAgents: BackgroundAgents;
  officeState: OfficeState;
}

interface InboxStripItemsProps extends InboxInputs {
  /** Phones: a short chip. */
  compact: boolean;
  /** TV mode: the 📥 count as a plain badge — no button, no panel. */
  passive?: boolean;
}

const WAIT_COLORS = {
  none: 'var(--color-text-muted)',
  yellow: 'var(--color-status-permission)',
  red: 'var(--color-status-error)',
} as const;

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), INBOX_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The office's per-agent state, reduced to the inbox's inputs. */
function useInbox(inputs: InboxInputs, now: number) {
  const inbox = useInboxState();
  const {
    agentIds,
    agentTools,
    agentStatuses,
    agentProgress,
    agentTitles,
    backgroundAgents,
    officeState,
  } = inputs;
  return useMemo(() => {
    const agents: InboxAgent[] = agentIds.map((id) => {
      const ch = officeState.characters.get(id);
      const asking = Object.values(inbox.asking[id] ?? {});
      return {
        id,
        title: agentTitles[id],
        repo: ch?.directoryName ?? backgroundAgents[id]?.directoryName,
        machine: officeState.agentSources.get(id)?.label,
        status: agentStatuses[id],
        permission:
          (agentTools[id]?.some((t) => t.permissionWait && !t.done) ?? false) ||
          ch?.bubbleType === 'permission',
        asking: asking.length > 0,
        askingSince: asking.length > 0 ? Math.min(...asking) : undefined,
        permissionSince: inbox.permissionSince[id],
        waitingSince: agentProgress[id]?.waitingSince,
        limit: inbox.limits[id],
        link: inbox.links[id],
      };
    });
    const ids = new Set(agentIds);
    return {
      ...buildInbox(agents, now),
      pausedLine: pausedSummary(inbox.limits, now, ids),
    };
  }, [
    inbox,
    agentIds,
    agentTools,
    agentStatuses,
    agentProgress,
    agentTitles,
    backgroundAgents,
    officeState,
    now,
  ]);
}

function WaitingItem({ row, now }: { row: InboxRow; now: number }) {
  const waitMs = Math.max(0, now - row.since);
  const level = waitLevel(waitMs);
  return (
    <li
      className="flex items-center gap-8 py-4 min-w-0 border-b-2 border-border last:border-b-0"
      data-testid="inbox-row"
      data-agent-id={row.id}
      data-reason={row.reason}
    >
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        <span className="text-2xs leading-none whitespace-nowrap">
          {WAIT_REASON_LABELS[row.reason]}
          <span
            className="ml-6"
            style={{ color: WAIT_COLORS[level] }}
            data-testid="inbox-wait"
            data-wait-level={level}
          >
            {formatWait(waitMs)}
          </span>
        </span>
        <span
          className="text-2xs leading-none whitespace-nowrap overflow-hidden text-ellipsis text-text-muted"
          title={row.label}
        >
          {row.label}
        </span>
      </div>
      <AgentLinkAction link={row.link} variant="row" />
    </li>
  );
}

function PausedItem({ row, now }: { row: PausedRow; now: number }) {
  return (
    <li
      className="flex items-center gap-8 py-4 min-w-0 border-b-2 border-border last:border-b-0"
      data-testid="inbox-paused-row"
      data-agent-id={row.id}
    >
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        <span
          className="text-2xs leading-none whitespace-nowrap overflow-hidden text-ellipsis"
          title={row.label}
        >
          ⏸️ {row.label}
        </span>
        <span className="text-2xs leading-none whitespace-nowrap text-text-muted">
          {resumeText(row, now)}
        </span>
      </div>
      <AgentLinkAction link={row.link} variant="row" />
    </li>
  );
}

/**
 * The inbox's pieces on the TODAY strip: the 📥 N button (a chip on phones)
 * that opens the "Needs you" panel, and "⏸️ N paused · resume <time>" while a
 * usage limit pauses anyone. The panel is portalled to the body: the strip
 * clips its overflow, and on phones the office page is a transformed track.
 */
export function InboxStripItems({ compact, passive = false, ...inputs }: InboxStripItemsProps) {
  const now = useClock();
  const { waiting, paused, pausedLine } = useInbox(inputs, now);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + INBOX_PANEL_GAP_PX });
      }
    };
    place();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', place);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const count = waiting.length;
  const oldestLevel = count > 0 ? waitLevel(Math.max(0, now - waiting[0].since)) : 'none';
  const countColor =
    count === 0 ? WAIT_COLORS.none : oldestLevel === 'none' ? undefined : WAIT_COLORS[oldestLevel];
  const countTitle = count === 1 ? '1 agent needs you' : `${count} agents need you`;
  const pausedItem = pausedLine && (
    <span className="shrink-0" title={pausedLine} data-testid="paused-summary">
      {compact ? `⏸️${paused.length}` : pausedLine}
    </span>
  );

  if (passive) {
    // TV mode: waiting work stays visible from across the room; nothing
    // invites a click (the panel and its links are controls).
    return (
      <>
        <span
          className={`shrink-0 flex items-center gap-4 text-text ${compact ? 'text-2xs' : 'text-sm'}`}
          title={countTitle}
          data-testid="inbox-badge"
          data-count={count}
        >
          <span>📥</span>
          <span style={{ color: countColor }}>{count}</span>
        </span>
        {pausedItem}
      </>
    );
  }

  const panelStyle: React.CSSProperties = compact
    ? {
        left: INBOX_PANEL_MOBILE_MARGIN_PX,
        right: INBOX_PANEL_MOBILE_MARGIN_PX,
        bottom: anchor?.bottom,
      }
    : {
        left: anchor?.left,
        bottom: anchor?.bottom,
        width: INBOX_PANEL_WIDTH_PX,
        maxWidth: `calc(100vw - ${2 * INBOX_PANEL_MOBILE_MARGIN_PX}px)`,
      };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`shrink-0 flex items-center gap-4 bg-transparent border-0 p-0 cursor-pointer text-text ${compact ? 'text-2xs' : 'text-sm'}`}
        title={countTitle}
        aria-expanded={open}
        data-testid="inbox-button"
        data-count={count}
      >
        <span>📥</span>
        <span style={{ color: countColor }}>{count}</span>
      </button>
      {pausedItem}
      {open &&
        anchor &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed pixel-panel flex flex-col py-6 px-10 overflow-y-auto"
            style={{
              ...panelStyle,
              maxHeight: `${INBOX_PANEL_MAX_HEIGHT_RATIO * 100}vh`,
              zIndex: INBOX_PANEL_Z_INDEX,
            }}
            role="dialog"
            aria-label="Needs you"
            data-testid="inbox-panel"
          >
            <div className="flex items-center justify-between gap-8 pb-4">
              <span className="text-sm">📥 Needs you ({count})</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="bg-transparent border-0 p-0 cursor-pointer text-text-muted hover:text-text"
                title="Close"
              >
                ×
              </button>
            </div>
            {count === 0 ? (
              <span className="text-2xs text-text-muted py-4">Nobody is waiting on you.</span>
            ) : (
              <ul className="list-none m-0 p-0">
                {waiting.map((row) => (
                  <WaitingItem key={row.id} row={row} now={now} />
                ))}
              </ul>
            )}
            {paused.length > 0 && (
              <>
                <span
                  className="text-2xs text-text-muted pt-8 pb-2"
                  data-testid="inbox-paused-heading"
                >
                  Paused by usage limit
                </span>
                <ul className="list-none m-0 p-0">
                  {paused.map((row) => (
                    <PausedItem key={row.id} row={row} now={now} />
                  ))}
                </ul>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
