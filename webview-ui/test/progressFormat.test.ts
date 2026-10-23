import { describe, expect, it } from 'vitest';

import {
  countLabel,
  formatHours,
  formatWait,
  hasStageTrack,
  newestPrs,
  PHASE_LABELS,
  PHASES,
  pipState,
  safePrUrl,
  totalPushes,
  WAIT_RED_MS,
  WAIT_YELLOW_MS,
  waitLevel,
} from '../src/progress/progressFormat.js';

const MIN = 60_000;

describe('waitLevel', () => {
  it('is neutral under 5 minutes, yellow under 15, red from 15', () => {
    expect(waitLevel(0)).toBe('none');
    expect(waitLevel(WAIT_YELLOW_MS - 1)).toBe('none');
    expect(waitLevel(WAIT_YELLOW_MS)).toBe('yellow');
    expect(waitLevel(14 * MIN)).toBe('yellow');
    expect(waitLevel(WAIT_RED_MS)).toBe('red');
    expect(waitLevel(3 * 60 * MIN)).toBe('red');
  });

  it('uses the 5 and 15 minute thresholds', () => {
    expect(WAIT_YELLOW_MS).toBe(5 * MIN);
    expect(WAIT_RED_MS).toBe(15 * MIN);
  });
});

describe('formatWait', () => {
  it('shows seconds under a minute', () => {
    expect(formatWait(0)).toBe('0s');
    expect(formatWait(45_900)).toBe('45s');
    expect(formatWait(59_999)).toBe('59s');
  });

  it('shows whole minutes under an hour', () => {
    expect(formatWait(MIN)).toBe('1m');
    expect(formatWait(14 * MIN + 59_000)).toBe('14m');
    expect(formatWait(59 * MIN + 59_999)).toBe('59m');
  });

  it('shows hours and zero-padded minutes from an hour', () => {
    expect(formatWait(60 * MIN)).toBe('1h 00m');
    expect(formatWait(65 * MIN)).toBe('1h 05m');
    expect(formatWait(25 * 60 * MIN + 30 * MIN)).toBe('25h 30m');
  });

  it('clamps a negative span (viewer clock behind the server) to 0s', () => {
    expect(formatWait(-5_000)).toBe('0s');
  });
});

describe('formatHours', () => {
  it('shows hours with one decimal', () => {
    expect(formatHours(0)).toBe('0.0 h');
    expect(formatHours(24 * MIN)).toBe('0.4 h');
    expect(formatHours(5.2 * 60 * MIN)).toBe('5.2 h');
    expect(formatHours(-MIN)).toBe('0.0 h');
  });
});

describe('PHASES', () => {
  it('lists the stage track in cycle order with upper-case labels', () => {
    expect(PHASES).toEqual(['explore', 'build', 'test', 'ship']);
    expect(PHASES.map((p) => PHASE_LABELS[p])).toEqual(['EXPLORE', 'BUILD', 'TEST', 'SHIP']);
  });
});

describe('pipState', () => {
  it('marks the current phase, reached phases, and the rest', () => {
    const reached = ['explore', 'build', 'test'] as const;
    expect(pipState('build', reached, 'build')).toBe('current');
    expect(pipState('explore', reached, 'build')).toBe('done');
    expect(pipState('test', reached, 'build')).toBe('done');
    expect(pipState('ship', reached, 'build')).toBe('off');
  });

  it('lets the current phase win even when it is not listed as reached', () => {
    expect(pipState('test', [], 'test')).toBe('current');
  });

  it('is all off with no phase and nothing reached', () => {
    expect(PHASES.map((p) => pipState(p, [], undefined))).toEqual(['off', 'off', 'off', 'off']);
  });
});

describe('hasStageTrack', () => {
  it('shows once the cycle has a phase or a reached phase', () => {
    expect(hasStageTrack({ reached: [] })).toBe(false);
    expect(hasStageTrack({ phase: 'explore', reached: [] })).toBe(true);
    expect(hasStageTrack({ reached: ['explore'] })).toBe(true);
  });
});

describe('countLabel', () => {
  it('uses the singular for exactly one', () => {
    expect(countLabel(1, 'PR')).toBe('1 PR');
    expect(countLabel(0, 'PR')).toBe('0 PRs');
    expect(countLabel(3, 'PR')).toBe('3 PRs');
  });

  it('takes an irregular plural', () => {
    expect(countLabel(1, 'push', 'pushes')).toBe('1 push');
    expect(countLabel(7, 'push', 'pushes')).toBe('7 pushes');
  });
});

describe('totalPushes', () => {
  it('sums the per-repo counts', () => {
    expect(totalPushes([])).toBe(0);
    expect(
      totalPushes([
        { repo: 'a', count: 3 },
        { repo: 'b', count: 4 },
      ]),
    ).toBe(7);
  });
});

describe('newestPrs', () => {
  it('sorts newest first without touching the input', () => {
    const prs = [
      { title: 'old', repo: 'o/r', at: 1 },
      { title: 'new', repo: 'o/r', at: 3, url: 'https://github.com/o/r/pull/3' },
      { title: 'mid', repo: 'o/r', at: 2 },
    ];
    expect(newestPrs(prs).map((p) => p.title)).toEqual(['new', 'mid', 'old']);
    expect(prs.map((p) => p.title)).toEqual(['old', 'new', 'mid']);
  });
});

describe('safePrUrl', () => {
  it('keeps http(s) urls', () => {
    expect(safePrUrl('https://github.com/o/r/pull/12')).toBe('https://github.com/o/r/pull/12');
    expect(safePrUrl('http://ghe.local/o/r/pull/1')).toBe('http://ghe.local/o/r/pull/1');
  });

  it('drops missing, malformed, and non-http urls', () => {
    expect(safePrUrl(undefined)).toBeUndefined();
    expect(safePrUrl('')).toBeUndefined();
    expect(safePrUrl('not a url')).toBeUndefined();
    expect(safePrUrl('javascript:alert(1)')).toBeUndefined();
    expect(safePrUrl('data:text/html,hi')).toBeUndefined();
  });
});
