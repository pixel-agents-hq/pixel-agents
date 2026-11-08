import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_WORKSPACE_ID } from '../../core/src/constants.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CapabilityRegistry, withoutCapabilityEnv } from '../src/capabilities.js';
import { CAPABILITY_ENV_NAME, TERMINAL_TERM_NAME } from '../src/constants.js';
import { CuratorTable } from '../src/curators.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { KbHarness } from './kbHarness.js';

/**
 * Per-agent capabilities (S2): issued by the standalone launcher only when the
 * caller injects isKbEnabled, delivered in the PTY env alone, verified against
 * the live state every time, and revoked on every path an agent leaves its
 * PTY, the store or its Workspace.
 */

const TOKEN_SHAPE = /^pxa_kb_[A-Za-z0-9_-]{43}$/;

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** argv with the (random) session id replaced, so two launches compare. */
function argvShape(args: string[], sessionId: string): string[] {
  return args.map((arg) => (arg === sessionId ? '<session>' : arg));
}

describe('capabilities', () => {
  let h: KbHarness;
  let savedLeftover: string | undefined;

  beforeEach(() => {
    h = new KbHarness();
    savedLeftover = process.env[CAPABILITY_ENV_NAME];
    delete process.env[CAPABILITY_ENV_NAME];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (savedLeftover === undefined) delete process.env[CAPABILITY_ENV_NAME];
    else process.env[CAPABILITY_ENV_NAME] = savedLeftover;
    h.dispose();
  });

  // ── A: issuing ──────────────────────────────────────────────

  describe('A: with isKbEnabled injected', () => {
    it('delivers a pxa_kb_ token in the PTY env that verifies to the agent', () => {
      const { id, token } = h.launch({ kb: true });
      expect(id).toBe(1);
      expect(token).toMatch(TOKEN_SHAPE);
      expect(token).toHaveLength('pxa_kb_'.length + 43);

      const agent = h.store.get(1)!;
      expect(h.capabilities.verify(token)).toEqual({
        agentId: 1,
        sessionId: agent.sessionId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        serial: 1,
      });
      expect(h.capabilities.verify(`Bearer ${token}`)?.agentId).toBe(1);
    });

    it('records the normalized Workspace and an issue serial independent of agent ids', () => {
      const ws = h.workspace('alpha');
      h.launch({ kb: false }); // agent 1, no capability: no serial used
      const second = h.launch({ kb: true, directoryPath: ws.dir });
      expect(second.id).toBe(2);
      expect(h.capabilities.verify(second.token)).toMatchObject({
        agentId: 2,
        workspaceId: ws.id,
        serial: 1,
      });
      const third = h.launch({ kb: true });
      expect(h.capabilities.verify(third.token)).toMatchObject({ agentId: 3, serial: 2 });
    });

    it('passes the Workspace key to isKbEnabled and issues only where it says yes', () => {
      const ws = h.workspace('alpha');
      const asked: string[] = [];
      const kb = (workspaceId: string) => {
        asked.push(workspaceId);
        return workspaceId === ws.id;
      };
      expect(h.launch({ kb, directoryPath: ws.dir }).token).toMatch(TOKEN_SHAPE);
      expect(h.launch({ kb }).token).toBeUndefined();
      expect(asked).toEqual([ws.id, DEFAULT_WORKSPACE_ID]);
    });

    it('spawns the same argv as a launch without a capability', () => {
      const on = h.launch({ kb: true });
      const off = h.launch({ kb: false });
      const onSession = h.store.get(on.id!)!.sessionId;
      const offSession = h.store.get(off.id!)!.sessionId;

      expect(on.spawn!.file).toBe(off.spawn!.file);
      expect(argvShape(on.spawn!.args, onSession)).toEqual(argvShape(off.spawn!.args, offSession));
      expect(on.spawn!.args.join('\0')).not.toContain(on.token!);
      expect(on.spawn!.options.cwd).toBe(off.spawn!.options.cwd);
      const { [CAPABILITY_ENV_NAME]: _token, ...onRest } = on.spawn!.options.env!;
      expect(onRest).toEqual(off.spawn!.options.env);
    });

    it("cannot be replaced by the provider's own env", () => {
      const planted = `pxa_kb_${'A'.repeat(43)}`;
      const { token } = h.launch({
        kb: true,
        provider: {
          buildLaunchCommand: (sessionId, cwd, opts) => ({
            ...claudeProvider.buildLaunchCommand!(sessionId, cwd, opts),
            env: { PWD: cwd, [CAPABILITY_ENV_NAME]: planted },
          }),
        },
      });
      expect(token).toMatch(TOKEN_SHAPE);
      expect(token).not.toBe(planted);
      expect(h.capabilities.verify(token)?.agentId).toBe(1);
      expect(h.capabilities.verify(planted)).toBeNull();
    });

    it('wins over a leftover in the server environment', () => {
      process.env[CAPABILITY_ENV_NAME] = `pxa_kb_${'B'.repeat(43)}`;
      const { token } = h.launch({ kb: true });
      expect(token).not.toBe(process.env[CAPABILITY_ENV_NAME]);
      expect(h.capabilities.verify(token)?.agentId).toBe(1);
    });
  });

  // ── B: default ──────────────────────────────────────────────

  describe('B: without isKbEnabled (the default)', () => {
    it('puts no capability in the PTY env, even with a leftover in process.env', () => {
      process.env[CAPABILITY_ENV_NAME] = 'leftover-from-a-parent-agent';
      const { id, spawn, token } = h.launch();
      expect(id).toBe(1);
      expect(token).toBeUndefined();
      expect(Object.keys(spawn!.options.env!)).not.toContain(CAPABILITY_ENV_NAME);
      expect(h.capabilities.size).toBe(0);
    });

    it('spawns exactly the command and environment it always did', () => {
      process.env[CAPABILITY_ENV_NAME] = 'leftover-from-a-parent-agent';
      const cwd = process.cwd();
      const { id, spawn } = h.launch();
      const sessionId = h.store.get(id!)!.sessionId;
      const expected = claudeProvider.buildLaunchCommand!(sessionId, cwd, {
        bypassPermissions: undefined,
      });
      expect(spawn!.file).toBe(expected.command);
      expect(spawn!.args).toEqual(expected.args);

      const inherited: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== CAPABILITY_ENV_NAME) inherited[key] = value;
      }
      expect(spawn!.options.env).toEqual({
        ...inherited,
        ...expected.env,
        TERM: TERMINAL_TERM_NAME,
      });
    });

    it('issues nothing with isKbEnabled but no registry, or false', () => {
      expect(h.launch({ kb: true, withoutRegistry: true }).token).toBeUndefined();
      expect(h.launch({ kb: false }).token).toBeUndefined();
      expect(h.capabilities.size).toBe(0);
    });

    it('strips the variable case-insensitively on Windows only', () => {
      const env = { pixel_agents_capability: 'x', [CAPABILITY_ENV_NAME]: 'y', Path: 'p' };
      expect(withoutCapabilityEnv(env, 'win32')).toEqual({ Path: 'p' });
      expect(withoutCapabilityEnv(env, 'linux')).toEqual({
        pixel_agents_capability: 'x',
        Path: 'p',
      });
      const clean = { Path: 'p' };
      expect(withoutCapabilityEnv(clean, 'win32')).toBe(clean);
    });
  });

  // ── C: verify input ─────────────────────────────────────────

  describe('C: verify refuses anything but a live token', () => {
    it('returns null for empty, unknown, foreign and malformed input', () => {
      const { token } = h.launch({ kb: true });
      const other = h.launch({ kb: true });

      // Another server's registry (same store shape, different instance).
      const foreignStore = new AgentStateStore();
      const foreign = new CapabilityRegistry({
        store: foreignStore,
        ptyManager: PtySessionManager.disabled('test'),
      });
      const foreignToken = foreign.issue({ agentId: 1, sessionId: 's', workspaceId: undefined });

      for (const presented of [
        '',
        'Bearer ',
        'Bearer',
        `pxa_kb_${'A'.repeat(43)}`,
        foreignToken.token,
        `bearer ${token}`,
        `Bearer  ${token}`,
        `Bearer ${token} `,
        ` ${token}`,
        `Basic ${token}`,
        `${token}x`,
        token!.slice(0, -1),
        `Bearer Bearer ${token}`,
        undefined,
        null,
        42,
        { token },
        [token],
      ]) {
        expect(h.capabilities.verify(presented)).toBeNull();
      }
      // Someone else's token proves someone else, never this agent.
      expect(h.capabilities.verify(other.token)?.agentId).toBe(other.id);
      expect(h.capabilities.verify(token)?.agentId).toBe(1);
      foreignStore.dispose();
    });
  });

  // ── D: revocation ───────────────────────────────────────────

  describe('D: revocation (capability gone, curator cleared and announced)', () => {
    /** Launch an eligible agent in `workspace` and appoint it curator there. */
    function curatorAgent(workspace?: { id: string; dir: string }): {
      id: number;
      token: string;
      workspaceId: string;
    } {
      const { id, token } = h.launch({ kb: true, directoryPath: workspace?.dir });
      const workspaceId = workspace?.id ?? DEFAULT_WORKSPACE_ID;
      expect(h.send({ type: 'setWorkspaceCurator', workspaceId, agentId: id })).toEqual([]);
      expect(h.curators.curatorOf(workspaceId)).toBe(id);
      return { id: id!, token: token!, workspaceId };
    }

    /** Checked BEFORE any verify(): the hook itself must have revoked (verify
     *  would otherwise revoke on its own live re-check and mask a missing hook). */
    function expectRevoked(token: string, workspaceId: string, agentId: number): void {
      expect(h.curators.curatorOf(workspaceId)).toBeNull();
      expect(h.curatorBroadcasts()).toContainEqual({
        type: 'workspaceCuratorChanged',
        workspaceId,
        agentId: null,
      });
      expect(h.capabilities.size).toBe(0);
      expect(h.capabilities.verify(token)).toBeNull();
      expect(h.capabilities.validFor(agentId)).toBeNull();
    }

    it('create throwing: the id rolls back and the registry stays empty', () => {
      h.spawnShouldThrow = true;
      const { id } = h.launch({ kb: true });
      expect(id).toBeNull();
      expect(h.store.nextAgentId.current).toBe(1);
      expect(h.store.size).toBe(0);
      expect(h.capabilities.size).toBe(0);
    });

    it('the PTY exiting on its own', () => {
      const c = curatorAgent();
      // Revoked by the process itself, before the store cleanup even starts.
      let sizeWhenClosed = -1;
      h.store.on('broadcast', (m) => {
        if (m.type === 'terminalSessionClosed') sizeWhenClosed = h.capabilities.size;
      });
      h.spawned[0].pty.exit(0);
      expect(sizeWhenClosed).toBe(0);
      expectRevoked(c.token, c.workspaceId, c.id);
    });

    it('a closeAgent message', () => {
      const c = curatorAgent();
      h.send({ type: 'closeAgent', id: c.id });
      expectRevoked(c.token, c.workspaceId, c.id);
    });

    it('removeTeammate (team-switch) removing a PTY agent', () => {
      const c = curatorAgent();
      h.store.get(c.id)!.leadAgentId = 99;
      h.runtime.removeTeammate(c.id, 'team-switch');
      expect(h.store.has(c.id)).toBe(false);
      expectRevoked(c.token, c.workspaceId, c.id);
    });

    it('removeWorkspace re-filing its agents under the default', () => {
      const ws = h.workspace('alpha');
      const c = curatorAgent(ws);
      h.send({ type: 'removeWorkspace', id: ws.id });
      expect(h.store.get(c.id)?.workspaceId).toBeUndefined();
      expectRevoked(c.token, ws.id, c.id);
    });

    it("a Lead's move carrying its follower along", () => {
      const alpha = h.workspace('alpha');
      const beta = h.workspace('beta');
      const lead = h.launch({ kb: true, directoryPath: alpha.dir });
      const follower = curatorAgent(alpha);
      h.store.get(follower.id)!.leadAgentId = lead.id!;

      h.store.setAgentWorkspace(lead.id!, beta.id);

      expect(h.store.get(follower.id)?.workspaceId).toBe(beta.id);
      expectRevoked(follower.token, alpha.id, follower.id);
      expect(h.capabilities.verify(lead.token)).toBeNull();
    });

    it('restore re-filing a teammate under its Lead', () => {
      const alpha = h.workspace('alpha');
      const beta = h.workspace('beta');
      const c = curatorAgent(alpha);
      h.store.get(c.id)!.leadAgentId = 77;
      const leadFile = path.join(h.projectDir, 'lead.jsonl');
      fs.writeFileSync(leadFile, '');
      const adapter = h.store.getAdapter()!;
      adapter.saveAgents([
        ...adapter.loadAgents(),
        {
          id: 77,
          sessionId: 'lead',
          terminalName: '',
          isExternal: true,
          jsonlFile: leadFile,
          projectDir: h.projectDir,
          workspaceId: beta.id,
        },
      ]);

      h.runtime.restoreExternalAgents();

      expect(h.store.get(c.id)?.workspaceId).toBe(beta.id);
      expectRevoked(c.token, alpha.id, c.id);
    });

    it('runtime.dispose', () => {
      const c = curatorAgent();
      h.runtime.dispose();
      expectRevoked(c.token, c.workspaceId, c.id);
    });

    it('store.clear()', () => {
      const c = curatorAgent();
      h.store.clear();
      expectRevoked(c.token, c.workspaceId, c.id);
      expect(h.capabilities.size).toBe(0);
    });
  });

  // ── E: post-create failure window ───────────────────────────

  it('E: a throwing agentAdded listener leaves no capability and no live PTY', () => {
    h.store.on('agentAdded', () => {
      throw new Error('listener blew up');
    });
    const { id, token, spawn } = h.launch({ kb: true });

    expect(id).toBeNull();
    expect(token).toMatch(TOKEN_SHAPE);
    expect(h.capabilities.verify(token)).toBeNull();
    expect(h.capabilities.size).toBe(0);
    expect(spawn!.pty.killSignals.length).toBeGreaterThan(0);
    expect(h.manager.has(1)).toBe(false);
    expect(h.store.has(1)).toBe(false);
  });

  // ── F: /clear ───────────────────────────────────────────────

  it('F: still verifies after /clear rewrites the sessionId', () => {
    const { id, token } = h.launch({ kb: true });
    const oldSession = h.store.get(id!)!.sessionId;
    const newSession = '22222222-2222-4222-8222-222222222222';

    h.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: oldSession,
      reason: 'clear',
    });
    h.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: newSession,
      source: 'clear',
      transcript_path: path.join(h.projectDir, `${newSession}.jsonl`),
    });

    expect(h.store.get(id!)!.sessionId).toBe(newSession);
    // Authorization ignores the session; the claim keeps the issued one (audit).
    expect(h.capabilities.verify(token)).toMatchObject({ agentId: id, sessionId: oldSession });
  });

  // ── G: shadow store ─────────────────────────────────────────

  it("G: the sub-agent shadow store's mutations never touch the registry", () => {
    const { id, token } = h.launch({ kb: true });
    const shadow = h.runtime.subagentWatch.store;
    const twin = createAgentState({
      id: id!,
      sessionId: 'shadow',
      isExternal: true,
      projectDir: h.projectDir,
      jsonlFile: path.join(h.projectDir, 'shadow.jsonl'),
    });

    shadow.set(id!, twin);
    shadow.setAgentWorkspace(id!, 'elsewhere');
    shadow.delete(id!);
    shadow.set(id!, twin);
    shadow.clear();

    expect(h.capabilities.verify(token)?.agentId).toBe(id);
    expect(h.capabilities.size).toBe(1);
  });

  // ── I: Workspace changes and restarts ───────────────────────

  describe('I: Workspace moves and restarts', () => {
    it('a move revokes for good: moving back does not revive the token', () => {
      const alpha = h.workspace('alpha');
      const beta = h.workspace('beta');
      const { id, token } = h.launch({ kb: true, directoryPath: alpha.dir });
      expect(h.send({ type: 'setWorkspaceCurator', workspaceId: alpha.id, agentId: id })).toEqual(
        [],
      );

      h.store.setAgentWorkspace(id!, beta.id);
      // The move itself revoked (checked before verify, which would too).
      expect(h.capabilities.size).toBe(0);
      expect(h.curatorBroadcasts()).toContainEqual({
        type: 'workspaceCuratorChanged',
        workspaceId: alpha.id,
        agentId: null,
      });
      expect(h.capabilities.verify(token)).toBeNull();

      h.store.setAgentWorkspace(id!, alpha.id);
      expect(h.capabilities.verify(token)).toBeNull();
      expect(h.send({ type: 'setWorkspaceCurator', workspaceId: alpha.id, agentId: id })).toEqual([
        expect.objectContaining({ type: 'curatorRejected', code: 'not_eligible' }),
      ]);
    });

    it('a restarted server (new store and registry) knows no capability and no curator', () => {
      const { id, token } = h.launch({ kb: true });
      h.send({ type: 'setWorkspaceCurator', workspaceId: DEFAULT_WORKSPACE_ID, agentId: id });
      expect(h.curators.list()).toHaveLength(1);

      const store = new AgentStateStore();
      const capabilities = new CapabilityRegistry({ store, ptyManager: h.manager });
      const curators = new CuratorTable({ capabilities, broadcast: () => {} });
      expect(capabilities.verify(token)).toBeNull();
      expect(curators.list()).toEqual([]);

      const replies = h.send(
        { type: 'webviewReady' },
        h.ctx({ store, capabilities, curators, runtime: h.runtime }),
      );
      expect(replies.find((m) => m.type === 'curatorsLoaded')).toEqual({
        type: 'curatorsLoaded',
        available: true,
        curators: [],
      });
      store.dispose();
    });
  });

  // ── J: nothing leaks ────────────────────────────────────────

  it('J: neither the token nor its digest appears in any output', () => {
    const logged: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
    const added: string[] = [];
    h.store.on('agentAdded', (id, agent) => {
      // Both the raw state object and the agentCreated fields httpServer sends.
      added.push(JSON.stringify(agent));
      added.push(JSON.stringify({ ...agent, type: 'agentCreated', id }));
    });

    const ws = h.workspace('alpha');
    const first = h.launch({ kb: true, directoryPath: ws.dir });
    const second = h.launch({ kb: true });
    const replies: Array<Record<string, unknown>> = [];
    replies.push(...h.send({ type: 'setWorkspaceCurator', workspaceId: ws.id, agentId: first.id }));
    replies.push(
      ...h.send({
        type: 'setWorkspaceCurator',
        workspaceId: DEFAULT_WORKSPACE_ID,
        agentId: second.id,
      }),
    );
    replies.push(...h.send({ type: 'webviewReady' }));
    replies.push(...h.send({ type: 'requestDiagnostics' }));
    h.store.persist();
    const persistedFile = path.join(h.tempHome, '.pixel-agents', 'standalone-state.json');
    const persisted = fs.readFileSync(persistedFile, 'utf-8');

    expect(replies.some((m) => m.type === 'existingAgents')).toBe(true);
    expect(replies.some((m) => m.type === 'agentDiagnostics')).toBe(true);
    expect(h.curatorBroadcasts()).toHaveLength(2);

    const haystack = [
      JSON.stringify(h.broadcasts),
      JSON.stringify(replies),
      added.join('\n'),
      persisted,
      logged.join('\n'),
      JSON.stringify([...h.store.values()]),
      JSON.stringify(h.spawned.map((s) => [s.file, s.args])),
    ].join('\n');
    for (const token of [first.token!, second.token!]) {
      const secret = token.slice('pxa_kb_'.length);
      expect(haystack).not.toContain(secret);
      expect(haystack).not.toContain(sha256Hex(token));
      expect(haystack).not.toContain(crypto.createHash('sha256').update(token).digest('base64'));
      expect(haystack).not.toContain(crypto.createHash('sha256').update(token).digest('base64url'));
    }
    expect(h.capabilities.verify(first.token)?.agentId).toBe(first.id);
  });
});
