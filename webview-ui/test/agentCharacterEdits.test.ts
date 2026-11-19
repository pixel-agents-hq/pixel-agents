/**
 * Unit tests for agentCharacterEdits: the Characters view's "Undo <agent>'s edit"
 * follows the server's agentCharacterEditStatus, an edit that lands is named in
 * the view's status line ("<agent> created Naruto"), and a refused press says why.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  agentCharacterEditEntry,
  handleAgentCharacterEditMessage,
  resetAgentCharacterEditsForTests,
  statusLineFor,
} from '../src/officeMcp/agentCharacterEdits.js';
import { undoButtonLabel } from '../src/officeMcp/agentEditStatus.js';

beforeEach(() => resetAgentCharacterEditsForTests());

const STATUS = {
  type: 'agentCharacterEditStatus',
  agentId: 3,
  agentName: 'Spike',
  summary: 'created Naruto',
};

test('no status = no button; a status names the agent and what its edit did', () => {
  assert.equal(undoButtonLabel(agentCharacterEditEntry()), null);
  assert.equal(handleAgentCharacterEditMessage(STATUS), true);
  const entry = agentCharacterEditEntry();
  assert.equal(undoButtonLabel(entry), "Undo Spike's edit");
  assert.equal(entry.undoable?.summary, 'created Naruto');
  // A status alone (the connect snapshot, a re-announce) is not news for the status line.
  assert.equal(statusLineFor(entry), null);
  assert.equal(handleAgentCharacterEditMessage({ type: 'agentLayoutEditStatus' }), false);
  handleAgentCharacterEditMessage({ type: 'agentCharacterEditStatus' });
  assert.equal(undoButtonLabel(agentCharacterEditEntry()), null);
});

test('an edit that lands is named in the status line, once per landing', () => {
  handleAgentCharacterEditMessage({ ...STATUS, landed: true });
  const first = agentCharacterEditEntry();
  assert.deepEqual(statusLineFor(first), { text: 'Spike created Naruto', kind: 'ok' });
  // The same words again are a new landing: a new entry, so the view shows it again.
  handleAgentCharacterEditMessage({ ...STATUS, landed: true });
  assert.notEqual(agentCharacterEditEntry(), first);
  assert.deepEqual(statusLineFor(agentCharacterEditEntry()), {
    text: 'Spike created Naruto',
    kind: 'ok',
  });
  // The next plain status keeps the button, not the news.
  handleAgentCharacterEditMessage(STATUS);
  assert.equal(statusLineFor(agentCharacterEditEntry()), null);
});

test('a refused press shows why, as an error, until the next status', () => {
  handleAgentCharacterEditMessage(STATUS);
  handleAgentCharacterEditMessage({
    type: 'agentCharacterEditStatus',
    refused: 'The characters changed since the last agent Character edit',
  });
  const entry = agentCharacterEditEntry();
  assert.equal(entry.undoable, null);
  assert.deepEqual(statusLineFor(entry), {
    text: 'The characters changed since the last agent Character edit',
    kind: 'err',
  });
  handleAgentCharacterEditMessage(STATUS);
  assert.equal(agentCharacterEditEntry().refused, null);
});
