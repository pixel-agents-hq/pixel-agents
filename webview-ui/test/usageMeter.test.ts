/**
 * The server room's usage meter, pure: the client state the two server
 * messages build, the display's rows / colours / tooltip / placeholder, and
 * where on the map the display hangs.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

import {
  USAGE_METER_HEIGHT_SPRITE_PX,
  USAGE_METER_HIGH_PERCENT,
  USAGE_METER_MAX_WIDTH_TILES,
  USAGE_METER_WARN_PERCENT,
} from '../src/constants.js';
import { TILE_SIZE } from '../src/office/types.js';
import type { UsageMeterClientState } from '../src/usage/usageModel.js';
import {
  INITIAL_USAGE_STATE,
  isUsageMessage,
  reduceUsageMessage,
  usageLevel,
  usageMeterRect,
  usagePlaceholder,
  usageRows,
  usageTooltip,
} from '../src/usage/usageModel.js';

const NOW = new Date(2026, 9, 18, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

const live: UsageMeterClientState = {
  meter: 'on',
  fiveHour: { usedPercentage: 62.4, resetsAt: NOW + HOUR + 12 * 60 * 1000 },
  sevenDay: { usedPercentage: 12, resetsAt: NOW + 3 * 24 * HOUR },
  updatedAt: NOW - 60 * 1000,
};

describe('usage meter state', () => {
  it('recognizes only its two messages', () => {
    expect(isUsageMessage({ type: 'usageMeterStatus', state: 'on' })).toBe(true);
    expect(isUsageMessage({ type: 'subscriptionUsage' })).toBe(true);
    expect(isUsageMessage({ type: 'agentLimit' })).toBe(false);
    expect(isUsageMessage(null)).toBe(false);
  });

  it('a status sets the meter; a usage message replaces the windows', () => {
    let state = reduceUsageMessage(INITIAL_USAGE_STATE, { type: 'usageMeterStatus', state: 'on' });
    state = reduceUsageMessage(state, {
      type: 'subscriptionUsage',
      fiveHour: live.fiveHour,
      sevenDay: live.sevenDay,
      updatedAt: 1,
    });
    expect(state).toMatchObject({ meter: 'on', fiveHour: live.fiveHour, updatedAt: 1 });
    // The 5-hour window reset: the next message omits it.
    state = reduceUsageMessage(state, { type: 'subscriptionUsage', sevenDay: live.sevenDay });
    expect(state.fiveHour).toBeUndefined();
    expect(state.meter).toBe('on');
  });
});

describe('usage meter rows', () => {
  it('shows each window as % used and the reset clock', () => {
    const [five, seven] = usageRows(live, NOW);
    expect(five).toMatchObject({
      label: '5H',
      percent: 62.4,
      level: 'warn',
      text: '62% · 1:12 pm',
    });
    expect(five.detail).toBe('Session (5-hour): 62% used, resets 1:12 pm (in 1h 12m)');
    expect(seven).toMatchObject({ label: '7D', level: 'ok' });
    expect(seven.text).toMatch(/^12% · \w{3} 12:00 pm$/);
  });

  it('a missing or reset window reads as a dash with an empty bar', () => {
    const rows = usageRows(
      { meter: 'on', fiveHour: { usedPercentage: 90, resetsAt: NOW - 1 }, updatedAt: NOW },
      NOW,
    );
    expect(rows[0]).toMatchObject({ percent: 0, text: '—' });
    expect(rows[1]).toMatchObject({ percent: 0, text: '—' });
  });

  it('colours by how much is used', () => {
    expect(usageLevel(USAGE_METER_WARN_PERCENT - 1)).toBe('ok');
    expect(usageLevel(USAGE_METER_WARN_PERCENT)).toBe('warn');
    expect(usageLevel(USAGE_METER_HIGH_PERCENT)).toBe('high');
    expect(usageLevel(100)).toBe('high');
  });

  it('the tooltip names both windows and when it was updated', () => {
    expect(usageTooltip(live, NOW).split('\n')).toEqual([
      'Session (5-hour): 62% used, resets 1:12 pm (in 1h 12m)',
      expect.stringMatching(/^Weekly \(7-day\): 12% used, resets \w{3} 12:00 pm \(in 3d 0h\)$/),
      'Updated 11:59 am',
    ]);
  });
});

describe('usage meter placeholder', () => {
  it('shows the bars once a report arrived with the meter on', () => {
    expect(usagePlaceholder(live)).toBeNull();
  });

  it('says why the display is blank otherwise', () => {
    expect(usagePlaceholder({ meter: 'on' })).toMatch(/waiting for Claude Code/);
    expect(usagePlaceholder({ meter: 'off' })).toMatch(/click to turn on/);
    expect(usagePlaceholder({ meter: 'off' }, true)).toMatch(/private link/);
    expect(usagePlaceholder({ ...live, meter: 'off' })).toMatch(/off/);
    expect(usagePlaceholder({ meter: 'foreign' })).toMatch(/own status line/);
    expect(usagePlaceholder({ meter: 'unreadable' })).toMatch(/unreadable/);
  });
});

describe('usage meter placement', () => {
  const room = (cols: number[], rows: number[]) =>
    rows.flatMap((row) => cols.map((col) => ({ col, row })));

  it('hangs on the wall above the racks, across the room', () => {
    // The default office's server room: cols 1-6, rows 10-15, racks on row 10.
    const rect = usageMeterRect(room([1, 2, 3, 4, 5, 6], [10, 11, 12, 13, 14, 15]), [
      '1,10',
      '2,10',
      '1,11',
      '2,11',
    ]);
    expect(rect).toEqual({
      x: 1 * TILE_SIZE,
      y: 10 * TILE_SIZE - USAGE_METER_HEIGHT_SPRITE_PX,
      w: 6 * TILE_SIZE,
      h: USAGE_METER_HEIGHT_SPRITE_PX,
    });
  });

  it('sits at the top of a room without racks, and caps its width', () => {
    const cols = Array.from({ length: 12 }, (_, i) => i + 3);
    const rect = usageMeterRect(room(cols, [4, 5]), []);
    expect(rect).toMatchObject({
      x: 3 * TILE_SIZE,
      y: 4 * TILE_SIZE - USAGE_METER_HEIGHT_SPRITE_PX,
      w: USAGE_METER_MAX_WIDTH_TILES * TILE_SIZE,
    });
  });

  it('has nowhere to hang without a Server room', () => {
    expect(usageMeterRect([], [])).toBeNull();
  });
});
