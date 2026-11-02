/**
 * Role Areas: an `inbox` Area is where agents that need the user go and wait;
 * a `meeting` Area is where a lead's finished sub-agents gather once the lead
 * has had at least MEETING_MIN_SUBAGENTS helpers in a turn.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { AREA_DEFAULT_COLORS, MEETING_MIN_SUBAGENTS } from '../src/constants.js';
import { updateAreaRole } from '../src/office/editor/editorActions.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { setProviderCapabilities } from '../src/office/toolUtils.js';
import type { Character, OfficeLayout } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';

// The webview learns the provider's tool taxonomy from providerCapabilities.
setProviderCapabilities({
  readingTools: [],
  subagentToolNames: ['Agent'],
  inputRequestTools: ['AskUserQuestion'],
});

const COLS = 12;
const ROWS = 6;

/** All-floor layout: meeting room in cols 0-2, inbox in cols 9-11. */
function roleLayout(withRoles = true): OfficeLayout {
  const areaTiles: Array<string | null> = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      areaTiles.push(col <= 2 ? 'Meeting' : col >= 9 ? 'Inbox' : null);
    }
  }
  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles: new Array<TileType>(COLS * ROWS).fill(TileType.FLOOR_1),
    furniture: [],
    areas: [
      {
        label: 'Meeting',
        color: AREA_DEFAULT_COLORS[3],
        ...(withRoles ? { role: 'meeting' as const } : {}),
      },
      {
        label: 'Inbox',
        color: AREA_DEFAULT_COLORS[1],
        ...(withRoles ? { role: 'inbox' as const } : {}),
      },
    ],
    areaTiles,
  };
}

function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 0.05) os.update(0.05);
}

function areaOf(ch: Character): string | null {
  if (ch.tileCol <= 2) return 'Meeting';
  if (ch.tileCol >= 9) return 'Inbox';
  return null;
}

function newOffice(withRoles = true): { os: OfficeState; lead: Character } {
  const os = new OfficeState(roleLayout(withRoles));
  os.addAgent(1, 0, 0, undefined, true);
  const lead = os.characters.get(1)!;
  lead.tileCol = 5;
  lead.tileRow = 2;
  lead.x = 5 * 16 + 8;
  lead.y = 2 * 16 + 8;
  return { os, lead };
}

test('a permission prompt walks the agent to the inbox, where it waits', () => {
  const { os, lead } = newOffice();
  os.showPermissionBubble(1);
  run(os, 20);
  assert.equal(areaOf(lead), 'Inbox');
  assert.equal(lead.holdInArea, true);
  assert.notEqual(lead.state, CharacterState.WALK, 'arrived and stays put');

  os.clearPermissionBubble(1);
  assert.equal(lead.holdInArea, false, 'answering the prompt releases it');
});

test('a question tool sends the agent to the inbox; the next tool releases it', () => {
  const { os, lead } = newOffice();
  os.setAgentTool(1, 'AskUserQuestion');
  os.setAgentActive(1, true);
  assert.equal(lead.holdInArea, true, 'going active with the question still open keeps it held');
  run(os, 20);
  assert.equal(areaOf(lead), 'Inbox');

  os.setAgentTool(1, 'Read');
  assert.equal(lead.holdInArea, false);
});

test('only an idle wait for input goes to the inbox, not a plain finished turn', () => {
  const { os, lead } = newOffice();
  os.setAgentActive(1, false);
  os.showWaitingBubble(1, false);
  assert.ok(!lead.holdInArea, 'a finished turn stays at the desk');

  os.showWaitingBubble(1, true);
  assert.equal(lead.holdInArea, true);
  os.setAgentActive(1, true);
  assert.equal(lead.holdInArea, false, 'a new prompt releases it');
});

test('without an inbox role Area nothing moves', () => {
  const { os, lead } = newOffice(false);
  os.showPermissionBubble(1);
  assert.ok(!lead.holdInArea);
});

