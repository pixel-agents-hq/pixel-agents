/**
 * The Nickname through the `existingAgents` restore (a reload or reconnect):
 * a restored agent gets its Nickname, and an agent the office already shows
 * takes the snapshot's (or loses one the snapshot no longer lists).
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ExistingAgentsOffice, PendingAgent } from '../src/office/engine/existingAgents.js';
import { reconcileExistingAgents } from '../src/office/engine/existingAgents.js';

function fakeOffice(existing: number[] = []): ExistingAgentsOffice & {
  nicknames: Map<number, string | undefined>;
} {
  const ids = new Set(existing);
  const nicknames = new Map<number, string | undefined>();
  return {
    nicknames,
    characters: { has: (id: number) => ids.has(id) },
    addAgent: (id) => {
      ids.add(id);
    },
    setHeadless: () => {},
    syncAgent: () => {},
    restAgent: () => {},
    setAgentNickname: (id, nickname) => {
      nicknames.set(id, nickname);
    },
  };
}

test('a restored agent gets its nickname; one already shown takes the snapshot’s', () => {
  const os = fakeOffice([2]);
  reconcileExistingAgents(os, [1, 2], {}, {}, true, [], {}, {}, { 1: 'reviewer' });
  assert.equal(os.nicknames.get(1), 'reviewer');
  assert.ok(os.nicknames.has(2));
  assert.equal(os.nicknames.get(2), undefined);
});

test('buffered until the layout is ready, the nickname rides with the agent', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];
  reconcileExistingAgents(os, [3], {}, {}, false, pending, {}, {}, { 3: 'scout' });
  assert.equal(pending[0].nickname, 'scout');
});
