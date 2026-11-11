/**
 * The Pixel Office MCP's `close_agent` through its main seam: a composed
 * standalone server, agents launched over /ws (mock-claude in a real PTY,
 * into real git Worktrees where it matters), the MCP SDK client with an
 * agent's token, and an office on /ws recording what it is told. Also
 * list_agents' status for an agent driven by hooks alone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { readRegistry } from '../src/worktreeRegistry.js';
import { gitIn, gitOk, makeRepo, removeTempRepos, writeFile } from './fixtures/gitRepos.js';
import { type Message, useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

describe('Pixel Office MCP: close_agent', () => {
  const h = useStandaloneOffice({
    name: 'pxl-close',
    close: true,
    holdWorktrees: true,
    forwardHooks: true,
    grant: true,
  });
  afterEach(() => removeTempRepos());
  const { send, hook } = h;

  // ── Helpers ─────────────────────────────────────────────────

  /** Launch an agent from the office (into a new Worktree of `repo` when
   *  given) and connect an MCP client with its token. */
  const launch = (repo?: string) => h.launchAgent({ repo });
  const call = h.callTool;
  const listed = h.listAgents;

  /** A Directory that is a git repo, and an agent launched into a new Worktree of it. */
  async function launchInWorktree(): Promise<{
    id: number;
    client: Awaited<ReturnType<typeof launch>>['client'];
    repo: string;
    worktree: { path: string; branch: string; name: string };
  }> {
    const repo = makeRepo();
    send({ type: 'saveDirectory', name: 'Repo', path: repo });
    await waitFor(() => h.received.some((m) => m.type === 'directorySaved'), 'the Directory');
    const { id, client } = await launch(repo);
    const entry = await waitFor(() => readRegistry()[0], 'the Worktree');
    return { id, client, repo, worktree: entry };
  }

  const closedNotice = (id: number) => (m: Message) => m.type === 'agentClosed' && m.id === id;
  const stateOf = (worktreePath: string) =>
    readRegistry().find((e) => e.path === worktreePath)?.state;

  // ── Main agents ─────────────────────────────────────────────

  it('closes another main agent: its terminal ends and it leaves every office', async () => {
    const { client } = await launch();
    const { id: otherId } = await launch();

    const result = await call(client, 'close_agent', { agent_id: otherId });
    expect(result).toMatchObject({
      isError: false,
      value: { agent_id: otherId, closed: true, how: 'its terminal was ended' },
    });
    await waitFor(() => h.received.some(closedNotice(otherId)), 'agentClosed');
    await waitFor(
      () => h.received.some((m) => m.type === 'terminalSessionClosed' && m.agentId === otherId),
      'its terminal to end',
    );
    expect((await listed(client)).map((a) => a.id)).not.toContain(otherId);
  });

  it('closes yourself: the reply comes first, then you leave the office', async () => {
    const { id, client } = await launch();

    const result = await call(client, 'close_agent');
    expect(result.value).toMatchObject({
      agent_id: id,
      closed: true,
      you: true,
      closes_after_reply: true,
    });
    // Still here when the reply arrived: nothing was cut short.
    expect(h.received.some(closedNotice(id))).toBe(false);
    expect(h.store.has(id)).toBe(true);
    // Its turn ends (the CLI wrote the reply into its transcript): it leaves.
    await hook(id, { hook_event_name: 'Stop' });
    await waitFor(() => h.received.some(closedNotice(id)), 'agentClosed');
    // Its token went with it.
    const after = await client.callTool({ name: 'list_agents', arguments: {} }).catch((e) => e);
    expect(after instanceof Error || (after as { isError?: boolean }).isError === true).toBe(true);
  });

  it('closing yourself waits for your turn to end, however long the reply takes', async () => {
    const { id, client } = await launch();
    // The close_agent call is a tool of its turn.
    await hook(id, {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__pixel-office__close_agent',
      tool_input: {},
      tool_use_id: 'toolu_close',
    });
    expect((await call(client, 'close_agent')).value).toMatchObject({ closes_after_reply: true });

    // Well past the moment a fixed delay would have cut it off: still here,
    // its CLI still writing the turn.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(h.store.has(id)).toBe(true);
    expect(h.received.some(closedNotice(id))).toBe(false);

    await hook(id, { hook_event_name: 'Stop' });
    await waitFor(() => h.received.some(closedNotice(id)), 'agentClosed', 3_000);
  });

  it('closes an adopted agent the way its card does: it leaves the office, its session runs on', async () => {
    const { client } = await launch();
    h.store.set(
      500,
      createAgentState({
        id: 500,
        sessionId: 'adopted-1',
        isExternal: true,
        projectDir: path.join(h.home, '.claude', 'projects', 'x'),
        jsonlFile: path.join(h.home, '.claude', 'projects', 'x', 'adopted-1.jsonl'),
      }),
    );

    const result = await call(client, 'close_agent', { agent_id: 500 });
    expect(result.value).toMatchObject({
      agent_id: 500,
      closed: true,
      how: 'it left the office; its session runs on outside it',
    });
    await waitFor(() => h.received.some(closedNotice(500)), 'agentClosed');
  });

  // ── Refusals ────────────────────────────────────────────────

  it('refuses a Teammate, naming its lead, and leaves it in the office', async () => {
    const { id: leadId, client } = await launch();
    h.store.set(
      600,
      createAgentState({
        id: 600,
        sessionId: h.store.get(leadId)!.sessionId,
        isExternal: true,
        projectDir: '/p',
        jsonlFile: '/p/teammate.jsonl',
        leadAgentId: leadId,
        agentName: 'reviewer',
      }),
    );

    const result = await call(client, 'close_agent', { agent_id: 600 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Teammate');
    expect(result.text).toContain(`agent ${leadId}`);
    expect(result.text).toContain('reviewer');
    expect(h.store.has(600)).toBe(true);
  });

  it('refuses an id that is no agent (a sub-agent has none of its own)', async () => {
    const { client } = await launch();
    const result = await call(client, 'close_agent', { agent_id: 4242 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('no agent 4242');
    expect(result.text).toContain('Sub-agent');
  });

  it('closing a lead closes its Teammates with it', async () => {
    const { client } = await launch();
    const { id: leadId } = await launch();
    h.store.set(
      700,
      createAgentState({
        id: 700,
        sessionId: 'tm-1',
        isExternal: true,
        projectDir: '/p',
        jsonlFile: '/p/tm-1.jsonl',
        leadAgentId: leadId,
        agentName: 'helper',
      }),
    );

    const result = await call(client, 'close_agent', { agent_id: leadId });
    expect(result.value).toMatchObject({ agent_id: leadId, teammates_closed: [700] });
    await waitFor(() => h.received.some(closedNotice(700)), 'the teammate to go');
    await waitFor(() => h.received.some(closedNotice(leadId)), 'the lead to go');
  });

  // ── The Worktree question ───────────────────────────────────

  it('a Worktree with uncommitted files: refused with the count, the agent left running', async () => {
    const { client } = await launch();
    const { id, worktree } = await launchInWorktree();
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    const result = await call(client, 'close_agent', { agent_id: id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('1 uncommitted file');
    expect(result.text).toContain(worktree.branch);
    expect(result.text).toContain('worktree_choice');
    expect(result.text).toContain('confirmed_files: 1');
    expect(h.store.has(id)).toBe(true);
    expect(h.received.some(closedNotice(id))).toBe(false);
    expect(stateOf(worktree.path)).toBe('active');
  });

  it('save: closes it, and its leave commits the files and parks the branch', async () => {
    const { client } = await launch();
    const { id, repo, worktree } = await launchInWorktree();
    writeFile(worktree.path, 'notes.txt', 'hello\n');
    expect((await call(client, 'close_agent', { agent_id: id })).isError).toBe(true);

    const result = await call(client, 'close_agent', { agent_id: id, worktree_choice: 'save' });
    expect(result.value).toMatchObject({
      agent_id: id,
      closed: true,
      worktree: { name: worktree.name, branch: worktree.branch, choice: 'save' },
    });
    await waitFor(() => stateOf(worktree.path) === 'parked', 'the Worktree to be parked');
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(gitIn(repo, 'show', `${worktree.branch}:notes.txt`)).toBe('hello');
  });

  it('keep: closes it, and the folder stays as it is', async () => {
    const { client } = await launch();
    const { id, worktree } = await launchInWorktree();
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    const result = await call(client, 'close_agent', { agent_id: id, worktree_choice: 'keep' });
    expect(result.value).toMatchObject({ closed: true, worktree: { choice: 'keep' } });
    await waitFor(() => stateOf(worktree.path) === 'kept', 'the Worktree to be kept');
    expect(fs.readFileSync(path.join(worktree.path, 'notes.txt'), 'utf8')).toBe('hello\n');
  });

  it('discard: refused without the count and with a stale one; with the count it closes and the files go', async () => {
    const { client } = await launch();
    const { id, repo, worktree } = await launchInWorktree();
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    const noCount = await call(client, 'close_agent', {
      agent_id: id,
      worktree_choice: 'discard',
    });
    expect(noCount.isError).toBe(true);
    expect(noCount.text).toContain('confirmed_files');

    // The user agreed to 1; another file appeared since.
    writeFile(worktree.path, 'more.txt', 'more\n');
    const stale = await call(client, 'close_agent', {
      agent_id: id,
      worktree_choice: 'discard',
      confirmed_files: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('now has 2 uncommitted files');
    expect(stale.text).toContain('confirmed_files: 2');
    expect(h.store.has(id)).toBe(true);

    const result = await call(client, 'close_agent', {
      agent_id: id,
      worktree_choice: 'discard',
      confirmed_files: 2,
    });
    expect(result.value).toMatchObject({ closed: true, worktree: { choice: 'discard' } });
    await waitFor(() => readRegistry().length === 0, 'the Worktree to go');
    expect(fs.existsSync(worktree.path)).toBe(false);
    expect(gitOk(repo, 'rev-parse', '--verify', worktree.branch)).toBe(false);
  });

  it('closing yourself out of a Worktree asks too, and the answer closes you after the reply', async () => {
    const { id, client, worktree } = await launchInWorktree();
    writeFile(worktree.path, 'notes.txt', 'hello\n');

    expect((await call(client, 'close_agent')).text).toContain('1 uncommitted file');
    const result = await call(client, 'close_agent', { worktree_choice: 'keep' });
    expect(result.value).toMatchObject({ agent_id: id, closes_after_reply: true });
    await hook(id, { hook_event_name: 'Stop' });
    await waitFor(() => h.received.some(closedNotice(id)), 'agentClosed');
    await waitFor(() => stateOf(worktree.path) === 'kept', 'the Worktree to be kept');
  });

  // ── list_agents' status, hooks alone ────────────────────────

  it("reads a hook-driven agent's status as the offices are told it", async () => {
    const { id, client } = await launch();
    const status = async () => (await listed(client)).find((a) => a.id === id)!.status;
    expect(await status()).toBe('waiting for input');

    await hook(id, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_use_id: 'toolu_1',
    });
    await waitFor(
      () =>
        h.received.some((m) => m.type === 'agentStatus' && m.id === id && m.status === 'active'),
      'the turn to show',
    );
    expect(await status()).toBe('active');

    await hook(id, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_use_id: 'toolu_1',
    });
    expect(await status()).toBe('active');

    await hook(id, {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    await waitFor(
      () => h.received.some((m) => m.type === 'agentToolPermission' && m.id === id),
      'the bubble',
    );
    expect(await status()).toBe('permission request');

    await hook(id, { hook_event_name: 'Stop' });
    await waitFor(
      () =>
        h.received.some((m) => m.type === 'agentStatus' && m.id === id && m.status === 'waiting'),
      'the turn to end',
    );
    expect(await status()).toBe('done');

    await hook(id, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Claude is waiting for your input',
    });
    await waitFor(
      () => h.received.some((m) => m.type === 'agentStatus' && m.id === id && m.awaitingInput),
      'the idle prompt',
    );
    expect(await status()).toBe('waiting for input');
  });
});
