/**
 * The Pixel Office MCP's `visit` through its main seam: a composed standalone
 * server, agents launched over /ws (mock-claude in a real PTY), the MCP SDK
 * client with an agent's token, and offices on /ws recording what they are
 * told. Turns are driven the way the CLI drives them: hook events POSTed to
 * /api/hooks/claude.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogSource } from '../../core/src/layout/index.js';
import { VISIT_LINGER_MS } from '../../core/src/layout/index.js';
import { VISIT_WALK_ALLOWANCE_MS } from '../src/constants.js';
import { type Message, useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

/**
 * A 7×5 office: walls round a 4×3 room (cols 1-4, rows 1-3), a wall column at
 * col 5, and a floor pocket at col 6 (rows 1-2) no one can walk to. A chair
 * at (1,3) is the seat; a plant at (3,1).
 */
const W = 0;
const F = 1;
// prettier-ignore
const TILES = [
  W, W, W, W, W, W, W,
  W, F, F, F, F, W, F,
  W, F, F, F, F, W, F,
  W, F, F, F, F, W, W,
  W, W, W, W, W, W, W,
];
const CATALOG: CatalogSource[] = [
  { id: 'CHAIR', label: 'Chair', category: 'chairs', footprintW: 1, footprintH: 1, isDesk: false },
  { id: 'PLANT', label: 'Plant', category: 'decor', footprintW: 1, footprintH: 1, isDesk: false },
];
const LAYOUT = {
  version: 1,
  cols: 7,
  rows: 5,
  tiles: TILES,
  furniture: [
    { uid: 'chair-1', type: 'CHAIR', col: 1, row: 3 },
    { uid: 'chair-2', type: 'CHAIR', col: 4, row: 3 },
    { uid: 'plant-1', type: 'PLANT', col: 3, row: 1 },
  ],
};

