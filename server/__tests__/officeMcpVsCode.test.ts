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
import { describe, expect, it, vi } from 'vitest';

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
import { AgentStateStore } from '../src/agentStateStore.js';
import { PixelAgentsServer } from '../src/server.js';
import { type Message, useVscodeOffice } from './helpers/officeMcpHarness.js';

interface Launched {
  id: number;
  terminal: FakeTerminal;
  client: Client;
}

describe('the Pixel Office MCP in a VS Code office (composed embedded server, fake terminals)', () => {
  const h = useVscodeOffice({
    prepare: ({ workspace }) => {
      terminals.length = 0;
      workspaceFolders.length = 0;
      workspaceFolders.push({ name: 'proj', uri: { fsPath: workspace } });
    },
  });

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
    expect(h.broadcasts.at(-1)).toMatchObject({ type: 'officeMcpStatus', consent: 'granted' });
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

  // ── Consent, in the webview ─────────────────────────────────

  it("asks in the webview's handshake until answered, and launches get the MCP only once granted", async () => {
    const asked = handshake();
    expect(asked.map((m) => m.type)).toEqual([
      'officeMcpStatus',
      'agentLayoutEditStatus',
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
    expect(h.broadcasts.at(-1)).toMatchObject({ type: 'officeMcpStatus', readOnly: true });
    expect(fromWebview({ type: 'setOfficeMcpEnabled', enabled: false }).handled).toBe(true);
    expect(h.broadcasts.at(-1)).toMatchObject({ type: 'officeMcpStatus', consent: 'declined' });
    const declined = await launchTerminal();
    expect(declined.terminal.commands[0]).not.toContain('--mcp-config');

    // Not one of the MCP's messages: left to the provider.
    expect(fromWebview({ type: 'saveLayout', layout: {} }).handled).toBe(false);
  });

  // ── The office through the MCP ──────────────────────────────

  it('a VS Code-launched agent lists the office', async () => {
    allow();
    const a = await launch();
    const b = await launch();

    const listed = await call(a.client, 'list_agents', {});
    expect(listed.isError, listed.text).toBe(false);
    const agents = (listed.value as { agents: Message[] }).agents;
    expect(agents.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(agents.find((x) => x.id === b.id)).toMatchObject({
      working_directory: h.workspace,
    });
  });

  // ── The rest ────────────────────────────────────────────────

  it("revokes an agent's token when it leaves", async () => {
    allow();
    const a = await launch();

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

  /** Another window's MCP, composed as the adapter composes it. */
  function anotherWindow(): {
    store: AgentStateStore;
    mcp: ReturnType<typeof createVscodeOfficeMcp>;
  } {
    const store = new AgentStateStore();
    const mcp = createVscodeOfficeMcp({
      store,
      defaultLayout: () => null,
      assets: () => null,
      directories: () => [],
    });
    return { store, mcp };
  }

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
});
