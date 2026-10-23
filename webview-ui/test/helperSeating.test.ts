/**
 * Helpers (sub-agents) at their own desk — the "two characters on one desk"
 * fix. A helper used to spawn on the walkable tile closest to its parent and
 * type there, which on a real layout is the parent's own desk. Now it
 * materializes beside the parent and walks to the free seat nearest the
 * parent's seat (seatPlacement.helperSeat), falling back to the old spot only
 * when no seat is free. Seats go back when the helper leaves, and a
 * top-level agent that finds the office full takes a helper's seat — agents
 * outrank helpers.
 *
 * Like teammateSeating / greeter, this pins the OfficeState domain model
 * (seat bookkeeping e2e can't observe), not UI internals.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { helperSeat } from '../src/office/engine/seatPlacement.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, MATRIX_EFFECT_DURATION, TileType } from '../src/office/types.js';

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

const chairAt = (uid: string, col: number, row: number): PlacedFurniture => ({
  uid,
  type: 'CHAIR',
  col,
  row,
});

/** An open floor with chairs — every seat reachable. */
function office(chairs: PlacedFurniture[], cols = 14, rows = 9): OfficeState {
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: chairs,
  };
  return new OfficeState(layout);
}

/** Simulate `seconds` of game time in small steps. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) os.update(0.05);
}

const PARENT = 1;

/** The parent seated at `p` (2,2); free seats near (4,2), mid (8,2), far (12,7). */
function busyOffice(): OfficeState {
  const os = office([
    chairAt('p', 2, 2),
    chairAt('near', 4, 2),
    chairAt('mid', 8, 2),
    chairAt('far', 12, 7),
  ]);
  os.addAgent(PARENT, 0, 0, 'p', true);
  return os;
}

describe('a helper gets a desk of its own', () => {
  it('takes the free seat nearest its parent, not a spot at the parent desk', () => {
    const os = busyOffice();
    const id = os.addSubagent(PARENT, 'tool-a');
    const helper = os.characters.get(id)!;
    expect(helper.seatId).toBe('near');
    expect(os.seats.get('near')!.assigned).toBe(true);
    // The parent keeps its own seat.
    expect(os.characters.get(PARENT)!.seatId).toBe('p');
  });

  it('materializes beside the parent, then walks over and types at that seat', () => {
    const os = busyOffice();
    const helper = os.characters.get(os.addSubagent(PARENT, 'tool-a'))!;
    const parent = os.characters.get(PARENT)!;
    expect(helper.matrixEffect).toBe('spawn');
    expect(
      Math.abs(helper.tileCol - parent.tileCol) + Math.abs(helper.tileRow - parent.tileRow),
    ).toBe(1);
    expect(helper.state).toBe(CharacterState.WALK);

    run(os, MATRIX_EFFECT_DURATION + 3);
    const seat = os.seats.get('near')!;
    expect([helper.tileCol, helper.tileRow]).toEqual([seat.seatCol, seat.seatRow]);
    expect(helper.state).toBe(CharacterState.TYPE);
    expect(helper.dir).toBe(seat.facingDir);
  });

  it('each further helper takes the next-nearest free seat', () => {
    const os = busyOffice();
    const a = os.characters.get(os.addSubagent(PARENT, 'tool-a'))!;
    const b = os.characters.get(os.addSubagent(PARENT, 'tool-b'))!;
    const c = os.characters.get(os.addSubagent(PARENT, 'tool-c'))!;
    expect([a.seatId, b.seatId, c.seatId]).toEqual(['near', 'mid', 'far']);
  });

  it('with no seat free, falls back to standing beside the parent and typing there', () => {
    const os = office([chairAt('p', 2, 2)]);
    os.addAgent(PARENT, 0, 0, 'p', true);
    const helper = os.characters.get(os.addSubagent(PARENT, 'tool-a'))!;
    expect(helper.seatId).toBeNull();
    expect(Math.abs(helper.tileCol - 2) + Math.abs(helper.tileRow - 2)).toBe(1);
    run(os, MATRIX_EFFECT_DURATION + 1);
    expect(helper.state).toBe(CharacterState.TYPE);
    expect(Math.abs(helper.tileCol - 2) + Math.abs(helper.tileRow - 2)).toBe(1);
  });

  it('frees its seat when it is removed, and the next helper can take it', () => {
    const os = busyOffice();
    os.addSubagent(PARENT, 'tool-a');
    expect(os.seats.get('near')!.assigned).toBe(true);
    os.removeSubagent(PARENT, 'tool-a');
    expect(os.seats.get('near')!.assigned).toBe(false);
    const next = os.characters.get(os.addSubagent(PARENT, 'tool-b'))!;
    expect(next.seatId).toBe('near');
  });

  it('frees every helper seat when the parent closes its helpers at once', () => {
    const os = busyOffice();
    os.addSubagent(PARENT, 'tool-a');
    os.addSubagent(PARENT, 'tool-b');
    os.removeAllSubagents(PARENT);
    expect(['near', 'mid'].map((s) => os.seats.get(s)!.assigned)).toEqual([false, false]);
  });

  it('is idempotent: re-adding the same helper keeps one character and one seat', () => {
    const os = busyOffice();
    const first = os.addSubagent(PARENT, 'tool-a');
    expect(os.addSubagent(PARENT, 'tool-a')).toBe(first);
    expect([...os.seats.values()].filter((s) => s.assigned).length).toBe(2); // parent + helper
  });

  it('never persists a helper seat (sub-agents are derived state)', () => {
    const os = busyOffice();
    os.addSubagent(PARENT, 'tool-a');
    expect(Object.keys(os.getPersistableSeats())).toEqual([String(PARENT)]);
  });
});

