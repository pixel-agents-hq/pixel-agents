/**
 * 阻擋式裁決的 hook 端流程（P1）：本地判斷、多伺服器合併、fail-closed、
 * 輸出格式、拒絕訊息範本。全部以注入的假 deps 執行，不碰網路、不呼叫真實 claude。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  HookGuardDeps,
  VerdictOutcome,
} from '../src/providers/hook/claude/guard/hookGuard.js';
import type { ServerConfig } from '../src/serverConfig.js';
import type { GuardList } from '../src/writeGuard/guardList.js';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const {
  WRITE_GUARD_DENY_GENERIC,
  WRITE_GUARD_DENY_TEMPLATES,
  WRITE_GUARD_HOOK_DEADLINE_MS,
  WRITE_GUARD_RULE_PROTECTED_PATH,
  WRITE_GUARD_RULE_UNREACHABLE,
} = await import('../src/constants.js');
const { formatDenyOutput } = await import('../src/providers/hook/claude/guard/decisionOutput.js');
const { extractGuardFields } =
  await import('../src/providers/hook/claude/guard/fieldExtraction.js');
const { planGuard, runGuardedDelivery } =
  await import('../src/providers/hook/claude/guard/hookGuard.js');
const { pathNormalizer } = await import('../src/writeGuard/pathNormalization.js');
const { renderDenyMessage } = await import('../src/writeGuard/denyMessage.js');
const { installHooks } = await import('../src/providers/hook/claude/claudeHookInstaller.js');

const SESSION = 'session-known';

function standaloneServer(port: number): ServerConfig {
  return {
    port,
    pid: process.pid,
    token: `token-${port}`,
    startedAt: 0,
    servesSpa: true,
    protocol: 1,
    standalone: { terminal: true, host: '127.0.0.1', allowedHosts: [] },
  };
}

function embeddedServer(port: number): ServerConfig {
  return {
    port,
    pid: process.pid,
    token: `token-${port}`,
    startedAt: 0,
    servesSpa: false,
    protocol: 1,
  };
}

/** 測試直寫的清單內容（P1 的受保護根目錄只由測試提供）。 */
function listFor(server: ServerConfig, roots: string[], sessions: string[]): GuardList {
  return {
    version: 1,
    pid: server.pid,
    port: server.port,
    protectedRoots: roots,
    knownSessions: sessions,
  };
}

interface Harness {
  deps: HookGuardDeps & { forward(): Promise<void>; emit(output: string): Promise<void> };
  calls: string[];
  emitted: string[];
  bodies: { port: number; body: string }[];
}

function harness(
  lists: Map<number, GuardList>,
  answer: (server: ServerConfig) => Promise<VerdictOutcome>,
): Harness {
  const calls: string[] = [];
  const emitted: string[] = [];
  const bodies: { port: number; body: string }[] = [];
  const deps: Harness['deps'] = {
    extractFields: (payload) => {
      calls.push('extract');
      return extractGuardFields(payload);
    },
    normalizer: {
      normalizeTarget: (raw, cwd) => {
        calls.push('normalize');
        return pathNormalizer.normalizeTarget(raw, cwd);
      },
      normalizeRoot: pathNormalizer.normalizeRoot,
      isWithin: pathNormalizer.isWithin,
    },
    readList: (server) => {
      calls.push(`readList:${server.port}`);
      return lists.get(server.port) ?? null;
    },
    requestVerdict: (server, body) => {
      calls.push(`request:${server.port}`);
      bodies.push({ port: server.port, body });
      return answer(server);
    },
    now: () => Date.now(),
    log: () => {},
    forward: async () => {
      calls.push('forward');
    },
    emit: async (output) => {
      emitted.push(output);
    },
  };
  return { deps, calls, emitted, bodies };
}

const verdict = (v: 'allow' | 'unknown-session'): Promise<VerdictOutcome> =>
  Promise.resolve({ kind: 'verdict', verdict: { verdict: v } });
