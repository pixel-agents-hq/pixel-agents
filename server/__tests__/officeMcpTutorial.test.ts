/**
 * The tutorial through the Pixel Office MCP's main seam: a composed standalone
 * server (isolated $HOME, a floor layout in layout.json), an office on /ws
 * answering the Intro, and the Guide launched by `startTutorial` — mock-claude
 * in a real PTY — then driven as the Guide with its own token. Asserted from
 * outside: the tutorialStatus offices hear, the argv the Guide's CLI got, the
 * tools' replies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { TUTORIAL_QUESTS } from '../../core/src/tutorial/quests.js';
import { type LoadedAssets, loadFurnitureAssets } from '../src/assetLoader.js';
import { claudeProvider } from '../src/providers/index.js';
import { tutorialFirstMessage, tutorialSkillName } from '../src/tutorial/tutorialCopy.js';
import { BUNDLED, type Json, useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

const FLOOR = 1;

/** 8×6 floor, no furniture. */
function floorLayout(): Json {
  const cols = 8;
  const rows = 6;
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<number>(cols * rows).fill(FLOOR),
    tileColors: new Array(cols * rows).fill(null),
    furniture: [],
  };
}

/** Turn the office's Skip Permissions on, as Settings does, and wait for it. */
async function skipPermissions(h: ReturnType<typeof useStandaloneOffice>): Promise<void> {
  h.send({ type: 'setBypassPermissions', enabled: true });
  await waitFor(
    () => h.received.find((m) => m.type === 'bypassPermissionsUpdated' && m.enabled === true),
    'Skip Permissions to be on',
  );
}

