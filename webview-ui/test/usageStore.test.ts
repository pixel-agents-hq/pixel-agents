/**
 * Unit tests for usageStore: which messages it takes, and that a request is
 * answered by the next usageBridgeStatus ARRIVAL — even one carrying the same
 * value (a failed install re-reports what was already held).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  awaitingAnswer,
  handleUsageMessage,
  resetUsageStoreForTests,
  usageEntry,
} from '../src/usage/usageStore.js';

const status = (installed: boolean, error?: string) => ({
  type: 'usageBridgeStatus',
  providerId: 'claude',
  installed,
  disclosure: 'd',
  ...(error ? { error } : {}),
});

beforeEach(() => resetUsageStoreForTests());

test('a status is kept per provider and counts as an arrival', () => {
  assert.equal(handleUsageMessage(status(false)), true);
  const entry = usageEntry('claude');
  assert.equal(entry.status?.installed, false);
  assert.equal(entry.seq, 1);
  assert.equal(usageEntry('other').seq, 0);
});

test('malformed usage messages are consumed but change nothing', () => {
  assert.equal(handleUsageMessage({ type: 'usageBridgeStatus', providerId: 'claude' }), true);
  assert.equal(handleUsageMessage({ type: 'usageLimits', providerId: 3 }), true);
  assert.deepEqual(usageEntry('claude'), { seq: 0 });
});

test('other messages are not usage messages', () => {
  assert.equal(handleUsageMessage({ type: 'hooksStatus', installed: true }), false);
});

test('limits are kept beside the status and do not count as an arrival', () => {
  handleUsageMessage(status(true));
  handleUsageMessage({ type: 'usageLimits', providerId: 'claude', updatedAt: 5 });
  const entry = usageEntry('claude');
  assert.equal(entry.limits?.updatedAt, 5);
  assert.equal(entry.status?.installed, true);
  assert.equal(entry.seq, 1);
});

test('the entry object is stable until a message changes it', () => {
  handleUsageMessage(status(false));
  assert.equal(usageEntry('claude'), usageEntry('claude'));
});

test('a request is pending until the next status arrives, even an equal one', () => {
  handleUsageMessage(status(false));
  const sentAt = usageEntry('claude').seq;
  assert.equal(awaitingAnswer(usageEntry('claude'), null), false);
  assert.equal(awaitingAnswer(usageEntry('claude'), sentAt), true);
  handleUsageMessage({ type: 'usageLimits', providerId: 'claude' });
  assert.equal(awaitingAnswer(usageEntry('claude'), sentAt), true);
  handleUsageMessage(status(false, 'nope'));
  assert.equal(awaitingAnswer(usageEntry('claude'), sentAt), false);
});