const deny = (rule: string, p?: string): Promise<VerdictOutcome> =>
  Promise.resolve({
    kind: 'verdict',
    verdict: p === undefined ? { verdict: 'deny', rule } : { verdict: 'deny', rule, path: p },
  });
const unanswered = (): Promise<VerdictOutcome> => Promise.resolve({ kind: 'unanswered' });
const rejected = (): Promise<VerdictOutcome> => Promise.resolve({ kind: 'rejected' });

function writePayload(filePath: string, sessionId = SESSION, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: tmpBase,
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'hello', ...extra },
  };
}

function parseDeny(output: string): { permissionDecision: string; reason: string } {
  const parsed = JSON.parse(output) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  return {
    permissionDecision: parsed.hookSpecificOutput.permissionDecision,
    reason: parsed.hookSpecificOutput.permissionDecisionReason,
  };
}

let protectedRoot: string;
let openDir: string;

beforeEach(() => {
  tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-guard-hook-')));
  protectedRoot = path.join(tmpBase, 'workspace', '.note');
  openDir = path.join(tmpBase, 'workspace', 'src');
  fs.mkdirSync(protectedRoot, { recursive: true });
  fs.mkdirSync(openDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

// ── 驗收 1：allow 無輸出，deny 輸出 JSON ─────────────────────────────

describe('decision output (F1)', () => {
  it('formats a deny as exit-0 JSON with permissionDecision deny and the reason (assumed format)', () => {
    // 假設：官方文件回報的格式，尚未以真實 claude 實測（P0 #1、#3）。
    expect(JSON.parse(formatDenyOutput('why'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'why',
      },
    });
  });

  it('emits nothing when the server allows', async () => {
    const server = standaloneServer(4001);
    const h = harness(new Map([[4001, listFor(server, [protectedRoot], [SESSION])]]), () =>
      verdict('allow'),
    );
    await runGuardedDelivery(writePayload(path.join(protectedRoot, 'a.md')), [server], h.deps);
    expect(h.emitted).toEqual([]);
    expect(h.calls).toContain('forward');
  });

  it('emits one deny with reason, rationale and suggestion when the server denies', async () => {
    const server = standaloneServer(4002);
    const target = path.join(protectedRoot, 'a.md');
    const h = harness(new Map([[4002, listFor(server, [protectedRoot], [SESSION])]]), () =>
      deny(WRITE_GUARD_RULE_PROTECTED_PATH, target),
    );
    await runGuardedDelivery(writePayload(target), [server], h.deps);
    expect(h.emitted).toHaveLength(1);
    const { permissionDecision, reason } = parseDeny(h.emitted[0]);
    expect(permissionDecision).toBe('deny');
    const template = WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_PROTECTED_PATH];
    expect(reason).toBe(
      `Reason: ${template.reason} Path: ${JSON.stringify(target)}.\n` +
        `Why: ${template.rationale}\n` +
        `Suggestion: ${template.suggestion}`,
    );
  });
});

// ── 驗收 2、3、4：fail-closed 的適用範圍 ─────────────────────────────

describe('server unreachable (F2, F3, F5)', () => {
  it('denies a known standalone session writing a protected path', async () => {
    const server = standaloneServer(4010);
    const target = path.join(protectedRoot, 'new-dir', 'new.md'); // 尚不存在
    const h = harness(new Map([[4010, listFor(server, [protectedRoot], [SESSION])]]), unanswered);
    await runGuardedDelivery(writePayload(target), [server], h.deps);
    expect(h.emitted).toHaveLength(1);
    const { reason } = parseDeny(h.emitted[0]);
    expect(reason).toContain(WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason);
    expect(reason).toContain(JSON.stringify(target));
  });

  it('allows the same known session writing outside every protected root', async () => {
    const server = standaloneServer(4011);
    const h = harness(new Map([[4011, listFor(server, [protectedRoot], [SESSION])]]), unanswered);
    await runGuardedDelivery(writePayload(path.join(openDir, 'a.ts')), [server], h.deps);
    expect(h.emitted).toEqual([]);
  });

  it('allows a known session running Bash (P1 does not judge Bash paths)', async () => {
    const server = standaloneServer(4012);
    const h = harness(new Map([[4012, listFor(server, [protectedRoot], [SESSION])]]), unanswered);
    await runGuardedDelivery(
      {
        hook_event_name: 'PreToolUse',
        session_id: SESSION,
        cwd: tmpBase,
        tool_name: 'Bash',
        tool_input: { command: `echo x > ${path.join(protectedRoot, 'a.md')}` },
      },
      [server],
      h.deps,
    );
    expect(h.emitted).toEqual([]);
  });

  it('allows an unknown session (not on any list) without any network call', async () => {
    const server = standaloneServer(4013);
    const h = harness(new Map([[4013, listFor(server, [protectedRoot], [SESSION])]]), unanswered);
    await runGuardedDelivery(
      writePayload(path.join(protectedRoot, 'a.md'), 'some-other-session'),
      [server],
      h.deps,
    );
    expect(h.emitted).toEqual([]);
    expect(h.calls.some((c) => c.startsWith('request:'))).toBe(false);
  });

  it('allows a VS Code session: the embedded server is never asked and its list is never read', async () => {
    const server = embeddedServer(4014);
    // 即使有人在內嵌伺服器的位置放了清單，hook 也不讀。
    const h = harness(new Map([[4014, listFor(server, [protectedRoot], [SESSION])]]), unanswered);
    await runGuardedDelivery(writePayload(path.join(protectedRoot, 'a.md')), [server], h.deps);
    expect(h.emitted).toEqual([]);
    expect(h.calls).not.toContain('readList:4014');
    expect(h.calls.some((c) => c.startsWith('request:'))).toBe(false);
  });

  it('a listing server answering non-2xx: protected write denied, other writes allowed', async () => {
    // 會被詢問的只有寫過清單的新版伺服器，它回非 2xx 是伺服器異常：與未回答同樣處理。
    // 各狀態碼（500、401、403）對應到 rejected 的部分由 claudeHookGuard.test.ts 以真實 HTTP 驗證。
    const server = standaloneServer(4015);
    const lists = new Map([[4015, listFor(server, [protectedRoot], [SESSION])]]);
    const answer = rejected;
    const protectedWrite = harness(lists, answer);
    await runGuardedDelivery(
      writePayload(path.join(protectedRoot, 'a.md')),
      [server],
      protectedWrite.deps,
    );
    expect(protectedWrite.emitted).toHaveLength(1);
    expect(parseDeny(protectedWrite.emitted[0]).reason).toContain(
      WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason,
    );

    const openWrite = harness(lists, answer);
    await runGuardedDelivery(writePayload(path.join(openDir, 'a.ts')), [server], openWrite.deps);
    expect(openWrite.emitted).toEqual([]);
  });

  it('allows a server without any list (old server that never writes one)', async () => {
    const server = standaloneServer(4016);
    const h = harness(new Map(), unanswered);
    await runGuardedDelivery(writePayload(path.join(protectedRoot, 'a.md')), [server], h.deps);
    expect(h.emitted).toEqual([]);
    expect(h.calls.some((c) => c.startsWith('request:'))).toBe(false);
  });

  it('allows everything when the registry has no live PID (no servers passed in)', async () => {
    const h = harness(new Map(), unanswered);
    await runGuardedDelivery(writePayload(path.join(protectedRoot, 'a.md')), [], h.deps);
    expect(h.emitted).toEqual([]);
    expect(h.calls).not.toContain('normalize');
  });

  it('falls back to the pre-network decision when the server never answers before the deadline', async () => {
    const server = standaloneServer(4017);
    const h = harness(
      new Map([[4017, listFor(server, [protectedRoot], [SESSION])]]),
      () => new Promise<VerdictOutcome>(() => {}), // 永不回答
    );
    const started = Date.now();
    await runGuardedDelivery(writePayload(path.join(protectedRoot, 'a.md')), [server], h.deps);
    const elapsed = Date.now() - started;
    expect(h.emitted).toHaveLength(1);
    expect(parseDeny(h.emitted[0]).reason).toContain(
      WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason,
    );
    expect(elapsed).toBeGreaterThanOrEqual(WRITE_GUARD_HOOK_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(WRITE_GUARD_HOOK_DEADLINE_MS + 1_000);
  });
});

// ── 驗收 5：多伺服器合併 ──────────────────────────────────────────

describe('multi-server merge (F4)', () => {
  const target = (): string => path.join(protectedRoot, 'a.md');

  it('denies when two servers both know the session and answer allow and deny', async () => {
    const a = standaloneServer(4020);
    const b = standaloneServer(4021);
    const h = harness(
      new Map([
        [4020, listFor(a, [protectedRoot], [SESSION])],
        [4021, listFor(b, [protectedRoot], [SESSION])],
      ]),
      (server) => (server.port === 4020 ? verdict('allow') : deny(WRITE_GUARD_RULE_PROTECTED_PATH)),
    );
    await runGuardedDelivery(writePayload(target()), [a, b], h.deps);
    expect(h.emitted).toHaveLength(1);
    expect(parseDeny(h.emitted[0]).permissionDecision).toBe('deny');
  });

  it('only asks servers whose list knows the session', async () => {
    const a = standaloneServer(4022);
    const b = standaloneServer(4023);
    const h = harness(
      new Map([
        [4022, listFor(a, [protectedRoot], [SESSION])],
        [4023, listFor(b, [protectedRoot], ['someone-else'])],
      ]),
      () => verdict('allow'),
    );
    await runGuardedDelivery(writePayload(target()), [a, b], h.deps);
    expect(h.calls).toContain('request:4022');
    expect(h.calls).not.toContain('request:4023');
    expect(h.emitted).toEqual([]);
  });

  it('ignores a server answering unknown-session; the one that knows the session decides', async () => {
    const a = standaloneServer(4024);
    const b = standaloneServer(4025);
    const lists = new Map([
      [4024, listFor(a, [protectedRoot], [SESSION])],
      [4025, listFor(b, [protectedRoot], [SESSION])],
    ]);
    const allowed = harness(lists, (s) =>
      s.port === 4024 ? verdict('unknown-session') : verdict('allow'),
    );
    await runGuardedDelivery(writePayload(target()), [a, b], allowed.deps);
    expect(allowed.emitted).toEqual([]);

    const denied = harness(lists, (s) =>
      s.port === 4024 ? verdict('unknown-session') : deny(WRITE_GUARD_RULE_PROTECTED_PATH),
    );
    await runGuardedDelivery(writePayload(target()), [a, b], denied.deps);
    expect(denied.emitted).toHaveLength(1);
  });

  it('allows when every server that lists the session answers unknown-session', async () => {
    const a = standaloneServer(4026);
    const h = harness(new Map([[4026, listFor(a, [protectedRoot], [SESSION])]]), () =>
      verdict('unknown-session'),
    );
    await runGuardedDelivery(writePayload(target()), [a], h.deps);
    expect(h.emitted).toEqual([]);
  });

  it('two listing servers, one answering 500 and one allowing: protected write denied, open write allowed', async () => {
    const a = standaloneServer(4029);
    const b = standaloneServer(4019);
    const lists = new Map([
      [4029, listFor(a, [protectedRoot], [SESSION])],
      [4019, listFor(b, [protectedRoot], [SESSION])],
    ]);
    const answer = (s: ServerConfig): Promise<VerdictOutcome> =>
      s.port === 4029 ? rejected() : verdict('allow');
    const protectedWrite = harness(lists, answer);
    await runGuardedDelivery(writePayload(target()), [a, b], protectedWrite.deps);
    expect(protectedWrite.emitted).toHaveLength(1);
    expect(parseDeny(protectedWrite.emitted[0]).reason).toContain(
      WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason,
    );

    const openWrite = harness(lists, answer);
    await runGuardedDelivery(writePayload(path.join(openDir, 'a.ts')), [a, b], openWrite.deps);
    expect(openWrite.emitted).toEqual([]);
  });

  it('fails closed when one listing server allows and another listing server is unreachable', async () => {
    const a = standaloneServer(4027);
    const b = standaloneServer(4028);
    const h = harness(
      new Map([
        [4027, listFor(a, [protectedRoot], [SESSION])],
        [4028, listFor(b, [protectedRoot], [SESSION])],
      ]),
      (s) => (s.port === 4027 ? verdict('allow') : unanswered()),
    );
    await runGuardedDelivery(writePayload(target()), [a, b], h.deps);
    expect(h.emitted).toHaveLength(1);
  });
});

// ── 驗收 7：請求不含檔案內容 ─────────────────────────────────────

describe('verdict request contents (F9)', () => {
  it('sends only tool_name, paths, command, cwd and session_id, even for a >64 KB Write', async () => {
    const server = standaloneServer(4030);
    const target = path.join(protectedRoot, 'big.md');
    const content = 'x'.repeat(100 * 1024);
    const h = harness(new Map([[4030, listFor(server, [protectedRoot], [SESSION])]]), () =>
      deny(WRITE_GUARD_RULE_PROTECTED_PATH, target),
    );
    await runGuardedDelivery(
      {
        hook_event_name: 'PreToolUse',
        session_id: SESSION,
        cwd: tmpBase,
        tool_name: 'Write',
        transcript_path: '/somewhere/t.jsonl',
        tool_input: { file_path: target, content },
      },
      [server],
      h.deps,
    );
    expect(h.bodies).toHaveLength(1);
    const sent = JSON.parse(h.bodies[0].body) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['cwd', 'paths', 'session_id', 'tool_name']);
    expect(sent.paths).toEqual([target]);
    expect(h.bodies[0].body).not.toContain('xxxx');
    expect(Buffer.byteLength(h.bodies[0].body)).toBeLessThan(1024);
    expect(h.emitted).toHaveLength(1);
  });

  it('does not send Edit old_string/new_string', async () => {
    const server = standaloneServer(4031);
    const h = harness(new Map([[4031, listFor(server, [protectedRoot], [SESSION])]]), () =>
      verdict('allow'),
    );
    await runGuardedDelivery(
      {
        hook_event_name: 'PreToolUse',
        session_id: SESSION,
        cwd: tmpBase,
        tool_name: 'Edit',
        tool_input: {
          file_path: path.join(openDir, 'a.ts'),
          old_string: 'SECRET-OLD',
          new_string: 'SECRET-NEW',
        },
      },
      [server],
      h.deps,
    );
    expect(h.bodies[0].body).not.toContain('SECRET');
  });

  it('sends the raw Bash command and no paths', async () => {
    const server = standaloneServer(4032);
    const h = harness(new Map([[4032, listFor(server, [protectedRoot], [SESSION])]]), () =>
      verdict('allow'),
    );
    await runGuardedDelivery(
      {
        hook_event_name: 'PreToolUse',
        session_id: SESSION,
        cwd: tmpBase,
        tool_name: 'Bash',
        tool_input: { command: 'ls -la', description: 'list' },
      },
      [server],
      h.deps,
    );
    expect(JSON.parse(h.bodies[0].body)).toEqual({
      tool_name: 'Bash',
      session_id: SESSION,
      cwd: tmpBase,
      paths: [],
      command: 'ls -la',
    });
  });

  it('resolves a relative file_path against cwd and through symlinks before comparing', async () => {
    const server = standaloneServer(4033);
    const link = path.join(tmpBase, 'link-to-note');
    fs.symlinkSync(protectedRoot, link);
    const h = harness(new Map([[4033, listFor(server, [protectedRoot], [SESSION])]]), unanswered);
    await runGuardedDelivery(
      {
        hook_event_name: 'PreToolUse',
        session_id: SESSION,
        cwd: tmpBase,
        tool_name: 'Write',
        tool_input: { file_path: 'link-to-note/x.md', content: '' },
      },
      [server],
      h.deps,
    );
    expect(h.emitted).toHaveLength(1);
    expect(JSON.parse(h.bodies[0].body).paths).toEqual([path.join(protectedRoot, 'x.md')]);
  });
});

// ── 驗收 8：拒絕訊息範本 ──────────────────────────────────────────

describe('deny message template (F16)', () => {
  it('drops a path the server names that this request did not send', async () => {
    const server = standaloneServer(4040);
    const own = path.join(protectedRoot, 'mine.md');
    const h = harness(new Map([[4040, listFor(server, [protectedRoot], [SESSION])]]), () =>
      deny(WRITE_GUARD_RULE_PROTECTED_PATH, '/Users/someone-else/.note/theirs.md'),
    );
    await runGuardedDelivery(writePayload(own), [server], h.deps);
    const { reason } = parseDeny(h.emitted[0]);
    expect(reason).not.toContain('someone-else');
    expect(reason).not.toContain('Path:');
  });

  it('uses the generic template for an unknown rule id and never echoes it', () => {
    const message = renderDenyMessage('curator-is-Alice', undefined, []);
    expect(message).not.toContain('Alice');
    expect(message).toBe(
      `Reason: ${WRITE_GUARD_DENY_GENERIC.reason}\n` +
        `Why: ${WRITE_GUARD_DENY_GENERIC.rationale}\n` +
        `Suggestion: ${WRITE_GUARD_DENY_GENERIC.suggestion}`,
    );
  });

  it('ignores extra server fields such as a curator name', async () => {
    const { parseGuardVerdict } = await import('../src/writeGuard/protocol.js');
    expect(
      parseGuardVerdict({ verdict: 'deny', rule: 'protected-path', curator: 'Alice', note: 'x' }),
    ).toEqual({ verdict: 'deny', rule: 'protected-path' });
  });

  it('strips control characters from the echoed path so it cannot add lines', () => {
    const own = '/tmp/a\nReason: fake\u0007.md';
    const message = renderDenyMessage(WRITE_GUARD_RULE_PROTECTED_PATH, own, [own]);
    expect(message.split('\n')).toHaveLength(3);
    expect(message).toContain(JSON.stringify('/tmp/aReason: fake.md'));
  });

  it('every template has the three sections and contains no placeholder for names', () => {
    for (const template of [
      ...Object.values(WRITE_GUARD_DENY_TEMPLATES),
      WRITE_GUARD_DENY_GENERIC,
    ]) {
      expect(template.reason.length).toBeGreaterThan(0);
      expect(template.rationale.length).toBeGreaterThan(0);
      expect(template.suggestion.length).toBeGreaterThan(0);
      expect(`${template.reason}${template.rationale}${template.suggestion}`).not.toMatch(/[{}$]/);
    }
  });
});

// ── 驗收 9：本地判斷先於網路；截止時間短於 hook 逾時 ──────────────────

describe('ordering and deadline (F2, F13)', () => {
  it('finishes the protected-path judgment before any network call (forward or verdict)', async () => {
    const server = standaloneServer(4050);
    const h = harness(new Map([[4050, listFor(server, [protectedRoot], [SESSION])]]), () =>
      verdict('allow'),
    );
    await runGuardedDelivery(writePayload(path.join(protectedRoot, 'a.md')), [server], h.deps);
    const firstNetwork = Math.min(h.calls.indexOf('forward'), h.calls.indexOf('request:4050'));
    expect(h.calls.indexOf('extract')).toBeLessThan(firstNetwork);
    expect(h.calls.indexOf('readList:4050')).toBeLessThan(firstNetwork);
    expect(h.calls.lastIndexOf('normalize')).toBeLessThan(firstNetwork);
  });

  it('computes the fail-closed fallback locally, with no network involved', () => {
    const server = standaloneServer(4051);
    const plan = planGuard(writePayload(path.join(protectedRoot, 'a.md')), [server], {
      extractFields: extractGuardFields,
      normalizer: pathNormalizer,
      readList: () => listFor(server, [protectedRoot], [SESSION]),
    });
    expect(plan?.fallback.decision).toBe('deny');
  });

  it('still forwards the event when the local judgment throws, and allows', async () => {
    const server = standaloneServer(4052);
    const h = harness(new Map(), unanswered);
    h.deps.readList = () => {
      throw new Error('boom');
    };
    await runGuardedDelivery(writePayload(path.join(protectedRoot, 'a.md')), [server], h.deps);
    expect(h.calls).toContain('forward');
    expect(h.emitted).toEqual([]);
  });

  it('keeps the hook deadline well below the installed hook timeout', async () => {
    await installHooks();
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpBase, '.claude', 'settings.json'), 'utf-8'),
    ) as { hooks: Record<string, { hooks: { timeout: number }[] }[]> };
    const timeoutsMs = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((entry) => entry.hooks.map((hook) => hook.timeout * 1000)),
    );
    expect(timeoutsMs.length).toBeGreaterThan(0);
    for (const timeoutMs of timeoutsMs) {
      // 留至少一半的餘裕給 node 啟動、讀 registry 與寫 stdout。
      expect(WRITE_GUARD_HOOK_DEADLINE_MS).toBeLessThanOrEqual(timeoutMs / 2);
    }
  });
});

