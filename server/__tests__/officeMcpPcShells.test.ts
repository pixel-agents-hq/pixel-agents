/**
 * PC shells over the Pixel Office MCP (the `shells` capability, standalone
 * only): an agent launched by a composed standalone office opens a shell at a
 * PC through the real /mcp endpoint, types into it, reads it back and closes
 * it — real PTYs, a real /bin/sh. What the user's office sees is the same as
 * for a shell it opened itself (pcShellsLoaded), minus the pcShellReady that
 * would make its drawer jump. Read-only narrows the tools as for any other.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { PC_SHELL_ID_BASE } from '../../core/src/constants.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import { foregroundOf } from '../src/terminal/pcShells.js';
import { TUTORIAL_PREAPPROVED_TOOLS } from '../src/tutorial/tutorialCopy.js';
import {
  type Json,
  loadBundledAssets,
  seededLayout,
  seedLayoutFile,
  useStandaloneOffice,
  waitFor,
} from './helpers/officeMcpHarness.js';
import { A_DESK, FRONT_PC, OTHER_PC, pcShellDriver } from './helpers/pcShellDriver.js';

const SHELL_TOOLS = [
  'list_pc_shells',
  'open_pc_shell',
  'read_pc_shell',
  'type_in_pc_shell',
  'close_pc_shell',
];

let catalog: Awaited<ReturnType<typeof loadBundledAssets>>['furniture']['catalog'] = [];
beforeAll(async () => {
  catalog = (await loadBundledAssets()).furniture.catalog;
});

/** Add a user Directory mapped to `area`, as the Directory modal and the Area panel do. */
function addDirectoryIn(name: string, dir: string, area: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = readConfig();
  cfg.directories = [...cfg.directories, { name, path: dir }];
  cfg.standalone.areaMappings = { ...cfg.standalone.areaMappings, [name]: [area] };
  writeConfig(cfg);
}

