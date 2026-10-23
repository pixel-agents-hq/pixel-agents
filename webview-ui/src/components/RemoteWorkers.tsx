import { useEffect, useMemo, useState } from 'react';

import {
  REMOTE_WORKERS_BOTTOM_RESERVE_PX,
  REMOTE_WORKERS_CLOCK_MS,
  REMOTE_WORKERS_MOBILE_BOTTOM_PX,
  REMOTE_WORKERS_MOBILE_MAX_HEIGHT_RATIO,
  REMOTE_WORKERS_MOBILE_WIDTH_PX,
  REMOTE_WORKERS_OPEN_Z_INDEX,
  REMOTE_WORKERS_TOP_PX,
  REMOTE_WORKERS_WIDTH_PX,
} from '../constants.js';
import { Button } from './ui/Button.js';
import type { WorkerInputs, WorkerStatus, WorkerTile } from './workerTiles.js';
import { workerSummary, workerTiles } from './workerTiles.js';

/** Same status vars as the office labels and cards. */
const STATUS_DOT: Record<WorkerStatus, string> = {
  permission: 'var(--color-status-permission)',
  active: 'var(--color-status-active)',
  waiting: 'var(--color-status-success)',
  idle: 'var(--color-text-muted)',
};

const STATUS_WORDS: Record<WorkerStatus, string> = {
  permission: 'needs approval',
  active: 'working',
  waiting: 'turn done',
  idle: 'idle',
};

// The repo and activity rows: smaller than the name, one line each.
const DETAIL_FONT_PX = 14;

/** Background agents by id, with everything the office knows about each. */
export type RemoteWorkerInputs = Record<number, WorkerInputs>;

/** The tiles, re-read on a slow clock: only a sleeping worker's coarse
 *  "💤 idle 3h" depends on the time, everything else changes by message. */
function useWorkerTiles(workers: RemoteWorkerInputs): WorkerTile[] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REMOTE_WORKERS_CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return useMemo(
    () => workerTiles(Object.keys(workers).map(Number), (id) => workers[id], now),
    [workers, now],
  );
}

function WorkerRow({ tile }: { tile: WorkerTile }) {
  const where = tile.repo ? `${tile.fullName} · ${tile.repo}` : tile.fullName;
  return (
    <li
      className="flex items-start gap-6 py-3 min-w-0"
      title={`${where}\n${tile.activity}`}
      data-testid="remote-worker"
      data-agent-id={tile.id}
      data-status={tile.status}
    >
      <span
        className={`size-6 shrink-0 mt-4 ${tile.status === 'active' ? 'pixel-pulse' : ''}`}
        style={{ background: STATUS_DOT[tile.status] }}
        aria-label={STATUS_WORDS[tile.status]}
      />
      <div className="flex flex-col gap-2 min-w-0">
        <span className="text-2xs leading-none whitespace-nowrap overflow-hidden text-ellipsis">
          {tile.name}
        </span>
        {tile.repo && (
          <span
            className="leading-none whitespace-nowrap overflow-hidden text-ellipsis text-text-muted"
            style={{ fontSize: DETAIL_FONT_PX }}
          >
            {tile.repo}
          </span>
        )}
        <span
          className="leading-none whitespace-nowrap overflow-hidden text-ellipsis"
          style={{ fontSize: DETAIL_FONT_PX }}
        >
          {tile.activity}
        </span>
      </div>
    </li>
  );
}

function WorkerList({ tiles }: { tiles: readonly WorkerTile[] }) {
  return (
    <ul className="m-0 p-0 list-none flex flex-col overflow-y-auto pixel-scrollbar min-h-0">
      {tiles.map((tile) => (
        <WorkerRow key={tile.id} tile={tile} />
      ))}
    </ul>
  );
}

function Header({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-between gap-8 text-2xs leading-none text-text-muted shrink-0">
      <span>REMOTE WORKERS</span>
      <span>{count}</span>
    </div>
  );
}

/**
 * Desktop: background agents (headless sessions with no office character) as
 * a compact list hanging under the zoom controls — top-left, clear of the
 * TODAY strip and toolbar (bottom-left), the version label (bottom-right),
 * the card bar (right edge) and the hooks toast (top-right). Hidden when
 * there are none.
 */
export function RemoteWorkersPanel({ workers }: { workers: RemoteWorkerInputs }) {
  const tiles = useWorkerTiles(workers);
  if (tiles.length === 0) return null;
  return (
    <div
      className="absolute left-8 z-20 pixel-panel py-6 px-8 flex flex-col gap-4 select-none"
      style={{
        top: REMOTE_WORKERS_TOP_PX,
        width: `min(${REMOTE_WORKERS_WIDTH_PX}px, calc(100% - 96px))`,
        maxHeight: `calc(100% - ${REMOTE_WORKERS_TOP_PX + REMOTE_WORKERS_BOTTOM_RESERVE_PX}px)`,
      }}
      data-testid="remote-workers"
    >
      <Header count={tiles.length} />
      <WorkerList tiles={tiles} />
    </div>
  );
}

/**
 * Phone: a "🤖 3" chip in the bottom-right corner, above the version label
 * (the top edge already holds Fit/Settings, the >_ toggle, the hooks toast
 * and the connection pill; the bottom-left holds the TODAY strip). Its dot is
 * the most urgent worker's status; a tap opens the same list upward. While
 * open it rises above the office labels it covers.
 */
export function RemoteWorkersChip({ workers }: { workers: RemoteWorkerInputs }) {
  const tiles = useWorkerTiles(workers);
  const [open, setOpen] = useState(false);
  if (tiles.length === 0) return null;
  const summary = workerSummary(tiles);
  return (
    <div
      className="absolute right-8 z-20"
      style={{
        bottom: REMOTE_WORKERS_MOBILE_BOTTOM_PX,
        zIndex: open ? REMOTE_WORKERS_OPEN_Z_INDEX : undefined,
      }}
    >
      <Button
        size="sm"
        variant={open ? 'active' : 'default'}
        className="border-border! shadow-pixel flex items-center gap-6 whitespace-nowrap"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${summary.count} remote worker${summary.count === 1 ? '' : 's'}`}
        data-testid="remote-workers-chip"
        data-status={summary.status}
      >
        <span className="size-6 shrink-0" style={{ background: STATUS_DOT[summary.status] }} />
        <span>🤖 {summary.count}</span>
      </Button>
      {open && (
        <div
          className="absolute right-0 bottom-full mb-6 pixel-panel py-6 px-8 flex flex-col gap-4 select-none"
          style={{
            width: `min(${REMOTE_WORKERS_MOBILE_WIDTH_PX}px, calc(100vw - 16px))`,
            maxHeight: `${Math.round(REMOTE_WORKERS_MOBILE_MAX_HEIGHT_RATIO * 100)}dvh`,
          }}
          data-testid="remote-workers"
        >
          <Header count={tiles.length} />
          <WorkerList tiles={tiles} />
        </div>
      )}
    </div>
  );
}
