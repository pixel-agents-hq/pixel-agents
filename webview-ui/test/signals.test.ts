import { describe, expect, it } from 'vitest';

import type { DailyTokens, TimelineEntry } from '../../core/src/messages.js';
import {
  ALARM_LAMP_BLINK_SEC,
  FIRE_ICON_FRAME_SEC,
  NOTICE_BOARD_INK,
  TILE_SIZE,
} from '../src/constants.js';
import type { Seat } from '../src/office/types.js';
import { Direction } from '../src/office/types.js';
import {
  formatTokenCount,
  formatUsd,
  formatWorked,
  noticeBoardRects,
  noticeLines,
  signalLabel,
  timelineCardPosition,
  timelineIcon,
  timelineRows,
  tokenMeterText,
  tokenMeterTitle,
} from '../src/signals/signalFormat.js';
import { SignalStore } from '../src/signals/signalStore.js';
import { deskTileFor, troubleFrame, troubleFurniture } from '../src/signals/troubleFurniture.js';

/** Useful signals in the office UI (docs/office/DESIGN.md, phase D): the pure parts. */

const tokens = (extra: Partial<DailyTokens> = {}): DailyTokens => ({
  type: 'dailyTokens',
  date: '2026-10-18',
  input: 1_000,
  output: 200_000,
  cacheRead: 1_000_000,
  cacheWrite: 0,
  byModel: {
    'claude-opus-5-5': {
      input: 1_000,
      output: 200_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      estimatedUsd: 3.4,
    },
  },
  ...extra,
});

describe('SignalStore', () => {
  it('tracks trouble, loops, tokens, notices and timelines, and forgets a closed agent', () => {
    const store = new SignalStore();
    let changes = 0;
    store.subscribe(() => changes++);
    const first = store.getSnapshot();

    expect(store.apply({ type: 'agentTrouble', id: 1, level: 'fire', failures: 1 })).toBe(true);
    expect(store.apply({ type: 'agentLoop', id: 1, looping: true, reason: 'stall' })).toBe(true);
    expect(store.apply({ ...tokens() })).toBe(true);
    expect(
      store.apply({
        type: 'noticeBoard',
        items: [{ kind: 'pr', title: 'T', repo: 'a/b', url: 'https://x' }],
      }),
    ).toBe(true);
    expect(
      store.apply({ type: 'agentTimeline', id: 1, entries: [], prs: [], pushes: 0, activeMs: 0 }),
    ).toBe(true);
    expect(store.apply({ type: 'agentStatus', id: 1, status: 'active' })).toBe(false);

    const s = store.getSnapshot();
    expect(s).not.toBe(first); // a new snapshot per change (useSyncExternalStore)
    expect(s.trouble.get(1)).toEqual({ level: 'fire', failures: 1 });
    expect(s.loops.get(1)).toBe('stall');
    expect(s.tokens?.output).toBe(200_000);
    expect(s.notices).toHaveLength(1);
    expect(s.timelines.has(1)).toBe(true);
    expect(changes).toBe(5);

    store.apply({ type: 'agentTrouble', id: 1, level: 'none', failures: 0 });
    store.apply({ type: 'agentLoop', id: 1, looping: false });
    expect(store.getSnapshot().trouble.has(1)).toBe(false);
    expect(store.getSnapshot().loops.has(1)).toBe(false);

    store.apply({ type: 'agentTrouble', id: 2, level: 'alarm', failures: 3 });
    // agentClosed is the office's message too: not consumed, but the agent is forgotten.
    expect(store.apply({ type: 'agentClosed', id: 2 })).toBe(false);
    expect(store.getSnapshot().trouble.has(2)).toBe(false);
  });
});