describe('PC shells over the Pixel Office MCP', () => {
  const h = useStandaloneOffice({
    name: 'pxl-mcp-shell',
    env: { SHELL: '/bin/sh' },
    layout: 'file',
    catalog: () => catalog,
    prepare: ({ home }) => seedLayoutFile(home, seededLayout()),
    grant: true,
  });
  const shells = pcShellDriver(h);

  /** A tool's reply, asserted not an error. */
  const call = async (client: Parameters<typeof h.callTool>[0], name: string, args: Json = {}) => {
    const reply = await h.callToolCaught(client, name, args);
    expect(reply.isError, reply.text).toBe(false);
    return reply.value!;
  };

  /** Read the shell until `pattern` shows (output arrives asynchronously). */
  const readUntil = async (
    client: Parameters<typeof h.callTool>[0],
    id: number,
    pattern: RegExp,
  ): Promise<Json> =>
    waitFor(async () => {
      const read = await call(client, 'read_pc_shell', { shell_id: id });
      return pattern.test(String(read.screen)) ? read : undefined;
    }, `${pattern} on shell ${id}'s screen`);

  it("opens a shell at a PC that the user's office shows, types into it and reads it back", async () => {
    const agent = await h.launchAgent();
    const offered = (await agent.client.listTools()).tools.map((t) => t.name);
    for (const tool of SHELL_TOOLS) expect(offered).toContain(tool);

    const before = h.received.length;
    const opened = await call(agent.client, 'open_pc_shell', { furniture_uid: FRONT_PC });
    expect(opened).toEqual({
      shell_id: expect.any(Number),
      cwd: h.home,
      directory: null,
      already_open: false,
    });
    const id = opened.shell_id as number;
    expect(id).toBeGreaterThan(PC_SHELL_ID_BASE);

    // The office is told as for its own shell: the card and the lit PC.
    await waitFor(() => shells.shells()?.some((s) => s.id === id), 'the shell announced');
    expect(shells.shells()).toEqual([{ id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF' }]);
    // No office opened it: none is sent pcShellReady (no drawer jumps).
    await new Promise((r) => setTimeout(r, 200));
    expect(h.received.slice(before).some((m) => m.type === 'pcShellReady')).toBe(false);
    // Never an agent.
    expect(h.store.has(id)).toBe(false);

    // Typed and submitted; the output read back.
    expect(
      await call(agent.client, 'type_in_pc_shell', { shell_id: id, text: 'echo hi-from-agent' }),
    ).toEqual({ shell_id: id, typed: true });
    const read = await readUntil(agent.client, id, /^hi-from-agent$/m);
    expect(read.screen_token).toEqual(expect.any(String));
    // The user sees it in the shell's terminal too.
    const term = await shells.attach(id);
    await term.waitFor(/hi-from-agent/);
    term.close();

    // A second open is the PC's live shell.
    expect(await call(agent.client, 'open_pc_shell', { furniture_uid: FRONT_PC })).toMatchObject({
      shell_id: id,
      already_open: true,
    });

    // Listed with its PC; the layout's other PCs listed free, a desk not at all.
    const listed = await call(agent.client, 'list_pc_shells');
    expect(listed.shells).toEqual([
      { shell_id: id, furniture_uid: FRONT_PC, directory: null, cwd: h.home, busy: false },
    ]);
    const pcs = listed.pcs as Json[];
    expect(pcs.find((pc) => pc.furniture_uid === FRONT_PC)).toEqual({
      furniture_uid: FRONT_PC,
      area: 'Blue room',
      directories: [],
      shell_id: id,
    });
    expect(pcs.find((pc) => pc.furniture_uid === OTHER_PC)).toMatchObject({ shell_id: null });
    expect(pcs.some((pc) => pc.furniture_uid === A_DESK)).toBe(false);
  });

  it("opens in one of the PC's Area's Directories, and refuses what the office refuses", async () => {
    addDirectoryIn('a', path.join(h.home, 'a'), 'Blue room');
    addDirectoryIn('b', path.join(h.home, 'b'), 'Blue room');
    const agent = await h.launchAgent();

    const listed = await call(agent.client, 'list_pc_shells');
    expect((listed.pcs as Json[]).find((pc) => pc.furniture_uid === FRONT_PC)).toMatchObject({
      directories: ['a', 'b'],
    });

    expect(
      await call(agent.client, 'open_pc_shell', { furniture_uid: FRONT_PC, directory: 'b' }),
    ).toMatchObject({ cwd: path.join(h.home, 'b'), directory: 'b', already_open: false });

    for (const args of [
      { furniture_uid: OTHER_PC, directory: 'nowhere' },
      { furniture_uid: A_DESK },
      { furniture_uid: 'no-such-piece' },
    ]) {
      const refused = await h.callToolCaught(agent.client, 'open_pc_shell', args);
      expect(refused.isError, JSON.stringify(args)).toBe(true);
      expect(refused.text).toContain('list_pc_shells');
    }
    expect(h.pcShells.records()).toHaveLength(1);
  });

  it('asks before closing a shell running a command, stops it with ctrl+c, closes when confirmed', async () => {
    const agent = await h.launchAgent();
    const id = (await call(agent.client, 'open_pc_shell', { furniture_uid: FRONT_PC }))
      .shell_id as number;

    await call(agent.client, 'type_in_pc_shell', { shell_id: id, text: 'sleep 30' });
    // `sleep` takes the terminal's foreground once the shell has started it.
    await waitFor(async () => (await foregroundOf(h.ptyManager.get(id)!.pid))?.command, 'sleep');
    expect((await call(agent.client, 'list_pc_shells')).shells).toMatchObject([
      { shell_id: id, busy: true, command: 'sleep' },
    ]);

    const refused = await h.callToolCaught(agent.client, 'close_pc_shell', { shell_id: id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('`sleep`');
    expect(refused.text).toContain('confirmed: true');
    expect(h.pcShells.has(id)).toBe(true);

    // ctrl+c stops it (a shell's key; never a Message's).
    await call(agent.client, 'type_in_pc_shell', { shell_id: id, keys: ['ctrl+c'] });
    await waitFor(
      async () => (await foregroundOf(h.ptyManager.get(id)!.pid)) === null,
      'the shell idle again',
    );
    const message = await h.callToolCaught(agent.client, 'send_message', {
      to: [agent.id],
      keys: ['ctrl+c'],
      gist: 'stop',
    });
    expect(message.isError).toBe(true);

    await call(agent.client, 'type_in_pc_shell', { shell_id: id, text: 'sleep 30' });
    await waitFor(async () => (await foregroundOf(h.ptyManager.get(id)!.pid))?.command, 'sleep');
    expect(await call(agent.client, 'close_pc_shell', { shell_id: id, confirmed: true })).toEqual({
      shell_id: id,
      closed: true,
    });
    await waitFor(() => shells.shells()?.length === 0, 'the office told it closed');
    expect(h.pcShells.has(id)).toBe(false);

    // Gone: every tool says so.
    for (const [tool, args] of [
      ['read_pc_shell', { shell_id: id }],
      ['type_in_pc_shell', { shell_id: id, text: 'echo late' }],
      ['close_pc_shell', { shell_id: id }],
    ] as const) {
      const reply = await h.callToolCaught(agent.client, tool, args);
      expect(reply.isError, tool).toBe(true);
      expect(reply.text).toContain(`no PC shell ${id}`);
    }
  });

  it('read-only: the agent may list and read shells, not open, type into or close one', async () => {
    const agent = await h.launchAgent();
    const id = (await call(agent.client, 'open_pc_shell', { furniture_uid: FRONT_PC }))
      .shell_id as number;
    await call(agent.client, 'type_in_pc_shell', { shell_id: id, text: 'echo before-read-only' });
    await readUntil(agent.client, id, /^before-read-only$/m);

    h.send({ type: 'setOfficeMcpReadOnly', readOnly: true });
    await waitFor(
      () => h.received.find((m) => m.type === 'officeMcpStatus' && m.readOnly === true),
      'read-only',
    );
    for (const [tool, args] of [
      ['open_pc_shell', { furniture_uid: OTHER_PC }],
      ['type_in_pc_shell', { shell_id: id, text: 'touch pwned' }],
      ['close_pc_shell', { shell_id: id, confirmed: true }],
    ] as const) {
      const reply = await h.callToolCaught(agent.client, tool, args);
      expect(reply.isError, tool).toBe(true);
      expect(reply.text).toContain('read-only in Pixel Agents settings');
    }
    expect((await call(agent.client, 'list_pc_shells')).shells).toHaveLength(1);
    expect((await call(agent.client, 'read_pc_shell', { shell_id: id })).screen).toMatch(
      /^before-read-only$/m,
    );
    expect(h.pcShells.has(id)).toBe(true);
    expect(h.pcShells.records()).toHaveLength(1);
  });

  it("the shell tools never reach an agent's terminal, nor its tools a shell", async () => {
    const agent = await h.launchAgent();
    const id = (await call(agent.client, 'open_pc_shell', { furniture_uid: FRONT_PC }))
      .shell_id as number;
    const term = await shells.attach(id);

    // An agent's id is no shell.
    for (const [tool, args] of [
      ['read_pc_shell', { shell_id: agent.id }],
      ['type_in_pc_shell', { shell_id: agent.id, text: 'touch pwned' }],
      ['close_pc_shell', { shell_id: agent.id, confirmed: true }],
    ] as const) {
      const reply = await h.callToolCaught(agent.client, tool, args);
      expect(reply.isError, tool).toBe(true);
    }
    expect(h.store.has(agent.id)).toBe(true);

    // A shell's id is no agent.
    expect(
      (await h.callToolCaught(agent.client, 'read_agent_terminal', { agent_id: id })).isError,
    ).toBe(true);
    const sent = await h.callToolCaught(agent.client, 'send_message', {
      to: [id],
      text: 'touch pwned',
      gist: 'hi',
    });
    const results = sent.isError ? [] : ((sent.value as { results: Json[] }).results ?? []);
    expect(results.every((r) => r.delivered !== true)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(term.text()).not.toContain('pwned');
    term.close();
  });

  it("the tutorial's Guide never has a shell tool pre-approved (a shell's screen can hold secrets)", () => {
    for (const tool of SHELL_TOOLS) expect(TUTORIAL_PREAPPROVED_TOOLS).not.toContain(tool);
  });
});
