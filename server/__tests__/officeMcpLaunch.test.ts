/**
 * launch_agent through the Pixel Office MCP's main seam: a composed standalone
 * server (isolated $HOME, the bundled default office seeded as layout.json),
 * a first agent launched over /ws as the office launches it — mock-claude in a
 * real PTY — and the MCP SDK's client calling launch_agent with that agent's
 * own token. Asserted from outside: what the client gets back, the argv each
 * mock-claude was started with, the protocol messages broadcast, and what
 * lands in standalone-state.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { type LoadedAssets, loadFurnitureAssets } from '../src/assetLoader.js';
import { getCharacterProfiles } from '../src/characterProfilesStore.js';
import { agentLabel, messageTag } from '../src/mcp/agentLabel.js';
import { claudeProvider } from '../src/providers/index.js';
import { launchForOffice } from '../src/terminal/standaloneLaunches.js';
import { gitIn } from './fixtures/gitRepos.js';
import { BUNDLED, type Json, useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

const RESUMED = '0f6c2a9e-1b3d-4c5e-8f70-9a1b2c3d4e5f';

describe('launch_agent (composed server, mock-claude in a PTY)', () => {
  let furniture: LoadedAssets;

  beforeAll(async () => {
    furniture = (await loadFurnitureAssets(BUNDLED))!;
  });

  const h = useStandaloneOffice({
    name: 'pxl-office-launch',
    prepare: ({ home, workspace }) => {
      // `proj`, a git repo with one commit: a Directory Worktrees can be made of.
      gitIn(workspace, 'init', '--quiet', '-b', 'main');
      fs.writeFileSync(path.join(workspace, 'README.md'), '# proj\n');
      gitIn(workspace, 'add', '-A');
      gitIn(
        workspace,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '--quiet',
        '-m',
        'initial',
      );
      fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
      fs.copyFileSync(
        path.join(BUNDLED, 'assets', 'default-layout-1.json'),
        path.join(home, '.pixel-agents', 'layout.json'),
      );
    },
    layout: 'file',
    catalog: () => furniture.catalog,
    launch: true,
    grant: true,
  });
  const { send, useClaude } = h;

  // ── Helpers ─────────────────────────────────────────────────

  function startOf(sessionId: string): ReturnType<typeof h.starts>[number] {
    const found = h.starts().find((s) => s.sessionId === sessionId);
    if (!found) throw new Error(`no start for ${sessionId}`);
    return found;
  }

  /** The first agent, launched from the office, connected as itself. */
  async function caller(): Promise<{
    id: number;
    client: Awaited<ReturnType<typeof h.mcpClient>>;
  }> {
    const before = h.starts().length;
    send({ type: 'launchAgent', directoryPath: h.workspace });
    const start = await waitFor(() => h.starts()[before], 'mock-claude to start');
    const id = [...h.store].find(([, a]) => a.sessionId === start.sessionId)![0];
    const configPath = start.args[start.args.indexOf('--mcp-config') + 1];
    const client = await h.mcpClient(h.tokenIn(configPath), `agent-${id}`);
    return { id, client };
  }

  const launch = (client: Awaited<ReturnType<typeof h.mcpClient>>, args: Json) =>
    h.callToolCaught(client, 'launch_agent', args);

  async function launched(
    client: Awaited<ReturnType<typeof h.mcpClient>>,
    args: Json,
  ): Promise<Json> {
    const reply = await launch(client, args);
    expect(reply.isError, reply.text).toBe(false);
    return reply.value!;
  }

  function persisted(): Json[] {
    const file = path.join(h.home, '.pixel-agents', 'standalone-state.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { agents: Json[] }).agents;
  }

  // ── Tests ───────────────────────────────────────────────────

  it('a launch with only a Directory: an agent of it, joined, with its id, character and session', async () => {
    const { client } = await caller();
    const reply = await launched(client, { directory: 'proj' });

    expect(reply.agent_id).toEqual(expect.any(Number));
    expect(reply.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(reply.character).toEqual({
      label: expect.any(String),
      palette: expect.any(Number),
      repeat: expect.any(Number),
    });
    expect(reply.seat).toBeNull(); // no office has seated it
    // Joined: in the office, its CLI running in its own terminal, with the MCP too.
    const agent = h.store.get(reply.agent_id)!;
    expect(agent.directoryName).toBe('proj');
    expect(h.ptyManager.get(reply.agent_id)?.hasExited).toBe(false);
    const start = startOf(reply.session_id);
    expect(start.cwd).toBe(h.workspace);
    expect(start.args.slice(0, 2)).toEqual(['--session-id', reply.session_id]);
    expect(start.args).toContain('--mcp-config');
    expect(start.args).not.toContain('--');
    expect(start.args).not.toContain('--model');
    expect(h.received).toContainEqual(
      expect.objectContaining({ type: 'agentCreated', id: reply.agent_id, directoryName: 'proj' }),
    );

    // A path names the same Directory.
    const byPath = await launched(client, { directory: h.workspace });
    expect(h.store.get(byPath.agent_id)!.directoryName).toBe('proj');
  });

  it('first message, model and permission mode reach the CLI as argv; character and nickname are worn', async () => {
    const { client } = await caller();
    const label = getCharacterProfiles()[2].name!;
    const message = `--help is not a flag here; "quote" $HOME \`tick\` 'x'\nsecond line`;
    const reply = await launched(client, {
      directory: 'proj',
      first_message: message,
      model: 'opus',
      permission_mode: 'plan',
      character: label,
      nickname: '  reviewer ',
    });

    const { args } = startOf(reply.session_id);
    // The prompt is the last argv entry, after `--`, byte for byte.
    expect(args.slice(-2)).toEqual(['--', message]);
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(reply.character).toMatchObject({ label, palette: 2 });

    // The nickname: on agentCreated, in list_agents, saved, and the Message sender label.
    expect(h.received).toContainEqual(
      expect.objectContaining({ type: 'agentCreated', id: reply.agent_id, nickname: 'reviewer' }),
    );
    const listed = await client.callTool({ name: 'list_agents', arguments: {} });
    const agents = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as {
      agents: Json[];
    };
    expect(agents.agents.find((a) => a.id === reply.agent_id)).toMatchObject({
      nickname: 'reviewer',
    });
    expect(persisted().find((a) => a.id === reply.agent_id)).toMatchObject({
      nickname: 'reviewer',
    });
    const agent = h.store.get(reply.agent_id)!;
    expect(messageTag(reply.agent_id, agentLabel(agent))).toBe(
      `[From reviewer, agent ${reply.agent_id}] `,
    );

    // A reload: the snapshot carries it.
    h.received.length = 0;
    send({ type: 'webviewReady' });
    const snapshot = await waitFor(
      () => h.received.find((m) => m.type === 'existingAgents'),
      'the snapshot',
    );
    expect(snapshot.nicknames).toEqual({ [reply.agent_id]: 'reviewer' });

    // By palette index too.
    const byIndex = await launched(client, { directory: 'proj', character: 1 });
    expect(byIndex.character).toMatchObject({ palette: 1 });
    // And by its permanent id (list_characters shows it).
    const byId = await launched(client, { directory: 'proj', character: 'char-3' });
    expect(byId.character).toMatchObject({ palette: 3 });
  });

  it('refuses what it cannot do, saying why, and launches nothing', async () => {
    const { client } = await caller();
    const before = h.store.size;
    const cases: Array<[Json, RegExp]> = [
      [{ directory: 'nowhere' }, /neither a Directory nor an existing folder.*proj/],
      [{ directory: 'proj', character: 'Nobody' }, /no character called Nobody/],
      [{ directory: 'proj', character: 99 }, /no character 99/],
      [{ directory: 'proj', seat: 'no-such-seat' }, /no seat no-such-seat/],
      [{ directory: 'proj', permission_mode: 'yolo' }, /not a permission mode.*acceptEdits/],
      [{ directory: 'proj', permission_mode: 'bypassPermissions' }, /doesn't allow that/],
      [{ directory: 'proj', model: '--dangerously-skip-permissions' }, /not a model name/],
      [{ directory: 'proj', nickname: '   ' }, /at least one visible character/],
      [{ directory: 'proj', nickname: 'x'.repeat(40) }, /at most 32/],
      [{ directory: 'proj', resume_session_id: 'not-a-uuid' }, /not a session id/],
      [{ directory: 'proj', resume_session_id: RESUMED }, /No conversation/],
      [{ directory: 'proj', worktree: { from: 'nope' } }, /no branch nope.*main/],
    ];
    for (const [args, reason] of cases) {
      const reply = await launch(client, args);
      expect(reply.isError, JSON.stringify(args)).toBe(true);
      expect(reply.text).toMatch(reason);
    }
    expect(h.store.size).toBe(before);
  });

  it('bypassPermissions launches only while the office allows skipping permissions', async () => {
    const { client } = await caller();
    send({ type: 'setBypassPermissions', enabled: true });
    await waitFor(
      () => h.received.some((m) => m.type === 'bypassPermissionsUpdated' && m.enabled === true),
      'the setting',
    );
    const reply = await launched(client, {
      directory: 'proj',
      permission_mode: 'bypassPermissions',
    });
    const { args } = startOf(reply.session_id);
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('a requested seat is taken when free; a taken one falls back, saying so', async () => {
    const { id: callerId, client } = await caller();
    const seats = h.office.layout.getLayout()!.seats;
    const [mine, wanted] = seats.map((s) => s.id);
    send({ type: 'saveAgentSeats', seats: { [callerId]: { seatId: mine } } });
    await waitFor(
      () => h.office.layout.getLayout()!.seats.find((s) => s.id === mine)?.takenBy,
      'the save',
    );

    const free = await launched(client, { directory: 'proj', seat: wanted });
    expect(free.seat).toBe(wanted);
    expect(free.notes).toBeUndefined();
    expect(h.received).toContainEqual(
      expect.objectContaining({ type: 'agentCreated', id: free.agent_id, seatId: wanted }),
    );

    const taken = await launched(client, { directory: 'proj', seat: mine });
    expect(taken.seat).not.toBe(mine);
    expect(taken.notes).toEqual([
      `Seat ${mine} is agent ${callerId}'s, so the office picked another.`,
    ]);
  });

  it('a Worktree launch makes the Worktree from the named branch and runs there', async () => {
    const { client } = await caller();
    const reply = await launched(client, {
      directory: 'proj',
      worktree: { name: 'feat-x', from: 'main' },
    });
    const agent = h.store.get(reply.agent_id)!;
    expect(agent.directoryName).toBe('proj');
    expect(agent.worktree).toMatchObject({ name: 'feat-x' });
    expect(startOf(reply.session_id).cwd).toBe(agent.worktree!.path);
    expect(gitIn(agent.worktree!.path, 'branch', '--show-current')).toBe(agent.worktree!.branch);
  });

  it('resumes a past conversation of the Directory, and refuses one already in the office', async () => {
    const { client } = await caller();
    const projectDir = path.join(h.home, '.claude', 'projects', normalizeProjectPath(h.workspace));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${RESUMED}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`,
    );

    const reply = await launched(client, {
      directory: 'proj',
      resume_session_id: RESUMED,
      first_message: 'carry on',
    });
    expect(reply.session_id).toBe(RESUMED);
    const { args } = startOf(RESUMED);
    expect(args.slice(0, 2)).toEqual(['--resume', RESUMED]);
    expect(args.slice(-2)).toEqual(['--', 'carry on']);

    const again = await launch(client, { directory: 'proj', resume_session_id: RESUMED });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(new RegExp(`already in the office: agent ${reply.agent_id}`));

    const both = await launch(client, {
      directory: 'proj',
      resume_session_id: RESUMED,
      worktree: {},
    });
    expect(both.text).toMatch(/leave `worktree` out/);
  });

  it('a CLI that exits as it starts fails the launch with what it said', async () => {
    const { client } = await caller();
    useClaude('#!/bin/sh\necho "error: unknown option --model"\nexit 2\n');
    const reply = await launch(client, { directory: 'proj', model: 'opus' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/exited as it started \(code 2\)/);
    expect(reply.text).toContain('unknown option --model');
  });

  it('a CLI that never draws within the time limit fails the launch, naming the agent', async () => {
    useClaude('#!/bin/sh\nsleep 5\n');
    const outcome = await launchForOffice(
      {
        store: h.store,
        runtime: h.runtime,
        ptyManager: h.ptyManager,
        provider: claudeProvider,
        hostDirectories: [{ name: 'proj', path: h.workspace }],
      },
      { directory: 'proj', asks: {} },
      1_000,
    );
    expect(outcome.ok).toBe(false);
    const id = [...h.store.keys()][0];
    expect(!outcome.ok && outcome.reason).toBe(
      `Agent ${id} was launched, but its CLI hasn't started within 1 s: read its terminal (read_agent_terminal) or check list_agents.`,
    );
  });

  it('is refused while the Pixel Office MCP is read-only', async () => {
    const { client } = await caller();
    send({ type: 'setOfficeMcpReadOnly', readOnly: true });
    await waitFor(
      () => h.received.some((m) => m.type === 'officeMcpStatus' && m.readOnly === true),
      'read-only',
    );
    const before = h.store.size;
    const reply = await launch(client, { directory: 'proj' });
    expect(reply.isError).toBe(true);
    expect(h.store.size).toBe(before);
  });
});