describe('token meter text', () => {
  it('formats counts and dollars compactly', () => {
    expect([950, 1_234, 1_234_567, 123_456_789, 3.4e9].map(formatTokenCount)).toEqual([
      '950',
      '1.2k',
      '1.2M',
      '123M',
      '3.4B',
    ]);
    expect(formatTokenCount(2_000_000)).toBe('2M');
    expect([3.4, 0.004, 1234.5].map(formatUsd)).toEqual(['$3.40', '<$0.01', '$1,235']);
  });

  it('reads "🔤 1.2M tok · ~$3.40 est." and is always labelled an estimate', () => {
    expect(tokenMeterText(tokens({ estimatedUsd: 3.4 }))).toBe('🔤 1.2M tok · ~$3.40 est.');
    expect(tokenMeterText(tokens({ estimatedUsd: 3.4, partialEstimate: true }))).toBe(
      '🔤 1.2M tok · ~$3.40+ est.',
    );
    expect(tokenMeterText(tokens())).toBe('🔤 1.2M tok');
  });

  it('explains the split per model in the tooltip', () => {
    const title = tokenMeterTitle(
      tokens({
        byModel: {
          'claude-opus-5-5': {
            input: 1,
            output: 1,
            cacheRead: 1_000_000,
            cacheWrite: 0,
            estimatedUsd: 0.2,
          },
          'claude-mystery': { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      }),
    );
    expect(title).toContain('claude-opus-5-5: 1M tok · ~$0.20');
    expect(title).toContain('claude-mystery: 5 tok · no price');
    expect(title).toContain('list prices');
  });
});

describe('timeline card', () => {
  const entry = (at: number, kind: TimelineEntry['kind'], text: string, failed?: boolean) => ({
    at,
    kind,
    text,
    ...(failed ? { failed } : {}),
  });

  it('shows the newest rows first, capped', () => {
    const entries = [1, 2, 3, 4].map((n) => entry(n, 'tool', `t${n}`));
    expect(timelineRows(entries, 3).map((e) => e.text)).toEqual(['t4', 't3', 't2']);
  });

  it('marks failed tools and kinds with icons', () => {
    expect(timelineIcon(entry(0, 'tool', 'x', true))).toBe('❌');
    expect(timelineIcon(entry(0, 'pr', 'x'))).toBe('🏆');
    expect(timelineIcon(entry(0, 'push', 'x'))).toBe('📦');
  });

  it('formats time worked', () => {
    expect(formatWorked(45 * 60_000)).toBe('45m');
    expect(formatWorked(125 * 60_000)).toBe('2h 05m');
  });

  it('sits beside the character, flipping left at the edge and staying inside', () => {
    const base = { containerW: 1000, containerH: 600, cardW: 300, cardH: 200, gap: 20 };
    expect(timelineCardPosition({ ...base, charX: 100, charY: 300 })).toEqual({
      left: 120,
      top: 284,
    });
    expect(timelineCardPosition({ ...base, charX: 900, charY: 300 })).toEqual({
      left: 580,
      top: 284,
    });
    expect(timelineCardPosition({ ...base, charX: 100, charY: 5 }).top).toBe(8);
    expect(timelineCardPosition({ ...base, charX: 100, charY: 590 }).top).toBe(392);
  });
});

describe('signal label', () => {
  const texts = { stuck: 'STUCK', loop: 'LOOP' };
  it('says stuck at the alarm and loop while looping', () => {
    expect(signalLabel(undefined, false, texts)).toBeUndefined();
    expect(signalLabel({ level: 'fire' }, false, texts)).toBeUndefined();
    expect(signalLabel({ level: 'alarm' }, false, texts)).toBe('STUCK');
    expect(signalLabel({ level: 'alarm' }, true, texts)).toBe('STUCK · LOOP');
    expect(signalLabel(undefined, true, texts)).toBe('LOOP');
  });
});

describe('trouble on the desk', () => {
  const seat = (facingDir: Seat['facingDir'], col = 5, row = 5): Seat => ({
    uid: 'chair',
    seatCol: col,
    seatRow: row,
    facingDir,
    assigned: true,
  });

  it('finds the desk the seat faces', () => {
    expect(deskTileFor(seat(Direction.UP))).toEqual({ col: 5, row: 4 });
    expect(deskTileFor(seat(Direction.DOWN))).toEqual({ col: 5, row: 6 });
    expect(deskTileFor(seat(Direction.LEFT))).toEqual({ col: 4, row: 5 });
    expect(deskTileFor(seat(Direction.RIGHT))).toEqual({ col: 6, row: 5 });
  });

  it('animates the fire through its ON frames and blinks the alarm OFF/ON', () => {
    expect(troubleFrame('fire', 0)).toBe('FIRE_ICON_ON_1');
    expect(troubleFrame('fire', FIRE_ICON_FRAME_SEC)).toBe('FIRE_ICON_ON_2');
    expect(troubleFrame('fire', 2 * FIRE_ICON_FRAME_SEC)).toBe('FIRE_ICON_ON_1');
    expect(troubleFrame('alarm', 0)).toBe('ALARM_LAMP_OFF');
    expect(troubleFrame('alarm', ALARM_LAMP_BLINK_SEC)).toBe('ALARM_LAMP_ON');
  });

  it('puts one icon on the desk of each seated agent in trouble, none without a sprite', () => {
    const sprite = Array.from({ length: 16 }, () => Array<string>(16).fill(NOTICE_BOARD_INK));
    const office = {
      characters: new Map([
        [1, { seatId: 'a', isSubagent: false }],
        [2, { seatId: null, isSubagent: false }],
        [-1, { seatId: 'a', isSubagent: true }],
      ]),
      seats: new Map([['a', seat(Direction.UP)]]),
    };
    const trouble = new Map([
      [1, { level: 'fire' as const, failures: 1 }],
      [2, { level: 'alarm' as const, failures: 3 }],
      [-1, { level: 'fire' as const, failures: 1 }],
    ]);
    const out = troubleFurniture(office, trouble, () => sprite, 0);
    expect(out).toHaveLength(1);
    // On the desk tile above the seat, sorted before the seated character.
    expect(out[0].y).toBeLessThan(5 * TILE_SIZE);
    expect(out[0].zY).toBeLessThan(5 * TILE_SIZE + TILE_SIZE / 2);
    expect(troubleFurniture(office, trouble, () => undefined, 0)).toEqual([]);
  });
});

describe('notice board', () => {
  it('writes short lines for the cork', () => {
    expect(
      noticeLines(
        [
          { kind: 'pr', title: 'Fix login', repo: 'acme/web', url: 'https://a' },
          { kind: 'issue', title: 'Crash', repo: 'acme/app', url: 'https://b' },
        ],
        5,
      ),
    ).toEqual(['PR web: Fix login', '# app: Crash']);
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: 'pr' as const,
      title: `${i}`,
      repo: 'a/b',
      url: 'https://c',
    }));
    expect(noticeLines(many, 5)).toHaveLength(5);
  });

  it('finds every board on the layout', () => {
    expect(
      noticeBoardRects(
        [
          { uid: 'nb', type: 'NOTICE_BOARD', col: 11, row: 0 },
          { uid: 'desk', type: 'DESK', col: 1, row: 1 },
        ],
        'NOTICE_BOARD',
      ),
    ).toEqual([{ uid: 'nb', x: 176, y: 0, w: 32, h: 32 }]);
  });
});
