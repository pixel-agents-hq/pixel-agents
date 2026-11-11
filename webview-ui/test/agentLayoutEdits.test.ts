/**
 * Unit tests for agentLayoutEdits: the editor's "Undo <agent>'s edit" follows
 * the server's agentLayoutEditStatus (a refusal shown until the next status),
 * and the office's editing-lock report is sent on change only and again after
 * a reconnect.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import type { ClientMessage } from '../../core/src/messages.js';
import {
  agentLayoutEditEntry,
  createLayoutEditingReporter,
  handleAgentLayoutEditMessage,
  resetAgentLayoutEditsForTests,
  undoButtonLabel,
} from '../src/officeMcp/agentLayoutEdits.js';
import { createEditingReporter } from '../src/officeMcp/editingReporter.js';

beforeEach(() => resetAgentLayoutEditsForTests());

test('no status = no button; a status names the agent whose edit undo reverts', () => {
  assert.equal(undoButtonLabel(agentLayoutEditEntry()), null);
  assert.equal(
    handleAgentLayoutEditMessage({ type: 'agentLayoutEditStatus', agentId: 3, agentName: 'api' }),
    true,
  );
  assert.equal(undoButtonLabel(agentLayoutEditEntry()), "Undo api's edit");
  assert.equal(handleAgentLayoutEditMessage({ type: 'layoutLoaded' }), false);
  // Nothing left to undo (undone, or the layout changed since): the button goes.
  handleAgentLayoutEditMessage({ type: 'agentLayoutEditStatus' });
  assert.equal(undoButtonLabel(agentLayoutEditEntry()), null);
});

test('a refused press shows why until the next status', () => {
  handleAgentLayoutEditMessage({
    type: 'agentLayoutEditStatus',
    refused: 'The layout changed since the last agent edit',
  });
  assert.match(agentLayoutEditEntry().refused ?? '', /changed since/);
  assert.equal(agentLayoutEditEntry().undoable, null);
  handleAgentLayoutEditMessage({ type: 'agentLayoutEditStatus', agentId: 4, agentName: 'web' });
  assert.equal(agentLayoutEditEntry().refused, null);
});

test('the editing lock is reported on change only, and re-sent dirty after a reconnect', () => {
  const sent: ClientMessage[] = [];
  const reporter = createLayoutEditingReporter((m) => sent.push(m));
  reporter.report(false);
  reporter.reconnected();
  assert.deepEqual(sent, []);
  reporter.report(true);
  reporter.report(true);
  reporter.reconnected();
  reporter.report(false);
  reporter.reconnected();
  assert.deepEqual(sent, [
    { type: 'layoutEditing', dirty: true },
    { type: 'layoutEditing', dirty: true },
    { type: 'layoutEditing', dirty: false },
  ]);
});

test("the Characters view's lock reports as charactersEditing, on change only and after a reconnect", () => {
  const sent: ClientMessage[] = [];
  const reporter = createEditingReporter('charactersEditing', (m) => sent.push(m));
  reporter.report(true);
  reporter.report(true);
  reporter.reconnected();
  reporter.report(false);
  assert.deepEqual(sent, [
    { type: 'charactersEditing', dirty: true },
    { type: 'charactersEditing', dirty: true },
    { type: 'charactersEditing', dirty: false },
  ]);
});
