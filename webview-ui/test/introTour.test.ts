/**
 * Unit tests for the Intro tour's wire-facing state machine
 * (src/hooks/introTourState.ts) — the pure reducer useIntroTour drives.
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * like greeter.test.ts, this covers DOMAIN invariants e2e can barely observe:
 * which asks survive being mooted, when a hooksStatus arrival is this tour's
 * install verdict and when it is noise, and what a revised choice resets.
 * Every one of them is a race with the server that a spec would have to
 * choreograph through timing; here each is one event applied to one state.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { IntroTourState } from '../src/hooks/introTourState.js';
import { INTRO_TOUR_IDLE, reduceIntroTour } from '../src/hooks/introTourState.js';

const REQUEST = {
  type: 'hooksConsentRequest',
  providerId: 'claude',
  headline: 'One more thing: hooks!',
  disclosure: 'What is written.\n\nWhat moves.\n\nHow to undo.',
} as const;

/** Fold a sequence of events over the idle state. */
function play(...events: Parameters<typeof reduceIntroTour>[1][]): IntroTourState {
  return events.reduce(reduceIntroTour, INTRO_TOUR_IDLE);
}

test('a request opens the tour with the server copy snapshotted', () => {
  const state = play({ kind: 'requestChanged', request: REQUEST });
  assert.equal(state.intro, REQUEST);
  assert.equal(state.installFailed, false);
});

test('an UNANSWERED tour follows the request back to null (cross-window install mooted it)', () => {
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'requestChanged', request: null },
  );
  assert.equal(state.intro, null);
});

test('an ANSWERED tour keeps its snapshot when its own answer moots the request', () => {
  // The install's hooksStatus clears the live request; the closing step must
  // still render.
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'requestChanged', request: null },
  );
  assert.equal(state.intro, REQUEST);
});

test('a status arriving with no wait armed is noise, not a verdict', () => {
  // The handshake's initial hooksStatus (installed=false) arrives before any
  // choice; it must not read as a failed install.
  const opened = play({ kind: 'requestChanged', request: REQUEST });
  const after = reduceIntroTour(opened, {
    kind: 'statusArrived',
    providerId: 'claude',
    installed: false,
  });
  assert.equal(after, opened, 'no-op events return the same state reference');
});

test('a failed install is detected by ARRIVAL, not by the value changing', () => {
  // The load-bearing case: installed was false before the click and the
  // failed install re-reports the same false. Only the arrival can settle it.
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'statusArrived', providerId: 'claude', installed: false },
  );
  assert.equal(state.installFailed, true);
});

test('a landed install reports no failure', () => {
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'statusArrived', providerId: 'claude', installed: true },
  );
  assert.equal(state.installFailed, false);
});

test('declines never arm the verdict wait', () => {
  // never/notNow can trigger a hooksStatus of their own (the revert and
  // persist-off paths report); it is not an install verdict.
  for (const choice of ['notNow', 'never'] as const) {
    const state = play(
      { kind: 'requestChanged', request: REQUEST },
      { kind: 'choiceSent', choice },
      { kind: 'statusArrived', providerId: 'claude', installed: false },
    );
    assert.equal(state.installFailed, false, `${choice} must not read a status as a verdict`);
  }
});

test('the pending window is exactly install-click to verdict-arrival', () => {
  // The consent step HOLDS off awaitingOutcome (useIntroTour's
  // installPending) — buttons disabled, Install reading "Installing..." — and
  // advances to the closing step when the window closes, so that step only
  // ever renders with a verdict. Advancing on the click flashed a verdict the
  // tour did not yet have.
  const armed = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
  );
  assert.equal(armed.awaitingOutcome, true, 'install opens the pending window');
  assert.equal(armed.installFailed, false, 'no verdict is claimed while pending');

  const settled = reduceIntroTour(armed, {
    kind: 'statusArrived',
    providerId: 'claude',
    installed: false,
  });
  assert.equal(settled.awaitingOutcome, false, 'the verdict closes the window');

  // A decline has no outcome to wait on — it must never hold the step.
  for (const choice of ['notNow', 'never'] as const) {
    const declined = play(
      { kind: 'requestChanged', request: REQUEST },
      { kind: 'choiceSent', choice },
    );
    assert.equal(declined.awaitingOutcome, false, `${choice} must not hold the consent step`);
  }
});

test('a Back-and-revised choice clears the earlier verdict', () => {
  // Install fails, the user walks Back and picks Not Now: the failure banner
  // must not survive onto the revised answer's closing step.
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'statusArrived', providerId: 'claude', installed: false },
    { kind: 'choiceSent', choice: 'notNow' },
  );
  assert.equal(state.installFailed, false);
});

test('the verdict settles on the FIRST arrival after the click', () => {
  // Pinned from the pre-extraction behavior: the verdict is about the tour's
  // own click. A later status (say, a Settings toggle succeeding in another
  // tab) does not rewrite it — the wait disarmed on the first arrival.
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'statusArrived', providerId: 'claude', installed: false },
    { kind: 'statusArrived', providerId: 'claude', installed: true },
  );
  assert.equal(state.installFailed, true);
});

test('closing resets everything, so the next request starts a fresh tour', () => {
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'statusArrived', providerId: 'claude', installed: false },
    { kind: 'closed' },
  );
  assert.deepEqual(state, INTRO_TOUR_IDLE);

  const reopened = reduceIntroTour(state, { kind: 'requestChanged', request: REQUEST });
  assert.equal(reopened.intro, REQUEST);
  assert.equal(reopened.installFailed, false);
});

test("another provider's status is noise, never this tour's verdict", () => {
  // The tour asked about claude; a copilot install failing (or landing) in
  // parallel says nothing about THIS install. Without the provider check, the
  // first arrival of any status would settle a verdict about the wrong write.
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'statusArrived', providerId: 'copilot', installed: false },
  );
  assert.equal(state.installFailed, false, 'the wait stays armed');

  const settled = reduceIntroTour(state, {
    kind: 'statusArrived',
    providerId: 'claude',
    installed: true,
  });
  assert.equal(settled.installFailed, false, "this tour's own status settles it");
});

test("a different provider's request replaces an UNANSWERED tour as a fresh one", () => {
  // Nothing of the first provider's tour may leak into the second: an
  // inherited armed wait would read the new provider's first status as a
  // verdict on an install that tour never sent.
  const OTHER = { ...REQUEST, providerId: 'copilot' } as const;
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'requestChanged', request: OTHER },
  );
  assert.equal(state.intro, OTHER);
  assert.equal(state.sentChoice, null);
  assert.equal(state.awaitingOutcome, false);
  assert.equal(state.installFailed, false);
});

test("an ANSWERED tour holds its snapshot against a different provider's request", () => {
  // The closing step (and its verdict) belongs to the person who just
  // answered; the queued ask is re-delivered by the driver once this tour
  // closes, not by yanking the closing step.
  const OTHER = { ...REQUEST, providerId: 'copilot' } as const;
  const state = play(
    { kind: 'requestChanged', request: REQUEST },
    { kind: 'choiceSent', choice: 'install' },
    { kind: 'requestChanged', request: OTHER },
  );
  assert.equal(state.intro, REQUEST, 'the answered tour keeps its own snapshot');
  assert.equal(state.awaitingOutcome, true, 'its verdict wait survives');
});
