/**
 * Sleeping agents (agentSleep): a session that is open but idle. The office
 * keeps the flag by agent id — the message can land before the character
 * exists — and a sleeping character stays in its seat, still, instead of
 * wandering the office, until it wakes (which takes effect immediately).
 * The dimmed rendering and the "💤 idle 3h" label read the same flag.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';
import { formatIdle, sleepLabel } from '../src/progress/progressFormat.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

beforeAll(() => {
  const chair: CatalogAsset = {
    id: 'CHAIR',
    label: 'Chair',
    category: 'chairs',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
  };
  expect(buildDynamicCatalog({ catalog: [chair], sprites: { CHAIR: [['']] } })).toBe(true);
});

function office(): OfficeState {
  const cols = 12;
  const rows = 9;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [{ uid: 'seat', type: 'CHAIR', col: 5, row: 4 }],
  };
  return new OfficeState(layout);
}

function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.1) os.update(0.1);
}

const ID = 3;

/** A seated agent whose turn has just ended (inactive, about to stand up). */
function idleAgent(): OfficeState {
  const os = office();
  os.addAgent(ID, 0, 0, 'seat', true);
  os.setAgentActive(ID, false);
  return os;
}

describe('a sleeping agent', () => {
  it('stays in its seat, still, for as long as it sleeps', () => {
    const os = idleAgent();
    os.setAgentSleeping(ID, true);
    const ch = os.characters.get(ID)!;
    const frame = ch.frame;
    run(os, 600); // ten minutes: far past every seat rest and wander timer
    expect([ch.tileCol, ch.tileRow]).toEqual([5, 4]);
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.frame).toBe(frame); // no typing animation while asleep
    expect(ch.path).toEqual([]);
  });

  it('wakes immediately: the next frames stand it up like any idle agent', () => {
    const os = idleAgent();
    os.setAgentSleeping(ID, true);
    run(os, 60);
    os.setAgentSleeping(ID, false);
    const ch = os.characters.get(ID)!;
    expect(ch.isSleeping).toBe(false);
    run(os, 0.2);
    expect(ch.state).not.toBe(CharacterState.TYPE);
  });

  it('heads back to its seat when it falls asleep mid-wander', () => {
    const os = idleAgent();
    const ch = os.characters.get(ID)!;
    // Let it get up and wander off the seat.
    for (let i = 0; i < 6000 && ch.tileCol === 5 && ch.tileRow === 4; i++) os.update(0.1);
    expect([ch.tileCol, ch.tileRow]).not.toEqual([5, 4]);

    os.setAgentSleeping(ID, true);
    run(os, 30);
    expect([ch.tileCol, ch.tileRow]).toEqual([5, 4]);
    expect(ch.state).toBe(CharacterState.TYPE);
  });

  it('starting work outranks sleep: an active sleeper types as usual', () => {
    const os = idleAgent();
    os.setAgentSleeping(ID, true);
    os.setAgentActive(ID, true);
    const ch = os.characters.get(ID)!;
    const frames = new Set<number>();
    for (let i = 0; i < 20; i++) {
      os.update(0.1);
      frames.add(ch.frame);
    }
    expect(frames.size).toBeGreaterThan(1);
  });

  it('a sleep that arrives before the character applies when it is created', () => {
    const os = office();
    os.setAgentSleeping(ID, true);
    os.addAgent(ID, 0, 0, 'seat', true);
    expect(os.characters.get(ID)!.isSleeping).toBe(true);
    // ...and a wake before creation leaves nothing behind.
    os.setAgentSleeping(9, true);
    os.setAgentSleeping(9, false);
    os.addAgent(9, 1, 0, undefined, true);
    expect(os.characters.get(9)!.isSleeping).toBeFalsy();
  });
});

describe('the sleeping label', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it('formats idle time coarsely: <1m, minutes, hours, days', () => {
    expect(formatIdle(0)).toBe('<1m');
    expect(formatIdle(59_999)).toBe('<1m');
    expect(formatIdle(MIN)).toBe('1m');
    expect(formatIdle(59 * MIN + 59_000)).toBe('59m');
    expect(formatIdle(HOUR)).toBe('1h');
    expect(formatIdle(3 * HOUR + 59 * MIN)).toBe('3h');
    expect(formatIdle(23 * HOUR + 59 * MIN)).toBe('23h');
    expect(formatIdle(49 * HOUR)).toBe('2d');
    expect(formatIdle(-5 * MIN)).toBe('<1m'); // a viewer clock behind the server's
  });

  it('reads "💤 idle 3h", or plain "💤 idle" without idleSince', () => {
    const now = 1_000_000_000;
    expect(sleepLabel(now - 3 * HOUR - 10 * MIN, now)).toBe('💤 idle 3h');
    expect(sleepLabel(undefined, now)).toBe('💤 idle');
  });
});
