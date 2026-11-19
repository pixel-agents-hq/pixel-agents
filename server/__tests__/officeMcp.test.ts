/**
 * The Pixel Office MCP through its main seam: a composed standalone server
 * (PixelAgentsServer + runtime + the real PTY manager), agents launched over
 * /ws exactly as the office launches them — mock-claude in a real PTY — and
 * the MCP SDK's own client talking to /mcp with the token an agent was given.
 * Asserted only from outside: what the launched CLI was handed, what the
 * config file holds, what an MCP client gets back, what the office is told.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CatalogSource } from '../../core/src/layout/index.js';
import { setOfficeMcpConsent } from '../src/configPersistence.js';
import { defineTool, ok } from '../src/mcp/tool.js';
import { OFFICE_TOOLS } from '../src/mcp/tools/index.js';
import { claudeProvider } from '../src/providers/index.js';
import { useStandaloneOffice, waitFor } from './helpers/officeMcpHarness.js';

/** An Area's colour (any; only its label matters here). */
const AREA_COLOR = ['#', '0000ff'].join('');
const SESSION_ID = '6f0d6c1e-58a5-4f53-9a3c-2f5e0a7b9c11';

/** A changing tool, to pin the read-only gate before any real one exists. */
const pokeTool = defineTool({
  name: 'poke',
  title: 'Poke',
  description: 'Test-only changing tool.',
  input: { agent_id: z.number().int().optional() },
  changes: true,
  uses: [],
  run: ({ agent_id }, { target }) => ok({ poked: target(agent_id) }),
});

