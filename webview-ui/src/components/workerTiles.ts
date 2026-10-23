/** Pure rules for the Remote Workers panel: what each background agent's tile
 *  says, and the one-glance summary the phone chip shows (DOM-free, so they
 *  run on the Node runner). RemoteWorkers.tsx draws them. */

import { truncateText } from '../office/agentLabel.js';
import type { ToolActivity } from '../office/types.js';
import { sleepLabel } from '../progress/progressFormat.js';

/** The tile's status dot, in priority order (the chip shows the first one any
 *  tile has): needs approval, running, turn done, nothing yet / asleep. */
export type WorkerStatus = 'permission' | 'active' | 'waiting' | 'idle';

const STATUS_PRIORITY: readonly WorkerStatus[] = ['permission', 'active', 'waiting', 'idle'];

/** A tile's title is cut to this many characters (the full one is its tooltip). */
export const WORKER_TITLE_MAX_CHARS = 28;

const NEEDS_APPROVAL_TEXT = 'Needs approval';
const WAITING_INPUT_TEXT = 'Waiting for input';
const DONE_TEXT = 'Done';
const WORKING_TEXT = 'Working';
const IDLE_TEXT = 'Idle';

/** Everything the office knows about one background agent. */
export interface WorkerInputs {
  title?: string;
  directoryName?: string;
  tools?: ToolActivity[];
  /** agentStatuses entry: 'waiting' after a turn ends, absent while active. */
  status?: string;
  /** The turn ended waiting on the user, not just done. */
  awaitingInput?: boolean;
  /** Latch: the agent has had any activity at all. */
  seenActivity?: boolean;
  /** Present while the server reports the agent sleeping. */
  sleep?: { idleSince?: number };
}

export interface WorkerTile {
  id: number;
  status: WorkerStatus;
  /** The short title, else the repo, else "Agent <id>". */
  name: string;
  /** The untruncated name, for the tooltip. */
  fullName: string;
  /** The repo, when the name is a title (never the repo twice). */
  repo?: string;
  /** Latest activity, as the office label would say it. */
  activity: string;
}

function workerStatus(w: WorkerInputs): WorkerStatus {
  const tools = w.tools ?? [];
  if (tools.some((t) => t.permissionWait && !t.done)) return 'permission';
  if (w.sleep) return 'idle';
  if (tools.some((t) => !t.done)) return 'active';
  if (w.status === 'waiting') return 'waiting';
  return w.seenActivity ? 'active' : 'idle';
}

function workerActivity(w: WorkerInputs, status: WorkerStatus, now: number): string {
  if (status === 'permission') return NEEDS_APPROVAL_TEXT;
  if (w.sleep) return sleepLabel(w.sleep.idleSince, now);
  const tools = w.tools ?? [];
  const running = [...tools].reverse().find((t) => !t.done);
  if (running) return running.status;
  if (w.status === 'waiting') return w.awaitingInput ? WAITING_INPUT_TEXT : DONE_TEXT;
  // Mid-turn between tools: keep the last tool's status, like the office label.
  const last = tools[tools.length - 1];
  if (last) return last.status;
  return w.seenActivity ? WORKING_TEXT : IDLE_TEXT;
}

/** One background agent's tile. */
export function workerTile(id: number, w: WorkerInputs, now: number): WorkerTile {
  const status = workerStatus(w);
  const title = w.title?.trim();
  const fullName = title || w.directoryName || `Agent ${id}`;
  return {
    id,
    status,
    name: truncateText(fullName, WORKER_TITLE_MAX_CHARS),
    fullName,
    repo: title ? w.directoryName : undefined,
    activity: workerActivity(w, status, now),
  };
}

/** Every background agent's tile, oldest agent first (ids rise with creation),
 *  so tiles never reshuffle as their status changes. */
export function workerTiles(
  ids: Iterable<number>,
  inputsFor: (id: number) => WorkerInputs,
  now: number,
): WorkerTile[] {
  return [...ids].sort((a, b) => a - b).map((id) => workerTile(id, inputsFor(id), now));
}

/** The collapsed phone chip: how many workers, and the most urgent dot. */
export function workerSummary(tiles: readonly WorkerTile[]): {
  count: number;
  status: WorkerStatus;
} {
  const status = STATUS_PRIORITY.find((s) => tiles.some((t) => t.status === s)) ?? 'idle';
  return { count: tiles.length, status };
}
