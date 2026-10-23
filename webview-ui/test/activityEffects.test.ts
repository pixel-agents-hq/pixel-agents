import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { WAITING_BUBBLE_DURATION_SEC } from '../src/constants.js';
import {
  activityPhase,
  advanceActivityClock,
  characterPoseOffset,
  classifyToolActivity,
  completionProgress,
  getCharacterActivity,
} from '../src/office/engine/activityEffectState.js';
import {
  areOfficeEffectsAnimated,
  isOfficeEffectsEnabled,
  setOfficeEffectsEnabled,
} from '../src/office/engine/activityPreferences.js';
import {
  createCharacter,
  getCharacterSprite,
  updateCharacter,
} from '../src/office/engine/characters.js';
import type { CharacterSprites } from '../src/office/sprites/spriteData.js';
import { setProviderCapabilities } from '../src/office/toolUtils.js';
import type { SpriteData } from '../src/office/types.js';
import { CharacterState, Direction } from '../src/office/types.js';

afterEach(() => {
  setOfficeEffectsEnabled(true);
  setProviderCapabilities({ readingTools: [], subagentToolNames: [] });
  vi.unstubAllGlobals();
});

test('Kiro and Claude tool names produce the same meaningful activity', () => {
  for (const tool of [
    'Read',
    'fs_read',
    'read_file',
    'Grep',
    'WebFetch',
    'list_directory',
    'file_search',
    'grep_search',
    'remote_web_search',
  ]) {
    assert.equal(classifyToolActivity(tool), 'reading', tool);
  }
  for (const tool of ['Write', 'fs_write', 'apply_patch', 'Edit']) {
    assert.equal(classifyToolActivity(tool), 'typing', tool);
  }
  for (const tool of ['Bash', 'execute_bash', 'execute_pwsh', 'shell', 'run_command']) {
    assert.equal(classifyToolActivity(tool), 'executing', tool);
  }
  for (const tool of ['Task', 'Agent', 'delegate_to_agent']) {
    assert.equal(classifyToolActivity(tool), 'delegating', tool);
  }
  assert.equal(classifyToolActivity(null), 'thinking');
  assert.equal(classifyToolActivity('custom_remote_operation'), 'executing');
});

test('Kiro turn-start thinking stays thinking until a real tool starts', () => {
  const ch = createCharacter(7, 0, null, null);
  for (const tool of ['thinking', 'reasoning', 'kiro_turn']) {
    ch.currentTool = tool;
    assert.equal(classifyToolActivity(tool), 'thinking', tool);
    assert.equal(getCharacterActivity(ch), 'thinking', tool);
  }
  ch.currentTool = 'execute_pwsh';
  assert.equal(getCharacterActivity(ch), 'executing');
  ch.currentTool = 'remote_web_search';
  assert.equal(getCharacterActivity(ch), 'reading');
});

test('provider taxonomy overrides aliases, including custom provider tool names', () => {
  setProviderCapabilities({
    readingTools: ['shell', 'inspect_kiro'],
    subagentToolNames: ['delegate_kiro'],
  });
  assert.equal(classifyToolActivity('shell'), 'reading');
  assert.equal(classifyToolActivity('inspect_kiro'), 'reading');
  assert.equal(classifyToolActivity('delegate_kiro'), 'delegating');
});

test('permission and input wait take precedence over an old active tool', () => {
  const ch = createCharacter(7, 0, null, null);
  ch.currentTool = 'fs_write';
  ch.bubbleType = 'permission';
  assert.equal(getCharacterActivity(ch), 'permission');
  assert.equal(completionProgress(ch), null);
  ch.isActive = false;
  ch.bubbleType = 'waiting';
  ch.waitingAwaitingInput = true;
  ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  assert.equal(getCharacterActivity(ch), 'waiting');
  assert.equal(completionProgress(ch), null);
});

test('celebration starts only for a confirmed done turn, then expires', () => {
  const ch = createCharacter(7, 0, null, null);
  assert.equal(completionProgress(ch), null);
  ch.isActive = false;
  ch.bubbleType = 'waiting';
  ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  assert.equal(getCharacterActivity(ch), 'done');
  assert.equal(completionProgress(ch), 0);
  ch.bubbleTimer -= 0.4;
  assert.ok(completionProgress(ch)! > 0);
  ch.bubbleTimer -= 0.6;
  assert.equal(completionProgress(ch), null);
  ch.bubbleTimer = 0;
  ch.bubbleType = null;
  assert.equal(getCharacterActivity(ch), 'idle');
  assert.equal(completionProgress(ch), null);
  ch.isActive = true;
  ch.bubbleType = 'waiting';
  ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  assert.equal(completionProgress(ch), null);
});

test('visual clock survives frame resets and agents have independent phases', () => {
  const first = createCharacter(1, 0, null, null);
  const second = createCharacter(2, 0, null, null);
  advanceActivityClock(first, 2.1);
  advanceActivityClock(second, 2.1);
  first.frameTimer = 0;
  assert.equal(first.visualTime, 2.1);
  assert.notEqual(activityPhase(first, 3.8), activityPhase(second, 3.8));
  advanceActivityClock(first, Number.NaN);
  advanceActivityClock(first, -100);
  assert.equal(first.visualTime, 2.1);
});

test('reading cadence is slower than typing and permission freezes hands', () => {
  const typing = createCharacter(1, 0, null, null);
  const reading = createCharacter(2, 0, null, null);
  typing.currentTool = 'fs_write';
  reading.currentTool = 'fs_read';
  updateCharacter(typing, 0.35, [], new Map(), [], new Set());
  updateCharacter(reading, 0.35, [], new Map(), [], new Set());
  assert.equal(typing.frame, 1);
  assert.equal(reading.frame, 0);
  typing.bubbleType = 'permission';
  updateCharacter(typing, 0.35, [], new Map(), [], new Set());
  assert.equal(typing.frame, 0);
  assert.equal(typing.visualTime, 0.7);
});

test('effects toggle and live reduced-motion changes suppress decorative motion', () => {
  const ch = createCharacter(1, 0, null, null);
  ch.currentTool = 'fs_read';
  ch.visualTime = 2.5;
  const query = { matches: false };
  vi.stubGlobal('window', { matchMedia: () => query });
  assert.equal(areOfficeEffectsAnimated(), true);
  assert.ok(characterPoseOffset(ch, areOfficeEffectsAnimated()) >= 0);
  query.matches = true;
  assert.equal(areOfficeEffectsAnimated(), false);
  assert.equal(characterPoseOffset(ch, areOfficeEffectsAnimated()), 0);
  query.matches = false;
  assert.equal(areOfficeEffectsAnimated(), true);
  setOfficeEffectsEnabled(false);
  assert.equal(isOfficeEffectsEnabled(), false);
  assert.equal(areOfficeEffectsAnimated(), false);
  assert.equal(characterPoseOffset(ch, areOfficeEffectsAnimated()), 0);
});

test('reduced-motion keeps the original seated sprite, without hand-frame cycling', () => {
  const ch = createCharacter(1, 0, null, null);
  ch.currentTool = 'fs_write';
  ch.state = CharacterState.TYPE;
  ch.dir = Direction.DOWN;
  ch.frame = 1;
  const first: SpriteData = [['first']];
  const second: SpriteData = [['second']];
  const pair = [first, second] as [SpriteData, SpriteData];
  const sprites = {
    walk: { 0: [first, second, first, second] },
    typing: { 0: pair },
    reading: { 0: pair },
  } as CharacterSprites;
  assert.equal(getCharacterSprite(ch, sprites), second);
  assert.equal(getCharacterSprite(ch, sprites, false), first);
});