describe('agents outrank helpers', () => {
  it('an agent arriving to a full office takes a helper seat; the helper moves beside its parent', () => {
    const os = office([chairAt('p', 2, 2), chairAt('near', 4, 2)]);
    os.addAgent(PARENT, 0, 0, 'p', true);
    const helper = os.characters.get(os.addSubagent(PARENT, 'tool-a'))!;
    run(os, MATRIX_EFFECT_DURATION + 3); // helper seated at 'near'
    expect(helper.seatId).toBe('near');

    os.addAgent(2, 1, 0, undefined, true);
    const agent = os.characters.get(2)!;
    expect(agent.seatId).toBe('near');
    expect(os.seats.get('near')!.assigned).toBe(true);
    expect(helper.seatId).toBeNull();

    run(os, 3);
    expect([helper.tileCol, helper.tileRow]).not.toEqual([4, 2]);
    expect(Math.abs(helper.tileCol - 2) + Math.abs(helper.tileRow - 2)).toBe(1);
  });

  it('a restored agent gets its own seat back from a helper, which moves to another free seat', () => {
    const os = busyOffice();
    const helper = os.characters.get(os.addSubagent(PARENT, 'tool-a'))!;
    expect(helper.seatId).toBe('near');

    os.addAgent(2, 1, 0, 'near', true); // its persisted seat
    expect(os.characters.get(2)!.seatId).toBe('near');
    expect(helper.seatId).toBe('mid');
    expect(os.seats.get('mid')!.assigned).toBe(true);
    expect([...os.seats.values()].filter((s) => s.assigned).length).toBe(3);
  });

  it('a layout rebuild seats agents before helpers', () => {
    const os = busyOffice();
    os.addSubagent(PARENT, 'tool-a');
    os.addAgent(2, 1, 0, 'mid', true);
    // Shrink to two chairs, neither one anybody's: the agents get them.
    os.rebuildFromLayout({
      ...os.getLayout(),
      furniture: [chairAt('x', 6, 6), chairAt('y', 9, 6)],
    });
    const seated = [...os.characters.values()].filter((ch) => ch.seatId !== null);
    expect(seated.map((ch) => ch.id).sort()).toEqual([PARENT, 2]);
  });
});

describe('helperSeat', () => {
  it('is null for an unknown parent, and the nearest free seat to its seat otherwise', () => {
    const seats = new Map([
      ['p', { seatCol: 2, seatRow: 2, assigned: true }],
      ['a', { seatCol: 9, seatRow: 2, assigned: false }],
      ['b', { seatCol: 3, seatRow: 3, assigned: false }],
    ]);
    expect(helperSeat(undefined, seats)).toBeNull();
    // Anchored to the parent's SEAT, not where it is standing right now.
    expect(helperSeat({ seatId: 'p', tileCol: 9, tileRow: 3 }, seats)).toBe('b');
    seats.get('b')!.assigned = true;
    seats.get('a')!.assigned = true;
    expect(helperSeat({ seatId: 'p', tileCol: 2, tileRow: 2 }, seats)).toBeNull();
  });
});
