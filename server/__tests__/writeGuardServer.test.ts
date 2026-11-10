/**
 * 阻擋式裁決的伺服器端（P1）：記憶體裁決、清單發佈與更新、內嵌分流、
 * 端點的縱深防禦。不呼叫真實 claude。
 */

import * as http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

/** 計數同步與非同步檔案系統呼叫（F13：裁決路徑必須是 0）。`vi.spyOn` 不能重定義
 *  ESM namespace，因此沿用 claudeHookInstaller.test.ts 的 module mock 作法。 */
const fsCounter = { on: false, calls: [] as string[] };
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const counted = <K extends keyof typeof actual>(name: K) => {
    const original = actual[name] as unknown as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => {
      if (fsCounter.on) fsCounter.calls.push(String(name));
      return original(...args);
    };
  };
  const names = [
    'readFileSync',
    'writeFileSync',
    'appendFileSync',
    'realpathSync',
    'statSync',
    'lstatSync',
    'existsSync',
    'readdirSync',
    'openSync',
    'readSync',
    'renameSync',
    'unlinkSync',
    'mkdirSync',
    'accessSync',
    'readFile',
    'writeFile',
    'realpath',
    'stat',
    'lstat',
  ] as const;
  const overrides = Object.fromEntries(names.map((n) => [n, counted(n)]));
  const realpathSync = Object.assign(overrides.realpathSync as typeof actual.realpathSync, {
    native: actual.realpathSync.native,
  });
  const promises = new Proxy(actual.promises, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (fsCounter.on) fsCounter.calls.push(`promises.${String(prop)}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const mocked = { ...actual, ...overrides, realpathSync, promises };
  return { ...mocked, default: mocked };
});

const fs = await import('fs');
const os = await import('os');
const path = await import('path');
const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createAgentState } = await import('../src/agentState.js');
const { WriteGuard } = await import('../src/writeGuard/writeGuard.js');
const { guardListPath, guardListsDir } = await import('../src/writeGuard/guardList.js');
const { guardRequestAuthorized } = await import('../src/writeGuard/endpointFilter.js');
const { PixelAgentsServer } = await import('../src/server.js');
const { WRITE_GUARD_API_PATH, WRITE_GUARD_RULE_PROTECTED_PATH } =
  await import('../src/constants.js');

type Store = InstanceType<typeof AgentStateStore>;

function addAgent(store: Store, id: number, sessionId: string, isExternal = false): void {
  store.set(
    id,
    createAgentState({
      id,
      sessionId,
      projectDir: path.join(tmpBase, 'projects'),
      jsonlFile: path.join(tmpBase, 'projects', `${sessionId}.jsonl`),
      isExternal,
    }),
  );
}

class FakeSessions {
  private listeners = new Set<() => void>();
  onSessionsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify(): void {
    for (const l of this.listeners) l();
  }
}

function readList(owner: { pid: number; port: number }): {
  knownSessions: string[];
  protectedRoots: string[];
} | null {
  try {
    return JSON.parse(fs.readFileSync(guardListPath(tmpBase, owner), 'utf-8')) as {
      knownSessions: string[];
      protectedRoots: string[];
    };
  } catch {
    return null;
  }
}

/** 直接控制標頭的 POST（fetch 不允許改 Host）。 */
function rawPost(
  port: number,
  headers: Record<string, string | string[]>,
  body: string,
  urlPath = WRITE_GUARD_API_PATH,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

let protectedRoot: string;
let held: Set<number>;
let store: Store;

beforeEach(() => {
  tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-guard-srv-')));
  protectedRoot = path.join(tmpBase, 'workspace', '.note');
  fs.mkdirSync(protectedRoot, { recursive: true });
  held = new Set<number>();
  store = new AgentStateStore();
  fsCounter.on = false;
  fsCounter.calls = [];
});

afterEach(() => {
  fsCounter.on = false;
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function guardWith(sessions?: FakeSessions) {
  return new WriteGuard({ store, ptyManager: { has: (id) => held.has(id) }, sessions });
}

// ── 記憶體裁決 ─────────────────────────────────────────────────────

describe('WriteGuard.verdict', () => {
  it('answers unknown-session for a session no PTY agent of this server holds', () => {
    const guard = guardWith();
    addAgent(store, 1, 'adopted-external', true); // 收編的外部 session：不在 PTY 清單
    guard.setProtectedRoots([protectedRoot]);
    const request = {
      tool_name: 'Write',
      session_id: 'adopted-external',
      cwd: tmpBase,
      paths: [path.join(protectedRoot, 'a.md')],
    };
    expect(guard.verdict(request)).toEqual({ verdict: 'unknown-session' });
    expect(guard.verdict({ ...request, session_id: 'manual-claude' })).toEqual({
      verdict: 'unknown-session',
    });
  });

  it('denies a known PTY agent writing under a protected root and allows elsewhere', () => {
    const guard = guardWith();
    addAgent(store, 2, 'pty-session');
    held.add(2);
    guard.setProtectedRoots([protectedRoot]);
    const target = path.join(protectedRoot, 'sub', 'a.md');
    expect(
      guard.verdict({
        tool_name: 'Write',
        session_id: 'pty-session',
        cwd: tmpBase,
        paths: [target],
      }),
    ).toEqual({ verdict: 'deny', rule: WRITE_GUARD_RULE_PROTECTED_PATH, path: target });
    expect(
      guard.verdict({
        tool_name: 'Write',
        session_id: 'pty-session',
        cwd: tmpBase,
        paths: [path.join(tmpBase, 'workspace', 'src', 'a.ts')],
      }),
    ).toEqual({ verdict: 'allow' });
  });

  it('rejects a malformed request', () => {
    const guard = guardWith();
    expect(guard.verdict({ session_id: 's' })).toBeNull();
    expect(guard.verdict({ tool_name: 'Write', session_id: 's', cwd: '/', paths: [1] })).toBeNull();
    expect(guard.verdict('nope')).toBeNull();
  });

  it('makes no file system call while deciding, sync or async (F13)', () => {
    const guard = guardWith();
    for (let i = 0; i < 20; i++) {
      addAgent(store, i, `s-${i}`);
      held.add(i);
    }
    guard.setProtectedRoots([protectedRoot]);
    fsCounter.calls = [];
    fsCounter.on = true;
    for (let i = 0; i < 20; i++) {
      guard.verdict({
        tool_name: 'Write',
        session_id: `s-${i}`,
        cwd: tmpBase,
        paths: [path.join(protectedRoot, 'a.md'), path.join(tmpBase, 'x')],
      });
    }
    guard.verdict({ tool_name: 'Write', session_id: 'unknown', cwd: tmpBase, paths: ['/x'] });
    fsCounter.on = false;
    expect(fsCounter.calls).toEqual([]);
  });

  it('P2: makes no file system call while deciding with KB rules and F17 active (F13)', () => {
    const wsRoot = path.join(tmpBase, 'workspace');
    const guard = new WriteGuard({
      store,
      ptyManager: { has: (id) => held.has(id) },
      curators: { curatorOf: () => 1 },
      workspaces: () => [{ id: 'default', name: 'Default', directoryPaths: [], rootPath: wsRoot }],
    });
    for (let i = 1; i <= 5; i++) {
      held.add(i);
      store.set(
        i,
        createAgentState({
          id: i,
          sessionId: `kb-${i}`,
          projectDir: tmpBase,
          jsonlFile: path.join(tmpBase, `kb-${i}.jsonl`),
          isExternal: false,
          directoryRealPath: path.join(tmpBase, `dir-${i}`),
          roleId: 'a.md',
        }),
      );
    }
    expect(guard.getKbState().anyActive).toBe(true);
    fsCounter.calls = [];
    fsCounter.on = true;
    const verdicts = [1, 2, 3, 4, 5].map((i) =>
      guard.verdict({
        tool_name: 'Write',
        session_id: `kb-${i}`,
        cwd: tmpBase,
        paths: [
          path.join(protectedRoot, 'a.md'),
          path.join(tmpBase, `dir-${i}`, '.note', 'b.md', 'x'),
          path.join(tmpBase, '.pixel-agents', 'x'),
        ],
      }),
    );
    guard.verdict({ tool_name: 'Write', session_id: 'kb-2', cwd: '', paths: [], unresolved: true });
    fsCounter.on = false;
    expect(fsCounter.calls).toEqual([]);
    // 1 號是 curator：工作空間 KB 放行，但 b.md 不是自己的識別鍵；其餘不是 curator。
    for (const v of verdicts) expect(v).toMatchObject({ verdict: 'deny' });
    guard.dispose();
  });

  it('stores protected roots realpath-resolved (the work happens at list time, not verdict time)', () => {
    const guard = guardWith();
    const link = path.join(tmpBase, 'note-link');
    fs.symlinkSync(protectedRoot, link);
    guard.setProtectedRoots([link, path.join(tmpBase, 'does-not-exist')]);
    expect(guard.getProtectedRoots()).toEqual([protectedRoot]);
  });
});

// ── 驗收 6：清單發佈與更新 ─────────────────────────────────────────

describe('WriteGuard list publishing', () => {
  const owner = { pid: process.pid, port: 45_001 };

  it('lists a PTY agent once registered and drops it on removal, /clear and clear-all', () => {
    const sessions = new FakeSessions();
    const guard = guardWith(sessions);
    guard.publish(owner);
    expect(readList(owner)?.knownSessions).toEqual([]);

    held.add(1);
    addAgent(store, 1, 'first');
    addAgent(store, 2, 'not-a-pty'); // 非 PTY：不列
    expect(readList(owner)?.knownSessions).toEqual(['first']);

    // /clear：session id 換掉後，AgentRuntime.registerAgent 會通知。
    store.get(1)!.sessionId = 'after-clear';
    sessions.notify();
    expect(readList(owner)?.knownSessions).toEqual(['after-clear']);

    // PTY 結束（manager 先自我移除），再從 store 移除。
    held.delete(1);
    sessions.notify();
    expect(readList(owner)?.knownSessions).toEqual([]);
    held.add(1);
    store.delete(1);
    expect(readList(owner)?.knownSessions).toEqual([]);

    held.add(3);
    addAgent(store, 3, 'third');
    expect(readList(owner)?.knownSessions).toEqual(['third']);
    store.clear();
    expect(readList(owner)?.knownSessions).toEqual([]);

    guard.unpublish();
    expect(readList(owner)).toBeNull();
  });

  it('follows /clear through the real AgentRuntime session registration', async () => {
    const { AgentRuntime } = await import('../src/agentRuntime.js');
    const { claudeProvider } = await import('../src/providers/index.js');
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      const guard = new WriteGuard({
        store,
        ptyManager: { has: (id) => held.has(id) },
        sessions: runtime,
      });
      guard.publish(owner);
      held.add(7);
      addAgent(store, 7, 'pre-clear');
      runtime.registerAgent('pre-clear', 7);
      expect(readList(owner)?.knownSessions).toEqual(['pre-clear']);

      // 與 onSessionClear 相同的順序：取消舊的、換 id、註冊新的。
      runtime.unregisterAgent('pre-clear');
      store.get(7)!.sessionId = 'post-clear';
      runtime.registerAgent('post-clear', 7);
      expect(readList(owner)?.knownSessions).toEqual(['post-clear']);
      guard.unpublish();
    } finally {
      runtime.dispose();
    }
  });

  it('picks up a session id change that bypassed every event via the fallback refresh', async () => {
    vi.useFakeTimers();
    try {
      const guard = guardWith();
      held.add(1);
      addAgent(store, 1, 'before');
      guard.publish(owner);
      expect(readList(owner)?.knownSessions).toEqual(['before']);
      store.get(1)!.sessionId = 'heuristic-clear';
      await vi.advanceTimersByTimeAsync(1_100);
      expect(readList(owner)?.knownSessions).toEqual(['heuristic-clear']);
      guard.unpublish();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes the list with mode 0600 and the protected roots realpath-resolved', () => {
    const guard = guardWith();
    guard.publish(owner);
    guard.setProtectedRoots([protectedRoot]);
    const file = guardListPath(tmpBase, owner);
    expect(readList(owner)?.protectedRoots).toEqual([protectedRoot]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    guard.unpublish();
  });
});

describe('PixelAgentsServer wiring', () => {
  let servers: InstanceType<typeof PixelAgentsServer>[] = [];
  afterEach(() => {
    for (const s of servers) s.stop();
    servers = [];
  });

  it('publishes on a standalone start, removes on stop, and a restart starts empty', async () => {
    const guard = guardWith();
    held.add(1);
    addAgent(store, 1, 'live');
    const first = new PixelAgentsServer();
    servers.push(first);
    const config = await first.start({ embedded: false, store, writeGuard: guard });
    expect(readList(config)?.knownSessions).toEqual(['live']);

    first.stop();
    expect(readList(config)).toBeNull();

    // 重啟：PTY Agent 不被還原，新行程的 store 沒有它們。
    const restartedStore = new AgentStateStore();
    const restartedGuard = new WriteGuard({
      store: restartedStore,
      ptyManager: { has: () => true },
    });
    const second = new PixelAgentsServer();
    servers.push(second);
    const config2 = await second.start({
      embedded: false,
      store: restartedStore,
      writeGuard: restartedGuard,
    });
    expect(readList(config2)?.knownSessions).toEqual([]);
  });

  it('prunes a guard list left behind by a dead server on start', async () => {
    const stale = path.join(guardListsDir(tmpBase), '999999-1234.json');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, '{}');
    const server = new PixelAgentsServer();
    servers.push(server);
    await server.start({ embedded: false, store, writeGuard: guardWith() });
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('embedded: answers unknown-session even for a session it knows, and writes no list', async () => {
    const guard = guardWith();
    held.add(1);
    addAgent(store, 1, 'known-to-embedded');
    guard.setProtectedRoots([protectedRoot]);
    const server = new PixelAgentsServer();
    servers.push(server);
    const config = await server.start({ embedded: true, store, writeGuard: guard });

    expect(fs.existsSync(guardListsDir(tmpBase))).toBe(false);
    const response = await rawPost(
      config.port,
      { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      JSON.stringify({
        tool_name: 'Write',
        session_id: 'known-to-embedded',
        cwd: tmpBase,
        paths: [path.join(protectedRoot, 'a.md')],
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ verdict: 'unknown-session' });
  });
});

// ── 端點的縱深防禦 ─────────────────────────────────────────────────

describe('verdict endpoint guard', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let port: number;
  let token: string;
  const body = (): string =>
    JSON.stringify({
      tool_name: 'Write',
      session_id: 'pty',
      cwd: tmpBase,
      paths: [path.join(protectedRoot, 'a.md')],
    });

  beforeEach(async () => {
    const guard = guardWith();
    held.add(1);
    addAgent(store, 1, 'pty');
    guard.setProtectedRoots([protectedRoot]);
    server = new PixelAgentsServer();
    const config = await server.start({ embedded: false, store, writeGuard: guard });
    port = config.port;
    token = config.token;
  });

  afterEach(() => server.stop());

  const json = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  });

  it('answers a well-formed, authenticated loopback request', async () => {
    const response = await rawPost(port, json(), body());
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ verdict: 'deny' });
  });

  it.each([
    ['an Origin header', { Origin: 'http://127.0.0.1' }],
    ['an empty Origin header', { Origin: '' }],
    ['a Forwarded header', { Forwarded: 'for=10.0.0.2' }],
    ['a Via header', { Via: '1.1 proxy' }],
    ['an X-Forwarded-For header', { 'X-Forwarded-For': '10.0.0.2' }],
    ['a non-loopback Host', { Host: 'evil.example' }],
  ])('refuses %s with 403 before authentication', async (_label, extra) => {
    const response = await rawPost(port, { ...json(), ...extra }, body());
    expect(response.status).toBe(403);
  });

  it('refuses an encoded spelling of the route the same way (route match, not url prefix)', async () => {
    const response = await rawPost(
      port,
      { ...json(), Origin: 'http://evil.example' },
      body(),
      '/api/guard/%76erdict',
    );
    expect(response.status).toBe(403);
  });

  it('refuses a missing or wrong token with 401', async () => {
    expect((await rawPost(port, { 'Content-Type': 'application/json' }, body())).status).toBe(401);
    expect(
      (
        await rawPost(
          port,
          { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
          body(),
        )
      ).status,
    ).toBe(401);
  });

  it('requires exactly one Authorization header', () => {
    expect(guardRequestAuthorized(['Authorization', 'Bearer t'], 't')).toBe(true);
    expect(
      guardRequestAuthorized(['Authorization', 'Bearer t', 'authorization', 'Bearer t'], 't'),
    ).toBe(false);
    expect(guardRequestAuthorized([], 't')).toBe(false);
  });

  it('answers 400 to a malformed body', async () => {
    const response = await rawPost(port, json(), JSON.stringify({ tool_name: 'Write' }));
    expect(response.status).toBe(400);
  });

  it('leaves the existing hook route as it was', async () => {
    const response = await rawPost(
      port,
      json(),
      JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' }),
      '/api/hooks/claude',
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
  });
});
