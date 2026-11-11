/**
 * The Pixel Office MCP in a VS Code office, through the composed embedded
 * server: the adapter's own composition (adapters/vscode/vscodeOfficeMcp.ts)
 * and its own terminal launch (agentManager's launchNewTerminal), with
 * `vscode` faked — terminals that record what is typed into them, readable by
 * nothing — and the MCP SDK's client calling the tools with an agent's own
 * token. Asserted from outside: the handshake and answers the webview gets,
 * the command each terminal was given, what the client gets back, and the
 * text that reached each terminal.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCharacterProfiles } from '../src/characterProfilesStore.js';

interface FakeTerminal {
  name: string;
  cwd: string;
  /** What the launch typed (the CLI's command line). */
  commands: string[];
  show(): void;
  sendText(text: string, shouldExecute?: boolean): void;
}

const { terminals, workspaceFolders } = vi.hoisted(() => ({
  terminals: [] as FakeTerminal[],
  workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
}));

vi.mock('vscode', () => ({
  window: {
    createTerminal: (options: { name: string; cwd: string }): FakeTerminal => {
      const terminal: FakeTerminal = {
        name: options.name,
        cwd: options.cwd,
        commands: [],
        show: () => {},
        sendText(text) {
          this.commands.push(text);
        },
      };
      terminals.push(terminal);
      return terminal;
    },
    get terminals() {
      return terminals;
    },
    activeTerminal: undefined,
  },
  workspace: { workspaceFolders },
}));

import { launchNewTerminal } from '../../adapters/vscode/agentManager.js';
import { createVscodeOfficeMcp } from '../../adapters/vscode/vscodeOfficeMcp.js';
import type { TerminalHandle } from '../../core/src/terminalAdapter.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { turnGuard } from '../src/mcp/messaging.js';
import { PixelAgentsServer } from '../src/server.js';
import { PLAIN_INPUT_MODES } from '../src/terminal/agentTerminals.js';
import type { TutorialSurface } from '../src/tutorial/tutorial.js';
import {
  type Message,
  useVscodeOffice,
  waitFor as harnessWaitFor,
} from './helpers/officeMcpHarness.js';

/** This suite's fake terminals answer fast: a shorter wait, polled more often. */
const waitFor = <T>(
  read: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  what: string,
): Promise<T> => harnessWaitFor(read, what, 10_000, 25);

interface Launched {
  id: number;
  terminal: FakeTerminal;
  client: Client;
}

