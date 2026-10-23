/**
 * The limit break, as pure rules: when the subscription's session limit cuts
 * an agent off mid-task, it goes to the Lounge with the others it cut off —
 * and the Manager and Ansh — and they pass the time there until the limit
 * resets (the server's `agentLimit paused:false`).
 *
 * Which pauses count, what each agent does next (a rotation of the Lounge's
 * pastimes), the sign over the group and what they say. FunDirector runs it;
 * OfficeState walks the NPCs over.
 */

import { LIMIT_BREAK_REASONS } from '../../../core/src/constants.js';
import { formatClock } from '../inbox/inboxModel.js';
import { BREAK_AGENT_LINES, BREAK_ANSH_LINES, BREAK_MANAGER_LINES } from './funConstants.js';

/** What an agent on the break is doing right now. */
export type BreakActivity = 'sofa' | 'pizza' | 'coffee' | 'shelves' | 'pingpong';

/** Fixed order (a seeded pick is reproducible) and how likely each is. The
 *  sofa chat is the break's resting state; the rest are outings from it. */
export const BREAK_ACTIVITY_WEIGHTS: ReadonlyArray<readonly [BreakActivity, number]> = [
  ['sofa', 3],
  ['pizza', 1],
  ['coffee', 1],
  ['shelves', 1],
  ['pingpong', 1],
];

/** Does an `agentLimit` reason put the agent on the break? */
export function isBreakReason(reason: unknown): boolean {
  return typeof reason === 'string' && LIMIT_BREAK_REASONS.includes(reason);
}

/**
 * The next activity among those the Lounge offers right now: by weight,
 * never the one just done (unless nothing else is on). Null when none is.
 */
export function pickBreakActivity(
  available: ReadonlySet<BreakActivity>,
  last: BreakActivity | undefined,
  random: () => number,
): BreakActivity | null {
  let options = BREAK_ACTIVITY_WEIGHTS.filter(([a]) => available.has(a) && a !== last);
  if (options.length === 0) options = BREAK_ACTIVITY_WEIGHTS.filter(([a]) => available.has(a));
  if (options.length === 0) return null;
  const total = options.reduce((n, [, w]) => n + w, 0);
  let roll = random() * total;
  for (const [activity, weight] of options) {
    roll -= weight;
    if (roll < 0) return activity;
  }
  return options[options.length - 1][0];
}

/** The sign over the group: "Back at 6:30 pm" (the earliest reset), else "On a break". */
export function breakSignText(resetsAt: number | undefined, now: number): string {
  return resetsAt !== undefined && resetsAt > now
    ? `Back at ${formatClock(resetsAt, now)}`
    : 'On a break';
}

/** Who says a line: an agent (its id) or one of the NPCs. */
export type BreakSpeaker = number | 'ansh' | 'manager';

/** A line for a speaker, with the reset time filled in. */
export function breakLine(
  who: BreakSpeaker,
  resetsAt: number | undefined,
  now: number,
  random: () => number,
): string {
  const lines =
    who === 'manager' ? BREAK_MANAGER_LINES : who === 'ansh' ? BREAK_ANSH_LINES : BREAK_AGENT_LINES;
  const line = lines[Math.floor(random() * lines.length) % lines.length];
  const time = resetsAt !== undefined && resetsAt > now ? formatClock(resetsAt, now) : 'the reset';
  return line.replace('{time}', time);
}
