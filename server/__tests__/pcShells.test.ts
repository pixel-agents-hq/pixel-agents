/**
 * PC shells through their seam: a composed standalone server (as cli.ts
 * composes it) driven over /ws by offices, the shell's terminal over its own
 * socket, real PTYs running a real shell. What an office can observe: the
 * answer to an open, the shells every office is told of (and a new office's
 * snapshot), the shell's output, its end, the close question, refusals — and
 * that an agent's own terminal tools (list_agents, read_agent_terminal,
 * send_message, close_agent) never reach a PC shell: agents reach shells only
 * through the MCP's shell tools (officeMcpPcShells.test.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { PC_SHELL_ID_BASE } from '../../core/src/constants.js';
import { readConfig, writeConfig } from '../src/configPersistence.js';
import { WS_CLOSE_UNAUTHORIZED } from '../src/constants.js';
import { ptyAgentTerminals } from '../src/terminal/agentTerminals.js';
import {
  foregroundOf,
  type ForegroundProbe,
  StandalonePcShells,
} from '../src/terminal/pcShells.js';
import type { TerminalSession, TerminalSessions } from '../src/terminal/terminalSessions.js';
import {
  type Json,
  loadBundledAssets,
  seededLayout,
  seedLayoutFile,
  useStandaloneOffice,
  waitFor,
} from './helpers/officeMcpHarness.js';
import { A_DESK, FRONT_PC, OTHER_PC, pcShellDriver } from './helpers/pcShellDriver.js';

let catalog: Awaited<ReturnType<typeof loadBundledAssets>>['furniture']['catalog'] = [];
beforeAll(async () => {
  catalog = (await loadBundledAssets()).furniture.catalog;
});

/** The user's shell for these tests: records how it was started, then runs /bin/sh. */
function fakeLoginShell(home: string): void {
  const file = path.join(home, 'bin', 'login-shell');
  fs.writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$*" > "$HOME/shell-args"\nexec /bin/sh "$@"\n`,
    { mode: 0o755 },
  );
  process.env.SHELL = file;
}

/** Map Directory `name` to the seeded layout's Area `area` (config areaMappings). */
function mapDirectory(name: string, area: string): void {
  const cfg = readConfig();
  cfg.standalone.areaMappings = { ...cfg.standalone.areaMappings, [name]: [area] };
  writeConfig(cfg);
}

/** Add a user Directory (config.json), as the Directory modal does. */
function addUserDirectory(name: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = readConfig();
  cfg.directories = [...cfg.directories, { name, path: dir }];
  writeConfig(cfg);
}

/** What the shell says it is: its folder and whether a CLI session marker reached it. */
const WHERE = `echo "WHERE:$(pwd):[\${CLAUDECODE}]"\r`;
const WHERE_RE = /WHERE:(\/[^:\r\n]*):\[([^\]\r\n]*)\]/;

let probe: ForegroundProbe | undefined;

