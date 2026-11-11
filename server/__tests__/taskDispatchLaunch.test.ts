import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleClientMessage } from '../src/clientMessageHandler.js';
import { CAPABILITY_ENV_NAME, TASK_DISPATCH_PORT_ENV_NAME } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { createStoppedAgent } from '../src/terminal/standaloneAgentRecords.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import { DISPATCH_TEST_PORT, DISPATCH_TEST_SHIM, DispatchHarness } from './taskDispatchHarness.js';

/**
 * The launch side of task dispatch: one switch issues a capability, sets
 * PIXEL_AGENTS_PORT and adds the stdio shim -- only for non-default
 * Workspaces, never with a secret in argv -- and the two runtime-only fields
 * are reset on every PTY session and never leave the process.
 */

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    'pixel-agents': { type: 'stdio', command: 'node', args: [DISPATCH_TEST_SHIM] },
  },
});

let h: DispatchHarness;
let ws: { id: string; dir: string };
let inheritedPort: string | undefined;

beforeEach(() => {
  // 在 Pixel Agents 啟動的 agent 內執行測試時，這個變數會從父行程繼承而來。
  inheritedPort = process.env[TASK_DISPATCH_PORT_ENV_NAME];
  delete process.env[TASK_DISPATCH_PORT_ENV_NAME];
  h = new DispatchHarness();
  ws = h.workspace('alpha');
});

afterEach(() => {
  h.dispose();
  if (inheritedPort !== undefined) process.env[TASK_DISPATCH_PORT_ENV_NAME] = inheritedPort;
});

describe('launcher: the task-dispatch switch', () => {
  it('a non-default Workspace launch gets a capability and the port in env, the shim in argv', () => {
    const { id, spawn, token } = h.launch({ directoryPath: ws.dir });
    const agent = h.store.get(id)!;
    expect(token).toMatch(/^pxa_kb_[A-Za-z0-9_-]{43}$/);
    expect(h.capabilities.verify(token)).toMatchObject({ agentId: id, workspaceId: ws.id });
    expect(spawn.options.env?.[TASK_DISPATCH_PORT_ENV_NAME]).toBe(String(DISPATCH_TEST_PORT));
    // --mcp-config is last (variadic) and names only `node <shim>`.
    expect(spawn.args).toEqual(['--session-id', agent.sessionId, '--mcp-config', MCP_CONFIG]);
    for (const arg of spawn.args) {
      expect(arg).not.toContain(token!);
      expect(arg).not.toContain(String(DISPATCH_TEST_PORT));
      expect(arg).not.toContain(CAPABILITY_ENV_NAME);
      expect(arg).not.toContain(TASK_DISPATCH_PORT_ENV_NAME);
    }
    expect(JSON.parse(spawn.args[3])).toEqual({
      mcpServers: {
        'pixel-agents': { type: 'stdio', command: 'node', args: [DISPATCH_TEST_SHIM] },
      },
    });
  });

  it('a default-Workspace launch is exactly the launch as before: no capability, port or shim', () => {
    const { id, spawn, token } = h.launch({});
    expect(token).toBeUndefined();
    expect(spawn.args).toEqual(['--session-id', h.store.get(id)!.sessionId]);
    expect(Object.keys(spawn.options.env ?? {})).not.toContain(TASK_DISPATCH_PORT_ENV_NAME);
    expect(h.capabilities.size).toBe(0);
  });

  it('without the switch, a non-default launch gets nothing either', () => {
    const { id, spawn, token } = h.launch({ directoryPath: ws.dir, withoutSwitch: true });
    expect(token).toBeUndefined();
    expect(spawn.args).toEqual(['--session-id', h.store.get(id)!.sessionId]);
    expect(Object.keys(spawn.options.env ?? {})).not.toContain(TASK_DISPATCH_PORT_ENV_NAME);
  });

  it('a provider that ignores mcpConfig gets no capability through it', () => {
    const { spawn, token } = h.launch({
      directoryPath: ws.dir,
      provider: {
        buildLaunchCommand: (sessionId: string) => ({
          command: 'claude',
          args: ['--session-id', sessionId],
        }),
      },
    });
    expect(token).toBeUndefined();
    expect(Object.keys(spawn.options.env ?? {})).not.toContain(TASK_DISPATCH_PORT_ENV_NAME);
    expect(h.capabilities.size).toBe(0);
  });

  it('keeps bypass, Role and resume arguments, with --mcp-config last', () => {
    const bypass = h.launch({ directoryPath: ws.dir, bypassPermissions: true });
    expect(bypass.spawn.args).toEqual([
      '--session-id',
      h.store.get(bypass.id)!.sessionId,
      '--dangerously-skip-permissions',
      '--mcp-config',
      MCP_CONFIG,
    ]);

    const snapshotPath = path.join(h.tempHome, 'role-snapshot.md');
    fs.writeFileSync(snapshotPath, 'role');
    const role = h.launch({
      directoryPath: ws.dir,
      role: { name: 'Writer', roleId: 'writer.md', snapshotPath },
    });
    expect(role.spawn.args).toEqual([
      '--session-id',
      h.store.get(role.id)!.sessionId,
      '--append-system-prompt-file',
      snapshotPath,
      '--mcp-config',
      MCP_CONFIG,
    ]);

    const resumed = h.createAndStart(ws.dir, {
      beforeStart: (id) => fs.writeFileSync(h.store.get(id)!.jsonlFile, ''),
    });
    expect(resumed.spawn.args).toEqual([
      '--resume',
      h.store.get(resumed.id)!.sessionId,
      '--mcp-config',
      MCP_CONFIG,
    ]);
    expect(resumed.token).toMatch(/^pxa_kb_/);
  });
});