describe('the tutorial (composed server, the Guide in a PTY)', () => {
  let furniture: LoadedAssets;

  beforeAll(async () => {
    furniture = (await loadFurnitureAssets(BUNDLED))!;
  });

  const h = useStandaloneOffice({
    name: 'pxl-tutorial',
    prepare: ({ home }) => {
      fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.pixel-agents', 'layout.json'),
        JSON.stringify(floorLayout()),
      );
    },
    layout: 'file',
    catalog: () => furniture.catalog,
    assets: () => ({ floorPatterns: 7, wallSets: 9, carpets: 0, pets: [] }),
    launch: true,
    tutorial: true,
  });

  const statuses = (from = 0): Json[] =>
    h.received.slice(from).filter((m) => m.type === 'tutorialStatus');
  const latest = (): Json | undefined => statuses().at(-1);
  const questState = (id: string): string | undefined =>
    (latest()?.run?.quests as Json[] | undefined)?.find((q) => q.id === id)?.state;

  /** Grant the MCP, start the tutorial, and connect as the Guide. */
  async function startGuide() {
    await h.answer('allow');
    await waitFor(() => latest()?.available === true, 'the tutorial to be offered');
    const before = h.starts().length;
    const ids = new Set(h.store.keys());
    h.send({ type: 'startTutorial', palette: 0 });
    const start = await waitFor(() => h.starts()[before], "the Guide's CLI to start");
    const run = await waitFor(() => latest()?.run, 'the run to be broadcast');
    const id = run.agentId as number;
    expect(ids.has(id)).toBe(false);
    const line = h.invocations().find((l) => l.includes(start.sessionId))!;
    const client = await h.connectAs({ id, line, sessionId: start.sessionId, args: '' });
    return { id, start, client };
  }

  it('is offered only once the Pixel Office MCP is granted, with a disclosure naming the session and its Directory', async () => {
    const first = statuses()[0];
    expect(first).toMatchObject({ available: false });
    expect(first.unavailableReason).toMatch(/Pixel Agents Office MCP/);
    expect(first.run).toBeUndefined();

    await h.answer('allow');
    const offered = await waitFor(() => latest()?.available === true && latest(), 'the offer');
    expect(offered.headline).toBe('Want me to show you around?');
    expect(offered.disclosure).toMatch(/real Claude Code session in proj/);
    expect(offered.disclosure).toMatch(/Claude plan/);
    expect(offered.disclosure).toMatch(/^I'll take a desk/);
  });

  it('refuses to start before the MCP is granted, launching nothing', async () => {
    const before = h.starts().length;
    h.send({ type: 'startTutorial' });
    const rejected = await waitFor(
      () => h.received.find((m) => m.type === 'tutorialRejected'),
      'the refusal',
    );
    expect(rejected.reason).toMatch(/Pixel Agents Office MCP/);
    expect(h.starts().length).toBe(before);
  });

  it('launches the Guide with the MCP, its look, the onboarding skill, its command as the first message, auto mode and the read tools pre-approved', async () => {
    const { id, start } = await startGuide();
    const args = start.args;
    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args).not.toContain('--dangerously-skip-permissions');
    const tools = args.indexOf('--allowedTools');
    expect(args.slice(tools + 1, tools + 6)).toEqual([
      'mcp__pixel-office__tutorial',
      'mcp__pixel-office__get_feature_guide',
      'mcp__pixel-office__list_agents',
      'mcp__pixel-office__get_layout',
      'mcp__pixel-office__list_catalog',
    ]);
    expect(args.slice(-2)).toEqual(['--', tutorialFirstMessage(claudeProvider.skills)]);
    expect(tutorialFirstMessage(claudeProvider.skills)).toBe('/pixel-agents:onboarding');
    // The skill, for this session alone: a plugin folder under ~/.pixel-agents.
    const plugin = args[args.indexOf('--plugin-dir') + 1];
    expect(plugin.startsWith(path.join(h.home, '.pixel-agents'))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8')),
    ).toMatchObject({ name: 'pixel-agents' });
    const skill = fs.readFileSync(path.join(plugin, 'skills/onboarding/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: onboarding\n/);
    expect(skill).toContain('You are Byte.');
    expect(fs.existsSync(path.join(h.home, '.claude', 'plugins'))).toBe(false);

    const agent = h.store.get(id)!;
    expect(agent.nickname).toBe('Guide');
    expect(agent.palette).toBe(0);
    const run = latest()!.run;
    expect(run.quests.map((q: Json) => q.id)).toEqual(TUTORIAL_QUESTS.map((q) => q.id));
    expect(run.quests.every((q: Json) => q.state === 'open')).toBe(true);
    expect(run.finished).toBe(false);
  });

  it("launches the Guide in auto mode, never skipping prompts, while the office's Skip Permissions is on", async () => {
    await skipPermissions(h);
    const { start } = await startGuide();
    expect(start.args[start.args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(start.args).not.toContain('--dangerously-skip-permissions');
  });

  it('a second start while one runs is refused', async () => {
    await startGuide();
    const before = h.starts().length;
    h.send({ type: 'startTutorial' });
    const rejected = await waitFor(
      () => h.received.find((m) => m.type === 'tutorialRejected'),
      'the refusal',
    );
    expect(rejected.reason).toMatch(/already running/);
    expect(h.starts().length).toBe(before);
  });

  it('the Guide reads the quests (its brief on request), skips one when asked, and marks none done', async () => {
    const { id, client } = await startGuide();
    const status = await h.callJson(client, 'tutorial', {});
    expect(status).toMatchObject({
      running: true,
      agentId: id,
      you: true,
      skill: tutorialSkillName(claudeProvider.skills),
    });
    expect(status.current).toBeUndefined();
    expect(status.brief).toBeUndefined();
    expect(status.quests[0]).toMatchObject({ id: 'create-character', state: 'open' });
    expect(status.quests[0].forGuide).toMatch(/Counts when/);
    const withBrief = await h.callJson(client, 'tutorial', { brief: true });
    expect(withBrief.brief).toMatch(/You are Byte\./);

    const refused = await h.callTool(client, 'tutorial', {
      action: 'complete',
      quest_id: 'create-character',
    });
    expect(refused.isError).toBe(true);

    // Skipping for the user: once, and only an open quest.
    const skipped = await h.callJson(client, 'tutorial', {
      action: 'skip',
      quest_id: 'add-directory',
    });
    expect(skipped.quests.find((q: Json) => q.id === 'add-directory').state).toBe('skipped');
    await waitFor(() => questState('add-directory') === 'skipped', 'the skip broadcast');
    const again = await h.callTool(client, 'tutorial', {
      action: 'skip',
      quest_id: 'add-directory',
    });
    expect(again.text).toMatch(/already skipped/);
    const unknown = await h.callTool(client, 'tutorial', { action: 'skip', quest_id: 'nope' });
    expect(unknown.text).toMatch(/There is no quest nope/);

    const guide = await h.callJson(client, 'get_feature_guide', { topic: 'radio' });
    expect(guide.title).toBe('The office radio');
  });

  it("goes by its character's name: a renamed greeter character renames the Guide", async () => {
    await h.answer('allow');
    h.send({
      type: 'saveCharacterProfiles',
      profiles: [{ id: 'char-0', name: 'Zed', body: 'flat', v: 35 }],
      saveId: 'rename',
    });
    await waitFor(
      () => h.received.some((m) => m.type === 'characterProfilesLoaded' && m.saveId === 'rename'),
      'the rename to be saved',
    );
    const { client } = await startGuide();
    const withBrief = await h.callJson(client, 'tutorial', { brief: true });
    expect(withBrief.brief).toMatch(/You are Zed\./);
  });

  it('another agent sees the run but gets no brief and cannot skip', async () => {
    await h.answer('allow');
    const other = await h.launchAgent();
    h.send({ type: 'startTutorial' });
    await waitFor(() => latest()?.run, 'the run');
    const view = await h.callJson(other.client, 'tutorial', {});
    expect(view.you).toBe(false);
    expect(view.brief).toBeUndefined();
    const refused = await h.callTool(other.client, 'tutorial', {
      action: 'skip',
      quest_id: 'add-directory',
    });
    expect(refused.text).toMatch(/Only the tutorial's Guide/);
  });

  it('every quest completes by itself when the server sees it, in any order', async () => {
    const { client } = await startGuide();

    // The Guide's edit is not the user's change, even once an office saves after it.
    const edit = await h.callTool(client, 'edit_layout', {
      ops: [{ op: 'paint_walls', tiles: [{ col: 5, row: 4 }] }],
    });
    expect(edit.isError, edit.text).toBe(false);
    h.send({
      type: 'saveLayout',
      layout: JSON.parse(
        fs.readFileSync(path.join(h.home, '.pixel-agents', 'layout.json'), 'utf8'),
      ),
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(questState('edit-layout')).toBe('open');

    // An office saving a changed layout, first.
    const layout = floorLayout();
    layout.tiles[0] = 0;
    h.send({ type: 'saveLayout', layout });
    await waitFor(() => questState('edit-layout') === 'done', 'the layout quest');

    // An agent launched in the start Directory (the Guide's own launch never counted).
    expect(questState('launch-agent')).toBe('open');
    h.send({ type: 'launchAgent', directoryPath: h.workspace });
    await waitFor(() => questState('launch-agent') === 'done', 'the launch quest');

    // A Directory added.
    const project = path.join(h.home, 'project');
    fs.mkdirSync(project, { recursive: true });
    h.send({ type: 'saveDirectory', name: 'Project', path: project });
    await waitFor(() => questState('add-directory') === 'done', 'the Directory quest');

    // A character saved that wasn't in the cast.
    h.send({
      type: 'saveCharacterProfiles',
      profiles: [{ id: 'mine', name: 'Mine', body: 'flat', v: 35 }],
      saveId: 's1',
    });
    await waitFor(() => questState('create-character') === 'done', 'the character quest');
    await waitFor(() => latest()?.run?.finished === true, 'the finish');
  }, 30_000);

  it('skipping every quest finishes the run; quitting ends it and closes the Guide', async () => {
    const { id } = await startGuide();
    for (const quest of TUTORIAL_QUESTS) h.send({ type: 'skipTutorialQuest', questId: quest.id });
    await waitFor(() => latest()?.run?.finished === true, 'the finish');
    expect(h.store.has(id)).toBe(true);

    h.send({ type: 'quitTutorial' });
    await waitFor(() => latest() && !latest()!.run, 'the run to end');
    await waitFor(() => !h.store.has(id), 'the Guide to leave');
    expect(latest()!.available).toBe(true);
  });

  it("the run ends when the Guide's session ends on its own", async () => {
    const { id } = await startGuide();
    h.send({ type: 'closeAgent', id });
    await waitFor(() => !h.store.has(id), 'the Guide to leave');
    await waitFor(() => latest() && !latest()!.run, 'the run to end');
  });
});

describe('the tutorial with a CLI that declares no auto permission mode', () => {
  const h = useStandaloneOffice({
    name: 'pxl-tutorial-nomode',
    launch: true,
    tutorial: true,
    provider: { ...claudeProvider, autoPermissionMode: undefined },
  });

  it("launches the Guide in the CLI's default mode, never skipping prompts, while the office's Skip Permissions is on", async () => {
    await skipPermissions(h);
    await h.answer('allow');
    await waitFor(
      () => h.received.filter((m) => m.type === 'tutorialStatus').at(-1)?.available === true,
      'the tutorial to be offered',
    );
    const before = h.starts().length;
    h.send({ type: 'startTutorial', palette: 0 });
    const start = await waitFor(() => h.starts()[before], "the Guide's CLI to start");
    expect(start.args).not.toContain('--dangerously-skip-permissions');
    expect(start.args).not.toContain('--permission-mode');
  });
});