describe('Pixel Office MCP (composed server, mock-claude launches)', () => {
  /** What the office's layout and catalog read (null / none unless a test sets them). */
  let layoutJson: Record<string, unknown> | null;
  let catalog: CatalogSource[];
  beforeEach(() => {
    layoutJson = null;
    catalog = [];
  });

  const h = useStandaloneOffice({
    layout: () => layoutJson,
    catalog: () => catalog,
    tools: [...OFFICE_TOOLS, pokeTool],
  });
  const { send, answer, invocations, mcpConfigPath, tokenIn, mcpClient, listAgents } = h;

  // ── Helpers ─────────────────────────────────────────────────

  /** Launch from the office (a drawer row) and wait for the CLI to start. */
  const launch = () => h.launchFromOffice();

  /** A raw initialize, for refusals the SDK client would only throw on. */
  function rawInitialize(headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      }),
    });
  }

  /** Files under ~/.claude that name the Pixel Office MCP (mock-claude's own
   *  transcripts live there too, and must not). */
  function claudeFilesNamingTheMcp(): string[] {
    const dir = path.join(h.home, '.claude');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { recursive: true })
      .map((f) => path.join(dir, String(f)))
      .filter((f) => fs.statSync(f).isFile())
      .filter((f) => /pixel-office|\/mcp\b/.test(fs.readFileSync(f, 'utf8')));
  }

  // ── Consent ─────────────────────────────────────────────────

  it('asks a privileged office (after the hooks ask) and never a read-only one', async () => {
    await waitFor(() => h.received.find((m) => m.type === 'officeMcpConsentRequest'), 'the ask');
    const status = h.received.find((m) => m.type === 'officeMcpStatus');
    expect(status).toMatchObject({ consent: 'unanswered', readOnly: false });
    // The hooks ask (nothing installed here) comes first: the tour opens on it.
    const types = h.received.map((m) => m.type);
    expect(types.indexOf('hooksConsentRequest')).toBeGreaterThan(-1);
    expect(types.indexOf('hooksConsentRequest')).toBeLessThan(
      types.indexOf('officeMcpConsentRequest'),
    );

    const spectator = await h.connectOffice({ privileged: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(spectator.received.some((m) => String(m.type).startsWith('officeMcp'))).toBe(false);
    // Its answer is refused: still unanswered.
    spectator.socket.send(JSON.stringify({ type: 'officeMcpConsentResponse', choice: 'allow' }));
    await new Promise((r) => setTimeout(r, 200));
    spectator.socket.close();
    const again = await h.connectOffice();
    await waitFor(
      () => again.received.find((m) => m.type === 'officeMcpConsentRequest'),
      'the ask',
    );
    again.socket.close();
  });

  it('unanswered or declined: launches get no --mcp-config and nothing is written to ~/.claude', async () => {
    const first = await launch();
    expect(first.args).not.toContain('--mcp-config');

    await answer('decline');
    const second = await launch();
    expect(second.args).not.toContain('--mcp-config');
    expect(fs.existsSync(path.join(h.home, '.pixel-agents', 'mcp'))).toBe(false);
    expect(claudeFilesNamingTheMcp()).toEqual([]);
    expect(fs.existsSync(path.join(h.home, '.claude', 'settings.json'))).toBe(false);

    // Answered: not asked again.
    const again = await h.connectOffice();
    await new Promise((r) => setTimeout(r, 200));
    expect(again.received.some((m) => m.type === 'officeMcpConsentRequest')).toBe(false);
    again.socket.close();
  });

  it('Back revises: allow then decline, and decline then allow, each an absolute state', async () => {
    await answer('allow');
    const granted = await launch();
    const file = mcpConfigPath(granted.args)!;
    const token = tokenIn(file);
    expect((await rawInitialize({ Authorization: `Bearer ${token}` })).status).toBe(200);

    await answer('decline');
    expect(fs.existsSync(file)).toBe(false);
    expect((await rawInitialize({ Authorization: `Bearer ${token}` })).status).toBe(401);

    await answer('allow');
    const regranted = await launch();
    expect(mcpConfigPath(regranted.args)).not.toBeNull();
    const config = JSON.parse(
      fs.readFileSync(path.join(h.home, '.pixel-agents', 'config.json'), 'utf8'),
    );
    expect(config.officeMcpConsent).toBe('granted');
  });

  it('not now leaves it unanswered, revoking an earlier allow, and the ask returns', async () => {
    await answer('allow');
    const granted = await launch();
    const token = tokenIn(mcpConfigPath(granted.args)!);

    await answer('notNow');
    expect((await rawInitialize({ Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await launch()).args).not.toContain('--mcp-config');
    const config = JSON.parse(
      fs.readFileSync(path.join(h.home, '.pixel-agents', 'config.json'), 'utf8'),
    );
    expect('officeMcpConsent' in config).toBe(false);
    const again = await h.connectOffice();
    await waitFor(
      () => again.received.find((m) => m.type === 'officeMcpConsentRequest'),
      'the ask again',
    );
    again.socket.close();
  });

  // ── Injection + list_agents ─────────────────────────────────

  it('a granted launch lists the office through list_agents and is marked as itself', async () => {
    await answer('allow');
    const me = await launch();
    const other = await launch();

    const file = mcpConfigPath(me.args);
    expect(file).not.toBeNull();
    // 0600, holds the endpoint and its own token, never the server's.
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file!, 'utf8');
    expect(raw).not.toContain(h.token);
    const config = JSON.parse(raw) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(config.mcpServers['pixel-office']).toMatchObject({
      type: 'http',
      url: `http://127.0.0.1:${h.port}/mcp`,
    });
    const token = tokenIn(file!);
    // The token is never on the command line.
    expect(me.args).not.toContain(token);
    expect(mcpConfigPath(other.args)).not.toBe(file);
    expect(tokenIn(mcpConfigPath(other.args)!)).not.toBe(token);

    const client = await mcpClient(token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('list_agents');

    const agents = await listAgents(client);
    expect(agents.map((a) => a.id).sort()).toEqual([me.id, other.id].sort());
    const mine = agents.find((a) => a.id === me.id)!;
    expect(mine.you).toBe(true);
    expect(agents.find((a) => a.id === other.id)!.you).toBeUndefined();
    expect(mine).toMatchObject({
      nickname: null,
      directory: { name: 'proj', path: h.workspace },
      working_directory: h.workspace,
      worktree: null,
      lead_id: null,
      teammates: [],
      at_desk: true,
      messageable: true,
    });
    expect(['active', 'done', 'waiting for input', 'permission request']).toContain(mine.status);
    expect(String(mine.transcript_path)).toMatch(/\.jsonl$/);
    expect(mine.character).toMatchObject({ palette: expect.any(Number) });

    // The other agent's token sees the same office, itself marked.
    const otherAgents = await listAgents(await mcpClient(tokenIn(mcpConfigPath(other.args)!)));
    expect(otherAgents.find((a) => a.id === other.id)!.you).toBe(true);
  });

  it("list_agents places an agent: its seat's tile and the Area holding it", async () => {
    // A two-seat sofa at (2,1) whose top row is background: seats (2,2) and (3,2).
    catalog = [
      {
        id: 'SOFA',
        label: 'Sofa',
        category: 'chairs',
        footprintW: 2,
        footprintH: 2,
        isDesk: false,
        backgroundTiles: 1,
      },
    ];
    const areaTiles: Array<string | null> = new Array(5 * 4).fill(null);
    areaTiles[2 * 5 + 3] = 'Blue room';
    layoutJson = {
      version: 1,
      cols: 5,
      rows: 4,
      tiles: new Array(5 * 4).fill(1),
      furniture: [{ uid: 'sofa-1', type: 'SOFA', col: 2, row: 1 }],
      areas: [{ label: 'Blue room', color: AREA_COLOR }],
      areaTiles,
    };
    await answer('allow');
    const { id, args } = await launch();
    // The office seats it (seats are decided client-side and saved back).
    send({ type: 'saveAgentSeats', seats: { [id]: { seatId: 'sofa-1:1' } } });
    await waitFor(() => h.store.getAdapter()?.loadSeats()[String(id)]?.seatId, 'the seat save');

    const [me] = await listAgents(await mcpClient(tokenIn(mcpConfigPath(args)!)));
    expect(me.seat).toEqual({ id: 'sofa-1:1', tile: { col: 3, row: 2 }, area: 'Blue room' });
  });

  it('a resume from the conversation list gets the MCP like a launch', async () => {
    await answer('allow');
    const sessionDir = claudeProvider.getSessionDirs!(h.workspace)[0];
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, `${SESSION_ID}.jsonl`), '{"type":"user"}\n');

    const before = invocations().length;
    send({ type: 'resumeConversation', sessionId: SESSION_ID, directoryPath: h.workspace });
    const line = await waitFor(() => invocations()[before], 'the resume to start');
    expect(line).toContain(`--resume ${SESSION_ID}`);
    const file = mcpConfigPath(line);
    expect(file).not.toBeNull();
    const agents = await listAgents(await mcpClient(tokenIn(file!)));
    expect(agents.find((a) => a.you === true)).toBeTruthy();
  });

  // ── Token scoping ───────────────────────────────────────────

  it('refuses no token, an unknown token, a browser, and the token of an agent that left', async () => {
    await answer('allow');
    const { id, args } = await launch();
    const token = tokenIn(mcpConfigPath(args)!);

    expect((await rawInitialize({})).status).toBe(401);
    expect((await rawInitialize({ Authorization: 'Bearer nope' })).status).toBe(401);
    // The server's own token is no MCP token.
    expect((await rawInitialize({ Authorization: `Bearer ${h.token}` })).status).toBe(401);
    expect(
      (await rawInitialize({ Authorization: `Bearer ${token}`, Origin: 'http://evil.test' }))
        .status,
    ).toBe(403);
    expect((await rawInitialize({ Authorization: `Bearer ${token}` })).status).toBe(200);

    send({ type: 'closeAgent', id });
    await waitFor(() => !h.store.has(id), 'the agent to leave');
    expect((await rawInitialize({ Authorization: `Bearer ${token}` })).status).toBe(401);
    expect(fs.existsSync(mcpConfigPath(args)!)).toBe(false);
  });

  it('turning it off in Settings revokes every token at once', async () => {
    send({ type: 'setOfficeMcpEnabled', enabled: true });
    await waitFor(
      () => h.received.find((m) => m.type === 'officeMcpStatus' && m.consent === 'granted'),
      'the grant',
    );
    const a = tokenIn(mcpConfigPath((await launch()).args)!);
    const b = tokenIn(mcpConfigPath((await launch()).args)!);
    expect((await rawInitialize({ Authorization: `Bearer ${a}` })).status).toBe(200);

    send({ type: 'setOfficeMcpEnabled', enabled: false });
    await waitFor(
      () => h.received.find((m) => m.type === 'officeMcpStatus' && m.consent === 'declined'),
      'the decline',
    );
    expect((await rawInitialize({ Authorization: `Bearer ${a}` })).status).toBe(401);
    expect((await rawInitialize({ Authorization: `Bearer ${b}` })).status).toBe(401);
  });

  it('read-only keeps list tools working and refuses changing ones with a reason, at once', async () => {
    await answer('allow');
    const { id, args } = await launch();
    const client = await mcpClient(tokenIn(mcpConfigPath(args)!));

    const poked = await client.callTool({ name: 'poke', arguments: {} });
    expect(poked.isError).toBeFalsy();
    // The target defaults to the caller.
    expect(JSON.parse((poked.content as Array<{ text: string }>)[0].text)).toEqual({ poked: id });

    send({ type: 'setOfficeMcpReadOnly', readOnly: true });
    await waitFor(
      () => h.received.find((m) => m.type === 'officeMcpStatus' && m.readOnly === true),
      'read-only',
    );
    expect((await listAgents(client)).length).toBe(1);
    const refused = await client.callTool({ name: 'poke', arguments: { agent_id: 7 } });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0].text).toContain(
      'read-only in Pixel Agents settings',
    );

    send({ type: 'setOfficeMcpReadOnly', readOnly: false });
    await waitFor(
      () =>
        h.received.filter((m) => m.type === 'officeMcpStatus' && m.readOnly === false).length > 1,
      'read-only off',
    );
    const again = await client.callTool({ name: 'poke', arguments: { agent_id: 7 } });
    expect(JSON.parse((again.content as Array<{ text: string }>)[0].text)).toEqual({ poked: 7 });
  });

  it('dies with the server: stopping removes every config file', async () => {
    await answer('allow');
    const file = mcpConfigPath((await launch()).args)!;
    expect(fs.existsSync(file)).toBe(true);
    h.officeMcp.dispose();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('Pixel Office MCP with a CLI that takes no MCP config file', () => {
  const h = useStandaloneOffice({
    name: 'pxl-office-mcp-nofile',
    provider: { ...claudeProvider, mcpConfigFile: undefined },
  });

  it('granted, a launch still gets no --mcp-config, no file and no token', async () => {
    setOfficeMcpConsent('granted');
    const launched = await h.launchFromOffice();
    expect(launched.args).not.toContain('--mcp-config');
    expect(h.officeMcp.configFor(launched.id)).toBeUndefined();
    // No file written, so no token was minted to put in one.
    expect(fs.existsSync(path.join(h.home, '.pixel-agents', 'mcp'))).toBe(false);
  });
});
