/**
 * The tutorial's progress reducer (pure): what moves a quest, what a closed
 * quest ignores, when a run is finished; what the quests are seen from
 * (tutorialSightings); the Guide's words, named after its character; and the
 * provider's spelling of pre-approved MCP tools and the session's plugin folder.
 */

import { describe, expect, it } from 'vitest';

import { TUTORIAL_QUESTS } from '../../core/src/tutorial/quests.js';
import { claudeProvider } from '../src/providers/index.js';
import {
  TUTORIAL_FIRST_MESSAGE,
  TUTORIAL_MCP_INSTRUCTIONS,
  TUTORIAL_SKILL_NAME,
  tutorialBrief,
  tutorialDisclosure,
  tutorialSkillMarkdown,
} from '../src/tutorial/tutorialCopy.js';
import {
  isTutorialFinished,
  reduceTutorialProgress,
  type TutorialProgress,
} from '../src/tutorial/tutorialProgress.js';
import {
  layoutSignature,
  questsSeen,
  type TutorialFacts,
} from '../src/tutorial/tutorialSightings.js';

const started = (): TutorialProgress =>
  reduceTutorialProgress(null, { kind: 'started', agentId: 4 });
const stateOf = (s: TutorialProgress, id: string) => s?.quests.find((q) => q.id === id)?.state;

describe('reduceTutorialProgress', () => {
  it('starts with every quest open', () => {
    const s = started();
    expect(s?.agentId).toBe(4);
    expect(s?.quests.map((q) => q.id)).toEqual(TUTORIAL_QUESTS.map((q) => q.id));
    expect(s?.quests.every((q) => q.state === 'open')).toBe(true);
    expect(isTutorialFinished(s)).toBe(false);
  });

  it('closes any quest in any order', () => {
    let s = started();
    for (const q of [...TUTORIAL_QUESTS].reverse()) {
      s = reduceTutorialProgress(s, { kind: 'questDone', questId: q.id });
      expect(stateOf(s, q.id)).toBe('done');
    }
    expect(isTutorialFinished(s)).toBe(true);
  });

  it('a closed quest stays as it closed; unknown quests and no run change nothing', () => {
    const skipped = reduceTutorialProgress(started(), {
      kind: 'questSkipped',
      questId: 'create-character',
    });
    expect(
      reduceTutorialProgress(skipped, { kind: 'questDone', questId: 'create-character' }),
    ).toBe(skipped);
    expect(reduceTutorialProgress(skipped, { kind: 'questSkipped', questId: 'nope' })).toBe(
      skipped,
    );
    expect(
      reduceTutorialProgress(null, { kind: 'questSkipped', questId: 'create-character' }),
    ).toBeNull();
  });

  it('is finished once every quest is closed, and ends to no run', () => {
    let s = started();
    for (const q of TUTORIAL_QUESTS)
      s = reduceTutorialProgress(s, { kind: 'questSkipped', questId: q.id });
    expect(isTutorialFinished(s)).toBe(true);
    expect(reduceTutorialProgress(s, { kind: 'ended' })).toBeNull();
    expect(isTutorialFinished(null)).toBe(false);
  });

  it('a restart begins afresh', () => {
    const s = reduceTutorialProgress(started(), {
      kind: 'questSkipped',
      questId: 'create-character',
    });
    const again = reduceTutorialProgress(s, { kind: 'started', agentId: 9 });
    expect(again?.agentId).toBe(9);
    expect(stateOf(again, 'create-character')).toBe('open');
  });
});

describe('questsSeen', () => {
  const from: TutorialFacts = {
    characterIds: ['char-0', 'char-1'],
    directoryPaths: ['/a'],
    agentIds: [1],
    layout: 'L0',
  };
  it('sees nothing while nothing changed', () => {
    expect(questsSeen(from, from)).toEqual([]);
  });
  it('sees a new character, a new Directory and a changed layout', () => {
    expect(questsSeen(from, { ...from, characterIds: ['char-0', 'x'] })).toEqual([
      'create-character',
    ]);
    expect(questsSeen(from, { ...from, directoryPaths: ['/a', '/b'] })).toEqual(['add-directory']);
    expect(questsSeen(from, { ...from, layout: 'L1' })).toEqual(['edit-layout']);
  });
  it("sees any agent joining, but not the Guide's own launch", () => {
    expect(questsSeen(from, { ...from, agentIds: [1, 8] }, 7)).toEqual(['launch-agent']);
    expect(questsSeen(from, { ...from, agentIds: [1, 7] }, 7)).toEqual([]);
  });
  it('a removal or reorder is no quest', () => {
    expect(
      questsSeen(from, { ...from, characterIds: ['char-1'], directoryPaths: [], agentIds: [] }),
    ).toEqual([]);
  });
});

describe("the Guide's words", () => {
  it('the first message is only the skill command, and the MCP instructions name the fallback', () => {
    expect(TUTORIAL_FIRST_MESSAGE).toBe(`/${TUTORIAL_SKILL_NAME}`);
    expect(TUTORIAL_MCP_INSTRUCTIONS).toContain(TUTORIAL_FIRST_MESSAGE);
    expect(TUTORIAL_MCP_INSTRUCTIONS).toContain('brief true');
  });
  it("go by the character's name, never a fixed one", () => {
    for (const text of [
      tutorialDisclosure('Zed', 'app'),
      tutorialBrief('Zed'),
      tutorialSkillMarkdown('Zed'),
    ]) {
      expect(text).toContain('Zed');
      expect(text).not.toMatch(/\b(Suit|Byte)\b/);
    }
    expect(tutorialDisclosure('Zed', 'app')).toContain(' in app');
  });
});

describe('layoutSignature', () => {
  it('changes with what an editor save changes, Areas included', () => {
    const layout = { version: 1, cols: 2, rows: 1, tiles: [0, 1], furniture: [] };
    const base = layoutSignature(layout);
    expect(layoutSignature({ ...layout, version: 2 })).toBe(base);
    expect(layoutSignature({ ...layout, tiles: [1, 1] })).not.toBe(base);
    expect(layoutSignature({ ...layout, furniture: [{ uid: 'p' }] })).not.toBe(base);
    expect(layoutSignature({ ...layout, areas: [{ label: 'A' }] })).not.toBe(base);
    expect(layoutSignature(null)).toBe('');
  });
});

describe('buildLaunchCommand preapprovedMcpTools + pluginDirs (Claude)', () => {
  it('becomes --allowedTools, one value per tool in Claude spelling, after the plugin folder and before the prompt', () => {
    const { args } = claudeProvider.buildLaunchCommand!('sid', '/w', {
      mcpConfig: '/c.json',
      prompt: 'hi',
      preapprovedMcpTools: { server: 'pixel-office', tools: ['tutorial', 'list_agents'] },
      pluginDirs: ['/p'],
    });
    expect(args).toEqual([
      '--session-id',
      'sid',
      '--mcp-config',
      '/c.json',
      '--plugin-dir',
      '/p',
      '--allowedTools',
      'mcp__pixel-office__tutorial',
      'mcp__pixel-office__list_agents',
      '--',
      'hi',
    ]);
  });
  it('is left out with no tools', () => {
    const { args } = claudeProvider.buildLaunchCommand!('sid', '/w', {
      preapprovedMcpTools: { server: 'pixel-office', tools: [] },
    });
    expect(args).not.toContain('--allowedTools');
  });
});