test('finished sub-agents meet only once the lead has enough helpers', () => {
  assert.equal(MEETING_MIN_SUBAGENTS, 2, 'scenario below assumes two');
  const { os } = newOffice();
  const a = os.characters.get(os.addSubagent(1, 'tool-a'))!;
  os.markSubagentFinished(1, 'tool-a');
  assert.ok(!a.holdInArea, 'one helper has no one to meet');

  const b = os.characters.get(os.addSubagent(1, 'tool-b'))!;
  os.markSubagentFinished(1, 'tool-b');
  assert.equal(a.holdInArea, true, 'the earlier finisher is fetched too');
  assert.equal(b.holdInArea, true);
  run(os, 20);
  assert.equal(areaOf(a), 'Meeting');
  assert.equal(areaOf(b), 'Meeting');
});

test('a finished background helper is kept for the meeting only when there is one', () => {
  const { os } = newOffice();
  os.addSubagent(1, 'bg-a');
  assert.equal(os.markSubagentFinished(1, 'bg-a'), false, 'alone: despawn as usual');
  os.removeSubagent(1, 'bg-a');

  os.addSubagent(1, 'bg-b');
  os.addSubagent(1, 'bg-c');
  assert.equal(os.markSubagentFinished(1, 'bg-b'), true, 'with a teammate: kept and seated');
});

test('the meeting ends when the lead goes idle with every helper handed back', () => {
  const { os } = newOffice();
  const a = os.characters.get(os.addSubagent(1, 'bg-a'))!;
  const b = os.characters.get(os.addSubagent(1, 'bg-b'))!;
  os.markSubagentFinished(1, 'bg-a');
  os.setAgentActive(1, false);
  assert.notEqual(a.matrixEffect, 'despawn', 'b is still working, so the meeting goes on');

  os.markSubagentFinished(1, 'bg-b');
  os.setAgentActive(1, true);
  assert.notEqual(a.matrixEffect, 'despawn', 'the lead is summing up; everyone stays');
  os.setAgentActive(1, false);
  assert.equal(a.matrixEffect, 'despawn');
  assert.equal(b.matrixEffect, 'despawn');
});

test('a helper spawned while the team is meeting joins the meeting', () => {
  const { os } = newOffice();
  os.addSubagent(1, 'tool-a');
  os.addSubagent(1, 'tool-b');
  os.markSubagentFinished(1, 'tool-a');
  const late = os.characters.get(os.addSubagent(1, 'tool-summary'))!;
  assert.equal(late.holdInArea, true);
  run(os, 20);
  assert.equal(areaOf(late), 'Meeting');
});

test('agents of another lead are not pulled into the meeting', () => {
  const { os } = newOffice();
  os.addAgent(2, 1, 0, undefined, true);
  const other = os.characters.get(os.addSubagent(2, 'tool-x'))!;
  os.addSubagent(1, 'tool-a');
  os.addSubagent(1, 'tool-b');
  os.markSubagentFinished(1, 'tool-a');
  assert.ok(!other.holdInArea);
});

test('the editor sets, changes and clears an Area role', () => {
  const layout = roleLayout(false);
  const inbox = updateAreaRole(layout, 'Inbox', 'inbox');
  assert.equal(inbox.areas?.find((a) => a.label === 'Inbox')?.role, 'inbox');
  assert.equal(updateAreaRole(inbox, 'Inbox', 'inbox'), inbox, 'unchanged role is a no-op');
  assert.equal(updateAreaRole(inbox, 'Nope', 'meeting'), inbox, 'unknown area is a no-op');

  const cleared = updateAreaRole(inbox, 'Inbox', null);
  assert.ok(!('role' in cleared.areas!.find((a) => a.label === 'Inbox')!), 'seating drops the key');
  assert.equal(layout.areas?.[1].role, undefined, 'the input layout is not mutated');
});