describe('field extraction (P1 interface)', () => {
  it('returns null for non-PreToolUse events and for tools P1 does not handle', () => {
    expect(
      extractGuardFields({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Write' }),
    ).toBeNull();
    expect(
      extractGuardFields({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        tool_name: 'Read',
        tool_input: { file_path: '/x' },
      }),
    ).toBeNull();
    expect(extractGuardFields({ hook_event_name: 'PreToolUse', tool_name: 'Write' })).toBeNull();
  });

  it('extracts file_path for Write and Edit and the raw command for Bash', () => {
    expect(
      extractGuardFields({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        cwd: '/w',
        tool_name: 'Edit',
        tool_input: { file_path: '/w/a', old_string: 'o', new_string: 'n' },
      }),
    ).toEqual({ toolName: 'Edit', sessionId: 's', cwd: '/w', pathFields: ['/w/a'] });
    expect(
      extractGuardFields({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        cwd: '/w',
        tool_name: 'Bash',
        tool_input: { command: 'cat > /w/.note/x' },
      }),
    ).toEqual({
      toolName: 'Bash',
      sessionId: 's',
      cwd: '/w',
      pathFields: [],
      command: 'cat > /w/.note/x',
    });
  });
});

describe('path normalization (P1 interface)', () => {
  it('treats a sibling named "..foo" as inside and "../x" as outside', () => {
    expect(pathNormalizer.isWithin('/a/b/..foo/c', '/a/b')).toBe(true);
    expect(pathNormalizer.isWithin('/a/c', '/a/b')).toBe(false);
    expect(pathNormalizer.isWithin('/a/b', '/a/b')).toBe(true);
    expect(pathNormalizer.isWithin('/a/bc', '/a/b')).toBe(false);
  });

  it('resolves `..` inside the path before comparing', () => {
    const sneaky = path.join(openDir, '..', '.note', 'a.md');
    expect(pathNormalizer.normalizeTarget(sneaky, tmpBase)).toBe(path.join(protectedRoot, 'a.md'));
  });

  it('refuses to guess a relative path without an absolute cwd', () => {
    expect(pathNormalizer.normalizeTarget('a.md', '')).toBeNull();
  });
});