describe('PC shells', () => {
  const h = useStandaloneOffice({
    name: 'pxl-pc-shell',
    // CLAUDECODE: a server started inside a Claude Code session, whose shells
    // must not inherit it. SHELL is set per test (fakeLoginShell).
    env: { SHELL: '/bin/sh', CLAUDECODE: '1' },
    layout: 'file',
    catalog: () => catalog,
    prepare: ({ home }) => {
      seedLayoutFile(home, seededLayout());
      fakeLoginShell(home);
    },
    // The real `ps` probe unless a test sets its own.
    foreground: (pid) => (probe ?? foregroundOf)(pid),
    grant: true,
  });
  const shells = pcShellDriver(h);

  it("opens the user's login shell in the single Directory of the PC's Area", async () => {
    // The host's Directory, listed (Settings → Show host Directories).
    h.send({ type: 'setShowHostDirectories', enabled: true });
    await waitFor(
      () => h.received.some((m) => m.type === 'directoriesLoaded' && m.directories.length > 0),
      'the host Directory listed',
    );
    mapDirectory('proj', 'Blue room');
    const answer = await shells.open(FRONT_PC);
    expect(answer.type).toBe('pcShellReady');
    const id = answer.id as number;
    expect(id).toBeGreaterThan(PC_SHELL_ID_BASE);

    const term = await shells.attach(id);
    term.type(WHERE);
    const [, cwd, marker] = await term.waitFor(WHERE_RE, 'where the shell is');
    expect(cwd).toBe(h.workspace);
    // Not handed the office's own CLI session markers.
    expect(marker).toBe('');
    // A login shell.
    expect(fs.readFileSync(path.join(h.home, 'shell-args'), 'utf8').trim()).toBe('-l');
    term.close();

    // Announced: the piece, its furniture, its Directory.
    expect(shells.shells()).toEqual([
      { id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF', directoryName: 'proj' },
    ]);
  });

  it('a hidden host Directory is neither offered nor picked, as the office shows it', async () => {
    // Show host Directories is off by default: the office's selector never
    // lists the host's folder, so neither does the server.
    mapDirectory('proj', 'Blue room');
    const id = (await shells.open(FRONT_PC)).id as number;
    const term = await shells.attach(id);
    term.type(WHERE);
    expect((await term.waitFor(WHERE_RE))[1]).toBe(h.home);
    term.close();
    expect(shells.shells()).toEqual([{ id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF' }]);
    expect(await shells.openIn(OTHER_PC, 'proj')).toMatchObject({ type: 'pcShellRejected' });
  });

  it('opens in the home folder when the Area has no Directory, or several', async () => {
    const first = (await shells.open(FRONT_PC)).id as number;
    const t1 = await shells.attach(first);
    t1.type(WHERE);
    expect((await t1.waitFor(WHERE_RE))[1]).toBe(h.home);
    expect(shells.shells()?.[0]).not.toHaveProperty('directoryName');

    addUserDirectory('a', path.join(h.home, 'a'));
    addUserDirectory('b', path.join(h.home, 'b'));
    mapDirectory('a', 'Blue room');
    mapDirectory('b', 'Blue room');
    const second = (await shells.open(OTHER_PC)).id as number;
    const t2 = await shells.attach(second);
    t2.type(WHERE);
    expect((await t2.waitFor(WHERE_RE))[1]).toBe(h.home);
    t1.close();
    t2.close();
  });

  it("opens in the Directory the office's selector named, one of the Area's several", async () => {
    addUserDirectory('a', path.join(h.home, 'a'));
    addUserDirectory('b', path.join(h.home, 'b'));
    mapDirectory('a', 'Blue room');
    mapDirectory('b', 'Blue room');
    const answer = await shells.openIn(FRONT_PC, 'b');
    expect(answer.type).toBe('pcShellReady');
    const id = answer.id as number;
    const term = await shells.attach(id);
    term.type(WHERE);
    expect((await term.waitFor(WHERE_RE))[1]).toBe(path.join(h.home, 'b'));
    term.close();
    expect(shells.shells()).toEqual([
      { id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF', directoryName: 'b' },
    ]);
  });

  it("refuses a named Directory that is not one of the PC's Area", async () => {
    addUserDirectory('a', path.join(h.home, 'a'));
    addUserDirectory('elsewhere', path.join(h.home, 'elsewhere'));
    mapDirectory('a', 'Blue room');
    mapDirectory('elsewhere', 'Some other room');
    for (const name of ['elsewhere', 'no-such-directory']) {
      expect(await shells.openIn(FRONT_PC, name)).toMatchObject({
        type: 'pcShellRejected',
        uid: FRONT_PC,
      });
    }
    expect(h.ptyManager.size).toBe(0);
    expect(shells.shells() ?? []).toEqual([]);
  });

  it('opens in the home folder for a PC in no Area', async () => {
    const plain = seededLayout();
    delete plain.areas;
    delete plain.areaTiles;
    seedLayoutFile(h.home, plain);
    mapDirectory('proj', 'Blue room');
    const id = (await shells.open(FRONT_PC)).id as number;
    const term = await shells.attach(id);
    term.type(WHERE);
    expect((await term.waitFor(WHERE_RE))[1]).toBe(h.home);
    term.close();
  });

  it("answers a second open with the piece's live shell", async () => {
    const first = await shells.open(FRONT_PC);
    const other = await h.connectOffice();
    const again = await shells.open(FRONT_PC, other.socket, other.received);
    expect(again).toEqual({ type: 'pcShellReady', id: first.id });
    expect(shells.shells()).toHaveLength(1);
    expect(h.ptyManager.size).toBe(1);
  });

  it('refuses furniture that opens no terminal, and a piece not in the layout', async () => {
    expect(await shells.open(A_DESK)).toMatchObject({ type: 'pcShellRejected', uid: A_DESK });
    expect(await shells.open('no-such-piece')).toMatchObject({ type: 'pcShellRejected' });
    expect(h.ptyManager.size).toBe(0);
  });

  it('tells privileged offices the shells and view-only ones only which PC is in use, snapshots included', async () => {
    const watcher = await h.connectOffice({ privileged: false });
    const tokened = await h.connectOffice();
    const id = (await shells.open(FRONT_PC)).id;
    await waitFor(() => shells.shells(tokened.received)?.length === 1, 'the tokened office told');
    // A view-only office is told which PC is in use, never the shell: on the change...
    const inUse = (received: typeof watcher.received) =>
      received.filter((m) => m.type === 'panelsInUse').at(-1)?.uids;
    await waitFor(() => inUse(watcher.received)?.length === 1, 'the view-only office told');
    expect(inUse(watcher.received)).toEqual([FRONT_PC]);
    expect(watcher.received.some((m) => m.type === 'pcShellsLoaded')).toBe(false);
    // ...and in a snapshot taken while one is live.
    const lateWatcher = await h.connectOffice({ privileged: false });
    expect(inUse(lateWatcher.received)).toEqual([FRONT_PC]);
    expect(lateWatcher.received.some((m) => m.type === 'pcShellsLoaded')).toBe(false);

    const late = await h.connectOffice();
    expect(shells.shells(late.received)).toEqual([
      { id, uid: FRONT_PC, furnitureType: 'PC_FRONT_OFF' },
    ]);
    // Never an agent: no agentCreated, not in existingAgents.
    const existing = late.received.find((m) => m.type === 'existingAgents')!;
    expect(existing.agents).toEqual([]);
    expect(h.received.some((m) => m.type === 'agentCreated')).toBe(false);
  });

  it('`exit` in the shell ends it in every office', async () => {
    const other = await h.connectOffice();
    const id = (await shells.open(FRONT_PC)).id as number;
    const term = await shells.attach(id);
    term.type('exit\r');
    await waitFor(() => term.exited(), 'the shell to exit');
    await waitFor(() => shells.shells()?.length === 0, 'the first office told');
    await waitFor(() => shells.shells(other.received)?.length === 0, 'the other office told');
    expect(h.pcShells.has(id)).toBe(false);
  });

  it('the × ends an idle shell at once', async () => {
    const id = (await shells.open(FRONT_PC)).id as number;
    const term = await shells.attach(id);
    term.type('echo READY\r');
    await term.waitFor(/^READY/m);
    const before = h.received.length;
    shells.close(id);
    await waitFor(() => shells.shells()?.length === 0, 'the shell closed');
    expect(h.received.slice(before).some((m) => m.type === 'pcShellCloseQuestion')).toBe(false);
    await waitFor(() => term.exited(), 'its process ended');
  });

  it('the × on a shell running a command asks first, and closes on confirmation', async () => {
    const other = await h.connectOffice();
    const id = (await shells.open(FRONT_PC)).id as number;
    const term = await shells.attach(id);
    term.type('echo RUNNING; sleep 30\r');
    await term.waitFor(/^RUNNING/m);
    // `sleep` takes the terminal's foreground once the shell has started it.
    await waitFor(async () => (await foregroundOf(h.ptyManager.get(id)!.pid))?.command, 'sleep');

    shells.close(id);
    const question = await waitFor(
      () => h.received.find((m) => m.type === 'pcShellCloseQuestion'),
      'the question',
    );
    expect(question).toEqual({ type: 'pcShellCloseQuestion', id, command: 'sleep' });
    // Asked only of the office that pressed it, and nothing closed.
    expect(other.received.some((m) => m.type === 'pcShellCloseQuestion')).toBe(false);
    expect(h.pcShells.has(id)).toBe(true);

    shells.close(id, { confirmed: true });
    await waitFor(() => shells.shells()?.length === 0, 'the shell closed');
    await waitFor(() => term.exited(), 'its process ended');
  });

  it('a probe that cannot tell counts as running', async () => {
    probe = async () => ({});
    try {
      const id = (await shells.open(FRONT_PC)).id as number;
      shells.close(id);
      expect(
        await waitFor(() => h.received.find((m) => m.type === 'pcShellCloseQuestion'), 'question'),
      ).toEqual({ type: 'pcShellCloseQuestion', id });
    } finally {
      probe = undefined;
    }
  });

  it('a read-only office can neither open, close, type into nor attach to a shell', async () => {
    const watcher = await h.connectOffice({ privileged: false });
    const before = watcher.received.length;
    h.send({ type: 'openPcShell', uid: FRONT_PC }, watcher.socket);
    const id = (await shells.open(FRONT_PC)).id as number;
    // The privileged open answered; the read-only one never did, and made nothing.
    expect(watcher.received.slice(before).some((m) => m.type === 'pcShellReady')).toBe(false);
    expect(h.ptyManager.size).toBe(1);

    shells.close(id, { confirmed: true, ws: watcher.socket });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.pcShells.has(id)).toBe(true);

    expect(await shells.refusedAttach(id)).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(await shells.refusedAttach(id, 'not-the-token')).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it("sends files to a PC shell's terminal under the agents' gate", async () => {
    const id = (await shells.open(FRONT_PC)).id as number;
    const upload = (token: string | null) =>
      fetch(
        `http://127.0.0.1:${h.port}/api/terminal/${id}/files?name=note.txt${token === null ? '' : `&token=${token}`}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: 'hello',
        },
      );
    expect((await upload(null)).status).toBe(401);
    const res = await upload(h.token);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { path: string };
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('hello');
  });

  it("joins the card bar's saved order beside the agents", async () => {
    const id = (await shells.open(FRONT_PC)).id as number;
    const before = h.received.length;
    h.send({ type: 'saveCardOrder', order: [id, 4242] });
    const loaded = await waitFor(
      () => h.received.slice(before).find((m) => m.type === 'cardOrderLoaded'),
      'the order',
    );
    // A PC shell's card is kept; an id that is nobody's is dropped.
    expect(loaded.order).toEqual([id]);
  });

  it("an agent's terminal tools neither list nor reach a PC shell (shells have tools of their own)", async () => {
    const agent = await h.launchAgent();
    const id = (await shells.open(FRONT_PC)).id as number;
    const term = await shells.attach(id);

    const listed = await h.listAgents(agent.client);
    expect(listed.map((a: Json) => a.id)).toEqual([agent.id]);
    expect(h.store.has(id)).toBe(false);

    const read = await h.callToolCaught(agent.client, 'read_agent_terminal', { agent_id: id });
    expect(read.isError).toBe(true);
    const sent = await h.callToolCaught(agent.client, 'send_message', {
      to: [id],
      text: 'touch pwned',
      gist: 'hi',
    });
    const results = sent.isError ? [] : ((sent.value as { results: Json[] }).results ?? []);
    expect(results.every((r) => r.delivered !== true)).toBe(true);
    const closed = await h.callToolCaught(agent.client, 'close_agent', { agent_id: id });
    expect(closed.isError).toBe(true);

    // Nothing was typed into it, and it still runs.
    await new Promise((r) => setTimeout(r, 300));
    expect(term.text()).not.toContain('pwned');
    expect(h.pcShells.has(id)).toBe(true);

    // By construction too: the agents' terminal seam cannot address a shell,
    // whatever a tool forgets to check first (shells are read and written
    // through their registry, by the MCP's shell tools).
    const seam = ptyAgentTerminals(h.terminals);
    expect(seam.has(id)).toBe(false);
    expect(await seam.screen(id)).toBeNull();
    expect(() => seam.write(id, 'touch pwned2\r')).toThrow();
    await new Promise((r) => setTimeout(r, 300));
    expect(term.text()).not.toContain('pwned2');
    term.close();
  });
});

describe('PC shells whose terminal has no pid yet (a PTY host spawn in flight)', () => {
  /** A shell session the host has not answered for: running, no pid. */
  function pendingSessions(): TerminalSessions {
    const sessions = new Map<number, TerminalSession>();
    const fake = {
      enabled: true,
      isAvailable: () => true,
      unavailableReason: () => null,
      create: ({ agentId }: { agentId: number }) => {
        const session = {
          agentId,
          pid: null,
          onExit: () => () => {},
        } as unknown as TerminalSession;
        sessions.set(agentId, session);
        return session;
      },
      get: (id: number) => sessions.get(id),
      has: (id: number) => sessions.has(id),
      dispose: (id: number) => void sessions.delete(id),
      survivors: () => [],
    };
    return fake as unknown as TerminalSessions;
  }

  it('the × asks first: a probe that cannot tell counts as running', async () => {
    const ptyManager = pendingSessions();
    const asked: number[] = [];
    const registry = new StandalonePcShells({
      ptyManager,
      saves: { loadPcShells: () => [], savePcShells: () => {} },
      facts: {
        layout: () => seededLayout(),
        catalog: () => catalog,
        readAreaMappings: () => ({}),
      },
      directories: () => [],
      broadcast: () => {},
      providers: [],
      foreground: async (pid) => {
        asked.push(pid);
        return null;
      },
    });
    const opened = registry.open(FRONT_PC);
    expect(opened.ok).toBe(true);
    const id = (opened as { id: number }).id;

    expect(await registry.close(id, false)).toEqual({ closed: false, question: {} });
    expect(registry.has(id)).toBe(true);
    expect(ptyManager.has(id)).toBe(true);
    // Confirmed, it closes.
    expect(await registry.close(id, true)).toEqual({ closed: true });
    expect(ptyManager.has(id)).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe('PC shells where the office runs no terminals', () => {
  const h = useStandaloneOffice({
    name: 'pxl-pc-shell-off',
    layout: 'file',
    catalog: () => catalog,
    prepare: ({ home }) => seedLayoutFile(home, seededLayout()),
    noTerminal: true,
  });
  const shells = pcShellDriver(h);

  it('refuses to open one', async () => {
    expect(await shells.open(FRONT_PC)).toMatchObject({
      type: 'pcShellRejected',
      uid: FRONT_PC,
    });
    expect(shells.shells()).toEqual([]);
  });
});
