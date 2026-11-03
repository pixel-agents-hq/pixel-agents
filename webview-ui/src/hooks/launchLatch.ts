import { LAUNCH_ANSWER_TIMEOUT_MS } from '../constants.js';

/**
 * Whether a terminal opening at `now` answers the launch this client armed at
 * `armedAt` (null = nothing armed). A launch only waits so long: one whose
 * spawn failed opens no terminal, and without the limit the latch would stay
 * armed and claim the next terminal anyone opens (another device's launch),
 * selecting its character and, on the phone, sliding to it. Pure, so it is
 * tested without React.
 */
export function answersLaunch(
  armedAt: number | null,
  now: number,
  timeoutMs: number = LAUNCH_ANSWER_TIMEOUT_MS,
): boolean {
  return armedAt !== null && now - armedAt <= timeoutMs;
}
