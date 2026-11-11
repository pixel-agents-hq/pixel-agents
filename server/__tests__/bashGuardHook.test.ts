/**
 * P3：hook 端的 Bash 本地判斷，伺服器不可達時（驗收 10）。注入的假 deps，不碰網路、
 * 不呼叫真實 claude。KB 區的 Bash 寫入目標 fail-closed；角色與 F17 不生效；
 * 未知 session 放行。另含超長指令與過大請求的明確行為。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WRITE_GUARD_BASH_MAX_PARSE_BYTES,
  WRITE_GUARD_DENY_TEMPLATES,
  WRITE_GUARD_MAX_REQUEST_BYTES,
  WRITE_GUARD_RULE_UNREACHABLE,
} from '../src/constants.js';
import { extractGuardFields } from '../src/providers/hook/claude/guard/fieldExtraction.js';
import type { HookGuardDeps } from '../src/providers/hook/claude/guard/hookGuard.js';
import { runGuardedDelivery } from '../src/providers/hook/claude/guard/hookGuard.js';
import type { ServerConfig } from '../src/serverConfig.js';
import { pathNormalizer } from '../src/writeGuard/pathNormalization.js';

const SESSION = 'known-session';
const SERVER: ServerConfig = {
  port: 4300,
  pid: process.pid,
  token: 't',
  startedAt: 0,
  servesSpa: true,
  protocol: 1,
  standalone: { terminal: true, host: '127.0.0.1' },
};

let base: string;
let workspace: string;
let protectedRoot: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-bash-hook-')));
  workspace = path.join(base, 'ws');
  protectedRoot = path.join(workspace, '.note');
  fs.mkdirSync(protectedRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** 伺服器一律不回答；回傳輸出的拒絕與送出的請求體。 */
async function deliver(
  command: string | undefined,
  opts: { session?: string; roots?: string[]; cwd?: string } = {},
) {
  const emitted: string[] = [];
  const bodies: string[] = [];
  const deps: HookGuardDeps & { forward(): Promise<void>; emit(o: string): Promise<void> } = {
    extractFields: extractGuardFields,
    normalizer: pathNormalizer,
    homeDir: () => base,
    readList: () => ({
      version: 1,
      pid: SERVER.pid,
      port: SERVER.port,
      protectedRoots: opts.roots ?? [protectedRoot],
      knownSessions: [SESSION],
    }),
    requestVerdict: (_server, body) => {
      bodies.push(body);
      return Promise.resolve({ kind: 'unanswered' });
    },
    now: () => Date.now(),
    log: () => {},
    forward: async () => {},
    emit: async (output) => {
      emitted.push(output);
    },
  };
  await runGuardedDelivery(
    {
      hook_event_name: 'PreToolUse',
      session_id: opts.session ?? SESSION,
      cwd: opts.cwd ?? workspace,
      tool_name: 'Bash',
      tool_input: command === undefined ? {} : { command },
    },
    [SERVER],
    deps,
  );
  const reason = emitted.map(
    (o) =>
      (JSON.parse(o) as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason,
  )[0];
  return { denied: emitted.length > 0, reason, bodies };
}

describe('server unreachable: KB zones fail closed for Bash write targets (acceptance 10)', () => {
  it.each([
    ['redirect', () => `echo x > ${protectedRoot}/a.md`],
    ['tee', () => `tee ${protectedRoot}/a.md < /dev/null`],
    ['sed -i', () => `sed -i s/a/b/ ${protectedRoot}/a.md`],
    ['cp', () => `cp a.md ${protectedRoot}/`],
    ['mv source', () => `mv ${protectedRoot}/a.md /tmp/`],
    ['rm of an ancestor', () => `rm -rf ${workspace}`],
    ['relative after cd', () => `cd ${workspace} && echo x > .note/a.md`],
    ['relative to the payload cwd', () => 'echo x > .note/a.md'],
    ['interpreter literal', () => `python -c "open('${protectedRoot}/x','w')"`],
  ])('%s is denied with the unreachable template', async (_label, command) => {
    const { denied, reason } = await deliver(command());
    expect(denied).toBe(true);
    expect(reason).toContain(WRITE_GUARD_DENY_TEMPLATES[WRITE_GUARD_RULE_UNREACHABLE].reason);
  });

  it('verifier F-1: 3000-deep parentheses fail closed instead of crashing the plan', async () => {
    const command = `${'('.repeat(3000)}rm -rf ${protectedRoot}${')'.repeat(3000)}`;
    const { denied, bodies } = await deliver(command);
    expect(denied).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ unresolved: true });
  });

  it('reading a KB zone and writing elsewhere stay allowed', async () => {
    expect((await deliver(`cat ${protectedRoot}/a.md | grep x`)).denied).toBe(false);
    expect((await deliver(`echo x > ${workspace}/out.txt`)).denied).toBe(false);
  });

  it('roles and F17 are not enforced while the server is unreachable', async () => {
    // 角色只存在伺服器記憶體：rm 放行。F17 不在本地清單：寫 ~/.claude/settings.json 放行。
    expect((await deliver('rm -rf build')).denied).toBe(false);
    expect((await deliver('echo x > ~/.claude/settings.json')).denied).toBe(false);
  });

  it('an unknown session is allowed without any request', async () => {
    const result = await deliver(`echo x > ${protectedRoot}/a.md`, { session: 'someone-else' });
    expect(result.denied).toBe(false);
    expect(result.bodies).toEqual([]);
  });

  it('a relative target with no usable cwd cannot be resolved: denied while KB rules are on', async () => {
    expect((await deliver('echo x > a.md', { cwd: '' })).denied).toBe(true);
    expect((await deliver('echo x > a.md', { cwd: '', roots: [] })).denied).toBe(false);
  });
});

describe('long commands and large requests (F9)', () => {
  it('a command over the parse limit is unresolved: denied only while KB rules are on', async () => {
    const huge = `echo ${'a'.repeat(WRITE_GUARD_BASH_MAX_PARSE_BYTES)}`;
    const on = await deliver(huge);
    expect(on.denied).toBe(true);
    expect(on.bodies.every((b) => Buffer.byteLength(b) <= WRITE_GUARD_MAX_REQUEST_BYTES)).toBe(
      true,
    );
    expect((await deliver(huge, { roots: [] })).denied).toBe(false);
    expect((await deliver(undefined)).denied).toBe(true);
  });

  it('a request over 64 KB is replaced by a minimal one: no command, unresolved, hook-side ops', async () => {
    const { bodies } = await deliver(`rm -f x # ${'a'.repeat(70_000)}`, { roots: [] });
    expect(bodies).toHaveLength(1);
    expect(Buffer.byteLength(bodies[0])).toBeLessThan(1024);
    expect(JSON.parse(bodies[0])).toEqual({
      tool_name: 'Bash',
      session_id: SESSION,
      cwd: workspace,
      paths: [],
      unresolved: true,
      bash_ops: ['delete'],
    });
  });

  it('a normal request carries the command, the targets and no file content', async () => {
    const { bodies } = await deliver(`rm -rf ${workspace}/build && python -c "x='./a/b'"`);
    expect(JSON.parse(bodies[0])).toEqual({
      tool_name: 'Bash',
      session_id: SESSION,
      cwd: workspace,
      paths: [],
      command: `rm -rf ${workspace}/build && python -c "x='./a/b'"`,
      recursive_paths: [path.join(workspace, 'build')],
      // 第二次驗證後修改：無法分類的 python 另把工作目錄本身列為潛在寫入。
      mentioned_paths: [path.join(workspace, 'a', 'b'), workspace],
    });
  });
});
