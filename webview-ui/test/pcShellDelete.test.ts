/**
 * Deleting a PC is closing its shell (pcShells/closingShells.ts): the shells of
 * the pieces being deleted are closed one at a time, each asking its usual
 * question while a command runs, and the delete runs once none is live. Keep
 * Running calls it off.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { ClosingShells } from '../src/pcShells/closingShells.js';

function setup() {
  const asked: number[] = [];
  let deleted = 0;
  const closing = new ClosingShells((id) => asked.push(id));
  return { asked, closing, deleted: () => deleted, then: () => void deleted++ };
}
const live = (...ids: number[]) => new Set(ids);

test('with no live shell the delete runs at once and nothing is asked', () => {
  const t = setup();
  t.closing.start([], t.then);
  t.closing.advance(live(), null);
  assert.equal(t.deleted(), 1);
  assert.deepEqual(t.asked, []);
  assert.equal(t.closing.active, false);
});

test('idle shells are closed one at a time, then the delete runs', () => {
  const t = setup();
  t.closing.start([1, 2], t.then);
  t.closing.advance(live(1, 2), null);
  assert.deepEqual(t.asked, [1]);
  t.closing.advance(live(2), null);
  assert.deepEqual(t.asked, [1, 2]);
  assert.equal(t.deleted(), 0);
  t.closing.advance(live(), null);
  assert.equal(t.deleted(), 1);
});

test('a running command asks first: it is not asked again while its question shows', () => {
  const t = setup();
  t.closing.start([1], t.then);
  t.closing.advance(live(1), null);
  // The question came back; another list arrives meanwhile.
  t.closing.advance(live(1, 7), 1);
  assert.deepEqual(t.asked, [1]);
  // Close Shell: the shell goes, the delete runs.
  t.closing.advance(live(7), null);
  assert.equal(t.deleted(), 1);
});

test('Keep Running calls the delete off, for good', () => {
  const t = setup();
  t.closing.start([1], t.then);
  t.closing.advance(live(1), null);
  t.closing.cancel();
  assert.equal(t.closing.active, false);
  // The shell ending later on its own deletes nothing.
  t.closing.advance(live(), null);
  assert.equal(t.deleted(), 0);
});
