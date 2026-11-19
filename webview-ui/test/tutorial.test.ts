/**
 * The tutorial's webview rules, pure: the Intro's one-step ask → start
 * flow (src/tutorial/tutorialOffer.ts) and the store's reading of the
 * server's messages (src/tutorial/tutorialStore.ts). Each is a race or a gate
 * a spec could only reach by timing; here it is one event on one state.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  reduceTutorialOffer,
  TUTORIAL_OFFER_START,
  tutorialOffered,
  type TutorialOfferEvent,
  type TutorialOfferState,
} from '../src/tutorial/tutorialOffer.js';
import {
  handleTutorialMessage,
  resetTutorialStoreForTests,
  tutorialEntry,
} from '../src/tutorial/tutorialStore.js';

function play(...events: TutorialOfferEvent[]): TutorialOfferState {
  return events.reduce(reduceTutorialOffer, TUTORIAL_OFFER_START);
}

test('one ask: confirming starts, and only the ask can be confirmed', () => {
  assert.equal(TUTORIAL_OFFER_START.step, 'ask');
  assert.equal(play({ kind: 'confirm' }).step, 'starting');
  assert.equal(play({ kind: 'confirm' }, { kind: 'confirm' }).step, 'starting');
});

test('a failure goes back to the ask on retry; a start under way does not', () => {
  assert.equal(play({ kind: 'confirm' }, { kind: 'retry' }).step, 'starting');
  const failed = play({ kind: 'confirm' }, { kind: 'rejected', reason: 'no' });
  assert.deepEqual(failed, { step: 'failed', reason: 'no' });
  assert.deepEqual(reduceTutorialOffer(failed, { kind: 'retry' }), TUTORIAL_OFFER_START);
});

test('only a start under way is settled by a run, or by a refusal', () => {
  // A run another office started, or a stale refusal, does not move an unanswered ask.
  assert.equal(play({ kind: 'status', running: true }).step, 'ask');
  assert.equal(play({ kind: 'rejected', reason: 'x' }).step, 'ask');
  const starting = play({ kind: 'confirm' });
  assert.equal(reduceTutorialOffer(starting, { kind: 'status', running: false }).step, 'starting');
  assert.equal(reduceTutorialOffer(starting, { kind: 'status', running: true }).step, 'started');
});

test('offered only while the server can start one and none runs', () => {
  assert.equal(tutorialOffered(undefined), false);
  assert.equal(tutorialOffered({ available: false }), false);
  assert.equal(tutorialOffered({ available: true }), true);
  assert.equal(tutorialOffered({ available: true, run: {} }), false);
});

beforeEach(() => resetTutorialStoreForTests());

test('the store keeps the latest status and numbers every refusal', () => {
  assert.equal(handleTutorialMessage({ type: 'agentStatus' }), false);
  const status = { type: 'tutorialStatus', available: true, headline: 'h', disclosure: 'd' };
  assert.equal(handleTutorialMessage(status), true);
  assert.equal(tutorialEntry().status, status as never);
  handleTutorialMessage({ type: 'tutorialRejected', reason: 'busy' });
  handleTutorialMessage({ type: 'tutorialRejected', reason: 'busy' });
  assert.deepEqual(tutorialEntry().rejected, { reason: 'busy', seq: 2 });
  // A malformed status is taken (it is one) but changes nothing.
  assert.equal(handleTutorialMessage({ type: 'tutorialStatus', available: 'yes' }), true);
  assert.equal(tutorialEntry().status, status as never);
});
