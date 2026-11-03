/**
 * The launch latch: the first terminal to open after this client launched
 * (or resumed) answers it, but only for so long.
 */

import { describe, expect, it } from 'vitest';

import { LAUNCH_ANSWER_TIMEOUT_MS } from '../src/constants.js';
import { answersLaunch } from '../src/hooks/launchLatch.js';

describe('answersLaunch', () => {
  it('answers nothing when no launch is armed', () => {
    expect(answersLaunch(null, 1_000)).toBe(false);
  });

  it('a terminal that opens soon after the launch answers it', () => {
    expect(answersLaunch(1_000, 1_500)).toBe(true);
    expect(answersLaunch(1_000, 1_000 + LAUNCH_ANSWER_TIMEOUT_MS)).toBe(true);
  });

  it('a launch that opened no terminal stops waiting after the timeout', () => {
    // The spawn failed: the next terminal is someone else's, long after.
    expect(answersLaunch(1_000, 1_001 + LAUNCH_ANSWER_TIMEOUT_MS)).toBe(false);
  });

  it('takes the timeout as a parameter', () => {
    expect(answersLaunch(0, 50, 100)).toBe(true);
    expect(answersLaunch(0, 150, 100)).toBe(false);
  });
});
