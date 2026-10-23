import type { DailyPr, DailyPush, WorkPhase } from '../../../core/src/messages.js';

/** The waiting badge turns yellow after this long on the user... */
export const WAIT_YELLOW_MS = 5 * 60_000;
/** ...and red after this long. */
export const WAIT_RED_MS = 15 * 60_000;

export type WaitLevel = 'none' | 'yellow' | 'red';

/** Color step of the waiting badge. 'none' still shows the badge, just neutral. */
export function waitLevel(ms: number): WaitLevel {
  if (ms >= WAIT_RED_MS) return 'red';
  if (ms >= WAIT_YELLOW_MS) return 'yellow';
  return 'none';
}

/** '45s' under a minute, '14m' under an hour, then '1h 05m'. Floors, never negative
 *  (a viewer's clock can run a little behind the server's). */
export function formatWait(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  return `${hours}h ${String(totalMin % 60).padStart(2, '0')}m`;
}

/** How long a sleeping agent has been idle, coarsely, so it reads at a glance
 *  from across the room: '<1m', '14m', '3h', '2d'. Floors, never negative. */
export function formatIdle(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A sleeping agent's label: '💤 idle 3h', or just '💤 idle' when the server
 *  didn't say since when. */
export function sleepLabel(idleSince: number | undefined, now: number): string {
  return idleSince === undefined ? '💤 idle' : `💤 idle ${formatIdle(now - idleSince)}`;
}

/** Active time as hours with one decimal: '0.4 h', '5.2 h'. */
export function formatHours(activeMs: number): string {
  return `${(Math.max(0, activeMs) / 3_600_000).toFixed(1)} h`;
}

/** The stage track, in cycle order. */
export const PHASES: readonly WorkPhase[] = ['explore', 'build', 'test', 'ship'];

export const PHASE_LABELS: Record<WorkPhase, string> = {
  explore: 'EXPLORE',
  build: 'BUILD',
  test: 'TEST',
  ship: 'SHIP',
};

export type PipState = 'done' | 'current' | 'off';

/** One pip of the stage track: the current phase wins over "reached". */
export function pipState(
  phase: WorkPhase,
  reached: readonly WorkPhase[],
  current: WorkPhase | undefined,
): PipState {
  if (phase === current) return 'current';
  if (reached.includes(phase)) return 'done';
  return 'off';
}

/** Whether the label shows a stage track at all: only once the cycle has a
 *  classified tool, so an agent that has done nothing keeps its compact label. */
export function hasStageTrack(progress: {
  phase?: WorkPhase;
  reached: readonly WorkPhase[];
}): boolean {
  return progress.phase !== undefined || progress.reached.length > 0;
}

/** '1 PR', '3 PRs'. */
export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function totalPushes(pushes: readonly DailyPush[]): number {
  return pushes.reduce((sum, p) => sum + p.count, 0);
}

/** Newest first; never mutates the message's own array. */
export function newestPrs(prs: readonly DailyPr[]): DailyPr[] {
  return [...prs].sort((a, b) => b.at - a.at);
}

/** A PR's url, only if it is http(s): a remote relay supplies `pr_url`, and a
 *  trophy must never become a `javascript:` link. */
export function safePrUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}
