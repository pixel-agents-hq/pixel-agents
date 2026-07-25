/**
 * Regression test for the flaky `expectTeammateSeatedNextToLead` e2e assertion
 * (hooks-on/teams.spec.ts "new-harness background agent becomes a named
 * teammate character"), which failed on the CI Windows/macOS runners.
 *
 * A teammate is seated at the free seat closest to its lead. Placement used the
 * lead's LIVE tile position, but the lead is assigned its seat at creation and
 * may still be walking toward it when the teammate is placed. Anchoring off the
 * transient walking position let a closer free seat open up once the lead landed
 * — the exact race the e2e seat invariant flags, and one that only loses on
 * slower runners where the walk is still in progress at placement time.
 *
 * The fix (seatPlacement.anchorTile) anchors to the lead's SEAT, stable from
 * creation. These tests reproduce the "lead mid-walk" condition deterministically:
 * the first would fail if placement anchored to the live tile.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { AnchorLike, SeatLike } from '../src/office/engine/seatPlacement.js';
import { anchorTile, closestFreeSeat } from '../src/office/engine/seatPlacement.js';

function seat(seatCol: number, seatRow: number, assigned = false): SeatLike {
  return { seatCol, seatRow, assigned };
}

// Lead seat at (10,5); a near free seat one tile away (the correct choice); a far
// seat at the bottom of the grid closest to where the lead currently *stands*
// (10,19) while it walks up to its seat.
function scenarioSeats(): Map<string, SeatLike> {
  return new Map<string, SeatLike>([
    ['lead-seat', seat(10, 5, true)],
    ['near-seat', seat(11, 5)], // dist 1 from lead SEAT, dist 14 from live tile
    ['far-seat', seat(10, 18)], // dist 13 from lead SEAT, dist 1 from live tile
  ]);
}

// The lead, seated but still walking: seatId points at its final seat while its
// live tile is still down at the spawn point.
const walkingLead: AnchorLike = { seatId: 'lead-seat', tileCol: 10, tileRow: 19 };

test('teammate anchors to the lead SEAT, so it takes the seat closest to the seat', () => {
  const seats = scenarioSeats();
  const anchor = anchorTile(walkingLead, seats);
  assert.deepEqual(anchor, { col: 10, row: 5 }, 'anchor is the lead seat, not the walking tile');

  const chosen = closestFreeSeat(seats, anchor!.col, anchor!.row);
  assert.equal(chosen, 'near-seat');

  // The exact invariant the e2e helper checks: no still-free seat may be strictly
  // closer to the lead's seat than the teammate's own seat.
  seats.get(chosen!)!.assigned = true;
  const leadSeat = seats.get('lead-seat')!;
  const dist = (s: SeatLike): number =>
    Math.abs(s.seatCol - leadSeat.seatCol) + Math.abs(s.seatRow - leadSeat.seatRow);
  const teammateDist = dist(seats.get(chosen!)!);
  const closer = [...seats.values()].find((s) => !s.assigned && dist(s) < teammateDist);
  assert.equal(closer, undefined, 'no free seat may be closer to the lead than the teammate');
});

test('anchoring to the live tile (the old behavior) would pick the wrong, far seat', () => {
  // Guards against a regression back to live-position anchoring: from the walking
  // tile the far seat is closest, which is exactly what produced the flake.
  const seats = scenarioSeats();
  const wrong = closestFreeSeat(seats, walkingLead.tileCol, walkingLead.tileRow);
  assert.equal(wrong, 'far-seat');
  assert.notEqual(wrong, closestFreeSeat(seats, 10, 5));
});

test('falls back to the live tile when the lead has no seat yet', () => {
  const seats = scenarioSeats();
  const seatlessLead: AnchorLike = { seatId: null, tileCol: 10, tileRow: 19 };
  assert.deepEqual(anchorTile(seatlessLead, seats), { col: 10, row: 19 });
});

test('no anchor yields undefined (non-teammate agents keep default seating)', () => {
  assert.equal(anchorTile(undefined, scenarioSeats()), undefined);
});