describe('Pixel Office MCP: visit', () => {
  let seated: Record<number, { seatId: string }>;
  beforeEach(() => {
    seated = {};
  });

  const h = useStandaloneOffice({
    name: 'pxl-visit',
    layout: () => LAYOUT,
    catalog: () => CATALOG,
    forwardHooks: true,
    grant: true,
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const { send, hook } = h;
  const connectOffice = () => h.connectOffice();

  // ── Helpers ─────────────────────────────────────────────────

  /** Launch an agent from the office, seat it, and connect an MCP client with its token. */
  async function launchSeated(
    seatId: string,
  ): Promise<{ id: number; client: Awaited<ReturnType<typeof h.mcpClient>> }> {
    const launched = await h.launchFromOffice();
    const { id } = launched;
    // The office saves every agent's seat at once.
    seated[id] = { seatId };
    send({ type: 'saveAgentSeats', seats: seated });
    await waitFor(() => h.store.getAdapter()?.loadSeats()[String(id)]?.seatId, 'the seat save');
    return { id, client: await h.connectAs(launched) };
  }

  const callVisit = (
    client: Awaited<ReturnType<typeof h.mcpClient>>,
    args: Record<string, unknown>,
  ) => h.callTool(client, 'visit', args);

  async function me(client: Awaited<ReturnType<typeof h.mcpClient>>, id: number): Promise<Message> {
    return (await h.listAgents(client)).find((a) => a.id === id)!;
  }

  function visits(messages: Message[], id: number): Message[] {
    return messages.filter((m) => m.type === 'agentVisit' && m.id === id);
  }

  let toolSeq = 0;
  /** The agent's turn is under way: it runs a tool. */
  async function working(id: number): Promise<void> {
    const before = h.received.length;
    await hook(id, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_use_id: `toolu_${++toolSeq}`,
    });
    await waitFor(
      () => h.received.slice(before).some((m) => m.type === 'agentStatus' && m.status === 'active'),
      'the turn to show',
    );
  }

  /** The agent's turn ended. */
  async function turnEnds(id: number): Promise<void> {
    const before = h.received.length;
    await hook(id, { hook_event_name: 'Stop' });
    await waitFor(
      () =>
        h.received.slice(before).some((m) => m.type === 'agentStatus' && m.status === 'waiting'),
      'the turn to end',
    );
  }

  // ── Tiles ───────────────────────────────────────────────────

  it('sends the caller to a tile facing a way: every office is told, list_agents says visiting, a later office gets it in its snapshot', async () => {
    const { id, client } = await launchSeated('chair-1');
    const other = await connectOffice();

    const result = await callVisit(client, { to: { col: 4, row: 2, facing: 'left' } });
    expect(result).toMatchObject({
      isError: false,
      value: { agent_id: id, tile: { col: 4, row: 2 }, facing: 'left', stay: false },
    });
    const expected = {
      type: 'agentVisit',
      id,
      to: { col: 4, row: 2 },
      facing: 'left',
      stay: false,
    };
    await waitFor(() => visits(h.received, id).length > 0, 'the broadcast');
    expect(visits(h.received, id).at(-1)).toEqual(expected);
    await waitFor(() => visits(other.received, id).length > 0, 'the second office');
    expect(visits(other.received, id).at(-1)).toEqual(expected);

    expect(await me(client, id)).toMatchObject({
      at_desk: false,
      visit: { tile: { col: 4, row: 2 }, facing: 'left', stay: false },
      seat: { id: 'chair-1', tile: { col: 1, row: 3 } },
    });

    const later = await connectOffice();
    await waitFor(() => visits(later.received, id).length > 0, 'the snapshot visit');
    expect(visits(later.received, id).at(-1)).toEqual(expected);
  });

  it("sends another agent's character, by id", async () => {
    const { client } = await launchSeated('chair-1');
    const { id: otherId, client: otherClient } = await launchSeated('chair-2');

    const result = await callVisit(client, {
      agent_id: otherId,
      to: { col: 2, row: 1, facing: 'down' },
      stay: true,
    });
    expect(result.value).toMatchObject({ agent_id: otherId, stay: true });
    await waitFor(() => visits(h.received, otherId).length > 0, 'the broadcast');
    expect(visits(h.received, otherId).at(-1)).toMatchObject({ stay: true, facing: 'down' });
    expect(await me(otherClient, otherId)).toMatchObject({ at_desk: false });
  });

  // ── Furniture ───────────────────────────────────────────────

  it('resolves a piece of furniture to the nearest free tile beside it, facing it', async () => {
    const { id, client } = await launchSeated('chair-1');
    // Beside the plant at (3,1): (2,1), (4,1) and (3,2). (3,2) and (2,1) are
    // equally near the seat; standing in front (below, facing up) wins.
    const first = await callVisit(client, { to: { furniture_uid: 'plant-1' }, stay: true });
    expect(first.value).toMatchObject({ tile: { col: 3, row: 2 }, facing: 'up', stay: true });
    await waitFor(() => visits(h.received, id).length > 0, 'the broadcast');
    expect(visits(h.received, id).at(-1)).toEqual({
      type: 'agentVisit',
      id,
      to: { col: 3, row: 2 },
      facing: 'up',
      stay: true,
    });

    // That spot is taken now: a second visitor gets the next one, facing the plant.
    const { client: second } = await launchSeated('chair-2');
    const next = await callVisit(second, { to: { furniture_uid: 'plant-1' } });
    expect(next.value).toMatchObject({ tile: { col: 4, row: 1 }, facing: 'left' });
  });

  // ── Refusals ────────────────────────────────────────────────

  it('refuses out-of-grid, unwalkable, unreachable and taken tiles, unknown furniture and non-agents, with reasons', async () => {
    const { id, client } = await launchSeated('chair-1');

    const outside = await callVisit(client, { to: { col: 9, row: 2, facing: 'up' } });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('outside the office');
    expect(outside.text).toContain('7 columns by 5 rows');

    const wall = await callVisit(client, { to: { col: 0, row: 0, facing: 'up' } });
    expect(wall.isError).toBe(true);
    expect(wall.text).toContain('wall, empty space or under furniture');

    const plant = await callVisit(client, { to: { col: 3, row: 1, facing: 'up' } });
    expect(plant.text).toContain('under furniture');

    const pocket = await callVisit(client, { to: { col: 6, row: 1, facing: 'up' } });
    expect(pocket.isError).toBe(true);
    expect(pocket.text).toContain(`can't be reached from agent ${id}'s seat`);

    const unknown = await callVisit(client, { to: { furniture_uid: 'nope' } });
    expect(unknown.text).toContain('No furniture with uid "nope"');

    const subagent = await callVisit(client, {
      agent_id: -1,
      to: { col: 2, row: 2, facing: 'up' },
    });
    expect(subagent.isError).toBe(true);
    expect(subagent.text).toContain('sub-agents are not agents');

    const { id: otherId, client: other } = await launchSeated('chair-2');
    await callVisit(other, { to: { col: 2, row: 2, facing: 'up' }, stay: true });
    const taken = await callVisit(client, { to: { col: 2, row: 2, facing: 'down' } });
    expect(taken.text).toContain(`Agent ${otherId}'s character is visiting tile (2, 2)`);

    // A bad facing never reaches the office.
    const facing = await callVisit(client, { to: { col: 2, row: 1, facing: 'north' } });
    expect(facing.isError).toBe(true);

    // Nothing refused was broadcast.
    expect(visits(h.received, id)).toEqual([]);
  });

  // ── How long a visit holds ──────────────────────────────────

  it("a visit holds until the agent's next turn, which clears it in every office and in the snapshot", async () => {
    const { id, client } = await launchSeated('chair-1');
    await callVisit(client, { to: { col: 2, row: 1, facing: 'down' }, stay: true });
    await waitFor(() => visits(h.received, id).length > 0, 'the visit');

    await working(id);
    await waitFor(() => visits(h.received, id).some((m) => m.cleared === true), 'the clear');
    expect(visits(h.received, id).at(-1)).toEqual({ type: 'agentVisit', id, cleared: true });
    expect(await me(client, id)).toMatchObject({ at_desk: true, visit: null });

    const later = await connectOffice();
    await waitFor(() => visits(later.received, id).length > 0, 'the snapshot');
    expect(visits(later.received, id)).toEqual([{ type: 'agentVisit', id, cleared: true }]);
  });

  it('a visit asked during a turn outlasts that turn and ends with the next one', async () => {
    const { id, client } = await launchSeated('chair-1');
    await working(id);
    await callVisit(client, { to: { col: 2, row: 1, facing: 'down' }, stay: true });
    await waitFor(() => visits(h.received, id).length > 0, 'the visit');

    await working(id); // the same turn goes on
    await turnEnds(id);
    expect(visits(h.received, id).some((m) => m.cleared)).toBe(false);
    expect(await me(client, id)).toMatchObject({ at_desk: false });

    await working(id); // the next turn
    await waitFor(() => visits(h.received, id).some((m) => m.cleared === true), 'the clear');
    expect(await me(client, id)).toMatchObject({ at_desk: true });
  });

  it('a visit without stay is over once its walk and linger are: a later office does not replay it', async () => {
    const { id, client } = await launchSeated('chair-1');
    vi.useFakeTimers({ toFake: ['Date'] });
    const asked = Date.now();
    await callVisit(client, { to: { col: 2, row: 1, facing: 'down' } });
    await waitFor(() => visits(h.received, id).length > 0, 'the visit');

    vi.setSystemTime(asked + VISIT_WALK_ALLOWANCE_MS + VISIT_LINGER_MS - 1000);
    expect(await me(client, id)).toMatchObject({ at_desk: false });

    vi.setSystemTime(asked + VISIT_WALK_ALLOWANCE_MS + VISIT_LINGER_MS + 1000);
    expect(await me(client, id)).toMatchObject({ at_desk: true, visit: null });
    const later = await connectOffice();
    await waitFor(() => visits(later.received, id).length > 0, 'the snapshot');
    expect(visits(later.received, id)).toEqual([{ type: 'agentVisit', id, cleared: true }]);
    // A stay visit has no such end.
    await callVisit(client, { to: { col: 2, row: 1, facing: 'down' }, stay: true });
    vi.setSystemTime(asked + 10 * (VISIT_WALK_ALLOWANCE_MS + VISIT_LINGER_MS));
    expect(await me(client, id)).toMatchObject({ at_desk: false });
  });

  // ── For messaging (no tool of its own): a spot beside an agent ─

  it("resolves a spot beside an agent's seat, facing it, nearest the visitor", async () => {
    const { id: host } = await launchSeated('chair-1');
    const { id: visitor } = await launchSeated('chair-2');
    // Beside the seat at (1,3): (1,2) and (2,3); (2,3) is nearer chair-2 at (4,3).
    expect(h.office.visits.spotBesideAgent(host, visitor)).toEqual({
      col: 2,
      row: 3,
      facing: 'left',
    });
    // Taken by a visit: the other one.
    h.office.visits.visit(
      visitor,
      { tile: { col: 2, row: 3 }, facing: 'left' },
      { stay: true, caller: visitor },
    );
    expect(h.office.visits.spotBesideAgent(host)).toEqual({ col: 1, row: 2, facing: 'down' });
    expect(h.office.visits.spotBesideAgent(999)).toBeNull();
  });

  it('refuses to send another agent while it is working; an agent may send itself mid-turn', async () => {
    const { id: busy, client: busyClient } = await launchSeated('chair-1');
    const { client } = await launchSeated('chair-2');
    await working(busy);
    const refused = await callVisit(client, {
      agent_id: busy,
      to: { col: 2, row: 1, facing: 'down' },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`Agent ${busy} is working`);
    expect(visits(h.received, busy)).toEqual([]);

    const self = await callVisit(busyClient, { to: { col: 2, row: 1, facing: 'down' } });
    expect(self.isError).toBe(false);

    await turnEnds(busy);
    const later = await callVisit(client, {
      agent_id: busy,
      to: { col: 3, row: 2, facing: 'up' },
    });
    expect(later.isError).toBe(false);
  });
});
