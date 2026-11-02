import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  setProviderCapabilities,
  ToolProp,
  toolPropFor,
  toolPropForTool,
} from '../src/office/toolUtils.js';

beforeEach(() => {
  setProviderCapabilities({
    readingTools: ['Read', 'Grep', 'Glob', 'NotebookRead'],
    subagentToolNames: [],
  });
});

test('each Claude tool family gets its prop', () => {
  const cases: Array<[string, ToolProp]> = [
    ['Read', ToolProp.MAGNIFIER],
    ['Grep', ToolProp.MAGNIFIER],
    ['Glob', ToolProp.MAGNIFIER],
    ['Edit', ToolProp.PENCIL],
    ['Write', ToolProp.PENCIL],
    ['MultiEdit', ToolProp.PENCIL],
    ['NotebookEdit', ToolProp.PENCIL],
    ['Bash', ToolProp.WRENCH],
    ['WebFetch', ToolProp.BOOK],
    ['WebSearch', ToolProp.BOOK],
    ['Agent', ToolProp.FOLDER],
    ['Task', ToolProp.FOLDER],
    ['SendMessage', ToolProp.FOLDER],
    ['EnterPlanMode', ToolProp.MARKER],
    ['TodoWrite', ToolProp.MARKER],
    ['AskUserQuestion', ToolProp.QUESTION],
  ];
  for (const [tool, prop] of cases) assert.equal(toolPropForTool(tool), prop, tool);
});

test('unlisted tools fall back by pattern, then the reading set, then the clipboard', () => {
  assert.equal(toolPropForTool('run_shell_command'), ToolProp.WRENCH);
  assert.equal(toolPropForTool('mcp__x__make_plan'), ToolProp.MARKER);
  assert.equal(toolPropForTool('NotebookRead'), ToolProp.MAGNIFIER);
  assert.equal(toolPropForTool('mcp__github__create_issue'), ToolProp.CLIPBOARD);
  assert.equal(toolPropForTool(''), ToolProp.CLIPBOARD);
  assert.equal(toolPropForTool(null), ToolProp.CLIPBOARD);
});

test('bubbles win over the tool; an idle character shows nothing', () => {
  const working = { isActive: true, currentTool: 'Bash', bubbleType: null };
  assert.equal(toolPropFor(working), ToolProp.WRENCH);
  assert.equal(toolPropFor({ ...working, bubbleType: 'permission' }), ToolProp.QUESTION);
  assert.equal(toolPropFor({ ...working, isActive: false, bubbleType: 'waiting' }), ToolProp.STAMP);
  assert.equal(toolPropFor({ ...working, isActive: false }), null);
  assert.equal(toolPropFor({ ...working, currentTool: null }), null);
});
