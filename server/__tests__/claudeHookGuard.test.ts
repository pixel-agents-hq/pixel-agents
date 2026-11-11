/**
 * 阻擋式裁決的端對端測試：以子行程執行打包後的 dist/hooks/claude-hook.js，
 * 搭配假的裁決伺服器或真的 standalone PixelAgentsServer。不呼叫真實 claude。
 *
 * 假設（未實測，P0 #1～#3）：Claude Code 依官方文件回報解讀 hook 的 stdout；
 * 這裡固定的是我們輸出的格式，不是 Claude Code 的行為。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const os = await import('os');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createAgentState } = await import('../src/agentState.js');
const { PixelAgentsServer } = await import('../src/server.js');
const { WriteGuard } = await import('../src/writeGuard/writeGuard.js');
const {
  WRITE_GUARD_API_PATH,
  WRITE_GUARD_DENY_TEMPLATES,
  WRITE_GUARD_RULE_PROTECTED_PATH,
  WRITE_GUARD_RULE_UNREACHABLE,
} = await import('../src/constants.js');

const HOOK_SCRIPT = path.join(__dirname, '../../dist/hooks/claude-hook.js');
const SESSION = 'guarded-session';

function writeRegistry(pid: number, port: number, token: string, standalone: boolean): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'servers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}-${port}.json`),
    JSON.stringify({
      port,
      pid,
      token,
      startedAt: Date.now(),
      servesSpa: standalone,
      protocol: 1,
      ...(standalone ? { standalone: { terminal: true, host: '127.0.0.1' } } : {}),
    }),
  );
}

/** 測試直寫的清單（P1 的受保護根目錄只由測試提供）。 */
function writeList(pid: number, port: number, roots: string[], sessions: string[]): void {
  const dir = path.join(tmpBase, '.pixel-agents', 'guard');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${pid}-${port}.json`),
    JSON.stringify({ version: 1, pid, port, protectedRoots: roots, knownSessions: sessions }),
  );
}

interface FakeServer {
  port: number;
  guardBodies: string[];
  hookBodies: string[];
  close(): Promise<void>;
}

/** 假伺服器：裁決端點依 respond 回覆，事件端點記錄並回 ok。 */
function startFakeServer(
  respond: (body: string) => { status: number; body: string },
): Promise<FakeServer> {
  const guardBodies: string[] = [];
  const hookBodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url === WRITE_GUARD_API_PATH) {
        guardBodies.push(body);
        const answer = respond(body);
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(answer.body);
        return;
      }
      hookBodies.push(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        guardBodies,
        hookBodies,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 取得一個目前沒人在聽的 port（伺服器不可達）。 */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function runHook(payload: unknown): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK_SCRIPT], {
      env: { ...process.env, HOME: tmpBase, USERPROFILE: tmpBase, PIXEL_AGENTS_DEBUG_LOG: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function write(filePath: string, sessionId = SESSION, content = 'hi') {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: tmpBase,
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
  };
}

function denyReason(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

const allowBody = { status: 200, body: JSON.stringify({ verdict: 'allow' }) };
const denyBody = (p?: string) => ({
  status: 200,
  body: JSON.stringify({
    verdict: 'deny',
    rule: WRITE_GUARD_RULE_PROTECTED_PATH,
    ...(p ? { path: p } : {}),
  }),
});

let protectedRoot: string;
let openFile: string;
const cleanups: (() => Promise<void> | void)[] = [];

const notBuilt = !fs.existsSync(HOOK_SCRIPT);
const itBuilt = it.skipIf(notBuilt);

beforeEach(() => {
  tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-guard-')));
  protectedRoot = path.join(tmpBase, 'ws', '.note');
  fs.mkdirSync(protectedRoot, { recursive: true });
  fs.mkdirSync(path.join(tmpBase, 'ws', 'src'), { recursive: true });
  openFile = path.join(tmpBase, 'ws', 'src', 'a.ts');
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('claude-hook.js write guard (bundled script)', () => {
  itBuilt('allow: exit 0, no stdout, and the event is still forwarded', async () => {
    const fake = await startFakeServer(() => allowBody);
    cleanups.push(fake.close);
    writeRegistry(process.pid, fake.port, 't', true);
    writeList(process.pid, fake.port, [protectedRoot], [SESSION]);

    const result = await runHook(write(path.join(protectedRoot, 'a.md')));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(fake.guardBodies).toHaveLength(1);
    expect(fake.hookBodies).toHaveLength(1);
    expect(JSON.parse(fake.hookBodies[0]).tool_input.content).toBe('hi');
  });

  itBuilt('deny: exit 0 with the JSON deny and the fixed three-part reason', async () => {
    const target = path.join(protectedRoot, 'a.md');
    const fake = await startFakeServer(() => denyBody(target));
    cleanups.push(fake.close);
    writeRegistry(process.pid, fake.port, 't', true);
    writeList(process.pid, fake.port, [protectedRoot], [SESSION]);

    const result = await runHook(write(target));
    expect(result.code).toBe(0);
    const reason = denyReason(result.stdout);
    const template = WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_PROTECTED_PATH];
    expect(reason).toContain(`Reason: ${template.reason}`);
    expect(reason).toContain(`Why: ${template.rationale}`);
    expect(reason).toContain(`Suggestion: ${template.suggestion}`);
    expect(reason).toContain(JSON.stringify(target));
  });

  itBuilt(
    'unreachable known standalone session: protected write denied, other writes allowed',
    async () => {
      const port = await closedPort();
      writeRegistry(process.pid, port, 't', true);
      writeList(process.pid, port, [protectedRoot], [SESSION]);

      const denied = await runHook(write(path.join(protectedRoot, 'a.md')));
      expect(denied.code).toBe(0);
      expect(denyReason(denied.stdout)).toContain(
        WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason,
      );
      expect(denied.ms).toBeLessThan(5000);

      const allowed = await runHook(write(openFile));
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toBe('');
    },
  );

  itBuilt('unreachable but unknown session: allowed', async () => {
    const port = await closedPort();
    writeRegistry(process.pid, port, 't', true);
    writeList(process.pid, port, [protectedRoot], ['someone-else']);
    const result = await runHook(write(path.join(protectedRoot, 'a.md')));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  itBuilt('VS Code (embedded) entry: never asked, list ignored, allowed', async () => {
    const fake = await startFakeServer(() => denyBody());
    cleanups.push(fake.close);
    writeRegistry(process.pid, fake.port, 't', false);
    writeList(process.pid, fake.port, [protectedRoot], [SESSION]);
    const result = await runHook(write(path.join(protectedRoot, 'a.md')));
    expect(result.stdout).toBe('');
    expect(fake.guardBodies).toHaveLength(0);
    expect(fake.hookBodies).toHaveLength(1);
  });

  itBuilt('old server (no list) answering 404: never asked, allowed', async () => {
    const fake = await startFakeServer(() => ({ status: 404, body: 'Not Found' }));
    cleanups.push(fake.close);
    writeRegistry(process.pid, fake.port, 't', true);
    // 舊版伺服器不寫清單。
    const result = await runHook(write(path.join(protectedRoot, 'a.md')));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(fake.guardBodies).toHaveLength(0);
    expect(fake.hookBodies).toHaveLength(1);
  });

  for (const status of [500, 401, 403]) {
    itBuilt(
      `listing server answering HTTP ${status}: protected write denied, other writes allowed`,
      async () => {
        const fake = await startFakeServer(() => ({ status, body: 'error' }));
        cleanups.push(fake.close);
        writeRegistry(process.pid, fake.port, 't', true);
        writeList(process.pid, fake.port, [protectedRoot], [SESSION]);

        const denied = await runHook(write(path.join(protectedRoot, 'a.md')));
        expect(denied.code).toBe(0);
        expect(denyReason(denied.stdout)).toContain(
          WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason,
        );

        const allowed = await runHook(write(openFile));
        expect(allowed.code).toBe(0);
        expect(allowed.stdout).toBe('');
        expect(fake.guardBodies).toHaveLength(2);
      },
    );
  }

  itBuilt(
    'two listing servers, one answering 500 and one allowing: protected denied, open allowed',
    async () => {
      const broken = await startFakeServer(() => ({ status: 500, body: 'error' }));
      const healthy = await startFakeServer(() => allowBody);
      cleanups.push(broken.close, healthy.close);
      writeRegistry(process.pid, broken.port, 'tb', true);
      writeRegistry(process.pid, healthy.port, 'th', true);
      writeList(process.pid, broken.port, [protectedRoot], [SESSION]);
      writeList(process.pid, healthy.port, [protectedRoot], [SESSION]);

      const denied = await runHook(write(path.join(protectedRoot, 'a.md')));
      expect(denyReason(denied.stdout)).toContain(
        WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason,
      );
      const allowed = await runHook(write(openFile));
      expect(allowed.stdout).toBe('');
    },
  );

  itBuilt('registry with no live PID: everything allowed', async () => {
    const port = await closedPort();
    writeRegistry(999_999, port, 't', true);
    writeList(999_999, port, [protectedRoot], [SESSION]);
    const result = await runHook(write(path.join(protectedRoot, 'a.md')));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  itBuilt('two servers that both know the session, answering allow and deny: deny', async () => {
    const a = await startFakeServer(() => allowBody);
    const b = await startFakeServer(() => denyBody());
    cleanups.push(a.close, b.close);
    writeRegistry(process.pid, a.port, 'ta', true);
    writeRegistry(process.pid, b.port, 'tb', true);
    writeList(process.pid, a.port, [protectedRoot], [SESSION]);
    writeList(process.pid, b.port, [protectedRoot], [SESSION]);
    const result = await runHook(write(path.join(protectedRoot, 'a.md')));
    expect(denyReason(result.stdout)).toContain('Reason:');
    expect(a.guardBodies).toHaveLength(1);
    expect(b.guardBodies).toHaveLength(1);
  });

  itBuilt(
    'a >64 KB Write still gets the right verdict and the request carries no content',
    async () => {
      const target = path.join(protectedRoot, 'big.md');
      const fake = await startFakeServer(() => denyBody(target));
      cleanups.push(fake.close);
      writeRegistry(process.pid, fake.port, 't', true);
      writeList(process.pid, fake.port, [protectedRoot], [SESSION]);
      const result = await runHook(write(target, SESSION, 'y'.repeat(100 * 1024)));
      expect(denyReason(result.stdout)).toContain(JSON.stringify(target));
      expect(fake.guardBodies).toHaveLength(1);
      expect(fake.guardBodies[0]).not.toContain('yyyy');
      expect(Object.keys(JSON.parse(fake.guardBodies[0])).sort()).toEqual([
        'cwd',
        'paths',
        'session_id',
        'tool_name',
      ]);
    },
  );

  itBuilt('non-PreToolUse events produce no output and no verdict request', async () => {
    const fake = await startFakeServer(() => denyBody());
    cleanups.push(fake.close);
    writeRegistry(process.pid, fake.port, 't', true);
    writeList(process.pid, fake.port, [protectedRoot], [SESSION]);
    const result = await runHook({ session_id: SESSION, hook_event_name: 'Stop' });
    expect(result.stdout).toBe('');
    expect(fake.guardBodies).toHaveLength(0);
    expect(fake.hookBodies).toHaveLength(1);
  });
});

describe('claude-hook.js against a real standalone server', () => {
  itBuilt(
    'denies a PTY agent writing a protected root; allows it elsewhere; forwards both',
    async () => {
      const store = new AgentStateStore();
      store.set(
        1,
        createAgentState({
          id: 1,
          sessionId: SESSION,
          projectDir: tmpBase,
          jsonlFile: path.join(tmpBase, `${SESSION}.jsonl`),
          isExternal: false,
        }),
      );
      const guard = new WriteGuard({ store, ptyManager: { has: (id) => id === 1 } });
      guard.setProtectedRoots([protectedRoot]);
      const received: string[] = [];
      const server = new PixelAgentsServer();
      server.onHookEvent((_provider, event) => received.push(String(event.hook_event_name)));
      cleanups.push(() => server.stop());
      await server.start({ embedded: false, store, writeGuard: guard });

      const target = path.join(protectedRoot, 'nested', 'new.md');
      const denied = await runHook(write(target));
      expect(denied.code).toBe(0);
      const reason = denyReason(denied.stdout);
      expect(reason).toContain(WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_PROTECTED_PATH].reason);
      expect(reason).toContain(JSON.stringify(target));

      const allowed = await runHook(write(openFile));
      expect(allowed.code).toBe(0);
      expect(allowed.stdout).toBe('');

      const otherSession = await runHook(write(target, 'not-a-pty-agent'));
      expect(otherSession.stdout).toBe('');

      expect(received.filter((e) => e === 'PreToolUse')).toHaveLength(3);
    },
  );
});