describe('runtime-only fields: launchedWithBypass and turnsCompletedThisSession', () => {
  it('a new launch records its bypass posture and starts at zero turns', () => {
    const plain = h.launch({ directoryPath: ws.dir });
    const risky = h.launch({ directoryPath: ws.dir, bypassPermissions: true });
    expect(h.store.get(plain.id)).toMatchObject({
      launchedWithBypass: false,
      turnsCompletedThisSession: 0,
    });
    expect(h.store.get(risky.id)).toMatchObject({
      launchedWithBypass: true,
      turnsCompletedThisSession: 0,
    });
  });

  it('starting a record resets both from the new launch, whatever the record held', () => {
    const started = h.createAndStart(ws.dir, {
      bypassPermissions: true,
      beforeStart: (id) => {
        const record = h.store.get(id)!;
        record.launchedWithBypass = false;
        record.turnsCompletedThisSession = 9;
      },
    });
    expect(h.store.get(started.id)).toMatchObject({
      launchedWithBypass: true,
      turnsCompletedThisSession: 0,
    });
  });

  it('a Stop hook and a JSONL turn_duration each count a completed turn', () => {
    const { id } = h.launch({ directoryPath: ws.dir });
    h.completeTurn(id);
    expect(h.store.get(id)!.turnsCompletedThisSession).toBe(1);
    processTranscriptLine(
      id,
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 }),
      h.store,
      h.runtime.waitingTimers,
      h.runtime.permissionTimers,
    );
    expect(h.store.get(id)!.turnsCompletedThisSession).toBe(2);
  });

  it('never reach persisted state', () => {
    const { id } = h.launch({ directoryPath: ws.dir, bypassPermissions: true });
    h.completeTurn(id);
    // A stopped record too (the one shape persisted with extra fields), even
    // one still carrying values from an earlier session.
    const stoppedId = createStoppedAgent(
      { store: h.store, provider: { ...claudeProvider, getSessionDirs: () => [h.projectDir] } },
      { directoryPath: ws.dir },
    )!;
    Object.assign(h.store.get(stoppedId)!, {
      launchedWithBypass: true,
      turnsCompletedThisSession: 3,
    });
    h.store.persist();
    expect(
      h.store
        .getAdapter()!
        .loadAgents()
        .some((a) => a.stopped),
    ).toBe(true);
    const persisted = JSON.stringify(h.store.getAdapter()!.loadAgents());
    expect(persisted).not.toContain('launchedWithBypass');
    expect(persisted).not.toContain('turnsCompletedThisSession');
    const stateFile = path.join(h.tempHome, '.pixel-agents', 'standalone-state.json');
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      expect(raw).not.toContain('launchedWithBypass');
      expect(raw).not.toContain('turnsCompletedThisSession');
    }
  });

  it('never reach a broadcast or the handshake', () => {
    const { id } = h.launch({ directoryPath: ws.dir, bypassPermissions: true });
    h.completeTurn(id);
    const replies: Array<Record<string, unknown>> = [];
    handleClientMessage({ type: 'webviewReady' }, (m) => replies.push(m), {
      store: h.store,
      cache: null,
      runtime: h.runtime,
      ptyManager: h.manager,
      capabilities: h.capabilities,
      curators: h.curators,
    });
    const everything = JSON.stringify([...h.broadcasts, ...replies]);
    expect(replies.some((m) => m.type === 'existingAgents')).toBe(true);
    expect(everything).not.toContain('launchedWithBypass');
    expect(everything).not.toContain('turnsCompletedThisSession');
  });
});