describe('the Pixel Office MCP in a VS Code office (composed embedded server, fake terminals)', () => {
  /** What the fake terminal adapter typed, per terminal. */
  let typed: Map<TerminalHandle, string[]>;
  /** What the CLI does as text lands in its terminal (unset: nothing). */
  let onTyped: ((terminal: TerminalHandle, text: string) => void) | undefined;
  beforeEach(() => {
    typed = new Map();
    onTyped = undefined;
  });

  const h = useVscodeOffice({
    prepare: ({ workspace }) => {
      terminals.length = 0;
      workspaceFolders.length = 0;
      workspaceFolders.push({ name: 'proj', uri: { fsPath: workspace } });
    },
    sendText: (terminal, text) => {
      const list = typed.get(terminal) ?? [];
      list.push(text);
      typed.set(terminal, list);
      onTyped?.(terminal, text);
    },
  });
  const { hook } = h;

  /** The name of the character an agent wears: its Message tag, with no Nickname. */
  function characterName(id: number): string {
    return getCharacterProfiles()[h.store.get(id)!.palette!].name!;
  }

  // ── Helpers ─────────────────────────────────────────────────

  /** The webview's message, answered as the provider answers it. */
  function fromWebview(message: Message): { handled: boolean; replies: Message[] } {
    const replies: Message[] = [];
    const handled = h.mcp.handleMessage(message, webviewClient, (m) => replies.push({ ...m }));
    return { handled, replies };
  }
  const webviewClient = {};

  /** The MCP's part of the webview's handshake, as the provider sends it. */
  function handshake(): Message[] {
    const sent: Message[] = [];
    h.mcp.handshake((m) => sent.push({ ...m }));
    return sent;
  }

  function allow(): void {
    expect(fromWebview({ type: 'officeMcpConsentResponse', choice: 'allow' }).handled).toBe(true);
    expect(lastStatus()).toMatchObject({ consent: 'granted' });
  }

  /** The newest officeMcpStatus broadcast (a consent answer is followed by the tutorial's status). */
  function lastStatus(): Message | undefined {
    return h.broadcasts.filter((m) => m.type === 'officeMcpStatus').at(-1);
  }

  /** Launch as the office's + does (agentManager), registered for its hooks. */
  async function launchTerminal(): Promise<{ id: number; terminal: FakeTerminal }> {
    const { store, runtime } = h;
    const id = await launchNewTerminal(
      store.nextAgentId,
      store.nextTerminalIndex,
      store,
      runtime.activeAgentId,
      runtime.knownJsonlFiles,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      runtime.jsonlPollTimers,
      runtime.projectScanTimer,
      () => store.persist(),
      { cwd: h.workspace, suppressShow: true, mcp: h.mcp },
    );
    runtime.registerAgent(store.get(id)!.sessionId, id);
    return { id, terminal: terminals.at(-1)! };
  }

  /** Launch, and connect an MCP client with the token its config file holds. */
  async function launch(): Promise<Launched> {
    const { id, terminal } = await launchTerminal();
    const configPath = /--mcp-config (\S+)/.exec(terminal.commands[0])?.[1];
    expect(configPath, terminal.commands[0]).toBeDefined();
    const config = JSON.parse(fs.readFileSync(configPath!, 'utf8')) as {
      mcpServers: Record<string, { url: string; headers: { Authorization: string } }>;
    };
    const entry = config.mcpServers['pixel-office'];
    expect(entry.url).toBe(`http://127.0.0.1:${h.port}/mcp`);
    const token = entry.headers.Authorization.slice('Bearer '.length);
    const client = await h.mcpClient(token, `agent-${id}`);
    return { id, terminal, client };
  }

  const call = h.callToolCaught;

  async function sendMessage(client: Client, args: Message): Promise<Message> {
    return (await h.sendMessage(client, args))[0];
  }

  async function statusOf(client: Client, id: number): Promise<string> {
    const agents = (await call(client, 'list_agents', {})).value!.agents as Message[];
    return agents.find((a) => a.id === id)?.status as string;
  }

  async function becomes(client: Client, id: number, status: string): Promise<void> {
    await waitFor(async () => (await statusOf(client, id)) === status, `agent ${id} ${status}`);
  }

  /** A record the agent's CLI writes to its transcript (the heuristic path, no hooks). */
  function transcript(id: number, record: Message): void {
    const file = h.store.get(id)!.jsonlFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  }

  let toolSeq = 0;
  /** The agent's turn is under way: it runs a tool. */
  function working(id: number): void {
    transcript(id, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `toolu_${++toolSeq}`, name: 'Read', input: { file_path: '/x' } },
        ],
      },
    });
  }

  /** The agent's turn ended. */
  function turnEnds(id: number): void {
    transcript(id, { type: 'system', subtype: 'turn_duration', durationMs: 10 });
  }

  // ── Consent, in the webview ─────────────────────────────────

  it("asks in the webview's handshake until answered, and launches get the MCP only once granted", async () => {
    const asked = handshake();
    expect(asked.map((m) => m.type)).toEqual([
      'officeMcpStatus',
      'agentLayoutEditStatus',
      'agentCharacterEditStatus',
      'tutorialStatus',
      'officeMcpConsentRequest',
    ]);
    expect(asked[0]).toMatchObject({ consent: 'unanswered', readOnly: false });

    // Unanswered: a launch runs the CLI with no MCP.
    const before = await launchTerminal();
    expect(before.terminal.commands[0]).toMatch(/^claude --session-id \S+$/);

    allow();
    expect(handshake().map((m) => m.type)).not.toContain('officeMcpConsentRequest');
    const after = await launchTerminal();
    expect(after.terminal.commands[0]).toMatch(/^claude --session-id \S+ --mcp-config \S+$/);

    // Settings' read-only switch, then turning it off: every office hears each.
    expect(fromWebview({ type: 'setOfficeMcpReadOnly', readOnly: true }).handled).toBe(true);
    expect(lastStatus()).toMatchObject({ readOnly: true });
    expect(fromWebview({ type: 'setOfficeMcpEnabled', enabled: false }).handled).toBe(true);
    expect(lastStatus()).toMatchObject({ consent: 'declined' });
    // No tutorial without the MCP (this VS Code test office has no tutorial surface either).
    expect(h.broadcasts.filter((m) => m.type === 'tutorialStatus').at(-1)).toMatchObject({
      available: false,
    });
    const declined = await launchTerminal();
    expect(declined.terminal.commands[0]).not.toContain('--mcp-config');

    // Not one of the MCP's messages: left to the provider.
    expect(fromWebview({ type: 'saveLayout', layout: {} }).handled).toBe(false);
  });

  // ── The office through the MCP ──────────────────────────────

  it('a VS Code-launched agent lists the office; reading a terminal gives its status only', async () => {
    allow();
    const a = await launch();
    const b = await launch();

    const listed = await call(a.client, 'list_agents', {});
    expect(listed.isError, listed.text).toBe(false);
    const agents = (listed.value as { agents: Message[] }).agents;
    expect(agents.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(agents.find((x) => x.id === b.id)).toMatchObject({
      messageable: true,
      working_directory: h.workspace,
    });

    const read = await call(a.client, 'read_agent_terminal', { agent_id: b.id });
    expect(read.isError, read.text).toBe(false);
    expect(read.value).toMatchObject({ agent_id: b.id, status: 'waiting for input' });
    expect(read.value).not.toHaveProperty('screen');
    expect(read.value).not.toHaveProperty('screen_token');
    expect(String(read.value!.no_screen)).toContain("can't read");
  });

  // ── Messages: text only, to done or active agents, no token ──

  it('types the tagged text into a done or active agent, no token needed', async () => {
    allow();
    const a = await launch();
    const b = await launch();

    working(b.id);
    await becomes(a.client, b.id, 'active');
    expect(await sendMessage(a.client, { to: [b.id], text: 'line one\nline two' })).toEqual({
      agent_id: b.id,
      delivered: true,
    });
    // A paste (bracketed, CR line breaks) tagged with the sender (in a single-root
    // window an agent launched into no Directory is named by its id), then Enter on its own.
    expect(typed.get(b.terminal)).toEqual([
      `\x1b[200~[From ${characterName(a.id)}, agent ${a.id}] line one\rline two\x1b[201~`,
      '\r',
    ]);

    turnEnds(b.id);
    await becomes(a.client, b.id, 'done');
    expect(
      await sendMessage(a.client, {
        to: [b.id],
        text: 'no enter',
        submit: false,
        screen_tokens: {},
      }),
    ).toEqual({ agent_id: b.id, delivered: true });
    expect(typed.get(b.terminal)?.slice(2)).toEqual([
      `\x1b[200~[From ${characterName(a.id)}, agent ${a.id}] no enter\x1b[201~`,
    ]);
    // Nothing reached the sender's own terminal.
    expect(typed.get(a.terminal)).toBeUndefined();
  });

  it('refuses keys, and text to an agent with a prompt open, with the reason', async () => {
    allow();
    const a = await launch();
    const b = await launch();

    // Launched and not yet prompted: its CLI waits on its user.
    const fresh = await sendMessage(a.client, { to: [b.id], text: 'hi' });
    expect(fresh).toMatchObject({ agent_id: b.id, delivered: false });
    expect(String(fresh.reason)).toContain('a prompt waiting for its user');

    working(b.id);
    await becomes(a.client, b.id, 'active');
    const keys = await sendMessage(a.client, { to: [b.id], keys: ['enter'] });
    expect(keys).toMatchObject({ agent_id: b.id, delivered: false });
    expect(String(keys.reason)).toContain("can't press keys");

    await hook(b.id, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    });
    await becomes(a.client, b.id, 'permission request');
    const prompt = await sendMessage(a.client, { to: [b.id], text: 'yes' });
    expect(prompt).toMatchObject({ agent_id: b.id, delivered: false });
    expect(String(prompt.reason)).toContain('a permission prompt');

    expect(typed.get(b.terminal)).toBeUndefined();
  });

  it('leaves the Enter out when a prompt opens while the text is landing', async () => {
    allow();
    const a = await launch();
    const b = await launch();
    working(b.id);
    await becomes(a.client, b.id, 'active');

    // The CLI asks for a permission the moment the paste lands, before the Enter.
    onTyped = (terminal) => {
      if (terminal !== b.terminal) return;
      onTyped = undefined;
      h.runtime.handleHookEvent('claude', {
        hook_event_name: 'PermissionRequest',
        session_id: h.store.get(b.id)!.sessionId,
        cwd: h.workspace,
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
      });
    };
    const result = await sendMessage(a.client, { to: [b.id], text: 'carry on' });
    expect(result).toMatchObject({ agent_id: b.id, delivered: false });
    expect(String(result.reason)).toContain('not submitted');
    expect(String(result.reason)).toContain('a permission prompt');
    expect(typed.get(b.terminal)).toEqual([
      `\x1b[200~[From ${characterName(a.id)}, agent ${a.id}] carry on\x1b[201~`,
    ]);
  });

  // ── The rest ────────────────────────────────────────────────

  it("offers no launch_agent or close_agent, and revokes an agent's token when it leaves", async () => {
    allow();
    const a = await launch();

    // VS Code can't do them: they aren't offered, so an agent never tries.
    const offered = (await a.client.listTools()).tools.map((t) => t.name);
    expect(offered).toContain('send_message');
    // The characters need no terminal: both surfaces offer them.
    expect(offered).toContain('list_wardrobe');
    expect(offered).toContain('list_characters');
    expect(offered).not.toContain('launch_agent');
    expect(offered).not.toContain('close_agent');
    const launched = await call(a.client, 'launch_agent', { directory: 'proj' });
    expect(launched.isError).toBe(true);

    // Its terminal closed: the agent leaves, and its token with it.
    h.runtime.removeAgent(a.id);
    const after = await call(a.client, 'list_agents', {});
    expect(after.isError).toBe(true);
    expect(after.text).toMatch(/revoked|left/i);
  });

  it("the editor's unsaved changes lock agents' layout edits, from the webview", async () => {
    allow();
    const a = await launch();
    expect(fromWebview({ type: 'layoutEditing', dirty: true }).handled).toBe(true);
    const edit = await call(a.client, 'edit_layout', {
      ops: [{ op: 'remove_furniture', uid: 'desk-1' }],
    });
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain('unsaved changes');

    // Nothing to undo: the refusal goes back to the webview alone.
    const undo = fromWebview({ type: 'undoAgentLayoutEdit' });
    expect(undo.handled).toBe(true);
    expect(undo.replies).toEqual([expect.objectContaining({ type: 'agentLayoutEditStatus' })]);
    expect(undo.replies[0].refused).toEqual(expect.any(String));
  });

  // ── Whether this office offers it at all ────────────────────

  /** Another window's MCP, composed as the adapter composes it (with the
   *  window's way to launch the tutorial's Guide, when given). */
  function anotherWindow(tutorial?: TutorialSurface): {
    store: AgentStateStore;
    mcp: ReturnType<typeof createVscodeOfficeMcp>;
  } {
    const store = new AgentStateStore();
    const mcp = createVscodeOfficeMcp({
      store,
      sendText: () => {},
      places: {
        layout: () => null,
        catalog: () => [],
        directories: () => [],
        readAreaMappings: () => ({}),
      },
      assets: () => null,
      characterRefsChanged: () => {},
      ...(tutorial ? { tutorial } : {}),
    });
    return { store, mcp };
  }

  /** A window's tutorial side that could launch the Guide into `proj`. */
  const guideLauncher: TutorialSurface = {
    where: () => ({ ok: true, directoryName: 'proj' }),
    launch: () => Promise.resolve({ ok: false, reason: 'No Guide in this test.' }),
    close: () => {},
  };

  it('a handshake before the server has started waits for it, then offers as usual', async () => {
    const { store, mcp } = anotherWindow();
    try {
      const sent: Message[] = [];
      mcp.handshake((m) => sent.push({ ...m }));
      await Promise.resolve();
      expect(sent).toEqual([]);
      // What server.start does once its own server listens.
      mcp.setEndpoint(`http://127.0.0.1:${h.port}/mcp`);
      await Promise.resolve();
      expect(mcp.offered()).toBe(true);
      expect(sent.map((m) => m.type)).toEqual([
        'officeMcpStatus',
        'agentLayoutEditStatus',
        'agentCharacterEditStatus',
        'tutorialStatus',
        'officeMcpConsentRequest',
      ]);
    } finally {
      mcp.dispose();
      store.dispose();
    }
  });

  it("a second window reusing this one's server is not offered the MCP: no settings, no ask, no config", async () => {
    const { store, mcp } = anotherWindow();
    const server = new PixelAgentsServer();
    try {
      const sent: Message[] = [];
      // Its webview may be ready before its server has started.
      mcp.handshake((m) => sent.push({ ...m }));
      const config = await server.start({ store, embedded: true, officeMcp: mcp });
      expect(config.port).toBe(h.port);
      mcp.handshake((m) => sent.push({ ...m }));
      await new Promise((r) => setTimeout(r, 50));
      expect(mcp.offered()).toBe(false);
      expect(sent).toEqual([]);

      // Granted (the consent is machine-wide), its launches still get none.
      allow();
      expect(mcp.configFor(1)).toBeUndefined();
    } finally {
      mcp.dispose();
      server.stop();
      store.dispose();
    }
  });

  it('a window whose server serves the MCP offers the tutorial as usual', async () => {
    const { store, mcp } = anotherWindow(guideLauncher);
    try {
      mcp.setEndpoint(`http://127.0.0.1:${h.port}/mcp`);
      allow();
      const sent: Message[] = [];
      mcp.handshake((m) => sent.push({ ...m }));
      await Promise.resolve();
      expect(sent.find((m) => m.type === 'tutorialStatus')).toMatchObject({ available: true });
      expect(sent.find((m) => m.type === 'tutorialStatus')?.unavailableReason).toBeUndefined();
    } finally {
      mcp.dispose();
      store.dispose();
    }
  });

  it("a second window reusing this one's server does not offer the tutorial, and says where it starts", async () => {
    const { store, mcp } = anotherWindow(guideLauncher);
    const server = new PixelAgentsServer();
    const heard: Message[] = [];
    store.on('broadcast', (m) => heard.push({ ...m }));
    try {
      await server.start({ store, embedded: true, officeMcp: mcp });
      expect(mcp.offered()).toBe(false);
      // Granted from this window: its tutorial status is broadcast, unavailable.
      mcp.handleMessage({ type: 'officeMcpConsentResponse', choice: 'allow' }, {}, () => {});
      const status = heard.filter((m) => m.type === 'tutorialStatus').at(-1);
      expect(status).toMatchObject({ available: false });
      expect(status?.unavailableReason).toMatch(/shares another window's office/);

      const replies: Message[] = [];
      mcp.handleMessage({ type: 'startTutorial' }, {}, (m) => replies.push({ ...m }));
      const rejected = await waitFor(
        () => replies.find((m) => m.type === 'tutorialRejected'),
        'the refusal',
      );
      expect(rejected.reason).toBe(status?.unavailableReason);
    } finally {
      mcp.dispose();
      server.stop();
      store.dispose();
    }
  });
});

describe('turnGuard: a CLI that declares no terminal input modes', () => {
  it('is typed into in plain modes', async () => {
    const store = new AgentStateStore();
    try {
      store.set(
        1,
        createAgentState({
          id: 1,
          sessionId: 'session-1',
          projectDir: '/tmp/none',
          jsonlFile: '/tmp/none/session-1.jsonl',
          isExternal: false,
        }),
      );
      store.setAgentStatus(1, { active: false, awaitingInput: false });
      const verdict = await turnGuard(store, {}).check(
        { id: 1, screenToken: undefined },
        { text: 'hello', submit: true },
      );
      expect(verdict).toEqual({ ok: true, modes: PLAIN_INPUT_MODES });
    } finally {
      store.dispose();
    }
  });
});
