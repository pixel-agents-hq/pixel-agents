/**
 * Unit tests for officeMcpStore: the Intro's Pixel Office MCP ask is a
 * snapshot — kept through the status the office's own answer brings back,
 * dropped when another office answered first — and the settings follow every
 * status.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  dismissOfficeMcpAsk,
  handleOfficeMcpMessage,
  markOfficeMcpAnswered,
  officeMcpEntry,
  resetOfficeMcpStoreForTests,
} from '../src/officeMcp/officeMcpStore.js';

const ask = { type: 'officeMcpConsentRequest', headline: 'h', summary: 's', disclosure: 'd' };
const status = (consent: string, readOnly = false) => ({
  type: 'officeMcpStatus',
  consent,
  readOnly,
  headline: 'h',
  disclosure: 'd',
});

beforeEach(() => resetOfficeMcpStoreForTests());

test('no status = no MCP on this server; a status is kept', () => {
  assert.equal(officeMcpEntry().status, undefined);
  assert.equal(handleOfficeMcpMessage(status('unanswered', true)), true);
  assert.equal(officeMcpEntry().status?.readOnly, true);
  assert.equal(handleOfficeMcpMessage({ type: 'somethingElse' }), false);
});

test("the office's own answer keeps the step until the tour closes", () => {
  handleOfficeMcpMessage(status('unanswered'));
  handleOfficeMcpMessage(ask);
  markOfficeMcpAnswered();
  handleOfficeMcpMessage(status('granted'));
  assert.equal(officeMcpEntry().ask?.headline, 'h');
  // Back and a revised answer: still held.
  handleOfficeMcpMessage(status('declined'));
  assert.notEqual(officeMcpEntry().ask, null);
  dismissOfficeMcpAsk();
  assert.equal(officeMcpEntry().ask, null);
  assert.equal(officeMcpEntry().answered, false);
});

test('an unanswered ask that another office answered is moot', () => {
  handleOfficeMcpMessage(ask);
  handleOfficeMcpMessage(status('declined'));
  assert.equal(officeMcpEntry().ask, null);
});

test('malformed messages are consumed but change nothing', () => {
  assert.equal(handleOfficeMcpMessage({ type: 'officeMcpConsentRequest', headline: 3 }), true);
  assert.equal(handleOfficeMcpMessage({ type: 'officeMcpStatus', consent: 'granted' }), true);
  assert.equal(officeMcpEntry().ask, null);
  assert.equal(officeMcpEntry().status, undefined);
});
